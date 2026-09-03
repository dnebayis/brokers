// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {GiftVault, IBrokersGV, IBoosterGV} from "../src/GiftVault.sol";

contract GiftNFT is ERC721 {
    constructor() ERC721("Gift", "GIFT") {}

    function mint(address to, uint256 id) external {
        _safeMint(to, id);
    }
}

/// Stand-in Broker wallet: accepts NFTs like the real ERC-6551 account does.
contract WalletMock is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract BrokersMock is IBrokersGV {
    uint256 public constant MAX_SUPPLY = 1776;
    mapping(uint256 => address) public wallets;

    function accountOf(uint256 tokenId) external view returns (address) {
        return wallets[tokenId];
    }

    function setWallet(uint256 tokenId, address w) external {
        wallets[tokenId] = w;
    }
}

contract BoosterMock is IBoosterGV {
    mapping(uint256 => bool) public isActive;

    function setActive(uint256 tokenId, bool a) external {
        isActive[tokenId] = a;
    }
}

contract GiftVaultTest is Test {
    GiftNFT nft;
    BrokersMock brokers;
    BoosterMock booster;
    GiftVault vault;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address donor = makeAddr("donor");
    uint64 constant INTERVAL = 3 days;

    function setUp() public {
        nft = new GiftNFT();
        brokers = new BrokersMock();
        booster = new BoosterMock();
        vault = new GiftVault(brokers, booster, keeper, INTERVAL, owner);
        vm.roll(1000);
        vm.warp(1_700_000_000);
        // every Broker gets a wallet; only a subset is active
        for (uint256 i = 1; i <= 1776; ++i) {
            brokers.setWallet(i, address(new WalletMock()));
        }
    }

    function _deposit(uint256 id) internal {
        nft.mint(donor, id);
        vm.prank(donor);
        nft.safeTransferFrom(donor, address(vault), id);
    }

    function _activateEveryOther() internal {
        for (uint256 i = 1; i <= 1776; ++i) {
            booster.setActive(i, i % 2 == 0);
        }
    }

    function test_safe_transfer_queues_fifo_and_upcoming_lists_it() public {
        _deposit(7);
        _deposit(8);
        assertEq(vault.queuedCount(), 2);
        assertTrue(vault.queued(address(nft), 7));
        GiftVault.Item[] memory up = vault.upcoming(5);
        assertEq(up.length, 2);
        assertEq(up[0].id, 7);
        assertEq(up[1].id, 8);
    }

    function test_direct_hook_call_without_custody_reverts() public {
        nft.mint(donor, 99); // exists, but the vault does not hold it
        vm.expectRevert(GiftVault.DirectTransfer.selector);
        vm.prank(address(nft));
        vault.onERC721Received(address(0), donor, 99, "");
    }

    function test_only_keeper_or_owner_opens_and_queue_must_hold_something() public {
        vm.prank(donor);
        vm.expectRevert(GiftVault.NotKeeper.selector);
        vault.openRound();
        vm.prank(keeper);
        vm.expectRevert(GiftVault.QueueEmpty.selector);
        vault.openRound();
    }

    function test_round_settles_to_an_active_broker_wallet() public {
        _activateEveryOther();
        _deposit(7);
        vm.prank(keeper);
        vault.openRound();
        (address rNft, uint256 rId, uint64 drawBlock,) = vault.open();
        assertEq(rNft, address(nft));
        assertEq(rId, 7);
        assertEq(drawBlock, 1000 + vault.DRAW_DELAY());
        assertEq(vault.queuedCount(), 0);

        vm.expectRevert(GiftVault.DrawBlockNotReached.selector);
        vault.settle();

        vm.roll(drawBlock + 1);
        vm.prank(donor); // anyone may settle
        vault.settle();
        address holder = nft.ownerOf(7);
        // find which Broker won and check it was active
        uint256 winner;
        for (uint256 i = 1; i <= 1776; ++i) {
            if (brokers.accountOf(i) == holder) winner = i;
        }
        assertTrue(winner != 0, "gift left the vault to a Broker wallet");
        assertTrue(booster.isActive(winner), "winner is active");
        assertEq(vault.lastGiftAt(), block.timestamp);
        assertEq(vault.roundCount(), 1);
        (address afterNft,,,) = vault.open();
        assertEq(afterNft, address(0));
    }

    function test_winner_is_deterministic_in_the_draw_block_hash() public {
        _activateEveryOther();
        _deposit(7);
        vm.prank(keeper);
        vault.openRound();
        (,, uint64 drawBlock,) = vault.open();
        vm.roll(drawBlock + 1);
        bytes32 hash = blockhash(drawBlock);
        bytes32 seed = keccak256(abi.encode(hash, uint256(1), address(nft), uint256(7)));
        uint256 expected;
        for (uint256 i; i < vault.MAX_TRIES(); ++i) {
            uint256 c = (uint256(keccak256(abi.encode(seed, i))) % 1776) + 1;
            if (booster.isActive(c)) {
                expected = c;
                break;
            }
        }
        vault.settle();
        assertEq(nft.ownerOf(7), brokers.accountOf(expected));
    }

    function test_cadence_is_enforced_between_gifts() public {
        _activateEveryOther();
        _deposit(7);
        _deposit(8);
        vm.prank(keeper);
        vault.openRound();
        (,, uint64 drawBlock,) = vault.open();
        vm.roll(drawBlock + 1);
        vault.settle();

        vm.prank(keeper);
        vm.expectRevert(GiftVault.TooSoon.selector);
        vault.openRound();

        vm.warp(block.timestamp + INTERVAL);
        vm.prank(keeper);
        vault.openRound();
        (, uint256 id2,,) = vault.open();
        assertEq(id2, 8);
        vm.prank(keeper);
        vm.expectRevert(GiftVault.RoundOpen.selector);
        vault.openRound();
    }

    function test_stale_hash_rerolls_instead_of_settling_on_zero() public {
        _activateEveryOther();
        _deposit(7);
        vm.prank(keeper);
        vault.openRound();
        (,, uint64 drawBlock,) = vault.open();
        vm.roll(drawBlock + 300); // hash no longer available
        vault.settle();
        (address stillNft,, uint64 newDraw,) = vault.open();
        assertEq(stillNft, address(nft));
        assertEq(newDraw, drawBlock + 300 + vault.DRAW_DELAY());
        assertEq(nft.ownerOf(7), address(vault));
        vm.roll(newDraw + 1);
        vault.settle();
        assertTrue(nft.ownerOf(7) != address(vault));
    }

    function test_no_active_brokers_rerolls() public {
        _deposit(7);
        vm.prank(keeper);
        vault.openRound();
        (,, uint64 drawBlock,) = vault.open();
        vm.roll(drawBlock + 1);
        vault.settle();
        (address stillNft,,,) = vault.open();
        assertEq(stillNft, address(nft));
        assertEq(nft.ownerOf(7), address(vault));
    }

    function test_rescue_and_cancel() public {
        _deposit(7);
        _deposit(8);
        vm.prank(donor);
        vm.expectRevert();
        vault.rescue(address(nft), 7, donor);
        vm.prank(owner);
        vault.rescue(address(nft), 7, donor);
        assertEq(nft.ownerOf(7), donor);
        assertEq(vault.queuedCount(), 1);

        vm.prank(keeper);
        vault.openRound();
        (, uint256 id,,) = vault.open();
        assertEq(id, 8);
        vm.prank(owner);
        vm.expectRevert(GiftVault.InRound.selector);
        vault.rescue(address(nft), 8, donor);
        vm.prank(owner);
        vault.cancelRound();
        assertEq(vault.queuedCount(), 1);
        (address none,,,) = vault.open();
        assertEq(none, address(0));
        vm.expectRevert(GiftVault.NoRound.selector);
        vault.settle();
    }

    function test_owner_setters() public {
        vm.prank(owner);
        vault.setInterval(7 days);
        assertEq(vault.interval(), 7 days);
        vm.prank(owner);
        vault.setKeeper(donor);
        assertEq(vault.keeper(), donor);
        vm.prank(keeper);
        vm.expectRevert(GiftVault.NotKeeper.selector);
        vault.openRound();
    }
}

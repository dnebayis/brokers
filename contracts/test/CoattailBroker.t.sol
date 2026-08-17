// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CoattailBroker, IBrokerRenderer, IBoosterHook, ICoatBurnable} from "../src/CoattailBroker.sol";
import {BrokerRenderer} from "../src/BrokerRenderer.sol";
import {IERC6551Registry} from "../src/interfaces/IExternal.sol";
import {MockRegistry6551} from "./Mocks.sol";

contract CoattailBrokerTest is Test {
    CoattailBroker broker;
    MockRegistry6551 registry;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address user = makeAddr("user");
    address impl = makeAddr("accountImpl");

    function setUp() public {
        registry = new MockRegistry6551();
        broker =
            new CoattailBroker(owner, treasury, IERC6551Registry(address(registry)), impl, "ipfs://base/");
        vm.prank(owner);
        broker.setMintOpen(true);
    }

    function test_mintPrice_defaults() public view {
        assertEq(broker.mintPriceWei(), 0.001 ether);
        assertEq(broker.INITIAL_MINT_PRICE(), 0.001 ether);
        assertEq(broker.mintPrice(), 0.001 ether);
        assertEq(broker.mintCap(), broker.MAX_SUPPLY());
        assertEq(broker.ACTIVATION_BURN(), 36_750 ether);
    }

    function test_mint_transfersToTreasuryAndDeploysAccount() public {
        uint256 unit = broker.mintPriceWei();
        vm.deal(user, 1 ether);
        vm.prank(user);
        broker.mint{value: unit}(1);

        assertEq(broker.totalMinted(), 1);
        uint256 tokenId = _firstOwned(user);
        assertTrue(tokenId >= 1 && tokenId <= broker.MAX_SUPPLY());
        assertEq(treasury.balance, unit);
        assertEq(broker.strategyOf(tokenId), 0); // Politician
        assertEq(
            broker.accountOf(tokenId),
            registry.account(impl, bytes32(0), block.chainid, address(broker), tokenId)
        );
    }

    function test_mint_refundsOverpay() public {
        uint256 unit = broker.mintPriceWei();
        vm.deal(user, 1 ether);
        vm.prank(user);
        broker.mint{value: unit + 0.1 ether}(1);
        assertEq(user.balance, 1 ether - unit); // overpay refunded
    }

    function test_walletCap_enforced() public {
        uint256 unit = broker.mintPriceWei();
        vm.deal(user, 1 ether);
        vm.prank(user);
        vm.expectRevert(CoattailBroker.WalletCapReached.selector);
        broker.mint{value: unit * 3}(3);
        assertEq(broker.WALLET_CAP(), 2);
    }

    function test_mintStartsClosed_andOwnerCanPauseResume() public {
        CoattailBroker closed =
            new CoattailBroker(owner, treasury, IERC6551Registry(address(registry)), impl, "");
        uint256 closedPrice = closed.mintPriceWei();
        vm.deal(user, 1 ether);
        vm.prank(user);
        vm.expectRevert(CoattailBroker.MintClosed.selector);
        closed.mint{value: closedPrice}(1);

        vm.prank(owner);
        closed.setMintOpen(true);
        vm.prank(user);
        closed.mint{value: closedPrice}(1);
        vm.prank(owner);
        closed.setMintOpen(false);
        vm.prank(user);
        vm.expectRevert(CoattailBroker.MintClosed.selector);
        closed.mint{value: closedPrice}(1);
    }

    function test_batchMint_drawsTwoDistinctIds() public {
        uint256 unit = broker.mintPriceWei();
        vm.deal(user, 1 ether);
        vm.prank(user);
        broker.mint{value: unit * 2}(2);
        uint256[] memory ids = _ownedIds(user, 2);
        assertNotEq(ids[0], ids[1]);
        assertEq(broker.totalMinted(), 2);
    }

    function test_revertedMintConsumesNoIdOrSupply() public {
        uint256 beforeMinted = broker.totalMinted();
        uint256 price = broker.mintPriceWei();
        vm.deal(user, 1 ether);
        vm.prank(user);
        vm.expectRevert();
        broker.mint{value: price - 1}(1);
        assertEq(broker.totalMinted(), beforeMinted);
        assertEq(broker.mintedBy(user), 0);
    }

    function test_insufficientPayment_reverts() public {
        uint256 unit = broker.mintPriceWei();
        vm.deal(user, 1 ether);
        vm.prank(user);
        vm.expectRevert();
        broker.mint{value: unit - 1}(1);
    }

    function test_tokenURI_usesRendererWhenSet() public {
        // mint one
        uint256 unit = broker.mintPriceWei();
        vm.deal(user, 1 ether);
        vm.prank(user);
        broker.mint{value: unit}(1);
        uint256 tokenId = _firstOwned(user);

        // upload art + wire renderer
        BrokerRenderer renderer = new BrokerRenderer(owner);
        bytes memory bmp = new bytes(200);
        bmp[100] = 0xFF; // some ink
        uint256[] memory ids = new uint256[](1);
        bytes[] memory bmps = new bytes[](1);
        bytes8[] memory tr = new bytes8[](1);
        ids[0] = tokenId;
        bmps[0] = bmp;
        tr[0] = bytes8(0);
        vm.prank(owner);
        renderer.uploadArt(ids, bmps, tr);
        vm.prank(owner);
        broker.setRenderer(IBrokerRenderer(address(renderer)));

        string memory uri = broker.tokenURI(tokenId);
        assertEq(_prefix(uri, 29), "data:application/json;base64,");
    }

    function test_activationRequiresCompleteWiring() public {
        vm.deal(user, 1 ether);
        uint256 price = broker.mintPriceWei();
        vm.prank(user);
        broker.mint{value: price}(1);
        uint256 tokenId = _firstOwned(user);

        vm.prank(user);
        vm.expectRevert(CoattailBroker.CoatNotSet.selector);
        broker.activate(tokenId);

        vm.prank(owner);
        broker.setCoat(ICoatBurnable(makeAddr("coat")));
        vm.prank(user);
        vm.expectRevert(CoattailBroker.BoosterNotSet.selector);
        broker.activate(tokenId);
    }

    function test_wiringIsNonzeroAndOneTime() public {
        vm.startPrank(owner);
        vm.expectRevert(CoattailBroker.ZeroAddress.selector);
        broker.setBooster(IBoosterHook(address(0)));
        broker.setBooster(IBoosterHook(makeAddr("booster")));
        vm.expectRevert(CoattailBroker.AlreadyWired.selector);
        broker.setBooster(IBoosterHook(makeAddr("replacement")));

        vm.expectRevert(CoattailBroker.ZeroAddress.selector);
        broker.setCoat(ICoatBurnable(address(0)));
        broker.setCoat(ICoatBurnable(makeAddr("coat")));
        vm.expectRevert(CoattailBroker.AlreadyWired.selector);
        broker.setCoat(ICoatBurnable(makeAddr("replacementCoat")));
        vm.stopPrank();
    }

    function test_royaltyIsTwoPointFivePercentAndTracksCreator() public {
        (address receiver, uint256 royalty) = broker.royaltyInfo(1, 10 ether);
        assertEq(receiver, treasury);
        assertEq(royalty, 0.25 ether);

        address nextCreator = makeAddr("nextCreator");
        vm.prank(owner);
        broker.setCreator(nextCreator);
        (receiver, royalty) = broker.royaltyInfo(1776, 4 ether);
        assertEq(receiver, nextCreator);
        assertEq(royalty, 0.1 ether);
        assertTrue(broker.supportsInterface(0x2a55205a));
    }

    // --- mint price: lower-only + free mint ---
    function test_setMintPrice_lowersAndAllowsFreeMint() public {
        vm.prank(owner);
        broker.setMintPrice(0.0005 ether);
        assertEq(broker.mintPriceWei(), 0.0005 ether);
        vm.deal(user, 1 ether);
        vm.prank(user);
        broker.mint{value: 0.0005 ether}(1);
        assertEq(treasury.balance, 0.0005 ether);

        // drop to zero: a free mint takes no ETH and forwards nothing to the creator.
        vm.prank(owner);
        broker.setMintPrice(0);
        assertEq(broker.mintPriceWei(), 0);
        uint256 treasuryBefore = treasury.balance;
        address freeMinter = makeAddr("freeMinter");
        vm.prank(freeMinter);
        broker.mint(1);
        assertEq(broker.balanceOf(freeMinter), 1);
        assertEq(treasury.balance, treasuryBefore); // creator received nothing on a free mint
    }

    function test_setMintPrice_cannotRaise_andOwnerOnly() public {
        vm.prank(owner);
        vm.expectRevert(CoattailBroker.PriceIncrease.selector);
        broker.setMintPrice(0.002 ether);

        vm.prank(user);
        vm.expectRevert();
        broker.setMintPrice(0);
    }

    // --- supply cut ---
    function test_cutMintCap_reducesSellableSupply() public {
        uint256 unit = broker.mintPriceWei();
        vm.deal(user, 1 ether);
        vm.prank(user);
        broker.mint{value: unit}(1); // totalMinted = 1

        vm.prank(owner);
        broker.cutMintCap(1); // cap down to exactly what is minted
        assertEq(broker.mintCap(), 1);
        assertEq(broker.MAX_SUPPLY(), 1776); // art/ID space untouched

        address late = makeAddr("late");
        vm.deal(late, 1 ether);
        vm.prank(late);
        vm.expectRevert(CoattailBroker.SoldOut.selector);
        broker.mint{value: unit}(1);
    }

    function test_cutMintCap_guards() public {
        vm.startPrank(owner);
        vm.expectRevert(CoattailBroker.CapNotLower.selector);
        broker.cutMintCap(1776); // not lower
        vm.expectRevert(CoattailBroker.CapNotLower.selector);
        broker.cutMintCap(2000); // cannot raise
        vm.stopPrank();

        uint256 unit = broker.mintPriceWei();
        vm.deal(user, 1 ether);
        vm.prank(user);
        broker.mint{value: unit * 2}(2); // totalMinted = 2
        vm.prank(owner);
        vm.expectRevert(CoattailBroker.CapBelowMinted.selector);
        broker.cutMintCap(1); // below already minted

        vm.prank(user);
        vm.expectRevert();
        broker.cutMintCap(2); // onlyOwner
    }

    // --- deployer-only mass refund (does not touch the NFTs) ---
    function test_refundHolders_refundsCurrentOwnersOnce() public {
        // This test contract deployed `broker` in setUp, so it is the `deployer`.
        vm.deal(address(this), 5 ether);
        uint256 unit = broker.mintPriceWei();
        vm.deal(user, 1 ether);
        vm.prank(user);
        broker.mint{value: unit * 2}(2);
        uint256[] memory ids = _ownedIds(user, 2);
        assertEq(broker.mintPaid(ids[0]), unit);

        // Transfer one to a buyer — the refund must follow to the CURRENT owner.
        address buyer = makeAddr("buyer");
        vm.prank(user);
        broker.transferFrom(user, buyer, ids[0]);

        uint256 userBefore = user.balance;
        uint256 buyerBefore = buyer.balance;
        broker.refundHolders{value: unit * 2}(1, broker.MAX_SUPPLY());
        assertEq(buyer.balance, buyerBefore + unit); // current owner of ids[0]
        assertEq(user.balance, userBefore + unit); // still owns ids[1]
        assertEq(broker.mintPaid(ids[0]), 0);
        assertEq(broker.mintPaid(ids[1]), 0);
        assertEq(broker.ownerOf(ids[0]), buyer); // NFTs untouched
        assertEq(broker.ownerOf(ids[1]), user);

        // Idempotent: a second sweep refunds nothing and returns the full funding.
        uint256 selfBefore = address(this).balance;
        broker.refundHolders{value: 1 ether}(1, broker.MAX_SUPPLY());
        assertEq(address(this).balance, selfBefore); // remainder fully returned
    }

    function test_refundHolders_onlyDeployerAndRange() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(CoattailBroker.NotDeployer.selector);
        broker.refundHolders(1, 1776);

        vm.expectRevert(CoattailBroker.BadRange.selector);
        broker.refundHolders(0, 10);
        vm.expectRevert(CoattailBroker.BadRange.selector);
        broker.refundHolders(5, 4);
        vm.expectRevert(CoattailBroker.BadRange.selector);
        broker.refundHolders(1, 1777);
    }

    // Deployer of `broker`; must accept the mass-refund remainder.
    receive() external payable {}

    function _prefix(string memory s, uint256 n) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = b[i];
        }
        return string(out);
    }

    function _firstOwned(address expectedOwner) internal view returns (uint256) {
        return _ownedIds(expectedOwner, 1)[0];
    }

    function _ownedIds(address expectedOwner, uint256 expected) internal view returns (uint256[] memory ids) {
        ids = new uint256[](expected);
        uint256 found;
        for (uint256 id = 1; id <= broker.MAX_SUPPLY() && found < expected; ++id) {
            try broker.ownerOf(id) returns (address actualOwner) {
                if (actualOwner == expectedOwner) ids[found++] = id;
            } catch {}
        }
        assertEq(found, expected, "owned random IDs not found");
    }
}

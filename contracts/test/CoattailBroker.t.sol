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

    function test_mintPrice_isFlat() public view {
        assertEq(broker.mintPriceWei(), 0.0015 ether);
        assertEq(broker.MINT_PRICE(), 0.0015 ether);
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
        uint256 closedPrice = closed.MINT_PRICE();
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
        uint256 unit = broker.MINT_PRICE();
        vm.deal(user, 1 ether);
        vm.prank(user);
        broker.mint{value: unit * 2}(2);
        uint256[] memory ids = _ownedIds(user, 2);
        assertNotEq(ids[0], ids[1]);
        assertEq(broker.totalMinted(), 2);
    }

    function test_revertedMintConsumesNoIdOrSupply() public {
        uint256 beforeMinted = broker.totalMinted();
        uint256 price = broker.MINT_PRICE();
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
        uint256 price = broker.MINT_PRICE();
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

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {BrokerAccount} from "../src/BrokerAccount.sol";
import {COAT} from "../src/COAT.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";
import {CoattailBroker, IBoosterHook, ICoatBurnable} from "../src/CoattailBroker.sol";
import {Booster} from "../src/Booster.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {IERC6551Registry, IStockRouter, IWETH, IAggregatorV3} from "../src/interfaces/IExternal.sol";
import {TestERC6551Registry, MockWETH, MockERC20, MockRouter, MockAggregator} from "./Mocks.sol";

/// @title FundSafety
/// @notice End-to-end proof of the two properties that matter most: user funds can never be
///         STOLEN (only the current NFT owner can move a Broker's wallet or claim its rewards)
///         and never LOCKED (everything a Broker accrues can always be claimed out and then
///         withdrawn from its ERC-6551 wallet — stock and ETH — including after basket rotation
///         and after a resale). Wired exactly like Deploy.s.sol with real ERC-6551 wallets.
contract FundSafetyTest is Test {
    BrokerAccount accountImpl;
    TestERC6551Registry reg6551;
    COAT coat;
    StrategyRegistry strat;
    CoattailBroker broker;
    Booster booster;
    FeeSplitter fees;
    MockWETH weth;
    MockRouter router;
    MockERC20 stockA;
    MockERC20 stockB;

    address deployer = address(this);
    address treasury = makeAddr("treasury");
    address buyback = makeAddr("buyback");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address mallory = makeAddr("mallory"); // the attacker — must never move others' funds

    uint256 constant RATE = 2;
    uint256 constant BURN = 36_750 ether;
    bytes32 constant MINTED_TOPIC = keccak256("Minted(address,uint256,address,uint256)");

    function setUp() public {
        accountImpl = new BrokerAccount();
        reg6551 = new TestERC6551Registry();
        weth = new MockWETH();
        router = new MockRouter(RATE);
        stockA = new MockERC20("Tokenized NVDA", "NVDA");
        stockB = new MockERC20("Tokenized AAPL", "AAPL");

        coat = new COAT(deployer, makeAddr("coatPoolManager"));
        strat = new StrategyRegistry(deployer, deployer);
        strat.createStrategy("The Politician");
        broker = new CoattailBroker(
            deployer, treasury, IERC6551Registry(address(reg6551)), address(accountImpl), ""
        );
        booster = new Booster(broker, strat, IStockRouter(address(router)), IWETH(address(weth)), 0, deployer);
        fees = new FeeSplitter(deployer, payable(address(booster)), payable(treasury), payable(buyback));

        broker.setBooster(IBoosterHook(address(booster)));
        broker.setCoat(ICoatBurnable(address(coat)));
        broker.setMintOpen(true);

        // basket starts 100% stockA
        _setBasket(address(stockA), 10000);

        // guards pass (fair price) for both stocks
        booster.setEthUsdManual(1000e8);
        booster.setStockFeed(address(stockA), IAggregatorV3(address(new MockAggregator(1000e8))));
        booster.setStockFeed(address(stockB), IAggregatorV3(address(new MockAggregator(1000e8))));

        coat.transfer(alice, 1_000_000 ether);
        coat.transfer(bob, 1_000_000 ether);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
    }

    function _setBasket(address token, uint16 w) internal {
        address[] memory toks = new address[](1);
        uint16[] memory ws = new uint16[](1);
        toks[0] = token;
        ws[0] = w;
        strat.setStrategy(0, toks, ws);
    }

    function _mintActivate(address who) internal returns (uint256 id, address tba) {
        uint256 unit = broker.mintPriceWei();
        vm.recordLogs();
        vm.startPrank(who);
        broker.mint{value: unit}(1);
        Vm.Log[] memory entries = vm.getRecordedLogs();
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i].emitter == address(broker) && entries[i].topics[0] == MINTED_TOPIC) {
                id = uint256(entries[i].topics[2]);
                break;
            }
        }
        require(id != 0, "random mint ID missing");
        coat.approve(address(broker), type(uint256).max);
        broker.activate(id);
        vm.stopPrank();
        tba = broker.accountOf(id);
    }

    // Helper: withdraw an ERC-20 out of a Broker's 6551 wallet via execute (owner-only).
    function _withdrawStock(address who, address tba, MockERC20 token, address to, uint256 amt) internal {
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", to, amt);
        vm.prank(who);
        BrokerAccount(payable(tba)).execute(address(token), 0, data, 0);
    }

    // ---------------------------------------------------------------
    // NOT LOCKED: the full path in and all the way back out
    // ---------------------------------------------------------------

    function test_notLocked_claimThenWithdrawStockFully() public {
        (uint256 id, address tba) = _mintActivate(alice);

        // fees → booster → buy stock
        vm.deal(address(fees), 1 ether);
        fees.flush();
        booster.poke();

        // claim into the wallet
        vm.prank(alice);
        booster.claim(id);
        uint256 got = stockA.balanceOf(tba);
        assertGt(got, 0, "claimed nothing");

        // withdraw ALL of it out to a plain external address → nothing stuck
        _withdrawStock(alice, tba, stockA, alice, got);
        assertEq(stockA.balanceOf(tba), 0, "stock stuck in wallet");
        assertEq(stockA.balanceOf(alice), got, "withdraw did not arrive");
    }

    function test_notLocked_withdrawEthFromWallet() public {
        (, address tba) = _mintActivate(alice);

        // someone sends ETH to the Broker wallet
        vm.deal(address(this), 5 ether);
        (bool ok,) = tba.call{value: 5 ether}("");
        assertTrue(ok);
        assertEq(tba.balance, 5 ether);

        // owner pulls the ETH back out via execute
        uint256 before = alice.balance;
        vm.prank(alice);
        BrokerAccount(payable(tba)).execute(alice, 5 ether, "", 0);
        assertEq(tba.balance, 0, "eth stuck");
        assertEq(alice.balance, before + 5 ether);
    }

    function test_notLocked_droppedBasketTokenStillClaimable() public {
        (uint256 id, address tba) = _mintActivate(alice);

        // accrue stockA
        vm.deal(address(booster), 1 ether);
        booster.poke();

        // basket rotates entirely to stockB; stockA leaves the live basket
        _setBasket(address(stockB), 10000);
        vm.deal(address(booster), 1 ether);
        booster.poke();

        // both the dropped token (A) and the current token (B) are still claimable — not locked
        vm.prank(alice);
        booster.claim(id);
        assertGt(stockA.balanceOf(tba), 0, "dropped-token reward locked");
        assertGt(stockB.balanceOf(tba), 0, "current-token reward missing");
    }

    function test_notLocked_activeBrokerStaysTransferable() public {
        (uint256 id,) = _mintActivate(alice);
        // an active Broker must always be transferable (deactivate runs in the transfer path)
        vm.prank(alice);
        broker.transferFrom(alice, bob, id);
        assertEq(broker.ownerOf(id), bob);
        assertFalse(broker.activated(id));
    }

    function test_notLocked_mintOverpaymentRefunded() public {
        uint256 unit = broker.mintPriceWei();
        vm.deal(alice, 10 ether);
        uint256 before = alice.balance;
        vm.prank(alice);
        broker.mint{value: unit + 3 ether}(1); // overpay by 3 ETH
        // only the unit price leaves alice; the 3 ETH overpay is refunded
        assertEq(alice.balance, before - unit, "overpayment not refunded");
    }

    // ---------------------------------------------------------------
    // NOT STOLEN: only the current owner controls wallet + rewards
    // ---------------------------------------------------------------

    function test_notStolen_strangerCannotExecuteWallet() public {
        (, address tba) = _mintActivate(alice);
        vm.deal(address(this), 1 ether);
        (bool ok,) = tba.call{value: 1 ether}("");
        assertTrue(ok);

        // mallory tries to drain the wallet — must revert
        vm.prank(mallory);
        vm.expectRevert(bytes("Invalid signer"));
        BrokerAccount(payable(tba)).execute(mallory, 1 ether, "", 0);
        assertEq(tba.balance, 1 ether, "wallet drained by stranger");
    }

    function test_notStolen_strangerCannotClaim() public {
        (uint256 id,) = _mintActivate(alice);
        vm.deal(address(booster), 1 ether);
        booster.poke();

        vm.prank(mallory);
        vm.expectRevert(Booster.NotBrokerOwner.selector);
        booster.claim(id);
    }

    function test_notStolen_strangerCannotActivateOthersBroker() public {
        uint256 unit = broker.mintPriceWei();
        vm.recordLogs();
        vm.prank(alice);
        broker.mint{value: unit}(1);
        Vm.Log[] memory entries = vm.getRecordedLogs();
        uint256 id;
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i].emitter == address(broker) && entries[i].topics[0] == MINTED_TOPIC) {
                id = uint256(entries[i].topics[2]);
                break;
            }
        }

        vm.prank(mallory);
        vm.expectRevert(CoattailBroker.NotOwner.selector);
        broker.activate(id);
    }

    function test_notStolen_sellerLosesWalletControlBuyerGainsIt() public {
        (uint256 id, address tba) = _mintActivate(alice);

        // fund + claim so the wallet holds real stock, then sell to bob
        vm.deal(address(booster), 1 ether);
        booster.poke();
        vm.prank(alice);
        booster.claim(id);
        uint256 bal = stockA.balanceOf(tba);
        assertGt(bal, 0);

        vm.prank(alice);
        broker.transferFrom(alice, bob, id);

        // the seller can no longer touch the wallet...
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", alice, bal);
        vm.prank(alice);
        vm.expectRevert(bytes("Invalid signer"));
        BrokerAccount(payable(tba)).execute(address(stockA), 0, data, 0);

        // ...but the buyer fully controls it and can withdraw the stock that came with the NFT
        _withdrawStock(bob, tba, stockA, bob, bal);
        assertEq(stockA.balanceOf(bob), bal, "buyer could not withdraw inherited stock");
        assertEq(stockA.balanceOf(tba), 0);
    }

    function test_notStolen_onlyBrokerContractDrivesShares() public {
        (uint256 id,) = _mintActivate(alice);
        // Booster.activate/deactivate are callable only by the Broker contract, never directly
        vm.prank(mallory);
        vm.expectRevert(Booster.OnlyBrokers.selector);
        booster.activate(id);

        vm.prank(mallory);
        vm.expectRevert(Booster.OnlyBrokers.selector);
        booster.deactivate(id);
    }

    // ---------------------------------------------------------------
    // Conservation: Booster never owes more stock than it holds
    // ---------------------------------------------------------------

    function test_conservation_boosterSolventAcrossManyClaimers() public {
        // Five independent primary minters, multiple pokes, everyone claims.
        address[5] memory owners;
        uint256[5] memory ids;
        for (uint256 i; i < 5; ++i) {
            owners[i] = address(uint160(50_000 + i));
            coat.transfer(owners[i], BURN);
            vm.deal(owners[i], 1 ether);
            (uint256 id,) = _mintActivate(owners[i]);
            ids[i] = id;
        }

        for (uint256 k; k < 3; ++k) {
            vm.deal(address(booster), 1 ether);
            booster.poke();
        }

        uint256 bought = stockA.balanceOf(address(booster));
        uint256 distributed;
        for (uint256 i; i < 5; ++i) {
            address tba = broker.accountOf(ids[i]);
            vm.prank(owners[i]);
            booster.claim(ids[i]);
            distributed += stockA.balanceOf(tba);
        }
        // every claim was covered (no revert) and total out never exceeded total bought
        assertLe(distributed, bought, "distributed more than bought (insolvent)");
        // only rounding dust may remain
        assertLe(stockA.balanceOf(address(booster)), 5, "excessive dust left");
    }
}

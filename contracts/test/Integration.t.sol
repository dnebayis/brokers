// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrokerAccount} from "../src/BrokerAccount.sol";
import {COAT} from "../src/COAT.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";
import {CoattailBroker, IBoosterHook, ICoatBurnable} from "../src/CoattailBroker.sol";
import {Booster} from "../src/Booster.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {IERC6551Registry, IStockRouter, IWETH, IAggregatorV3} from "../src/interfaces/IExternal.sol";
import {TestERC6551Registry, MockWETH, MockERC20, MockRouter, MockAggregator} from "./Mocks.sol";

/// Full-lifecycle proof, wired exactly like script/Deploy.s.sol, using real ERC-6551 wallets
/// (byte-identical registry) + mock venue/feeds: mint → activate → poke → claim (into the
/// NFT's own wallet) → transfer (deactivates, stock stays) → re-activate.
contract IntegrationTest is Test {
    BrokerAccount accountImpl;
    TestERC6551Registry reg6551;
    COAT coat;
    StrategyRegistry strat;
    CoattailBroker broker;
    Booster booster;
    FeeSplitter fees;
    MockWETH weth;
    MockRouter router;
    MockERC20 stock;

    address deployer = address(this);
    address treasury = makeAddr("treasury");
    address buyback = makeAddr("buyback");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant RATE = 2;
    uint256 constant BURN = 36_750 ether;

    function setUp() public {
        // infra + venue mocks
        accountImpl = new BrokerAccount();
        reg6551 = new TestERC6551Registry();
        weth = new MockWETH();
        router = new MockRouter(RATE);
        stock = new MockERC20("Tokenized NVDA", "NVDA");

        // core system (same order as Deploy.s.sol)
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

        // strategy basket: 100% the one stock
        address[] memory toks = new address[](1);
        uint16[] memory w = new uint16[](1);
        toks[0] = address(stock);
        w[0] = 10000;
        strat.setStrategy(0, toks, w);

        // slippage guard: manual ETH/USD + stock feed (fair → passes)
        booster.setEthUsdManual(1000e8);
        booster.setStockFeed(address(stock), IAggregatorV3(address(new MockAggregator(1000e8))));

        // fund the actors
        coat.transfer(alice, 1_000_000 ether);
        coat.transfer(bob, 1_000_000 ether);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
    }

    function test_fullLifecycle() public {
        uint256 unit = broker.mintPriceWei();

        // 1) alice mints 2 Brokers (inactive) — each gets a real 6551 wallet
        vm.prank(alice);
        broker.mint{value: unit * 2}(2);
        uint256[] memory ids = _ownedIds(alice, 2);
        uint256 firstId = ids[0];
        uint256 secondId = ids[1];
        assertEq(broker.totalMinted(), 2);
        assertFalse(broker.activated(firstId));
        address w1 = broker.accountOf(firstId);
        assertGt(w1.code.length, 0); // wallet actually deployed
        assertEq(BrokerAccount(payable(w1)).owner(), alice);

        // 2) alice activates both (burns COAT) → 2 earning shares
        vm.startPrank(alice);
        coat.approve(address(broker), type(uint256).max);
        broker.activate(firstId);
        broker.activate(secondId);
        vm.stopPrank();
        assertEq(booster.activeShares(), 2);
        assertEq(coat.balanceOf(alice), 1_000_000 ether - 2 * BURN);

        // 3) fees arrive via FeeSplitter → 80% to Booster; poke buys stock (guarded swap)
        vm.deal(address(fees), 1 ether);
        fees.flush();
        assertEq(address(booster).balance, 0.8 ether);
        booster.poke();
        assertEq(stock.balanceOf(address(booster)), 0.8 ether * RATE);

        // 4) alice claims Broker 1 → stock lands INSIDE its 6551 wallet
        vm.prank(alice);
        booster.claim(firstId);
        uint256 owed = (0.8 ether * RATE) / 2; // equal split across 2 active
        assertEq(stock.balanceOf(w1), owed);

        // 5) alice sells Broker 1 to bob → auto-deactivates; unclaimed entitlement follows tokenId
        vm.prank(alice);
        broker.transferFrom(alice, bob, firstId);
        assertFalse(broker.activated(firstId));
        assertEq(booster.activeShares(), 1);
        assertEq(stock.balanceOf(w1), owed); // untouched
        assertEq(BrokerAccount(payable(w1)).owner(), bob); // wallet control moved with the NFT

        // 6) bob re-activates Broker 1 (must re-burn COAT) → back to 2 shares
        vm.startPrank(bob);
        coat.approve(address(broker), type(uint256).max);
        broker.activate(firstId);
        vm.stopPrank();
        assertEq(booster.activeShares(), 2);
        assertEq(coat.balanceOf(bob), 1_000_000 ether - BURN);
    }

    function _ownedIds(address expectedOwner, uint256 expected) internal view returns (uint256[] memory ids) {
        ids = new uint256[](expected);
        uint256 found;
        for (uint256 id = 1; id <= broker.MAX_SUPPLY() && found < expected; ++id) {
            try broker.ownerOf(id) returns (address actualOwner) {
                if (actualOwner == expectedOwner) ids[found++] = id;
            } catch {}
        }
        assertEq(found, expected);
    }
}

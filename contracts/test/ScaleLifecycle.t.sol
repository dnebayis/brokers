// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {BrokerAccount} from "../src/BrokerAccount.sol";
import {COAT} from "../src/COAT.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";
import {CoattailBroker, IBoosterHook, ICoatBurnable} from "../src/CoattailBroker.sol";
import {Booster} from "../src/Booster.sol";
import {IERC6551Registry, IStockRouter, IWETH, IAggregatorV3} from "../src/interfaces/IExternal.sol";
import {MockRegistry6551, MockWETH, MockERC20, MockRouter, MockAggregator} from "./Mocks.sol";

/// @notice Full collection/accounting load test: 888 independent primary minters, two
/// pseudo-random IDs each, every activation and permissionless batched reward claim.
contract ScaleLifecycleTest is Test {
    uint256 constant ACTORS = 888;
    uint256 constant SUPPLY = 1_000_000_000 ether;
    uint256 constant BURN = 36_750 ether;

    address poolManager = makeAddr("poolManager");
    address creator = makeAddr("creator");
    COAT coat;
    CoattailBroker broker;
    Booster booster;
    MockERC20 stock;
    uint256[] mintedIds;
    bytes32 constant MINTED_TOPIC = keccak256("Minted(address,uint256,address,uint256)");

    function setUp() public {
        coat = new COAT(address(this), poolManager);
        MockRegistry6551 registry6551 = new MockRegistry6551();
        StrategyRegistry registry = new StrategyRegistry(address(this), address(this));
        registry.createStrategy("The Politician");
        broker = new CoattailBroker(
            address(this), creator, IERC6551Registry(address(registry6551)), address(new BrokerAccount()), ""
        );
        MockWETH weth = new MockWETH();
        booster = new Booster(
            broker, registry, IStockRouter(address(new MockRouter(2))), IWETH(address(weth)), 0, address(this)
        );
        broker.setBooster(IBoosterHook(address(booster)));
        broker.setCoat(ICoatBurnable(address(coat)));
        broker.setMintOpen(true);

        stock = new MockERC20("Stock", "STK");
        address[] memory tokens = new address[](1);
        uint16[] memory weights = new uint16[](1);
        tokens[0] = address(stock);
        weights[0] = 10_000;
        registry.setStrategy(0, tokens, weights);
        booster.setEthUsdManual(2_000e8);
        booster.setStockFeed(address(stock), IAggregatorV3(address(new MockAggregator(2_000e8))));
        booster.setPokeThreshold(1 wei);
    }

    function test_888Actors_1776RandomMintActivateClaim_reconcilesExactly() public {
        coat.transfer(poolManager, SUPPLY);
        coat.enableTrading();
        vm.roll(block.number + 1);

        // Same-block EVM ordering: 888 distinct callers receive enough COAT for two activations.
        for (uint256 i; i < ACTORS; ++i) {
            uint256 shuffled = (i * 137) % ACTORS;
            address actor = address(uint160(10_000 + shuffled));
            vm.prank(poolManager);
            coat.transfer(actor, 2 * BURN);
        }

        uint256 mintPrice = broker.MINT_PRICE();
        for (uint256 i; i < ACTORS; ++i) {
            address actor = address(uint160(10_000 + ((i * 137) % ACTORS)));
            vm.deal(actor, 2 * mintPrice);
            vm.recordLogs();
            vm.prank(actor);
            broker.mint{value: 2 * mintPrice}(2);
            Vm.Log[] memory entries = vm.getRecordedLogs();
            vm.startPrank(actor);
            coat.approve(address(broker), type(uint256).max);
            uint256 actorMints;
            for (uint256 j; j < entries.length; ++j) {
                if (entries[j].emitter == address(broker) && entries[j].topics[0] == MINTED_TOPIC) {
                    uint256 tokenId = uint256(entries[j].topics[2]);
                    mintedIds.push(tokenId);
                    broker.activate(tokenId);
                    ++actorMints;
                }
            }
            vm.stopPrank();
            assertEq(actorMints, 2, "mint receipt missing random IDs");
        }

        assertEq(mintedIds.length, 1_776);
        assertEq(broker.totalMinted(), 1_776);
        assertEq(booster.activeShares(), 1_776);
        assertEq(creator.balance, 2.664 ether);
        assertEq(coat.totalSupply(), SUPPLY - 1_776 * BURN);
        assertEq(coat.balanceOf(poolManager), SUPPLY - 1_776 * BURN);

        bool[] memory seen = new bool[](1_777);
        bool nonMonotonic;
        for (uint256 i; i < mintedIds.length; ++i) {
            uint256 tokenId = mintedIds[i];
            assertTrue(tokenId >= 1 && tokenId <= 1_776, "random ID out of range");
            assertFalse(seen[tokenId], "random ID repeated");
            seen[tokenId] = true;
            if (i > 0 && tokenId < mintedIds[i - 1]) nonMonotonic = true;
        }
        assertTrue(nonMonotonic, "mint order unexpectedly monotonic");
        for (uint256 tokenId = 1; tokenId <= 1_776; ++tokenId) {
            assertTrue(seen[tokenId]);
        }

        vm.deal(address(booster), 1 ether);
        booster.poke();
        uint256 bought = booster.totalBought(address(stock));
        assertEq(bought, 2 ether);

        for (uint256 offset; offset < mintedIds.length; offset += booster.MAX_CLAIM_BATCH()) {
            uint256 length = mintedIds.length - offset;
            if (length > booster.MAX_CLAIM_BATCH()) length = booster.MAX_CLAIM_BATCH();
            uint256[] memory batch = new uint256[](length);
            for (uint256 j; j < length; ++j) {
                batch[j] = mintedIds[offset + j];
            }
            booster.claimBatch(batch);
        }

        uint256 claimed = booster.totalClaimed(address(stock));
        assertEq(stock.balanceOf(address(booster)), bought - claimed, "reward reconciliation mismatch");
        assertLe(bought - claimed, 1_776, "unexpected distribution dust");
    }
}

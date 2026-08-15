// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Booster} from "../src/Booster.sol";
import {CoattailBroker} from "../src/CoattailBroker.sol";
import {StockRouter} from "../src/StockRouter.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";
import {IStockRouter, IWETH} from "../src/interfaces/IExternal.sol";

/// @notice Mainnet-only configuration regression. The real route/liquidity probe lives in
///         ForkStockRoutes.t.sol, including the Arbitrum L1/L2 block-number adaptation required
///         for Rialto Fermi freshness checks under Foundry.
contract ForkMainnetTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    function test_mainnetCannotEnableUnguardedStockSwaps() public {
        if (block.chainid != 4663) {
            if (vm.envOr("REQUIRE_MAINNET_FORK", false)) {
                fail("REQUIRE_MAINNET_FORK=true but Robinhood Chain mainnet fork is not active");
            }
            return;
        }

        StrategyRegistry registry = new StrategyRegistry(address(this), address(this));
        StockRouter stockRouter = new StockRouter(WETH, address(this));
        Booster booster = new Booster(
            CoattailBroker(address(0xB0)),
            registry,
            IStockRouter(address(stockRouter)),
            IWETH(WETH),
            0,
            address(this)
        );

        vm.expectRevert(Booster.UnguardedForbiddenOnMainnet.selector);
        booster.setAllowUnguarded(address(0xA11CE), true);
    }
}

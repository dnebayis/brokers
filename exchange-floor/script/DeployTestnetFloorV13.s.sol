// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BasketRouter, IWETHFloor, IStrategyRegistryFloor, IBoosterFeedFloor} from "../src/BasketRouter.sol";

/// @notice v1.3 testnet refresh: new router (three-currency exits + sweep), pools reused
///         from the funded v1.1 run. Exercises the NEW legs: buy with USDG, and the full
///         basket exit straight into $COAT through the hooked pool.
contract DeployTestnetFloorV13 is Script {
    address constant REGISTRY = 0xd859B6Ea10dd61604b55e8E86Dc4A12C1e1f7Ab3;
    address constant BOOSTER = 0x39e4B20401dc4cA45c0b14800c86Fc3Df953A245;
    address constant WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa;
    address constant TUSDG = 0xca71484e6FA828dc261C7b4e902d3DF47542aDa4;
    address constant TAAPL = 0x44B8DA4948e3Eacb0f2E20a42c694Af49942e5C9;
    address constant TCOAT = 0xD3f44c7DD32D12C7a6776C23c839DEcA8196cf07;
    address constant COAT_ROUTER = 0x5fBCa6b6Dd403659B273Ea7d6d13e6a2e2462123;
    address constant AAPL_POOL = 0xf601F91ae22b6073ecA296b646125800a6E3F565;
    address constant ETH_POOL = 0xB5E31Ee9e75CcAdB354c65db1dc4bd8E7CEb1917;

    function run() external {
        require(block.chainid == 46630, "testnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);

        BasketRouter router = new BasketRouter(
            IERC20(TUSDG),
            IWETHFloor(WETH),
            IStrategyRegistryFloor(REGISTRY),
            IBoosterFeedFloor(BOOSTER),
            0,
            BOOSTER,
            me,
            me
        );
        router.setPool(TAAPL, AAPL_POOL);
        router.setEthPool(ETH_POOL);
        router.setFeedStaleAfter(365 days);
        router.setCoatRoute(TCOAT, COAT_ROUTER);
        console2.log("BasketRouter v1.3", address(router));

        // NEW leg 1: buy the basket with USDG (leftover inventory from earlier funding runs)
        uint256 usdgBal = IERC20(TUSDG).balanceOf(me);
        uint256 usdgIn = usdgBal > 3 ether ? 3 ether : usdgBal;
        require(usdgIn > 0, "no tUSDG inventory");
        IERC20(TUSDG).approve(address(router), usdgIn);
        uint256 aaplBefore = IERC20(TAAPL).balanceOf(me);
        router.buyBasket(0, usdgIn, me, block.timestamp + 600);
        console2.log("buyBasket(USDG) tAAPL delta", IERC20(TAAPL).balanceOf(me) - aaplBefore);

        // top up the position with a small ETH buy so the exit has something to sweep
        router.buyBasketEth{value: 0.001 ether}(0, me, block.timestamp + 600);

        // NEW leg 2: whole-basket exit straight into $COAT
        address[] memory t = new address[](1);
        uint256[] memory a = new uint256[](1);
        t[0] = TAAPL;
        a[0] = 0.02 ether; // explicit amount: the test pool's tUSDG inventory is thin
        IERC20(TAAPL).approve(address(router), type(uint256).max);
        uint256 coatBefore = IERC20(TCOAT).balanceOf(me);
        uint256 coatOut = router.sellBasket(t, a, BasketRouter.OutCurrency.COAT, 0, me, block.timestamp + 600);
        console2.log("sellBasket->COAT out", coatOut);
        require(IERC20(TCOAT).balanceOf(me) - coatBefore == coatOut, "coat must land");

        router.flushFees(0);
        console2.log("fees flushed");
        vm.stopBroadcast();
    }
}

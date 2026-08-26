// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BasketRouter, IWETHFloor, IStrategyRegistryFloor, IBoosterFeedFloor} from "../src/BasketRouter.sol";

/// @notice v1.2 testnet refresh on a thin gas budget: deploys ONLY the new BasketRouter
///         (with buyBasketCoat) and re-points it at the pools the v1.1 run already funded,
///         then exercises the COAT entry end to end.
contract DeployTestnetFloorV12 is Script {
    address constant REGISTRY = 0xd859B6Ea10dd61604b55e8E86Dc4A12C1e1f7Ab3;
    address constant BOOSTER = 0x39e4B20401dc4cA45c0b14800c86Fc3Df953A245;
    address constant WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa;
    address constant TUSDG = 0xca71484e6FA828dc261C7b4e902d3DF47542aDa4;
    address constant TAAPL = 0x44B8DA4948e3Eacb0f2E20a42c694Af49942e5C9;
    address constant TCOAT = 0xD3f44c7DD32D12C7a6776C23c839DEcA8196cf07;
    address constant COAT_ROUTER = 0x5fBCa6b6Dd403659B273Ea7d6d13e6a2e2462123;
    // funded pools from the v1.1 run
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
        console2.log("BasketRouter v1.2", address(router));

        // COAT -> basket, one transaction
        (bool okC,) =
            COAT_ROUTER.call{value: 0.003 ether}(abi.encodeWithSignature("buy(uint256,address)", 0, me));
        require(okC, "coat buy");
        uint256 coatBal = IERC20(TCOAT).balanceOf(me);
        IERC20(TCOAT).approve(address(router), coatBal);
        uint256 before = IERC20(TAAPL).balanceOf(me);
        router.buyBasketCoat(0, coatBal, 0, me, block.timestamp + 600);
        console2.log("coatIn", coatBal);
        console2.log("tAAPL delta", IERC20(TAAPL).balanceOf(me) - before);
        require(IERC20(TAAPL).balanceOf(me) > before, "basket via COAT must land");

        // sellBasket sanity on the fresh router
        address[] memory t = new address[](1);
        uint256[] memory a = new uint256[](1);
        t[0] = TAAPL;
        IERC20(TAAPL).approve(address(router), type(uint256).max);
        uint256 ethOut = router.sellBasket(t, a, BasketRouter.OutCurrency.ETH, 0, me, block.timestamp + 600);
        console2.log("sellBasket ethOut", ethOut);

        router.flushFees(0);
        console2.log("fees flushed to booster");
        vm.stopBroadcast();
    }
}

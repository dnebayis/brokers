// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RialtoLeg, RialtoPokeRunner, IRialtoRouterRegistry, IBoosterPoke} from "../src/RialtoLeg.sol";

/// @notice Mainnet (4663) deploy of the Rialto adapters: one RialtoPokeRunner (owner = deployer,
///         first stager = keeper relay) unless RIALTO_RUNNER is set, then one RialtoLeg per stock
///         in RIALTO_STOCKS (comma-separated addresses). Deploy + log only: nothing routes until
///         the owner calls StockRouter.setRoute(stock, MID_POOL, USDG, leg, PoolKind.Rialto) and,
///         for a new name, Booster.setStockFeed(stock, chainlinkFeed). Those calldata lines are
///         printed at the end so the owner can send them from the owner wallet.
contract DeployRialtoLegs is Script {
    address constant BOOSTER = 0x7bAf435847A4b45c2e22a7fd13549C3192C95953;
    address constant STOCK_ROUTER = 0x99F3f896B58bcb8A515ED3C7174c017B5a55075a;
    address constant KEEPER_RELAY = 0xa492c8fFa033016144B169501D2e428BeDD518CA;
    address constant RIALTO_REGISTRY = 0x71a120CbBf3Ce7cD910a3c50fF77aFc62735687E;
    address constant MID_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function run() external {
        require(block.chainid == 4663, "mainnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address[] memory stocks = vm.envAddress("RIALTO_STOCKS", ",");
        address runnerAddress = vm.envOr("RIALTO_RUNNER", address(0));

        vm.startBroadcast(pk);
        if (runnerAddress == address(0)) {
            RialtoPokeRunner runner = new RialtoPokeRunner(IBoosterPoke(BOOSTER), vm.addr(pk), KEEPER_RELAY);
            runnerAddress = address(runner);
            console2.log("RialtoPokeRunner (mainnet):", runnerAddress);
        } else {
            console2.log("RialtoPokeRunner (existing):", runnerAddress);
        }
        for (uint256 i; i < stocks.length; ++i) {
            RialtoLeg leg = new RialtoLeg(
                USDG, stocks[i], STOCK_ROUTER, runnerAddress, IRialtoRouterRegistry(RIALTO_REGISTRY)
            );
            console2.log("RialtoLeg for", stocks[i], "->", address(leg));
            console2.log(
                "  owner tx: StockRouter.setRoute",
                vm.toString(
                    abi.encodeWithSignature(
                        "setRoute(address,address,address,address,uint8)",
                        stocks[i],
                        MID_POOL,
                        USDG,
                        address(leg),
                        uint8(0)
                    )
                )
            );
        }
        vm.stopBroadcast();
    }
}

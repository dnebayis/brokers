// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ClaimSweeper} from "../src/ClaimSweeper.sol";

/// Deploys the ownerless ClaimSweeper periphery bound to the live Booster.
/// Any funded EOA may deploy — the contract has no owner, holds no funds and
/// takes no approvals, so the deployer key carries no ongoing authority.
contract DeployClaimSweeper is Script {
    function run() external {
        address booster = vm.envAddress("BOOSTER_ADDRESS");
        vm.startBroadcast();
        ClaimSweeper sweeper = new ClaimSweeper(booster);
        vm.stopBroadcast();
        console2.log("ClaimSweeper deployed:", address(sweeper));
        console2.log("bound to Booster:", booster);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {GiftVault, IBrokersGV, IBoosterGV} from "../src/GiftVault.sol";

/// @notice Mainnet (4663) deploy of the GiftVault: deploy + wire only. Nothing moves until
///         an NFT is safe-transferred in and the keeper opens the first round.
///         GIFT_INTERVAL (seconds) defaults to three days.
contract DeployGiftVault is Script {
    address constant BROKERS = 0x1122dB21998707F8c2eD8182734356C947fA5e98;
    address constant BOOSTER = 0x7bAf435847A4b45c2e22a7fd13549C3192C95953;
    address constant KEEPER_RELAY = 0xa492c8fFa033016144B169501D2e428BeDD518CA;

    function run() external {
        require(block.chainid == 4663, "mainnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        uint64 interval = uint64(vm.envOr("GIFT_INTERVAL", uint256(3 days)));
        vm.startBroadcast(pk);
        GiftVault vault =
            new GiftVault(IBrokersGV(BROKERS), IBoosterGV(BOOSTER), KEEPER_RELAY, interval, vm.addr(pk));
        console2.log("GiftVault (mainnet):", address(vault));
        console2.log("interval (s):", interval);
        vm.stopBroadcast();
    }
}

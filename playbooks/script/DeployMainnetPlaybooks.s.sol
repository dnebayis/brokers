// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PlaybookEngine, IBrokersPB, IBoosterPB, IFloorPB} from "../src/PlaybookEngine.sol";

/// @notice Mainnet (4663) deploy of the PlaybookEngine: deploy + wire only, no trading.
///         The panel stays hidden until the launch commit pastes this address into
///         frontend/src/lib/playbooks.ts.
contract DeployMainnetPlaybooks is Script {
    address constant BROKERS = 0x1122dB21998707F8c2eD8182734356C947fA5e98;
    address constant BOOSTER = 0x7bAf435847A4b45c2e22a7fd13549C3192C95953;
    address constant FLOOR = 0x478F22A32663cF37702d65352A7579A73e61FDc7;
    address constant KEEPER_RELAY = 0xa492c8fFa033016144B169501D2e428BeDD518CA;

    function run() external {
        require(block.chainid == 4663, "mainnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        PlaybookEngine engine = new PlaybookEngine(
            IBrokersPB(BROKERS), IBoosterPB(BOOSTER), IFloorPB(FLOOR), KEEPER_RELAY, vm.addr(pk)
        );
        console2.log("PlaybookEngine (mainnet):", address(engine));
        vm.stopBroadcast();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BrokerRenderer, IBrokerState} from "../src/BrokerRenderer.sol";
import {BrokerRendererV2, IBrokerRendererV1} from "../src/BrokerRendererV2.sol";

/// Deploys BrokerRendererV2 pointed at the deployed v1 renderer and mirrors v1's live wiring
/// (broker, stock list) plus the COAT address. It does NOT switch the collection over: that is
/// the owner's separate, reversible `CoattailBroker.setRenderer(v2)` call, made only after the
/// fork parity test has passed against the block the switch will happen at.
///
///   RENDERER_V1=0xB1b6... BROKER_ADDRESS=0x1122... COAT_ADDRESS=0x93a8... \
///   forge script script/DeployRendererV2.s.sol --rpc-url $RPC --private-key $PK --broadcast
contract DeployRendererV2 is Script {
    function run() external {
        address v1Addr = vm.envAddress("RENDERER_V1");
        address brokerAddr = vm.envAddress("BROKER_ADDRESS");
        address coatAddr = vm.envAddress("COAT_ADDRESS");
        BrokerRenderer v1 = BrokerRenderer(v1Addr);

        uint256 n = v1.stockCount();
        address[] memory toks = new address[](n);
        string[] memory syms = new string[](n);
        for (uint256 i; i < n; ++i) {
            toks[i] = v1.stockTokens(i);
            syms[i] = v1.stockSymbols(i);
        }

        vm.startBroadcast();
        address owner = msg.sender;
        BrokerRendererV2 v2 = new BrokerRendererV2(owner, IBrokerRendererV1(v1Addr));
        v2.setBroker(IBrokerState(brokerAddr));
        v2.setStockTokens(toks, syms);
        v2.setCoat(coatAddr);
        vm.stopBroadcast();

        console2.log("BrokerRendererV2:", address(v2));
        console2.log("reads art from v1:", v1Addr);
        console2.log("stock list mirrored, entries:", n);
        console2.log("next (owner, reversible): CoattailBroker.setRenderer(", address(v2), ")");
    }
}

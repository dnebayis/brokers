// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BrokerRenderer, IBrokerState} from "../src/BrokerRenderer.sol";
import {BrokerRendererV4, IBrokerRendererV1} from "../src/BrokerRendererV4.sol";

/// Deploys BrokerRendererV4 pointed at the deployed v1 renderer, mirrors v1's live wiring plus
/// the COAT address, loads the rank plan from contracts/ranks-v4.hex (pipeline/rank_plan.py)
/// in four chunks and locks it behind its keccak256. It does NOT switch the collection over:
/// that is the owner's separate, reversible `CoattailBroker.setRenderer(v4)` call.
///
///   RENDERER_V1=0xB1b6... BROKER_ADDRESS=0x1122... COAT_ADDRESS=0x93a8... \
///   forge script script/DeployRendererV4.s.sol --rpc-url $RPC --private-key $PK --broadcast
contract DeployRendererV4 is Script {
    function run() external {
        address v1Addr = vm.envAddress("RENDERER_V1");
        address brokerAddr = vm.envAddress("BROKER_ADDRESS");
        address coatAddr = vm.envAddress("COAT_ADDRESS");
        BrokerRenderer v1 = BrokerRenderer(v1Addr);

        // forge-lint: disable-next-line(unsafe-cheatcode)
        bytes memory ranks = vm.parseBytes(vm.trim(vm.readFile("ranks-v4.hex")));
        require(ranks.length == 1776 * 2, "rank plan must be 3552 bytes");
        bytes32 planHash = keccak256(ranks);

        uint256 n = v1.stockCount();
        address[] memory toks = new address[](n);
        string[] memory syms = new string[](n);
        for (uint256 i; i < n; ++i) {
            toks[i] = v1.stockTokens(i);
            syms[i] = v1.stockSymbols(i);
        }

        vm.startBroadcast();
        address owner = msg.sender;
        BrokerRendererV4 v4 = new BrokerRendererV4(owner, IBrokerRendererV1(v1Addr));
        v4.setBroker(IBrokerState(brokerAddr));
        v4.setStockTokens(toks, syms);
        v4.setCoat(coatAddr);
        uint256 chunk = 888;
        for (uint256 off; off < ranks.length; off += chunk) {
            uint256 end = off + chunk > ranks.length ? ranks.length : off + chunk;
            bytes memory part = new bytes(end - off);
            for (uint256 i; i < part.length; ++i) {
                part[i] = ranks[off + i];
            }
            v4.appendRanks(part);
        }
        v4.lockRanks(planHash);
        vm.stopBroadcast();

        console2.log("BrokerRendererV4:", address(v4));
        console2.log("reads art from v1:", v1Addr);
        console2.log("stock list mirrored, entries:", n);
        console2.log("rank plan locked, keccak256:");
        console2.logBytes32(planHash);
        console2.log("rank 1 / 2 / 1334:", v4.rankOf(1176), v4.rankOf(405), v4.rankOf(1334));
        console2.log("next (owner, reversible): CoattailBroker.setRenderer(", address(v4), ")");
    }
}

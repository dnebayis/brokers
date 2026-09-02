// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrokerRenderer, IBrokerState} from "../src/BrokerRenderer.sol";
import {BrokerRendererV2, IBrokerRendererV1} from "../src/BrokerRendererV2.sol";

/// Against the DEPLOYED mainnet renderer: v2 pointed at v1 must produce a byte-identical SVG and
/// identical fixed traits for real Brokers, including the rares. Run with
///   forge test --match-contract ForkRendererV2 --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract ForkRendererV2Test is Test {
    address constant V1 = 0xB1b64E0CE411135DfaB728a482b21981B07fAd31;
    address constant BROKER = 0x1122dB21998707F8c2eD8182734356C947fA5e98;
    address constant COAT = 0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833;

    function _onMainnet() internal view returns (bool) {
        if (block.chainid == 4663) return true;
        require(!vm.envOr("REQUIRE_MAINNET_FORK", false), "required RH mainnet fork missing");
        return false;
    }

    /// Everything before `"Status"` is the fixed-trait section; it must match v1 exactly.
    function _fixedPrefix(string memory json) internal pure returns (string memory) {
        uint256 cut = vm.indexOf(json, '{"trait_type":"Status"');
        bytes memory b = bytes(json);
        if (cut == type(uint256).max) cut = b.length;
        bytes memory out = new bytes(cut);
        for (uint256 i; i < cut; ++i) {
            out[i] = b[i];
        }
        return string(out);
    }

    function test_v2MatchesV1ArtAndFixedTraits() public {
        if (!_onMainnet()) return;
        BrokerRenderer v1 = BrokerRenderer(V1);
        BrokerRendererV2 v2 = new BrokerRendererV2(address(this), IBrokerRendererV1(V1));
        // Mirror v1's live wiring so the JSON prefix (name, image, fixed traits) lines up.
        v2.setBroker(IBrokerState(BROKER));
        uint256 n = v1.stockCount();
        address[] memory toks = new address[](n);
        string[] memory syms = new string[](n);
        for (uint256 i; i < n; ++i) {
            toks[i] = v1.stockTokens(i);
            syms[i] = v1.stockSymbols(i);
        }
        v2.setStockTokens(toks, syms);
        v2.setCoat(COAT);

        uint256[24] memory ids = [
            uint256(405),
            1176,
            178,
            311,
            1648,
            1684,
            1,
            2,
            3,
            100,
            250,
            500,
            742,
            777,
            913,
            1000,
            1234,
            1500,
            1600,
            1700,
            1742,
            1775,
            1776,
            12
        ];
        for (uint256 i; i < ids.length; ++i) {
            assertEq(
                keccak256(bytes(v2.renderSVG(ids[i]))), keccak256(bytes(v1.renderSVG(ids[i]))), "svg differs"
            );
            assertEq(
                _fixedPrefix(v2.renderJSON(ids[i])),
                _fixedPrefix(v1.renderJSON(ids[i])),
                "fixed traits differ"
            );
            // v2 never emits a quoted share value
            assertEq(
                vm.indexOf(v2.renderJSON(ids[i]), ' shares","value":"'),
                type(uint256).max,
                "quoted shares leaked"
            );
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrokerRenderer, IBrokerState} from "../src/BrokerRenderer.sol";
import {BrokerRendererV3, IBrokerRendererV1} from "../src/BrokerRendererV3.sol";

/// Against the DEPLOYED mainnet v1 renderer: v3 must draw a byte-identical SVG and its whole
/// `attributes` array must equal exactly v1's fixed-trait section (nothing live inside), for real
/// Brokers including every rare. Run with
///   forge test --match-contract ForkRendererV3 --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract ForkRendererV3Test is Test {
    address constant V1 = 0xB1b64E0CE411135DfaB728a482b21981B07fAd31;
    address constant BROKER = 0x1122dB21998707F8c2eD8182734356C947fA5e98;
    address constant COAT = 0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833;

    function _onMainnet() internal view returns (bool) {
        if (block.chainid == 4663) return true;
        require(!vm.envOr("REQUIRE_MAINNET_FORK", false), "required RH mainnet fork missing");
        return false;
    }

    function _slice(string memory s, uint256 from, uint256 to) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(to - from);
        for (uint256 i; i < to - from; ++i) {
            out[i] = b[from + i];
        }
        return string(out);
    }

    /// v1's attributes up to (not including) the live `Status` entry, closed with `]`.
    function _v1Fixed(string memory json) internal pure returns (string memory) {
        uint256 a = vm.indexOf(json, '"attributes":');
        uint256 cut = vm.indexOf(json, ',{"trait_type":"Status"');
        return string.concat(_slice(json, a, cut), "]");
    }

    /// v3's whole attributes array (everything from `"attributes":` to the `live` object).
    function _v3Attrs(string memory json) internal pure returns (string memory) {
        uint256 a = vm.indexOf(json, '"attributes":');
        uint256 e = vm.indexOf(json, ',"live":');
        return _slice(json, a, e);
    }

    function test_v3MatchesV1ArtAndFixedTraitsOnly() public {
        if (!_onMainnet()) return;
        BrokerRenderer v1 = BrokerRenderer(V1);
        BrokerRendererV3 v3 = new BrokerRendererV3(address(this), IBrokerRendererV1(V1));
        v3.setBroker(IBrokerState(BROKER));
        uint256 n = v1.stockCount();
        address[] memory toks = new address[](n);
        string[] memory syms = new string[](n);
        for (uint256 i; i < n; ++i) {
            toks[i] = v1.stockTokens(i);
            syms[i] = v1.stockSymbols(i);
        }
        v3.setStockTokens(toks, syms);
        v3.setCoat(COAT);

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
                keccak256(bytes(v3.renderSVG(ids[i]))), keccak256(bytes(v1.renderSVG(ids[i]))), "svg differs"
            );
            string memory j = v3.renderJSON(ids[i]);
            assertEq(
                _v3Attrs(j), _v1Fixed(v1.renderJSON(ids[i])), "attributes are not exactly v1's fixed traits"
            );
            assertEq(vm.indexOf(j, "display_type"), type(uint256).max, "numeric attribute leaked");
            assertEq(
                vm.indexOf(j, '"trait_type":"Status"'), type(uint256).max, "status leaked into attributes"
            );
            assertTrue(vm.indexOf(j, '"live":{"status":"') != type(uint256).max, "live object missing");
        }
    }
}

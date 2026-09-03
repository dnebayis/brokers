// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrokerRenderer, IBrokerState} from "../src/BrokerRenderer.sol";
import {BrokerRendererV4, IBrokerRendererV1} from "../src/BrokerRendererV4.sol";

/// Against the DEPLOYED mainnet v1 renderer, with the real rank plan (contracts/ranks-v4.hex):
/// v4 draws a byte-identical SVG, its `attributes` are exactly v1's Type plus the planned band,
/// and every one of v1's fixed traits reappears in the `traits` object. Run with
///   forge test --match-contract ForkRendererV4 --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract ForkRendererV4Test is Test {
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

    function _between(string memory s, string memory a, string memory b)
        internal
        pure
        returns (string memory)
    {
        uint256 x = vm.indexOf(s, a) + bytes(a).length;
        uint256 y = vm.indexOf(_slice(s, x, bytes(s).length), b) + x;
        return _slice(s, x, y);
    }

    function test_v4MatchesV1ArtAndScoresTypePlusBandOnly() public {
        if (!_onMainnet()) return;
        BrokerRenderer v1 = BrokerRenderer(V1);
        BrokerRendererV4 v4 = new BrokerRendererV4(address(this), IBrokerRendererV1(V1));
        v4.setBroker(IBrokerState(BROKER));
        uint256 n = v1.stockCount();
        address[] memory toks = new address[](n);
        string[] memory syms = new string[](n);
        for (uint256 i; i < n; ++i) {
            toks[i] = v1.stockTokens(i);
            syms[i] = v1.stockSymbols(i);
        }
        v4.setStockTokens(toks, syms);
        v4.setCoat(COAT);
        bytes memory ranks = vm.parseBytes(vm.trim(vm.readFile("ranks-v4.hex")));
        assertEq(ranks.length, 3552, "rank plan size");
        v4.appendRanks(ranks);
        v4.lockRanks(keccak256(ranks));

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
            1334,
            1600,
            1700,
            1742,
            1775,
            1776,
            12
        ];
        for (uint256 i; i < ids.length; ++i) {
            assertEq(
                keccak256(bytes(v4.renderSVG(ids[i]))), keccak256(bytes(v1.renderSVG(ids[i]))), "svg differs"
            );
            string memory j1 = v1.renderJSON(ids[i]);
            string memory j4 = v4.renderJSON(ids[i]);
            string memory typeValue = _between(j1, '{"trait_type":"Type","value":"', '"}');
            string memory expected = string.concat(
                '"attributes":[{"trait_type":"Type","value":"',
                typeValue,
                '"},{"trait_type":"Rank band","value":"',
                v4.bandOf(ids[i]),
                '"}],"traits":'
            );
            assertTrue(vm.indexOf(j4, expected) != type(uint256).max, "attributes are not Type + band");
            assertTrue(v4.rankOf(ids[i]) >= 1 && v4.rankOf(ids[i]) <= 1776, "rank out of range");
            // every fixed trait v1 publishes must reappear in v4's traits object
            string memory traits = _between(j4, '"traits":', ',"rank":');
            string[6] memory keys = ["Headwear", "Eyes", "Mouth", "Jewelry", "Face", "Accessory"];
            for (uint256 k; k < keys.length; ++k) {
                string memory probe = string.concat('{"trait_type":"', keys[k], '","value":"');
                if (vm.indexOf(j1, probe) == type(uint256).max) continue;
                string memory value = _between(j1, probe, '"}');
                assertTrue(
                    vm.indexOf(traits, string.concat('"', keys[k], '":"', value, '"')) != type(uint256).max,
                    "fixed trait missing from traits object"
                );
            }
        }
        // the plan's headline order: the two Aliens are ranks 1 and 2
        assertEq(v4.rankOf(1176), 1);
        assertEq(v4.rankOf(405), 2);
        assertEq(v4.bandOf(1334), "373-772");
    }
}

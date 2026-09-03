// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrokerRenderer, IBrokerState} from "../src/BrokerRenderer.sol";
import {BrokerRendererV4, IBrokerRendererV1} from "../src/BrokerRendererV4.sol";
import {MockERC20} from "./Mocks.sol";

contract FakeBrokerStateV4 is IBrokerState {
    mapping(uint256 => bool) public active;
    mapping(uint256 => address) public tba;

    function set(uint256 id, bool a, address t) external {
        active[id] = a;
        tba[id] = t;
    }

    function activated(uint256 id) external view returns (bool) {
        return active[id];
    }

    function accountOf(uint256 id) external view returns (address) {
        return tba[id];
    }
}

/// v4 must draw v1's picture, score only Type + Rank band, and keep the seven art traits
/// readable (description + `traits` object) without them touching the rank.
contract RendererV4Test is Test {
    BrokerRenderer v1;
    BrokerRendererV4 v4;
    FakeBrokerStateV4 state;
    MockERC20 stock;
    MockERC20 coat;
    address owner = makeAddr("owner");
    address wallet = makeAddr("wallet");
    bytes ranks;

    function _bitmap(uint256 seed) internal pure returns (bytes memory b) {
        b = new bytes(200);
        for (uint256 i; i < 200; ++i) {
            b[i] = bytes1(uint8(uint256(keccak256(abi.encode(seed, i)))));
        }
    }

    function _setRank(uint256 id, uint16 r) internal {
        ranks[(id - 1) * 2] = bytes1(uint8(r >> 8));
        ranks[(id - 1) * 2 + 1] = bytes1(uint8(r));
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 i; i < to - from; ++i) {
            out[i] = b[from + i];
        }
    }

    function setUp() public {
        v1 = new BrokerRenderer(owner);
        uint256[] memory ids = new uint256[](3);
        bytes[] memory bms = new bytes[](3);
        bytes8[] memory tr = new bytes8[](3);
        ids[0] = 405;
        ids[1] = 742;
        ids[2] = 1776;
        bms[0] = _bitmap(1);
        bms[1] = _bitmap(2);
        bms[2] = _bitmap(3);
        tr[0] = bytes8(
            abi.encodePacked(uint8(0), uint8(3), uint8(2), uint8(0), uint8(4), uint8(0), uint8(9), uint8(0))
        ); // Alien, Tiara, 3D Glasses, Earring, Eyepatch
        tr[1] = bytes8(
            abi.encodePacked(uint8(4), uint8(0), uint8(0), uint8(4), uint8(0), uint8(0), uint8(0), uint8(0))
        ); // Male, Smile
        tr[2] = bytes8(
            abi.encodePacked(uint8(3), uint8(8), uint8(4), uint8(6), uint8(1), uint8(4), uint8(15), uint8(0))
        );
        vm.prank(owner);
        v1.uploadArt(ids, bms, tr);

        state = new FakeBrokerStateV4();
        stock = new MockERC20("Tokenized INTC", "INTC");
        coat = new MockERC20("COAT", "COAT");
        state.set(405, true, wallet);
        state.set(742, false, wallet);
        state.set(1776, true, makeAddr("empty"));

        v4 = new BrokerRendererV4(owner, IBrokerRendererV1(address(v1)));
        address[] memory toks = new address[](1);
        string[] memory syms = new string[](1);
        toks[0] = address(stock);
        syms[0] = "INTC";
        vm.startPrank(owner);
        v4.setBroker(IBrokerState(address(state)));
        v4.setStockTokens(toks, syms);
        v4.setCoat(address(coat));
        v1.setBroker(IBrokerState(address(state)));
        v1.setStockTokens(toks, syms);
        vm.stopPrank();

        ranks = new bytes(1776 * 2);
        _setRank(405, 2);
        _setRank(742, 1000);
        _setRank(1776, 3);
    }

    function _load() internal {
        vm.startPrank(owner);
        v4.appendRanks(_slice(ranks, 0, 1000));
        v4.appendRanks(_slice(ranks, 1000, 3552));
        v4.lockRanks(keccak256(ranks));
        vm.stopPrank();
    }

    function _attrs(string memory json) internal pure returns (string memory) {
        uint256 a = vm.indexOf(json, '"attributes":');
        uint256 b = vm.indexOf(json, ',"traits":');
        bytes memory src = bytes(json);
        return string(_slice(src, a, b));
    }

    function test_svgIsByteIdentical() public view {
        assertEq(v4.renderSVG(405), v1.renderSVG(405));
        assertEq(v4.renderSVG(742), v1.renderSVG(742));
        assertEq(v4.renderSVG(1776), v1.renderSVG(1776));
    }

    function test_attributesAreTypeAndBandOnly() public {
        _load();
        assertEq(
            _attrs(v4.renderJSON(405)),
            '"attributes":[{"trait_type":"Type","value":"Alien"},{"trait_type":"Rank band","value":"1-2"}]'
        );
        assertEq(
            _attrs(v4.renderJSON(742)),
            '"attributes":[{"trait_type":"Type","value":"Male"},{"trait_type":"Rank band","value":"773-1776"}]'
        );
        assertEq(
            _attrs(v4.renderJSON(1776)),
            '"attributes":[{"trait_type":"Type","value":"Female"},{"trait_type":"Rank band","value":"3-6"}]'
        );
        string memory j = v4.renderJSON(405);
        assertEq(vm.indexOf(j, '"trait_type":"Headwear"'), type(uint256).max, "accessory leaked");
        assertEq(vm.indexOf(j, '"trait_type":"Status"'), type(uint256).max);
        assertEq(vm.indexOf(j, "display_type"), type(uint256).max);
    }

    function test_traitsAndRankStayReadableOutsideAttributes() public {
        _load();
        stock.mint(wallet, 1.23456789 ether);
        coat.mint(wallet, 11_914 ether);
        string memory j = v4.renderJSON(405);
        assertTrue(
            vm.indexOf(
                j,
                "Ride the coattails of smart money. Traits: Headwear Tiara, Eyes 3D Glasses, Jewelry Earring, Accessory Eyepatch. Rank 2 of 1776. Status: Active. Holds 1.2345 INTC. 11914 COAT inside."
            ) != type(uint256).max,
            "description"
        );
        assertTrue(
            vm.indexOf(
                j,
                '"traits":{"Type":"Alien","Headwear":"Tiara","Eyes":"3D Glasses","Jewelry":"Earring","Accessory":"Eyepatch"},"rank":2,"live":{"status":"Active","holdings":[{"symbol":"INTC","shares":1.2345}],"coatInside":11914}'
            ) != type(uint256).max,
            "objects"
        );
        // a single trait reads as one short sentence; the rank sentence follows it
        string memory j2 = v4.renderJSON(742);
        assertTrue(
            vm.indexOf(j2, "smart money. Traits: Mouth Smile. Rank 1000 of 1776. Status: Inactive.")
                != type(uint256).max
        );
        assertTrue(
            vm.indexOf(j2, '"traits":{"Type":"Male","Mouth":"Smile"},"rank":1000') != type(uint256).max
        );
    }

    function test_beforeRanksLoadAttributesAreTypeOnly() public view {
        assertEq(_attrs(v4.renderJSON(405)), '"attributes":[{"trait_type":"Type","value":"Alien"}]');
        assertEq(v4.rankOf(405), 0);
        assertEq(v4.bandOf(405), "");
        assertTrue(vm.indexOf(v4.renderJSON(405), '"rank":0,') != type(uint256).max);
    }

    function test_bandEdges() public {
        uint16[8] memory samples = [1, 2, 3, 6, 7, 22, 23, 1776];
        string[8] memory expected = ["1-2", "1-2", "3-6", "3-6", "7-22", "7-22", "23-72", "773-1776"];
        for (uint256 k; k < samples.length; ++k) {
            _setRank(742, samples[k]);
        }
        // load once with the last sample, then check the pure band mapping through rankOf
        _load();
        assertEq(v4.bandOf(742), expected[7]);
        assertEq(v4.rankOf(742), 1776);
        assertEq(v4.rankOf(1), 0); // a token with no rank in the plan reads as 0
    }

    function test_lockSemantics() public {
        vm.startPrank(owner);
        v4.appendRanks(_slice(ranks, 0, 1000));
        vm.expectRevert(BrokerRendererV4.RanksIncomplete.selector);
        v4.lockRanks(keccak256(ranks));
        v4.appendRanks(_slice(ranks, 1000, 3552));
        vm.expectRevert(BrokerRendererV4.RanksHashMismatch.selector);
        v4.lockRanks(bytes32(uint256(1)));
        v4.lockRanks(keccak256(ranks));
        assertTrue(v4.ranksLocked());
        assertEq(v4.ranksHash(), keccak256(ranks));
        vm.expectRevert(BrokerRendererV4.Locked.selector);
        v4.appendRanks(hex"0001");
        vm.expectRevert(BrokerRendererV4.Locked.selector);
        v4.resetRanks();
        vm.stopPrank();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        v4.appendRanks(hex"0001");
    }

    function test_tooManyRanksAndReset() public {
        vm.startPrank(owner);
        v4.appendRanks(ranks);
        vm.expectRevert(BrokerRendererV4.TooManyRanks.selector);
        v4.appendRanks(hex"0001");
        v4.resetRanks();
        assertEq(v4.ranksLength(), 0);
        vm.stopPrank();
    }

    function test_revertsIfNotUploaded() public {
        vm.expectRevert(abi.encodeWithSelector(BrokerRendererV4.NotUploaded.selector, 7));
        v4.renderJSON(7);
    }
}

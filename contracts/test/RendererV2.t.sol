// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrokerRenderer, IBrokerState} from "../src/BrokerRenderer.sol";
import {BrokerRendererV2, IBrokerRendererV1} from "../src/BrokerRendererV2.sol";
import {MockERC20} from "./Mocks.sol";

contract FakeBrokerState is IBrokerState {
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

/// v2 must draw the same picture and name the same fixed traits as v1; only the live section
/// changes shape (numbers, rounded, dust omitted, COAT inside).
contract RendererV2Test is Test {
    BrokerRenderer v1;
    BrokerRendererV2 v2;
    FakeBrokerState state;
    MockERC20 stock;
    MockERC20 coat;
    address owner = makeAddr("owner");
    address wallet = makeAddr("wallet");

    function _bitmap(uint256 seed) internal pure returns (bytes memory b) {
        b = new bytes(200);
        for (uint256 i; i < 200; ++i) {
            b[i] = bytes1(uint8(uint256(keccak256(abi.encode(seed, i)))));
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

        state = new FakeBrokerState();
        stock = new MockERC20("Tokenized INTC", "INTC");
        coat = new MockERC20("COAT", "COAT");
        state.set(405, true, wallet);
        state.set(742, false, wallet);
        state.set(1776, true, makeAddr("empty"));

        v2 = new BrokerRendererV2(owner, IBrokerRendererV1(address(v1)));
        address[] memory toks = new address[](1);
        string[] memory syms = new string[](1);
        toks[0] = address(stock);
        syms[0] = "INTC";
        vm.startPrank(owner);
        v2.setBroker(IBrokerState(address(state)));
        v2.setStockTokens(toks, syms);
        v2.setCoat(address(coat));
        v1.setBroker(IBrokerState(address(state)));
        v1.setStockTokens(toks, syms);
        vm.stopPrank();
    }

    function test_svgIsByteIdentical() public view {
        assertEq(v2.renderSVG(405), v1.renderSVG(405));
        assertEq(v2.renderSVG(742), v1.renderSVG(742));
        assertEq(v2.renderSVG(1776), v1.renderSVG(1776));
    }

    function test_fixedTraitsIdenticalToV1() public view {
        // With no holdings, both renderers emit exactly Type..Accessory + Status.
        assertEq(v2.renderJSON(1776), v1.renderJSON(1776));
        assertEq(v2.renderJSON(742), v1.renderJSON(742));
    }

    function test_holdingsAreRoundedNumbers() public {
        stock.mint(wallet, 0.00001703183574401 ether); // the exact dust that churned ranks
        string memory j = v2.renderJSON(405);
        // dust below 0.0001 is omitted entirely, and no full-precision string appears
        assertEq(vm.indexOf(j, "0.00001703183574401"), type(uint256).max);
        assertEq(vm.indexOf(j, "INTC shares"), type(uint256).max);

        stock.mint(wallet, 1.23456789 ether);
        j = v2.renderJSON(405);
        assertTrue(
            vm.indexOf(j, '{"display_type":"number","trait_type":"INTC shares","value":1.2345}')
                != type(uint256).max
        );
        // v1 would have printed the full precision as a string trait
        assertTrue(
            vm.indexOf(v1.renderJSON(405), '"INTC shares","value":"1.23458492183574401"') != type(uint256).max
        );
    }

    function test_coatInsideIsWholeNumber() public {
        coat.mint(wallet, 11_914.893617 ether);
        string memory j = v2.renderJSON(405);
        assertTrue(
            vm.indexOf(j, '{"display_type":"number","trait_type":"COAT inside","value":11914}')
                != type(uint256).max
        );
        // below one COAT: omitted
        string memory j2 = v2.renderJSON(1776);
        assertEq(vm.indexOf(j2, "COAT inside"), type(uint256).max);
    }

    function test_statusStaysAStringTrait() public view {
        assertTrue(
            vm.indexOf(v2.renderJSON(405), '{"trait_type":"Status","value":"Active"}') != type(uint256).max
        );
        assertTrue(
            vm.indexOf(v2.renderJSON(742), '{"trait_type":"Status","value":"Inactive"}') != type(uint256).max
        );
    }

    function test_revertsIfNotUploaded() public {
        vm.expectRevert(abi.encodeWithSelector(BrokerRendererV2.NotUploaded.selector, 7));
        v2.renderJSON(7);
    }
}

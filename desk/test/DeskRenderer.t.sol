// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeskRenderer, IDeskEngineView} from "../src/DeskRenderer.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

contract MockEngine {
    mapping(uint256 => uint256) public deployedUsdg;

    function set(uint256 id, uint256 raw) external {
        deployedUsdg[id] = raw;
    }
}

/// The load-bearing suite here is PARITY: the fixtures under test/fixtures are emitted
/// by desk/art/pack_traits.py from the Python reference renderer, and renderSVG must
/// reproduce them byte for byte. If a fixture test fails, the two renderers disagree
/// and the PYTHON side is the spec.
contract DeskRendererTest is Test {
    DeskRenderer internal r;
    address internal ownerAddr = address(0xB055);
    bytes internal blob;
    bytes32 internal commit;

    function setUp() public {
        blob = vm.parseBytes(vm.readFile("art/traits-packed.hex"));
        assertEq(blob.length, 8000, "packed blob length");
        commit = keccak256(blob);
        r = new DeskRenderer(commit, ownerAddr);
    }

    function _upload() internal {
        bytes32[] memory words = new bytes32[](250);
        for (uint256 w; w < 250; ++w) {
            bytes32 word;
            for (uint256 b; b < 32; ++b) {
                word |= bytes32(blob[w * 32 + b]) >> (b * 8);
            }
            words[w] = word;
        }
        vm.startPrank(ownerAddr);
        r.uploadTraits(0, words);
        r.freezeTraits();
        vm.stopPrank();
    }

    function test_freezeRejectsWrongBlob() public {
        bytes32[] memory words = new bytes32[](250); // all zero != commit
        vm.startPrank(ownerAddr);
        r.uploadTraits(0, words);
        vm.expectRevert(DeskRenderer.CommitMismatch.selector);
        r.freezeTraits();
        vm.stopPrank();
    }

    function test_traitsLockAfterFreeze() public {
        _upload();
        bytes32[] memory one = new bytes32[](1);
        vm.prank(ownerAddr);
        vm.expectRevert(DeskRenderer.AlreadyFrozen.selector);
        r.uploadTraits(0, one);
    }

    function test_traitsOfMatchesTable() public {
        _upload();
        // Desk #1 from traits-2000.json: cream oak single-large green-up calculator coffee amber
        uint8[7] memory t1 = r.traitsOf(1);
        assertEq(t1[0], 3); // cream
        assertEq(t1[1], 0); // oak
        assertEq(t1[2], 0); // single-large
        assertEq(t1[3], 0); // green-up
        assertEq(t1[4], 0); // calculator
        assertEq(t1[5], 0); // coffee
        assertEq(t1[6], 3); // amber
        // Desk #24: navy dark dual green-up calculator cat violet
        uint8[7] memory t24 = r.traitsOf(24);
        assertEq(t24[0], 0);
        assertEq(t24[1], 4);
        assertEq(t24[2], 1);
        assertEq(t24[4], 0);
        assertEq(t24[5], 4);
        assertEq(t24[6], 4);
    }

    function test_parityWithPythonReference() public {
        _upload();
        uint256[6] memory ids = [uint256(1), 16, 17, 22, 24, 120];
        for (uint256 i; i < ids.length; ++i) {
            string memory expected =
                vm.readFile(string.concat("test/fixtures/desk-", vm.toString(ids[i]), ".svg"));
            assertEq(r.renderSVG(ids[i]), expected, string.concat("svg parity id ", vm.toString(ids[i])));
        }
    }

    function test_tokenURIShapeAndLiveField() public {
        _upload();
        MockEngine eng = new MockEngine();
        eng.set(1, 123_456_789); // 123.456789 USDG deployed -> rounds to 123
        vm.prank(ownerAddr);
        r.setEngine(IDeskEngineView(address(eng)));
        string memory json = r.renderJSON(1);
        assertTrue(vm.contains(json, '"name":"Desk #1"'), "name");
        assertTrue(vm.contains(json, '{"trait_type":"Wall","value":"cream"}'), "wall trait");
        assertTrue(vm.contains(json, '{"trait_type":"Companion","value":"coffee"}'), "companion trait");
        assertTrue(
            vm.contains(json, '{"display_type":"number","trait_type":"Deployed USDG","value":123}'),
            "live field rounded"
        );
        assertTrue(vm.contains(json, '"image":"data:image/svg+xml;base64,'), "image data url");
        // the wrapped tokenURI is just the base64 of the same body
        assertTrue(vm.contains(r.tokenURI(1), "data:application/json;base64,"), "data url prefix");
    }

    function test_boundsAndFreezeGates() public {
        vm.expectRevert(DeskRenderer.NotFrozen.selector);
        r.traitsOf(1);
        _upload();
        vm.expectRevert(DeskRenderer.BadId.selector);
        r.traitsOf(0);
        vm.expectRevert(DeskRenderer.BadId.selector);
        r.traitsOf(2001);
    }
}

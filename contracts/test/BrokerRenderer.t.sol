// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrokerRenderer} from "../src/BrokerRenderer.sol";

contract BrokerRendererTest is Test {
    BrokerRenderer renderer;
    address owner = makeAddr("owner");

    function setUp() public {
        renderer = new BrokerRenderer(owner);
    }

    function _upload(uint256 id, bytes memory bmp, bytes8 traits) internal {
        uint256[] memory ids = new uint256[](1);
        bytes[] memory bmps = new bytes[](1);
        bytes8[] memory tr = new bytes8[](1);
        ids[0] = id;
        bmps[0] = bmp;
        tr[0] = traits;
        vm.prank(owner);
        renderer.uploadArt(ids, bmps, tr);
    }

    function test_upload_and_flags() public {
        assertFalse(renderer.isUploaded(1));
        bytes memory bmp = new bytes(200);
        _upload(1, bmp, bytes8(0));
        assertTrue(renderer.isUploaded(1));
    }

    function test_upload_rejectsBadLength() public {
        uint256[] memory ids = new uint256[](1);
        bytes[] memory bmps = new bytes[](1);
        bytes8[] memory tr = new bytes8[](1);
        ids[0] = 1;
        bmps[0] = new bytes(199);
        tr[0] = bytes8(0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BrokerRenderer.BadBitmapLength.selector, uint256(199)));
        renderer.uploadArt(ids, bmps, tr);
    }

    function test_onlyOwner_upload() public {
        uint256[] memory ids = new uint256[](1);
        bytes[] memory bmps = new bytes[](1);
        bytes8[] memory tr = new bytes8[](1);
        ids[0] = 1;
        bmps[0] = new bytes(200);
        tr[0] = bytes8(0);
        vm.expectRevert();
        renderer.uploadArt(ids, bmps, tr); // not owner
    }

    function test_svg_hasRectsForInk() public {
        bytes memory bmp = new bytes(200);
        // set the first 8 pixels of row 0 (byte 0 = 0xFF -> a run of 8)
        bmp[0] = 0xFF;
        _upload(1, bmp, bytes8(0));
        string memory svg = renderer.renderSVG(1);
        assertTrue(_contains(svg, "<svg"));
        assertTrue(_contains(svg, "#4E5666")); // ink group
        assertTrue(_contains(svg, 'width="8" height="1"')); // run-length of 8
    }

    function test_tokenURI_isBase64Json() public {
        bytes memory bmp = new bytes(200);
        bmp[50] = 0x81;
        // traits: robot type (2), etc.
        bytes8 traits = bytes8(
            abi.encodePacked(uint8(2), uint8(0), uint8(1), uint8(0), uint8(0), uint8(8), uint8(1), uint8(12))
        );
        _upload(7, bmp, traits);
        string memory uri = renderer.tokenURI(7);
        assertTrue(_startsWith(uri, "data:application/json;base64,"));
    }

    function test_tokenURI_revertsIfNotUploaded() public {
        vm.expectRevert(abi.encodeWithSelector(BrokerRenderer.NotUploaded.selector, uint256(99)));
        renderer.tokenURI(99);
    }

    // --- string helpers ---
    function _startsWith(string memory s, string memory p) internal pure returns (bool) {
        bytes memory bs = bytes(s);
        bytes memory bp = bytes(p);
        if (bs.length < bp.length) return false;
        for (uint256 i; i < bp.length; ++i) {
            if (bs[i] != bp[i]) return false;
        }
        return true;
    }

    function _contains(string memory s, string memory sub) internal pure returns (bool) {
        bytes memory bs = bytes(s);
        bytes memory bsub = bytes(sub);
        if (bsub.length == 0 || bs.length < bsub.length) return false;
        for (uint256 i; i <= bs.length - bsub.length; ++i) {
            bool ok = true;
            for (uint256 j; j < bsub.length; ++j) {
                if (bs[i + j] != bsub[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}

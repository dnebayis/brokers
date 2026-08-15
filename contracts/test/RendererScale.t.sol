// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BrokerRenderer} from "../src/BrokerRenderer.sol";

/// @notice Loads every canonical release payload, uploads in production-sized batches and
/// renders all 1,776 tokenURIs. This catches missing files and ID/payload ordering assumptions.
contract RendererScaleTest is Test {
    uint256 internal constant SUPPLY = 1_776;
    uint256 internal constant BATCH = 5;

    function test_allCanonicalPayloadsUploadAndRender() public {
        BrokerRenderer renderer = new BrokerRenderer(address(this));
        bytes32 uriHash;

        for (uint256 start = 1; start <= SUPPLY; start += BATCH) {
            uint256 length = SUPPLY - start + 1;
            if (length > BATCH) length = BATCH;
            uint256[] memory ids = new uint256[](length);
            bytes[] memory bitmaps = new bytes[](length);
            bytes8[] memory traits = new bytes8[](length);
            for (uint256 i; i < length; ++i) {
                uint256 tokenId = start + i;
                string memory stem = string.concat("../pipeline/collection/", vm.toString(tokenId));
                bytes memory bitmap = vm.readFileBinary(string.concat(stem, ".bin"));
                bytes memory traitBytes = vm.parseBytes(vm.readFile(string.concat(stem, ".traits")));
                assertEq(bitmap.length, 200, "canonical bitmap length");
                assertEq(traitBytes.length, 8, "canonical trait length");
                bytes8 packedTraits;
                assembly {
                    packedTraits := mload(add(traitBytes, 0x20))
                }
                ids[i] = tokenId;
                bitmaps[i] = bitmap;
                traits[i] = packedTraits;
            }
            renderer.uploadArt(ids, bitmaps, traits);
        }

        for (uint256 tokenId = 1; tokenId <= SUPPLY; ++tokenId) {
            assertTrue(renderer.isUploaded(tokenId), "renderer upload gap");
            string memory uri = renderer.tokenURI(tokenId);
            assertGt(bytes(uri).length, 29, "empty tokenURI");
            uriHash = keccak256(abi.encodePacked(uriHash, keccak256(bytes(uri))));
        }
        emit log_named_bytes32("all-token tokenURI hash", uriHash);
    }
}

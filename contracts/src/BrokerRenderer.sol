// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title BrokerRenderer
/// @notice Fully on-chain art for Coattail Brokers. Stores each token's 200-byte
///         40x40 1-bit bitmap + 8-byte trait value, and renders tokenURI as an
///         on-chain SVG (bit=1 -> slate ink, bit=0 -> cream canvas) plus decoded
///         trait attributes. Mirrors pipeline/trait_names.py lookup tables.
/// @dev Art is uploaded in batches (owner) before/at reveal, matching the
///      pipeline's `{id}.bin` + `{id}.traits` outputs.
contract BrokerRenderer is Ownable2Step {
    using Strings for uint256;

    uint256 internal constant W = 40;
    uint256 internal constant H = 40;
    uint256 internal constant BITMAP_BYTES = 200;
    string internal constant FG = "#4E5666"; // slate ink
    string internal constant BG = "#EDE8DE"; // broken-white canvas

    mapping(uint256 tokenId => bytes) public bitmapOf; // 200 bytes each
    mapping(uint256 tokenId => bytes8) public traitsOf;

    // Trait label pools (indices mirror pipeline/trait_names.py + config).
    string[] private _type;
    string[] private _headwear;
    string[] private _eyes;
    string[] private _mouth;
    string[] private _jewelry;
    string[] private _face;
    string[] private _accessory;

    event ArtUploaded(uint256 indexed tokenId);

    error LengthMismatch();
    error BadBitmapLength(uint256 got);
    error NotUploaded(uint256 tokenId);

    constructor(address owner_) Ownable(owner_) {
        _type = ["Alien", "Ape", "Zombie", "Female", "Male"];
        _headwear = [
            "None",
            "Beanie",
            "Pilot Helmet",
            "Tiara",
            "Top Hat",
            "Cowboy Hat",
            "Hoodie",
            "Cap Forward",
            "Bandana"
        ];
        _eyes = ["None", "Welding Goggles", "3D Glasses", "VR", "Classic Shades"];
        _mouth = ["None", "Buck Teeth", "Medical Mask", "Cigarette", "Smile", "Pipe", "Hot Lipstick"];
        _jewelry = ["None", "Choker", "Silver Chain", "Gold Chain", "Earring"];
        _face = ["None", "Spots", "Rosy Cheeks", "Clown Nose", "Mole"];
        _accessory = [
            "None",
            "Headphones",
            "Earbuds",
            "Hair Clip",
            "Small Nose Ring",
            "Headband",
            "Laurel Wreath",
            "Flower Behind Ear",
            "Cheek Bandage",
            "Eyepatch",
            "Round Glasses",
            "Aviator Shades",
            "Neck Scarf",
            "Neck Kerchief",
            "Pendant",
            "Septum Ring"
        ];
    }

    // ---------------------------------------------------------------------
    // Upload (owner) — matches pipeline outputs {id}.bin + {id}.traits
    // ---------------------------------------------------------------------
    function uploadArt(uint256[] calldata tokenIds, bytes[] calldata bitmaps, bytes8[] calldata traits)
        external
        onlyOwner
    {
        if (tokenIds.length != bitmaps.length || tokenIds.length != traits.length) revert LengthMismatch();
        for (uint256 i; i < tokenIds.length; ++i) {
            if (bitmaps[i].length != BITMAP_BYTES) revert BadBitmapLength(bitmaps[i].length);
            bitmapOf[tokenIds[i]] = bitmaps[i];
            traitsOf[tokenIds[i]] = traits[i];
            emit ArtUploaded(tokenIds[i]);
        }
    }

    function isUploaded(uint256 tokenId) public view returns (bool) {
        return bitmapOf[tokenId].length == BITMAP_BYTES;
    }

    // ---------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (!isUploaded(tokenId)) revert NotUploaded(tokenId);
        bytes memory bmp = bitmapOf[tokenId];
        bytes8 t = traitsOf[tokenId];

        string memory svg = _svg(bmp);
        string memory image = string.concat("data:image/svg+xml;base64,", Base64.encode(bytes(svg)));

        string memory json = string.concat(
            '{"name":"Coattail Broker #',
            tokenId.toString(),
            '","description":"A fully on-chain Coattail Broker. Ride the coattails of smart money.",',
            '"image":"',
            image,
            '","attributes":',
            _attributes(t),
            "}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @notice Raw SVG (useful for off-chain preview / debugging).
    function renderSVG(uint256 tokenId) external view returns (string memory) {
        if (!isUploaded(tokenId)) revert NotUploaded(tokenId);
        return _svg(bitmapOf[tokenId]);
    }

    function _pixel(bytes memory bmp, uint256 x, uint256 y) internal pure returns (bool) {
        uint256 idx = y * W + x;
        return (uint8(bmp[idx >> 3]) >> (7 - (idx & 7))) & 1 == 1;
    }

    /// @dev Run-length encodes each row into <rect> spans to keep the SVG compact.
    function _svg(bytes memory bmp) internal pure returns (string memory) {
        bytes memory rects;
        for (uint256 y; y < H; ++y) {
            uint256 x;
            while (x < W) {
                if (_pixel(bmp, x, y)) {
                    uint256 run = 1;
                    while (x + run < W && _pixel(bmp, x + run, y)) ++run;
                    rects = abi.encodePacked(
                        rects,
                        '<rect x="',
                        x.toString(),
                        '" y="',
                        y.toString(),
                        '" width="',
                        run.toString(),
                        '" height="1"/>'
                    );
                    x += run;
                } else {
                    ++x;
                }
            }
        }
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" shape-rendering="crispEdges">',
            '<rect width="40" height="40" fill="',
            BG,
            '"/>',
            '<g fill="',
            FG,
            '">',
            string(rects),
            "</g></svg>"
        );
    }

    function _attributes(bytes8 t) internal view returns (string memory) {
        return string.concat(
            "[",
            _attr("Type", _at(_type, uint8(t[0]))),
            ",",
            _attr("Headwear", _at(_headwear, uint8(t[1]))),
            ",",
            _attr("Eyes", _at(_eyes, uint8(t[2]))),
            ",",
            _attr("Mouth", _at(_mouth, uint8(t[3]))),
            ",",
            _attr("Jewelry", _at(_jewelry, uint8(t[4]))),
            ",",
            _attr("Face", _at(_face, uint8(t[5]))),
            ",",
            _attr("Accessory", _at(_accessory, uint8(t[6]))),
            "]"
        );
    }

    function _attr(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('{"trait_type":"', k, '","value":"', v, '"}');
    }

    function _at(string[] storage pool, uint8 i) internal view returns (string memory) {
        return i < pool.length ? pool[i] : pool[0];
    }
}

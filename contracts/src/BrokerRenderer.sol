// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @dev Live Broker state the metadata reads: activation status and the token's ERC-6551 wallet.
interface IBrokerState {
    function activated(uint256 tokenId) external view returns (bool);
    function accountOf(uint256 tokenId) external view returns (address);
}

/// @dev ERC-8056 tokenized stock read surface: raw balance plus the display multiplier/decimals.
interface IStockToken {
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
    function uiMultiplier() external view returns (uint256);
}

/// @title BrokerRenderer
/// @notice Fully on-chain art + dynamic marketplace metadata for Coattail Brokers. Stores each
///         token's 200-byte 40x40 1-bit bitmap + 8-byte trait value, and renders tokenURI as an
///         on-chain SVG (bit=1 -> slate ink, bit=0 -> cream canvas). The visual traits are fixed;
///         `None` options are omitted from the JSON. On top of the art the metadata reports the
///         Broker's live `Active`/`Inactive` status and the tokenized stocks actually held by its
///         ERC-6551 account — read from `balanceOf(accountOf(tokenId))` over a bounded, owner-set V1
///         stock list, never from a claimable entitlement. Holdings therefore persist across a
///         transfer (they live in the TBA) until the owner withdraws them.
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

    // --- dynamic metadata wiring ---
    // The Broker supplies live activation state + the token's TBA address; the bounded stock list
    // is the ONLY set of tokens tokenURI reads holdings for (no unbounded wallet/registry scan).
    uint256 internal constant MAX_STOCKS = 16;
    IBrokerState public broker;
    address[] public stockTokens;
    string[] public stockSymbols;

    // Trait label pools (indices mirror pipeline/trait_names.py + config).
    string[] private _type;
    string[] private _headwear;
    string[] private _eyes;
    string[] private _mouth;
    string[] private _jewelry;
    string[] private _face;
    string[] private _accessory;

    event ArtUploaded(uint256 indexed tokenId);
    event BrokerSet(address broker);
    event StockTokensSet(uint256 count);

    error LengthMismatch();
    error BadBitmapLength(uint256 got);
    error NotUploaded(uint256 tokenId);
    error TooManyStocks();

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
    // Dynamic-metadata wiring (owner)
    // ---------------------------------------------------------------------
    /// @notice Point the renderer at the Broker so metadata can read live status + TBA address.
    ///         Until set, tokenURI renders the static art/traits only (no Status/holdings).
    function setBroker(IBrokerState b) external onlyOwner {
        broker = b;
        emit BrokerSet(address(b));
    }

    /// @notice Set the bounded, deployment-verified V1 stock list read for holdings, with display
    ///         symbols. Replaces the list wholesale. A universe expansion is an explicit owner action.
    function setStockTokens(address[] calldata tokens, string[] calldata symbols) external onlyOwner {
        if (tokens.length != symbols.length) revert LengthMismatch();
        if (tokens.length > MAX_STOCKS) revert TooManyStocks();
        // Rebuild both lists element-by-element: a nested calldata string[] cannot be assigned to
        // storage wholesale without via-ir, and the deploy pipeline compiles without it.
        delete stockTokens;
        delete stockSymbols;
        for (uint256 i; i < tokens.length; ++i) {
            stockTokens.push(tokens[i]);
            stockSymbols.push(symbols[i]);
        }
        emit StockTokensSet(tokens.length);
    }

    function stockCount() external view returns (uint256) {
        return stockTokens.length;
    }

    // ---------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(_json(tokenId))));
    }

    /// @notice Raw metadata JSON (the same object tokenURI base64-encodes). Useful for off-chain
    ///         schema checks, marketplace debugging and the read-back audit.
    function renderJSON(uint256 tokenId) external view returns (string memory) {
        return _json(tokenId);
    }

    function _json(uint256 tokenId) internal view returns (string memory) {
        if (!isUploaded(tokenId)) revert NotUploaded(tokenId);
        string memory svg = _svg(bitmapOf[tokenId]);
        string memory image = string.concat("data:image/svg+xml;base64,", Base64.encode(bytes(svg)));
        return string.concat(
            '{"name":"Coattail Broker #',
            tokenId.toString(),
            '","description":"A fully on-chain Coattail Broker. Ride the coattails of smart money.",',
            '"image":"',
            image,
            '","attributes":',
            _attributes(tokenId, traitsOf[tokenId]),
            "}"
        );
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

    /// @dev Builds the attributes array. `Type` is always present (index 0 is a real value, "Alien").
    ///      The other visual traits omit their `None` (index 0) option entirely. On top of the fixed
    ///      art it appends live `Status` and one holding entry per non-zero V1 stock in the TBA.
    function _attributes(uint256 tokenId, bytes8 t) internal view returns (string memory) {
        string memory acc = "[";
        bool first = true;

        (acc, first) = _append(acc, first, _attr("Type", _at(_type, uint8(t[0]))));
        (acc, first) = _optional(acc, first, "Headwear", _headwear, uint8(t[1]));
        (acc, first) = _optional(acc, first, "Eyes", _eyes, uint8(t[2]));
        (acc, first) = _optional(acc, first, "Mouth", _mouth, uint8(t[3]));
        (acc, first) = _optional(acc, first, "Jewelry", _jewelry, uint8(t[4]));
        (acc, first) = _optional(acc, first, "Face", _face, uint8(t[5]));
        (acc, first) = _optional(acc, first, "Accessory", _accessory, uint8(t[6]));

        // Dynamic section (only when the Broker is wired): status + live TBA holdings.
        if (address(broker) != address(0)) {
            string memory status = broker.activated(tokenId) ? "Active" : "Inactive";
            (acc, first) = _append(acc, first, _attr("Status", status));

            address tba = broker.accountOf(tokenId);
            uint256 n = stockTokens.length;
            for (uint256 i; i < n; ++i) {
                uint256 bal = IStockToken(stockTokens[i]).balanceOf(tba);
                if (bal == 0) continue;
                (acc, first) = _append(
                    acc,
                    first,
                    _attr(string.concat(stockSymbols[i], " shares"), _formatShares(bal, stockTokens[i]))
                );
            }
        }

        return string.concat(acc, "]");
    }

    /// @dev Append `obj` with the right comma; `first` guards the leading element.
    function _append(string memory acc, bool first, string memory obj)
        internal
        pure
        returns (string memory, bool)
    {
        return (string.concat(acc, first ? "" : ",", obj), false);
    }

    /// @dev A visual trait whose index 0 means "None": omit it entirely at index 0.
    function _optional(string memory acc, bool first, string memory key, string[] storage pool, uint8 i)
        internal
        view
        returns (string memory, bool)
    {
        if (i == 0) return (acc, first); // None → omitted
        return _append(acc, first, _attr(key, _at(pool, i)));
    }

    function _attr(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('{"trait_type":"', k, '","value":"', v, '"}');
    }

    function _at(string[] storage pool, uint8 i) internal view returns (string memory) {
        return i < pool.length ? pool[i] : pool[0];
    }

    /// @dev ERC-8056 display shares: raw · uiMultiplier / 1e18, then rendered with token decimals.
    function _formatShares(uint256 rawBal, address stock) internal view returns (string memory) {
        uint256 mult = IStockToken(stock).uiMultiplier();
        uint8 dec = IStockToken(stock).decimals();
        uint256 display = mult == 0 ? rawBal : (rawBal * mult) / 1e18;
        return _formatUnits(display, dec);
    }

    /// @dev Fixed-point → decimal string with trailing zeros trimmed (e.g. 1_230000000000000000,18 → "1.23").
    function _formatUnits(uint256 amount, uint8 dec) internal pure returns (string memory) {
        if (dec == 0) return amount.toString();
        uint256 base = 10 ** dec;
        uint256 whole = amount / base;
        uint256 frac = amount % base;
        if (frac == 0) return whole.toString();

        bytes memory f = bytes(frac.toString());
        bytes memory padded = new bytes(dec);
        uint256 pad = dec - f.length;
        for (uint256 i; i < pad; ++i) {
            padded[i] = "0";
        }
        for (uint256 i; i < f.length; ++i) {
            padded[pad + i] = f[i];
        }
        uint256 end = dec;
        while (end > 0 && padded[end - 1] == "0") {
            --end;
        }
        bytes memory trimmed = new bytes(end);
        for (uint256 i; i < end; ++i) {
            trimmed[i] = padded[i];
        }
        return string.concat(whole.toString(), ".", string(trimmed));
    }
}

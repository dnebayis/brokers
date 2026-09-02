// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {IBrokerState, IStockToken} from "./BrokerRenderer.sol";

/// @dev The deployed v1 renderer: the collection's art and fixed traits live there and are read,
///      never copied. Only its public getters are used.
interface IBrokerRendererV1 {
    function bitmapOf(uint256 tokenId) external view returns (bytes memory);
    function traitsOf(uint256 tokenId) external view returns (bytes8);
    function isUploaded(uint256 tokenId) external view returns (bool);
}

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

/// @title BrokerRendererV2
/// @notice Same picture, sane metadata. The image is rendered from the v1 renderer's `bitmapOf`
///         with byte-identical SVG code, and the seven fixed art traits are emitted exactly as v1
///         does, so nothing a holder owns changes. What changes is the LIVE section: holdings are
///         emitted as `display_type: number` values rounded to four decimals (rarity engines
///         exclude numeric display attributes by spec), so a Broker's rank no longer tracks the
///         decimal places of its stock balance. `Status` stays a two-value string trait because
///         buyers filter on it. A `COAT inside` number is added for the treasury drops.
contract BrokerRendererV2 is Ownable2Step {
    using Strings for uint256;

    uint256 internal constant W = 40;
    uint256 internal constant H = 40;
    uint256 internal constant BITMAP_BYTES = 200;
    string internal constant FG = "#4E5666"; // slate ink — identical to v1
    string internal constant BG = "#EDE8DE"; // broken-white canvas — identical to v1
    uint256 internal constant MAX_STOCKS = 16;
    uint8 internal constant DISPLAY_DECIMALS = 4;

    IBrokerRendererV1 public immutable v1;
    IBrokerState public broker;
    address public coat;
    address[] public stockTokens;
    string[] public stockSymbols;

    // Trait label pools — identical strings and order to v1's constructor.
    string[] private _type;
    string[] private _headwear;
    string[] private _eyes;
    string[] private _mouth;
    string[] private _jewelry;
    string[] private _face;
    string[] private _accessory;

    event BrokerSet(address broker);
    event CoatSet(address coat);
    event StockTokensSet(uint256 count);

    error NotUploaded(uint256 tokenId);
    error LengthMismatch();
    error TooManyStocks();
    error ZeroAddress();

    constructor(address owner_, IBrokerRendererV1 v1_) Ownable(owner_) {
        if (address(v1_) == address(0)) revert ZeroAddress();
        v1 = v1_;
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
    // Wiring (owner)
    // ---------------------------------------------------------------------
    function setBroker(IBrokerState b) external onlyOwner {
        broker = b;
        emit BrokerSet(address(b));
    }

    function setCoat(address c) external onlyOwner {
        coat = c;
        emit CoatSet(c);
    }

    function setStockTokens(address[] calldata tokens, string[] calldata symbols) external onlyOwner {
        if (tokens.length != symbols.length) revert LengthMismatch();
        if (tokens.length > MAX_STOCKS) revert TooManyStocks();
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
    // Art passthrough
    // ---------------------------------------------------------------------
    function isUploaded(uint256 tokenId) public view returns (bool) {
        return v1.isUploaded(tokenId);
    }

    function bitmapOf(uint256 tokenId) external view returns (bytes memory) {
        return v1.bitmapOf(tokenId);
    }

    function traitsOf(uint256 tokenId) external view returns (bytes8) {
        return v1.traitsOf(tokenId);
    }

    // ---------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(_json(tokenId))));
    }

    function renderJSON(uint256 tokenId) external view returns (string memory) {
        return _json(tokenId);
    }

    function renderSVG(uint256 tokenId) external view returns (string memory) {
        if (!isUploaded(tokenId)) revert NotUploaded(tokenId);
        return _svg(v1.bitmapOf(tokenId));
    }

    function _json(uint256 tokenId) internal view returns (string memory) {
        if (!isUploaded(tokenId)) revert NotUploaded(tokenId);
        string memory svg = _svg(v1.bitmapOf(tokenId));
        string memory image = string.concat("data:image/svg+xml;base64,", Base64.encode(bytes(svg)));
        return string.concat(
            '{"name":"Coattail Broker #',
            tokenId.toString(),
            '","description":"A fully on-chain Coattail Broker. Ride the coattails of smart money.",',
            '"image":"',
            image,
            '","attributes":',
            _attributes(tokenId, v1.traitsOf(tokenId)),
            "}"
        );
    }

    // --- SVG: byte-identical to v1 ---
    function _pixel(bytes memory bmp, uint256 x, uint256 y) internal pure returns (bool) {
        uint256 idx = y * W + x;
        return (uint8(bmp[idx >> 3]) >> (7 - (idx & 7))) & 1 == 1;
    }

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

    // --- Attributes: fixed traits identical to v1; live data as numbers ---
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

        if (address(broker) != address(0)) {
            string memory status = broker.activated(tokenId) ? "Active" : "Inactive";
            (acc, first) = _append(acc, first, _attr("Status", status));

            address tba = broker.accountOf(tokenId);
            uint256 n = stockTokens.length;
            for (uint256 i; i < n; ++i) {
                uint256 bal = IStockToken(stockTokens[i]).balanceOf(tba);
                if (bal == 0) continue;
                string memory shares = _formatShares(bal, stockTokens[i]);
                if (bytes(shares).length == 0) continue; // dust below 0.0001: not shown
                (acc, first) =
                    _append(acc, first, _numAttr(string.concat(stockSymbols[i], " shares"), shares));
            }
            if (coat != address(0)) {
                uint256 cb = _tryBalance(coat, tba);
                if (cb >= 1e18) {
                    (acc, first) = _append(acc, first, _numAttr("COAT inside", (cb / 1e18).toString()));
                }
            }
        }

        return string.concat(acc, "]");
    }

    function _append(string memory acc, bool first, string memory obj)
        internal
        pure
        returns (string memory, bool)
    {
        return (string.concat(acc, first ? "" : ",", obj), false);
    }

    function _optional(string memory acc, bool first, string memory key, string[] storage pool, uint8 i)
        internal
        view
        returns (string memory, bool)
    {
        if (i == 0) return (acc, first);
        return _append(acc, first, _attr(key, _at(pool, i)));
    }

    function _attr(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('{"trait_type":"', k, '","value":"', v, '"}');
    }

    /// @dev A numeric attribute. `display_type: number` is the OpenSea/ERC-721 metadata convention
    ///      that rarity engines skip; the value is an unquoted JSON number.
    function _numAttr(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('{"display_type":"number","trait_type":"', k, '","value":', v, "}");
    }

    function _at(string[] storage pool, uint8 i) internal view returns (string memory) {
        return i < pool.length ? pool[i] : pool[0];
    }

    /// @dev ERC-8056 display shares (raw · uiMultiplier / 1e18 in token decimals), rounded DOWN to
    ///      four decimals. Returns "" when the rounded value is zero so dust is omitted.
    function _formatShares(uint256 rawBal, address stock) internal view returns (string memory) {
        uint256 mult = _tryUint(stock, IStockToken.uiMultiplier.selector, 1e18);
        uint8 dec = uint8(_tryUint(stock, IStockToken.decimals.selector, 18));
        uint256 display = mult == 0 ? rawBal : (rawBal * mult) / 1e18;
        uint256 scaled; // value in units of 10^-DISPLAY_DECIMALS
        if (dec >= DISPLAY_DECIMALS) scaled = display / (10 ** (dec - DISPLAY_DECIMALS));
        else scaled = display * (10 ** (DISPLAY_DECIMALS - dec));
        if (scaled == 0) return "";
        return _formatUnits(scaled, DISPLAY_DECIMALS);
    }

    function _tryUint(address target, bytes4 selector, uint256 fallbackValue)
        internal
        view
        returns (uint256)
    {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSelector(selector));
        if (ok && data.length >= 32) return abi.decode(data, (uint256));
        return fallbackValue;
    }

    function _tryBalance(address token, address account) internal view returns (uint256) {
        (bool ok, bytes memory data) =
            token.staticcall(abi.encodeWithSelector(IERC20Balance.balanceOf.selector, account));
        if (ok && data.length >= 32) return abi.decode(data, (uint256));
        return 0;
    }

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

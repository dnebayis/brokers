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

/// @title BrokerRendererV4
/// @notice Same picture, curated rank. The image is rendered from the v1 renderer's `bitmapOf`
///         with byte-identical SVG code. `attributes` carries exactly two entries: `Type` and a
///         `Rank band`, so the marketplace rarity order follows the collection's own rule (Type
///         first: Alien, Ape, Zombie, Female, Male; inside a type, accessory rarity) instead of a
///         flat sum over seven slots that ranked bare Aliens below accessorised Males. The seven
///         art traits are still published, unchanged, in the description and in a `traits`
///         object; live state stays in the description tail and the `live` object as in v3.
///         Ranks are derived off chain from the on-chain traits (pipeline/rank_plan.py), loaded
///         once by the owner and locked behind a hash: after `lockRanks` nothing can move.
contract BrokerRendererV4 is Ownable2Step {
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

    /// @dev One uint16 per token, big-endian, index = tokenId - 1. Loaded in chunks, then locked.
    bytes private _ranks;
    bool public ranksLocked;
    uint256 internal constant RANKED_SUPPLY = 1776;

    event BrokerSet(address broker);
    event CoatSet(address coat);
    event StockTokensSet(uint256 count);
    event RanksAppended(uint256 totalBytes);
    event RanksReset();
    event RanksLocked(bytes32 hash);

    error NotUploaded(uint256 tokenId);
    error LengthMismatch();
    error TooManyStocks();
    error ZeroAddress();
    error Locked();
    error TooManyRanks();
    error RanksIncomplete();
    error RanksHashMismatch();

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
    // Rank plan (owner, until locked)
    // ---------------------------------------------------------------------
    function appendRanks(bytes calldata chunk) external onlyOwner {
        if (ranksLocked) revert Locked();
        if (_ranks.length + chunk.length > RANKED_SUPPLY * 2) revert TooManyRanks();
        _ranks = bytes.concat(_ranks, chunk);
        emit RanksAppended(_ranks.length);
    }

    function resetRanks() external onlyOwner {
        if (ranksLocked) revert Locked();
        delete _ranks;
        emit RanksReset();
    }

    /// @notice Freeze the plan. The caller states the hash it expects, so a truncated or
    ///         mis-ordered upload can never be locked in by accident.
    function lockRanks(bytes32 expected) external onlyOwner {
        if (ranksLocked) revert Locked();
        if (_ranks.length != RANKED_SUPPLY * 2) revert RanksIncomplete();
        if (keccak256(_ranks) != expected) revert RanksHashMismatch();
        ranksLocked = true;
        emit RanksLocked(expected);
    }

    function ranksHash() external view returns (bytes32) {
        return keccak256(_ranks);
    }

    function ranksLength() external view returns (uint256) {
        return _ranks.length;
    }

    /// @notice 1 = rarest. 0 while the plan is not loaded for this id.
    function rankOf(uint256 tokenId) public view returns (uint256) {
        if (tokenId == 0 || tokenId * 2 > _ranks.length) return 0;
        uint256 i = (tokenId - 1) * 2;
        return (uint256(uint8(_ranks[i])) << 8) | uint256(uint8(_ranks[i + 1]));
    }

    /// @notice The marketplace attribute: bands grow (2, 4, 16, 50, 100, 200, 400, 1004) so an
    ///         information-content score orders them exactly as the plan does.
    function bandOf(uint256 tokenId) public view returns (string memory) {
        uint256 r = rankOf(tokenId);
        if (r == 0) return "";
        uint16[8] memory edges = [2, 6, 22, 72, 172, 372, 772, 1776];
        uint256 lo = 1;
        for (uint256 k; k < edges.length; ++k) {
            if (r <= edges[k]) return string.concat(lo.toString(), "-", uint256(edges[k]).toString());
            lo = edges[k] + 1;
        }
        return "";
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
            '","description":"',
            _description(tokenId),
            '","image":"',
            image,
            '",',
            _tail(tokenId),
            "}"
        );
    }

    /// @dev Description = the v1 sentence, the seven art traits, the rank, then the live tail.
    function _description(uint256 tokenId) internal view returns (string memory) {
        (string memory traitText,) = _traits(v1.traitsOf(tokenId));
        uint256 rank = rankOf(tokenId);
        (string memory liveText,) = _live(tokenId);
        return string.concat(
            "A fully on-chain Coattail Broker. Ride the coattails of smart money.",
            traitText,
            rank == 0 ? "" : string.concat(" Rank ", rank.toString(), " of ", RANKED_SUPPLY.toString(), "."),
            liveText
        );
    }

    /// @dev `attributes` (scored), then `traits`, `rank` and `live` (never scored).
    function _tail(uint256 tokenId) internal view returns (string memory) {
        bytes8 t = v1.traitsOf(tokenId);
        (, string memory traitJson) = _traits(t);
        (, string memory liveJson) = _live(tokenId);
        return string.concat(
            '"attributes":',
            _attributes(t, tokenId),
            ',"traits":',
            traitJson,
            ',"rank":',
            rankOf(tokenId).toString(),
            ',"live":',
            liveJson
        );
    }

    /// @dev Live state rendered twice: as plain text appended to the description (visible on any
    ///      marketplace) and as a structured `live` object (for the site and bots). Neither is
    ///      inside `attributes`, so neither can move a rarity rank.
    function _live(uint256 tokenId) internal view returns (string memory text, string memory json) {
        if (address(broker) == address(0)) return ("", "null");
        bool active = broker.activated(tokenId);
        address tba = broker.accountOf(tokenId);
        text = active ? " Status: Active." : " Status: Inactive.";
        string memory holdings = "[";
        string memory holdText = "";
        bool first = true;
        uint256 n = stockTokens.length;
        for (uint256 i; i < n; ++i) {
            uint256 bal = IStockToken(stockTokens[i]).balanceOf(tba);
            if (bal == 0) continue;
            string memory shares = _formatShares(bal, stockTokens[i]);
            if (bytes(shares).length == 0) continue; // dust below 0.0001: not shown
            holdings = string.concat(
                holdings, first ? "" : ",", '{"symbol":"', stockSymbols[i], '","shares":', shares, "}"
            );
            holdText = string.concat(holdText, first ? " Holds " : ", ", shares, " ", stockSymbols[i]);
            first = false;
        }
        holdings = string.concat(holdings, "]");
        if (!first) text = string.concat(text, holdText, ".");
        uint256 coatWhole = coat == address(0) ? 0 : _tryBalance(coat, tba) / 1e18;
        if (coatWhole > 0) text = string.concat(text, " ", coatWhole.toString(), " COAT inside.");
        json = string.concat(
            '{"status":"',
            active ? "Active" : "Inactive",
            '","holdings":',
            holdings,
            ',"coatInside":',
            coatWhole.toString(),
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

    // --- Attributes: Type + Rank band, nothing else is scored ---
    function _attributes(bytes8 t, uint256 tokenId) internal view returns (string memory) {
        string memory acc = string.concat("[", _attr("Type", _at(_type, uint8(t[0]))));
        string memory band = bandOf(tokenId);
        if (bytes(band).length != 0) acc = string.concat(acc, ",", _attr("Rank band", band));
        return string.concat(acc, "]");
    }

    /// @dev The seven art traits, unchanged from v1, as description text (" Traits: Headwear Top
    ///      Hat, Eyes VR.") and as a `traits` object. Type always; the rest only when present.
    function _traits(bytes8 t) internal view returns (string memory text, string memory json) {
        json = string.concat('{"Type":"', _at(_type, uint8(t[0])), '"');
        for (uint256 slot = 1; slot < 7; ++slot) {
            uint8 i = uint8(t[slot]);
            if (i == 0) continue;
            string memory k = _key(slot);
            string memory v = _value(slot, i);
            text = string.concat(text, bytes(text).length == 0 ? " Traits: " : ", ", k, " ", v);
            json = string.concat(json, ',"', k, '":"', v, '"');
        }
        json = string.concat(json, "}");
        if (bytes(text).length != 0) text = string.concat(text, ".");
    }

    function _key(uint256 slot) internal pure returns (string memory) {
        if (slot == 1) return "Headwear";
        if (slot == 2) return "Eyes";
        if (slot == 3) return "Mouth";
        if (slot == 4) return "Jewelry";
        if (slot == 5) return "Face";
        return "Accessory";
    }

    function _value(uint256 slot, uint8 i) internal view returns (string memory) {
        if (slot == 1) return _at(_headwear, i);
        if (slot == 2) return _at(_eyes, i);
        if (slot == 3) return _at(_mouth, i);
        if (slot == 4) return _at(_jewelry, i);
        if (slot == 5) return _at(_face, i);
        return _at(_accessory, i);
    }

    function _attr(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('{"trait_type":"', k, '","value":"', v, '"}');
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

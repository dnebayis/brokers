// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IDeskEngineView {
    function deployedUsdg(uint256 deskId) external view returns (uint256);
}

/// @title DeskRenderer — fully on-chain art + metadata for The Desk
/// @notice Mechanical Solidity port of desk/art/scene_gen.py (the reference renderer).
///         Every desk is a 40x40 pixel scene composed from seven curated trait axes;
///         the full 2,000-id table is uploaded here and frozen against a keccak
///         commitment published before wave 1, so later waves are provably
///         pre-committed and rarity can never move after mint (the Brokers lesson).
/// @dev Layout rules, palette hexes and SMIL animation timings must match the Python
///      reference EXACTLY — desk/test/fixtures holds byte-for-byte parity fixtures.
///      Live data (deployed capital) is emitted only as display_type:number, which
///      rarity engines ignore.
contract DeskRenderer is Ownable2Step {
    using Strings for uint256;

    // --- trait table: 2000 ids x 4 bytes, 8 ids per word, 250 words ---
    uint256 public constant TOTAL_IDS = 2000;
    uint256 public constant WORDS = 250;

    bytes32 public immutable traitsCommit; // keccak256 of the packed 8000-byte blob
    mapping(uint256 => bytes32) private _words;
    bool public frozen;

    IDeskEngineView public engine; // optional: zero engine simply omits live fields

    event TraitsUploaded(uint256 startWord, uint256 count);
    event TraitsFrozen();
    event EngineSet(address engine);

    error AlreadyFrozen();
    error NotFrozen();
    error BadLength();
    error CommitMismatch();
    error BadId();

    constructor(bytes32 traitsCommit_, address owner_) Ownable(owner_) {
        traitsCommit = traitsCommit_;
    }

    /// @notice Upload the packed trait table in one or more chunks of whole words.
    function uploadTraits(uint256 startWord, bytes32[] calldata words) external onlyOwner {
        if (frozen) revert AlreadyFrozen();
        if (startWord + words.length > WORDS) revert BadLength();
        for (uint256 i; i < words.length; ++i) {
            _words[startWord + i] = words[i];
        }
        emit TraitsUploaded(startWord, words.length);
    }

    /// @notice Freeze the table forever; only succeeds when the stored bytes hash to
    ///         the commitment pinned at deploy time.
    function freezeTraits() external onlyOwner {
        if (frozen) revert AlreadyFrozen();
        bytes memory blob = new bytes(WORDS * 32);
        for (uint256 w; w < WORDS; ++w) {
            bytes32 word = _words[w];
            assembly {
                mstore(add(add(blob, 32), mul(w, 32)), word)
            }
        }
        if (keccak256(blob) != traitsCommit) revert CommitMismatch();
        frozen = true;
        emit TraitsFrozen();
    }

    function setEngine(IDeskEngineView engine_) external onlyOwner {
        engine = engine_;
        emit EngineSet(address(engine_));
    }

    /// @notice The seven axis indices for a desk: wall, wood, screens, chart, gadget,
    ///         companion, accent — exactly the row order of traits-2000.json.
    function traitsOf(uint256 id) public view returns (uint8[7] memory t) {
        if (id == 0 || id > TOTAL_IDS) revert BadId();
        if (!frozen) revert NotFrozen();
        uint256 idx = id - 1;
        bytes32 word = _words[idx / 8];
        uint256 shift = 256 - ((idx % 8) + 1) * 32;
        uint32 packed = uint32(uint256(word) >> shift);
        t[0] = uint8(packed >> 28) & 0xF;
        t[1] = uint8(packed >> 24) & 0xF;
        t[2] = uint8(packed >> 20) & 0xF;
        t[3] = uint8(packed >> 16) & 0xF;
        t[4] = uint8(packed >> 12) & 0xF;
        t[5] = uint8(packed >> 8) & 0xF;
        t[6] = uint8(packed >> 4) & 0xF;
    }

    // --- palette ---
    // 0 base | 1..18 walls (wall,floor per option) | 19..33 woods (lite,mid,dark) |
    // 34 frame 35 screen 36 green 37 red | 38..43 calculator | 44..46 papers |
    // 47 brew 48 steam | 49..51 plant | 52..54 lamp | 55..57 cat | 58..63 accents
    function _palette() private pure returns (string[64] memory p) {
        p[0] = "#1b1d22";
        // walls in axis order: navy teal sage cream lavender grey sand burgundy midnight
        p[1] = "#33506b"; p[2] = "#26374a";
        p[3] = "#2f6360"; p[4] = "#234a48";
        p[5] = "#5d7a4d"; p[6] = "#485e3b";
        p[7] = "#c9b58f"; p[8] = "#a5906c";
        p[9] = "#6b5a7d"; p[10] = "#524561";
        p[11] = "#7d838c"; p[12] = "#5f646c";
        p[13] = "#a3814a"; p[14] = "#7f6438";
        p[15] = "#6e3a3f"; p[16] = "#532b2f";
        p[17] = "#23262d"; p[18] = "#191c22";
        // woods in axis order: oak walnut birch mahogany dark
        p[19] = "#c99a62"; p[20] = "#a87c4a"; p[21] = "#835d34";
        p[22] = "#9a6b45"; p[23] = "#7d5334"; p[24] = "#5d3c24";
        p[25] = "#e0c9a2"; p[26] = "#c4ab82"; p[27] = "#9b845f";
        p[28] = "#8a4a3a"; p[29] = "#6e372b"; p[30] = "#51261d";
        p[31] = "#6b5140"; p[32] = "#4f3a2c"; p[33] = "#38281d";
        p[34] = "#2b2f36"; p[35] = "#0d1b2e"; p[36] = "#43d17c"; p[37] = "#e0564f";
        p[38] = "#b9bdc4"; p[39] = "#7e838b"; p[40] = "#f2c53d"; p[41] = "#a67c1a";
        p[42] = "#1c2620"; p[43] = "#ffe98a";
        p[44] = "#e9ecef"; p[45] = "#f6f8fa"; p[46] = "#a9b0b8";
        p[47] = "#5d4634"; p[48] = "#c9cfd8";
        p[49] = "#57c274"; p[50] = "#2e7a44"; p[51] = "#8a4527";
        p[52] = "#3a3d44"; p[53] = "#caa84a"; p[54] = "#f5e6a8";
        p[55] = "#e8933a"; p[56] = "#b56b21"; p[57] = "#1d232b";
        // accents in axis order: crimson forest azure amber violet mono
        p[58] = "#c94a42"; p[59] = "#3f9d5a"; p[60] = "#4a7fc9";
        p[61] = "#d9a83f"; p[62] = "#8a6fc0"; p[63] = "#8b9099";
    }

    // --- pixel canvas ---

    struct Anim {
        uint8 x;
        uint8 y;
        uint8 color;
        uint8 kind; // 0 tick, 1 steam-a, 2 steam-b, 3 lamp-a, 4 lamp-b, 5 cat-a, 6 cat-b
    }

    struct Scene {
        bytes buf; // 1600 palette indices
        Anim[4] anims;
        uint256 animCount;
    }

    function _put(Scene memory s, uint256 x, uint256 y, uint8 c) private pure {
        if (x < 40 && y < 40) s.buf[y * 40 + x] = bytes1(c);
    }

    function _rect(Scene memory s, uint256 x0, uint256 y0, uint256 x1, uint256 y1, uint8 c) private pure {
        for (uint256 y = y0; y <= y1; ++y) {
            for (uint256 x = x0; x <= x1; ++x) {
                _put(s, x, y, c);
            }
        }
    }

    function _anim(Scene memory s, uint256 x, uint256 y, uint8 color, uint8 kind) private pure {
        s.anims[s.animCount++] = Anim(uint8(x), uint8(y), color, kind);
    }

    // --- furniture (each function mirrors its Python namesake line by line) ---

    function _room(Scene memory s, uint8 wall, uint8 floor) private pure {
        _rect(s, 0, 0, 39, 26, wall);
        _rect(s, 0, 26, 39, 26, 0); // baseboard
        _rect(s, 0, 27, 39, 39, floor);
    }

    function _desk(Scene memory s, uint8 lite, uint8 mid, uint8 dark) private pure {
        _rect(s, 1, 22, 38, 22, lite); // top edge highlight
        _rect(s, 1, 23, 38, 23, mid); // tabletop
        _rect(s, 2, 24, 37, 31, mid); // front panel
        _rect(s, 2, 24, 37, 24, dark); // shadow under top
        _rect(s, 2, 28, 37, 28, dark); // drawer split
        _rect(s, 8, 26, 9, 26, dark); // drawer handles
        _rect(s, 30, 26, 31, 26, dark);
        _rect(s, 8, 30, 9, 30, dark);
        _rect(s, 30, 30, 31, 30, dark);
        _rect(s, 2, 31, 37, 31, dark); // base shadow
        _rect(s, 3, 32, 5, 34, dark); // feet
        _rect(s, 34, 32, 36, 34, dark);
    }

    function _monitor(Scene memory s, uint256 x, uint256 top, uint256 w, uint256 h, bool up) private pure {
        _rect(s, x, top, x + w - 1, top + h + 1, 34);
        _rect(s, x + 1, top + 1, x + w - 2, top + h, 35);
        uint8 ch = up ? 36 : 37;
        uint256 n = w - 4;
        for (uint256 i; i < n; ++i) {
            uint256 rise = (i * (h - 3)) / (n - 1);
            uint256 y = up ? top + h - 1 - rise : top + 2 + rise;
            if (i == n - 1) {
                // live tick: the chart's leading pixel pulses like a fresh candle
                _anim(s, x + 2 + i, y, ch, 0);
            } else {
                _put(s, x + 2 + i, y, ch);
            }
            if (i != 0 && i % 3 == 0) {
                _put(s, x + 2 + i, up ? y + 1 : y - 1, ch); // thicken occasional steps
            }
        }
        uint256 cx = x + w / 2;
        _rect(s, cx - 1, top + h + 2, cx, 20, 34); // stand
        _rect(s, x + 2, 21, x + w - 3, 21, 34); // base
    }

    function _calculator(Scene memory s, uint256 x, bool gold) private pure {
        uint8 body = gold ? 40 : 38;
        uint8 edge = gold ? 41 : 39;
        _rect(s, x, 15, x + 6, 21, body);
        _rect(s, x, 21, x + 6, 21, edge);
        _rect(s, x + 1, 16, x + 5, 17, 42);
        _rect(s, x + 2, 16, x + 2, 16, 36);
        _rect(s, x + 4, 16, x + 5, 16, 36);
        _put(s, x + 1, 19, edge);
        _put(s, x + 3, 19, edge);
        _put(s, x + 5, 19, edge);
        _put(s, x + 1, 20, body);
        _put(s, x + 3, 20, body);
        if (gold) {
            _put(s, x, 15, 43); // glint
            _put(s, x + 6, 15, 43);
        }
    }

    function _papers(Scene memory s, uint256 x, uint8 pen) private pure {
        _rect(s, x, 20, x + 4, 21, 44);
        _rect(s, x, 20, x + 3, 20, 45);
        _put(s, x + 1, 21, 46);
        _put(s, x + 5, 21, pen);
    }

    function _coffee(Scene memory s, uint256 x, uint8 mug) private pure {
        _rect(s, x, 18, x + 2, 21, mug);
        _put(s, x + 3, 19, mug);
        _put(s, x + 1, 18, 47); // brew line
        // rising steam: two pixels drift up and fade, out of phase
        _anim(s, x + 1, 17, 48, 1);
        _anim(s, x + 2, 17, 48, 2);
    }

    function _plant(Scene memory s, uint256 x, uint8 pot) private pure {
        _rect(s, x, 19, x + 3, 21, pot);
        _rect(s, x, 19, x + 3, 19, 51);
        _put(s, x + 1, 18, 59);
        _put(s, x + 2, 18, 59);
        _rect(s, x, 16, x + 1, 17, 59);
        _rect(s, x + 2, 15, x + 3, 17, 59);
        _put(s, x + 1, 14, 49);
        _put(s, x + 3, 14, 50);
    }

    function _lamp(Scene memory s, uint256 x) private pure {
        _rect(s, x, 21, x + 2, 21, 52); // base
        _rect(s, x + 1, 14, x + 1, 20, 52); // pole
        _rect(s, x + 1, 13, x + 4, 13, 53); // arm/shade
        _rect(s, x + 2, 14, x + 4, 14, 53);
        // warm glow, slow breathing flicker
        _anim(s, x + 3, 15, 54, 3);
        _anim(s, x + 4, 15, 54, 4);
    }

    function _cat(Scene memory s, uint256 x) private pure {
        _rect(s, x, 18, x + 4, 21, 55); // body
        _rect(s, x + 3, 15, x + 4, 17, 55); // head (slim)
        _put(s, x + 3, 14, 56); // ears
        _put(s, x + 5, 14, 56);
        _put(s, x + 5, 15, 55); // ear-side cheek
        _put(s, x + 4, 16, 57); // eye
        _put(s, x + 5, 17, 44); // muzzle
        _rect(s, x - 1, 17, x - 1, 21, 56); // tail up
        // tail tip wags between two pixels
        _anim(s, x - 2, 16, 56, 5);
        _anim(s, x - 2, 15, 56, 6);
        _rect(s, x, 21, x + 4, 21, 56); // paws shadow
    }

    // --- composition (mirrors scene_gen.compose) ---

    function _compose(uint8[7] memory t) private pure returns (Scene memory s) {
        s.buf = new bytes(1600);
        uint8 wall = uint8(1 + 2 * t[0]);
        uint8 floor = wall + 1;
        uint8 accent = uint8(58 + t[6]);
        bool up = t[3] == 0;

        _room(s, wall, floor);
        uint8 woodBase = uint8(19 + 3 * t[1]);
        _desk(s, woodBase, woodBase + 1, woodBase + 2);
        // accent drawer handles over the wood-dark defaults
        _rect(s, 8, 26, 9, 26, accent);
        _rect(s, 8, 30, 9, 30, accent);
        _rect(s, 30, 26, 31, 26, accent);
        _rect(s, 30, 30, 31, 30, accent);

        // screens (centered; dual pairs a big and a small)
        if (t[2] == 0) _monitor(s, 5, 8, 14, 10, up);
        else if (t[2] == 1) {
            _monitor(s, 4, 9, 12, 9, up);
            _monitor(s, 17, 12, 9, 6, up);
        } else _monitor(s, 8, 11, 10, 7, up);

        // gadget slot at x=24
        if (t[4] == 0) _calculator(s, 24, false);
        else if (t[4] == 2) _papers(s, 24, accent);
        else if (t[4] == 3) _calculator(s, 24, true);

        // companion slot (cat claims the gadget slot when it is free)
        if (t[5] == 0) _coffee(s, 32, accent);
        else if (t[5] == 1) _plant(s, 31, accent);
        else if (t[5] == 2) _lamp(s, 32);
        else if (t[5] == 4) _cat(s, t[4] == 1 ? 24 : 31);
    }

    // --- SVG emit (row-RLE, BrokerRenderer dialect) ---

    function _animBody(uint8 kind) private pure returns (string memory) {
        if (kind == 0) {
            return '<animate attributeName="opacity" values="1;0.2;1" dur="1.2s" begin="0s" repeatCount="indefinite"/>';
        }
        if (kind == 1) {
            return '<animate attributeName="y" values="17;15;13" dur="2.8s" begin="0s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;0.9;0" dur="2.8s" begin="0s" repeatCount="indefinite"/>';
        }
        if (kind == 2) {
            return '<animate attributeName="y" values="17;15;13" dur="2.8s" begin="1.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;0.7;0" dur="2.8s" begin="1.4s" repeatCount="indefinite"/>';
        }
        if (kind == 3) {
            return '<animate attributeName="opacity" values="1;0.45;1" dur="2.4s" begin="0s" repeatCount="indefinite"/>';
        }
        if (kind == 4) {
            return '<animate attributeName="opacity" values="1;0.45;1" dur="2.4s" begin="0.3s" repeatCount="indefinite"/>';
        }
        if (kind == 5) {
            return '<animate attributeName="opacity" values="1;1;0;0;1" keyTimes="0;0.45;0.5;0.95;1" dur="1.8s" begin="0s" repeatCount="indefinite"/>';
        }
        return '<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.45;0.5;0.95;1" dur="1.8s" begin="0s" repeatCount="indefinite"/>';
    }

    function _svg(Scene memory s) private pure returns (string memory) {
        string[64] memory pal = _palette();
        uint8 base = uint8(s.buf[0]);
        bytes memory rects;
        for (uint256 y; y < 40; ++y) {
            uint256 x;
            while (x < 40) {
                uint8 c = uint8(s.buf[y * 40 + x]);
                uint256 run = 1;
                while (x + run < 40 && uint8(s.buf[y * 40 + x + run]) == c) {
                    ++run;
                }
                if (c != base) {
                    rects = abi.encodePacked(
                        rects,
                        '<rect x="', x.toString(),
                        '" y="', y.toString(),
                        '" width="', run.toString(),
                        '" height="1" fill="', pal[c], '"/>'
                    );
                }
                x += run;
            }
        }
        bytes memory anims;
        for (uint256 i; i < s.animCount; ++i) {
            Anim memory a = s.anims[i];
            anims = abi.encodePacked(
                anims,
                '<rect x="', uint256(a.x).toString(),
                '" y="', uint256(a.y).toString(),
                '" width="1" height="1" fill="', pal[a.color], '">',
                _animBody(a.kind),
                "</rect>"
            );
        }
        return string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" shape-rendering="crispEdges">',
                '<rect width="40" height="40" fill="', pal[base], '"/>',
                rects,
                anims,
                "</svg>"
            )
        );
    }

    // --- metadata ---

    function _axisOption(uint256 axis, uint8 v) private pure returns (string memory) {
        if (axis == 0) {
            string[9] memory o = ["navy", "teal", "sage", "cream", "lavender", "grey", "sand", "burgundy", "midnight"];
            return o[v];
        }
        if (axis == 1) {
            string[5] memory o = ["oak", "walnut", "birch", "mahogany", "dark"];
            return o[v];
        }
        if (axis == 2) {
            string[3] memory o = ["single-large", "dual", "single-small"];
            return o[v];
        }
        if (axis == 3) {
            string[2] memory o = ["green-up", "red-down"];
            return o[v];
        }
        if (axis == 4) {
            string[4] memory o = ["calculator", "none", "papers", "gold-calculator"];
            return o[v];
        }
        if (axis == 5) {
            string[5] memory o = ["coffee", "plant", "lamp", "none", "cat"];
            return o[v];
        }
        string[6] memory a = ["crimson", "forest", "azure", "amber", "violet", "mono"];
        return a[v];
    }

    function _attributes(uint256 id, uint8[7] memory t) private view returns (string memory) {
        string[7] memory names = ["Wall", "Wood", "Screens", "Chart", "Gadget", "Companion", "Accent"];
        bytes memory out;
        for (uint256 a; a < 7; ++a) {
            out = abi.encodePacked(
                out,
                a == 0 ? "" : ",",
                '{"trait_type":"', names[a], '","value":"', _axisOption(a, t[a]), '"}'
            );
        }
        if (address(engine) != address(0)) {
            // LIVE data: display_type number + whole dollars, so rarity engines ignore it
            // and it can never re-rank the fixed traits (the Brokers rarity-churn lesson)
            try engine.deployedUsdg(id) returns (uint256 raw) {
                out = abi.encodePacked(
                    out,
                    ',{"display_type":"number","trait_type":"Deployed USDG","value":',
                    (raw / 1e6).toString(),
                    "}"
                );
            } catch {}
        }
        return string(out);
    }

    function renderSVG(uint256 id) public view returns (string memory) {
        return _svg(_compose(traitsOf(id)));
    }

    /// @notice The raw metadata JSON, un-encoded — same body tokenURI wraps in base64.
    function renderJSON(uint256 id) public view returns (string memory) {
        uint8[7] memory t = traitsOf(id);
        string memory image = string.concat(
            "data:image/svg+xml;base64,", Base64.encode(bytes(_svg(_compose(t))))
        );
        return string.concat(
            '{"name":"Desk #', id.toString(),
            '","description":"A working desk on Robinhood Chain. Deposit USDG and the engine buys the live Congress basket into its own wallet. Visual traits are fixed at mint; the full 2,000-id table was committed on-chain before wave one.",',
            '"image":"', image, '",',
            '"attributes":[', _attributes(id, t), "]}"
        );
    }

    function tokenURI(uint256 id) external view returns (string memory) {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(renderJSON(id))));
    }
}

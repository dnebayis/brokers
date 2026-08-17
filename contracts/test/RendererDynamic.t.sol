// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CoattailBroker, IBoosterHook, ICoatBurnable, IBrokerRenderer} from "../src/CoattailBroker.sol";
import {BrokerRenderer, IBrokerState} from "../src/BrokerRenderer.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";
import {Booster} from "../src/Booster.sol";
import {COAT} from "../src/COAT.sol";
import {IERC6551Registry, IStockRouter, IWETH} from "../src/interfaces/IExternal.sol";
import {MockRegistry6551, MockWETH, MockERC20, MockRouter} from "./Mocks.sol";

/// Dynamic marketplace metadata: None-trait omission, live Active/Inactive status, TBA holdings
/// (never claimable), holdings persisting across transfer, ERC-4906 refresh signalling, and the
/// #742-style full lifecycle acceptance (inactive → active → accrue → claim → hold → withdraw →
/// transfer → reactivate).
contract RendererDynamicTest is Test {
    CoattailBroker broker;
    BrokerRenderer renderer;
    StrategyRegistry registry;
    Booster booster;
    COAT coat;
    MockRegistry6551 accReg;
    MockWETH weth;
    MockERC20 stock;
    MockRouter router;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address user = makeAddr("user");
    uint256 constant RATE = 2;
    uint256 constant BURN = 36_750 ether;

    // EIP-4906
    event MetadataUpdate(uint256 _tokenId);

    function setUp() public {
        accReg = new MockRegistry6551();
        broker = new CoattailBroker(owner, treasury, IERC6551Registry(address(accReg)), makeAddr("impl"), "");
        renderer = new BrokerRenderer(owner);

        registry = new StrategyRegistry(owner, owner);
        vm.prank(owner);
        registry.createStrategy("The Politician");
        stock = new MockERC20("Tokenized AAPL", "AAPL");
        address[] memory tks = new address[](1);
        uint16[] memory wts = new uint16[](1);
        tks[0] = address(stock);
        wts[0] = 10000;
        vm.prank(owner);
        registry.setStrategy(0, tks, wts);

        weth = new MockWETH();
        router = new MockRouter(RATE);
        booster = new Booster(broker, registry, IStockRouter(address(router)), IWETH(address(weth)), 0, owner);
        coat = new COAT(owner, makeAddr("pm"));

        // wire renderer for dynamic metadata
        address[] memory stkAddrs = new address[](1);
        string[] memory stkSyms = new string[](1);
        stkAddrs[0] = address(stock);
        stkSyms[0] = "AAPL";
        vm.startPrank(owner);
        renderer.setBroker(IBrokerState(address(broker)));
        renderer.setStockTokens(stkAddrs, stkSyms);
        broker.setRenderer(IBrokerRenderer(address(renderer)));
        broker.setBooster(IBoosterHook(address(booster)));
        broker.setCoat(ICoatBurnable(address(coat)));
        broker.setMintOpen(true);
        booster.setAllowUnguarded(address(stock), true);
        coat.transfer(user, 1_000_000 ether);
        vm.stopPrank();
    }

    // --- None omission (no mint needed; renderJSON reads any uploaded id) ---
    function test_omitsNoneTraitsAndKeepsType() public {
        uint256 id = 742;
        // Type=Male(4), Headwear=None(0), Eyes=3D Glasses(2), Mouth=None(0), Jewelry=None(0),
        // Face=None(0), Accessory=Headphones(1).
        _upload(id, bytes8(0x0400020000000100));

        string memory json = renderer.renderJSON(id);
        assertTrue(_has(json, '"trait_type":"Type","value":"Male"'), "Type present");
        assertTrue(_has(json, '"trait_type":"Eyes","value":"3D Glasses"'), "Eyes present");
        assertTrue(_has(json, '"trait_type":"Accessory","value":"Headphones"'), "Accessory present");
        // Omitted None traits must be entirely absent.
        assertFalse(_has(json, '"value":"None"'), "no None value anywhere");
        assertFalse(_has(json, '"trait_type":"Headwear"'), "Headwear omitted");
        assertFalse(_has(json, '"trait_type":"Mouth"'), "Mouth omitted");
        assertFalse(_has(json, '"trait_type":"Jewelry"'), "Jewelry omitted");
        assertFalse(_has(json, '"trait_type":"Face"'), "Face omitted");
    }

    function test_supportsERC4906() public view {
        assertTrue(broker.supportsInterface(0x49064906));
    }

    // --- holdings formatting straight from the TBA balance ---
    function test_holdingsFormatFromTbaBalance() public {
        uint256 id = _mintOne();
        _upload(id, bytes8(0x0400000000000000)); // Male only
        address tba = broker.accountOf(id);

        // no balance → no holding attribute
        assertFalse(_has(renderer.renderJSON(id), "AAPL shares"), "no holding when empty");

        stock.mint(tba, 1.5 ether); // 1.5 shares (decimals 18, uiMultiplier 1e18)
        assertTrue(_has(renderer.renderJSON(id), '"trait_type":"AAPL shares","value":"1.5"'), "1.5 shares");

        // ERC-8056 uiMultiplier doubles the display balance.
        stock.setUiMultiplier(2e18);
        assertTrue(_has(renderer.renderJSON(id), '"trait_type":"AAPL shares","value":"3"'), "doubled by mult");
    }

    // --- full #742-style lifecycle on a live minted token ---
    function test_fullLifecycle_statusHoldingsAnd4906() public {
        uint256 id = _mintOne();
        _upload(id, bytes8(0x0400020000000100));

        // 1) Inactive at mint.
        assertTrue(_has(renderer.renderJSON(id), '"trait_type":"Status","value":"Inactive"'));
        assertFalse(_has(renderer.renderJSON(id), "AAPL shares"));

        // 2) Activate → status Active + ERC-4906.
        vm.prank(user);
        coat.approve(address(broker), type(uint256).max);
        vm.expectEmit(true, true, true, true, address(broker));
        emit MetadataUpdate(id);
        vm.prank(user);
        broker.activate(id);
        assertTrue(_has(renderer.renderJSON(id), '"trait_type":"Status","value":"Active"'));

        // 3) Accrue (poke) — claimable grows but the TBA is still empty, so NO holding shows yet.
        vm.deal(address(booster), 1 ether);
        booster.poke();
        (, uint256[] memory amts) = booster.claimable(id);
        assertGt(amts[0], 0, "claimable accrued");
        assertFalse(_has(renderer.renderJSON(id), "AAPL shares"), "claimable is not a holding");

        // 4) Claim → holding appears + ERC-4906 from the Booster path.
        address tba = broker.accountOf(id);
        vm.expectEmit(true, true, true, true, address(broker));
        emit MetadataUpdate(id);
        vm.prank(user);
        booster.claim(id);
        uint256 held = stock.balanceOf(tba);
        assertGt(held, 0, "stock in TBA");
        assertTrue(_has(renderer.renderJSON(id), "AAPL shares"), "holding shown after claim");

        // 5) Transfer → status flips to Inactive but the holding stays in the TBA.
        address buyer = makeAddr("buyer");
        vm.prank(user);
        broker.transferFrom(user, buyer, id);
        assertTrue(
            _has(renderer.renderJSON(id), '"trait_type":"Status","value":"Inactive"'), "inactive after xfer"
        );
        assertTrue(_has(renderer.renderJSON(id), "AAPL shares"), "holding persists across transfer");
        assertEq(stock.balanceOf(tba), held, "TBA balance unchanged by transfer");

        // 6) Withdraw from the TBA → holding disappears; owner signals a refresh.
        vm.prank(tba);
        stock.transfer(buyer, held);
        assertFalse(_has(renderer.renderJSON(id), "AAPL shares"), "holding gone after withdrawal");
        vm.expectEmit(true, true, true, true, address(broker));
        emit MetadataUpdate(id);
        vm.prank(buyer);
        broker.refreshMetadata(id);

        // 7) Reactivate → status Active again.
        vm.startPrank(owner);
        coat.transfer(buyer, 100_000 ether);
        vm.stopPrank();
        vm.prank(buyer);
        coat.approve(address(broker), type(uint256).max);
        vm.prank(buyer);
        broker.activate(id);
        assertTrue(_has(renderer.renderJSON(id), '"trait_type":"Status","value":"Active"'), "active again");
        // No response ever carried a None attribute.
        assertFalse(_has(renderer.renderJSON(id), '"value":"None"'));
    }

    // Representative size/shape guard: a holdings-laden tokenURI renders a valid, bounded payload.
    // (Absolute gas is checked by the normal `forge test` gas report, not asserted here — a
    // gasleft() bound is unreliable under `forge coverage` instrumentation.) The full 1,776-ID
    // on-chain read-back runs against the deployed renderer post-upload, via renderer_readback_audit.py.
    function test_tokenURI_validShapeWithHoldings() public {
        uint256 id = _mintOne();
        _upload(id, bytes8(0x0400020000000100));
        address tba = broker.accountOf(id);
        stock.mint(tba, 1.25 ether);

        string memory uri = broker.tokenURI(id);
        assertTrue(_has(uri, "data:application/json;base64,"), "data URI prefix");
        assertGt(bytes(uri).length, 200, "non-trivial payload");
        assertLt(bytes(uri).length, 20_000, "payload bounded"); // no unbounded growth

        // JSON schema spot-checks on the raw object.
        string memory json = renderer.renderJSON(id);
        assertTrue(_has(json, '"name":"Coattail Broker #'), "name field");
        assertTrue(_has(json, '"image":"data:image/svg+xml;base64,'), "image field");
        assertTrue(_has(json, '"attributes":['), "attributes array");
        assertTrue(_has(json, '"trait_type":"Status"'), "status attr");
    }

    // A stock token that lacks uiMultiplier()/decimals() (or reverts) must NOT brick tokenURI.
    function test_holdingRendersEvenIfTokenLacksUiMultiplier() public {
        NoMultiplierStock bad = new NoMultiplierStock();
        address[] memory tks = new address[](1);
        string[] memory syms = new string[](1);
        tks[0] = address(bad);
        syms[0] = "BAD";
        vm.prank(owner);
        renderer.setStockTokens(tks, syms);

        uint256 id = _mintOne();
        _upload(id, bytes8(0x0400000000000000));
        address tba = broker.accountOf(id);
        bad.mint(tba, 2e18); // 18-decimal default, no uiMultiplier → shows "2"

        string memory json = renderer.renderJSON(id); // must not revert
        assertTrue(_has(json, '"trait_type":"BAD shares","value":"2"'), "renders with 1e18 fallback");
    }

    function test_refreshMetadata_onlyAuthorized() public {
        uint256 id = _mintOne();
        _upload(id, bytes8(0x0400000000000000));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(CoattailBroker.NotAuthorizedRefresh.selector);
        broker.refreshMetadata(id);
        // owner is authorized
        vm.prank(user);
        broker.refreshMetadata(id);
    }

    // --- helpers ---
    function _mintOne() internal returns (uint256 id) {
        uint256 unit = broker.mintPriceWei();
        vm.deal(user, 1 ether);
        vm.prank(user);
        broker.mint{value: unit}(1);
        for (uint256 t = 1; t <= broker.MAX_SUPPLY(); ++t) {
            try broker.ownerOf(t) returns (address o) {
                if (o == user) return t;
            } catch {}
        }
        revert("no minted id");
    }

    function _upload(uint256 id, bytes8 traits) internal {
        uint256[] memory ids = new uint256[](1);
        bytes[] memory bmps = new bytes[](1);
        bytes8[] memory tr = new bytes8[](1);
        ids[0] = id;
        bytes memory bmp = new bytes(200);
        bmp[100] = 0xFF;
        bmps[0] = bmp;
        tr[0] = traits;
        vm.prank(owner);
        renderer.uploadArt(ids, bmps, tr);
    }

    function _has(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return n.length == 0;
        for (uint256 i = 0; i <= h.length - n.length; ++i) {
            bool ok = true;
            for (uint256 j = 0; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}

// A minimal stock token that implements balanceOf + decimals but NOT uiMultiplier() — the renderer
// must fall back gracefully instead of reverting the whole tokenURI.
contract NoMultiplierStock {
    mapping(address => uint256) public balanceOf;

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }
}

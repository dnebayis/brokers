// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    BasketRouter,
    IWETHFloor,
    IStrategyRegistryFloor,
    IBoosterFeedFloor,
    IAggregatorV3Floor
} from "../src/BasketRouter.sol";
import {
    Token,
    MockWETH,
    MockV3Pool,
    MockCoatRouter,
    MockFeed,
    MockBoosterFeeds,
    MockRegistryStrat,
    ICallback
} from "./BasketRouter.t.sol";

/// A feed whose answer and age can be set.
contract MockFeedAt {
    int256 public answer;
    uint256 public updatedAt;

    constructor(int256 a) {
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 at) external {
        (answer, updatedAt) = (a, at);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

/// Takes only half the input (a pool that runs out of range) and pays for that half.
contract PartialPool {
    address public token0;
    address public token1;

    constructor(address t0, address t1) {
        (token0, token1) = (t0, t1);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 half = uint256(amountSpecified) / 2;
        uint256 out = half * 1e10; // the same 1 USDG -> 0.01e18 as the INTC pool
        if (zeroForOne) {
            (amount0, amount1) = (int256(half), -int256(out));
            IERC20(token1).transfer(recipient, out);
        } else {
            (amount0, amount1) = (-int256(out), int256(half));
            IERC20(token0).transfer(recipient, out);
        }
        ICallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

/// Reports a fair output but sends only half of it.
contract LyingPool {
    address public token0;
    address public token1;

    constructor(address t0, address t1) {
        (token0, token1) = (t0, t1);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amtIn = uint256(amountSpecified);
        uint256 out = amtIn * 1e10;
        (amount0, amount1) = zeroForOne ? (int256(amtIn), -int256(out)) : (-int256(out), int256(amtIn));
        IERC20(zeroForOne ? token1 : token0).transfer(recipient, out / 2);
        ICallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

/// Claims to pay twice the ETH it sends.
contract BraggingCoatRouter {
    IERC20 public coat;
    uint256 public weiPerCoat;

    constructor(IERC20 c, uint256 rate) payable {
        (coat, weiPerCoat) = (c, rate);
    }

    function sell(uint256 coatIn, uint256, address to) external returns (uint256 out) {
        coat.transferFrom(msg.sender, address(this), coatIn);
        out = (coatIn * weiPerCoat) / 1e18;
        (bool ok,) = to.call{value: out}("");
        require(ok, "eth");
        return out * 2;
    }
}

contract RefusesEth {}

/// Shape of the Playbooks engine: pulls every stock from a wallet, approves the router, sells
/// the lot into `dest`. Nothing may stay here afterwards.
contract EngineLike {
    function run(BasketRouter r, address[] calldata tokens, address from, address dest)
        external
        returns (uint256 out)
    {
        uint256[] memory amounts = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            amounts[i] = IERC20(tokens[i]).balanceOf(from);
            IERC20(tokens[i]).transferFrom(from, address(this), amounts[i]);
            IERC20(tokens[i]).approve(address(r), amounts[i]);
        }
        out = r.sellBasket(tokens, amounts, BasketRouter.OutCurrency.USDG, 0, dest, block.timestamp + 300);
    }
}

contract BasketRouterV2Test is Test {
    Token usdg;
    Token intc; // $100
    Token spcx; // $200
    Token rklb; // has a Booster feed, no pool here (a Rialto-only name)
    MockWETH wethT; // $2500
    MockV3Pool intcPool;
    MockV3Pool spcxPool;
    MockV3Pool ethPool;
    MockBoosterFeeds feeds;
    MockRegistryStrat strat;
    MockFeedAt ethFeed;
    BasketRouter router;

    address ownerA = address(0xA11CE);
    address boosterSink = address(0xB005);
    address treasury = address(0x7EA5);
    address alice = address(0xAA);
    address bob = address(0xB0B);
    uint256 constant U = 1e6;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new Token("USDG", 6);
        intc = new Token("INTC", 18);
        spcx = new Token("SPCX", 18);
        rklb = new Token("RKLB", 18);
        wethT = new MockWETH();
        feeds = new MockBoosterFeeds();
        strat = new MockRegistryStrat();
        router = new BasketRouter(
            IERC20(address(usdg)),
            IWETHFloor(address(wethT)),
            IStrategyRegistryFloor(address(strat)),
            IBoosterFeedFloor(address(feeds)),
            0,
            boosterSink,
            treasury,
            ownerA
        );
        intcPool = new MockV3Pool(address(usdg), address(intc), 1e10, 1);
        spcxPool = new MockV3Pool(address(usdg), address(spcx), 5e9, 1);
        ethPool = new MockV3Pool(address(usdg), address(wethT), 4e8, 1);
        intc.transfer(address(intcPool), 1e6 ether);
        spcx.transfer(address(spcxPool), 1e6 ether);
        wethT.transfer(address(ethPool), 1e5 ether);
        usdg.transfer(address(intcPool), 1e8 * U);
        usdg.transfer(address(spcxPool), 1e8 * U);
        usdg.transfer(address(ethPool), 1e8 * U);
        vm.deal(address(wethT), 1e6 ether);

        feeds.set(address(intc), address(new MockFeed(100e8)));
        feeds.set(address(spcx), address(new MockFeed(200e8)));
        feeds.set(address(rklb), address(new MockFeed(20e8)));
        ethFeed = new MockFeedAt(2500e8);

        vm.startPrank(ownerA);
        router.setPool(address(intc), address(intcPool));
        router.setPool(address(spcx), address(spcxPool));
        router.setEthPool(address(ethPool));
        router.setEthUsdFeed(IAggregatorV3Floor(address(ethFeed)), 30 hours);
        vm.stopPrank();

        _basket3(5000, 3000, 2000); // INTC 50, RKLB 30 (unrouted), SPCX 20

        usdg.transfer(alice, 1e7 * U);
        rklb.transfer(alice, 1000 ether);
        vm.deal(alice, 100 ether);
        vm.startPrank(alice);
        usdg.approve(address(router), type(uint256).max);
        intc.approve(address(router), type(uint256).max);
        spcx.approve(address(router), type(uint256).max);
        rklb.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _basket3(uint16 wIntc, uint16 wRklb, uint16 wSpcx) internal {
        address[] memory t = new address[](3);
        uint16[] memory w = new uint16[](3);
        (t[0], t[1], t[2]) = (address(intc), address(rklb), address(spcx));
        (w[0], w[1], w[2]) = (wIntc, wRklb, wSpcx);
        strat.setBasket(t, w);
    }

    function _dl() internal view returns (uint256) {
        return block.timestamp + 600;
    }

    // --- the bug v2 fixes: an unrouted name in the live basket ---

    function test_livePreset_skipsUnroutedNameAndSpreadsItsWeight() public {
        vm.expectEmit(true, true, false, true);
        emit BasketRouter.BasketBought(alice, 0, 1000 * U, 2, 3 * U);
        vm.prank(alice);
        router.buyBasket(0, 1000 * U, alice, _dl());
        // net 997 over the routed 70%: INTC 5/7 = 712.142857 USDG, SPCX 2/7 = 284.857142 USDG
        assertEq(intc.balanceOf(alice), 712_142_857 * 1e10);
        assertEq(spcx.balanceOf(alice), 284_857_142 * 5e9);
        assertEq(rklb.balanceOf(alice), 1000 ether, "the unrouted name is untouched");
        assertEq(usdg.balanceOf(address(router)), router.feesAccrued(), "custody = fees only");
    }

    function test_livePreset_ethAndCoatEntriesSkipToo() public {
        vm.prank(alice);
        router.buyBasketEth{value: 0.4 ether}(0, alice, _dl()); // 1000 USDG
        assertEq(intc.balanceOf(alice), 712_142_857 * 1e10);

        Token coatT = new Token("COAT", 18);
        MockCoatRouter cr = new MockCoatRouter{value: 10 ether}(IERC20(address(coatT)), 5e10);
        vm.prank(ownerA);
        router.setCoatRoute(address(coatT), address(cr));
        coatT.transfer(alice, 8_000_000e18);
        vm.startPrank(alice);
        coatT.approve(address(router), type(uint256).max);
        router.buyBasketCoat(0, 8_000_000e18, 0.39 ether, alice, _dl()); // 0.4 ETH -> 1000 USDG
        vm.stopPrank();
        assertEq(intc.balanceOf(alice), 2 * 712_142_857 * 1e10);
    }

    function test_livePreset_nothingRouted_reverts() public {
        address[] memory t = new address[](1);
        uint16[] memory w = new uint16[](1);
        (t[0], w[0]) = (address(rklb), 10_000);
        strat.setBasket(t, w);
        vm.prank(alice);
        vm.expectRevert(BasketRouter.NothingRouted.selector);
        router.buyBasket(0, 1000 * U, alice, _dl());
    }

    function test_basketLegs_view() public view {
        (address[] memory t, uint16[] memory w, address[] memory skipped) = router.basketLegs(0);
        assertEq(t.length, 2);
        assertEq(t[0], address(intc));
        assertEq(t[1], address(spcx));
        assertEq(uint256(w[0]) + w[1], 10_000);
        assertEq(w[0], 7142);
        assertEq(w[1], 2858); // the last routed name takes the rounding
        assertEq(skipped.length, 1);
        assertEq(skipped[0], address(rklb));
    }

    function test_customBasket_unroutedName_reverts() public {
        address[] memory t = new address[](2);
        uint16[] memory w = new uint16[](2);
        (t[0], t[1]) = (address(intc), address(rklb));
        (w[0], w[1]) = (5000, 5000);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.RouteMissing.selector, address(rklb)));
        router.buyCustomBasket(t, w, 100 * U, alice, _dl());
    }

    function test_curatedPreset_routedOnly_andSkipsARouteRemovedLater() public {
        address[] memory t = new address[](2);
        uint16[] memory w = new uint16[](2);
        (t[0], t[1]) = (address(intc), address(rklb));
        (w[0], w[1]) = (6000, 4000);
        vm.prank(ownerA);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.RouteMissing.selector, address(rklb)));
        router.setPreset(1, "Mixed", t, w);

        t[1] = address(spcx);
        vm.startPrank(ownerA);
        router.setPreset(1, "Two", t, w);
        router.setPool(address(spcx), address(0)); // the SPCX pool dies, its route is removed
        vm.stopPrank();
        vm.prank(alice);
        router.buyBasket(1, 1000 * U, alice, _dl());
        assertEq(intc.balanceOf(alice), 9.97 ether, "all of the net goes to the routed name");
        assertEq(spcx.balanceOf(alice), 0);
    }

    function test_setPool_needsABoosterFeed_andCanBeRemoved() public {
        Token noFeed = new Token("NOFEED", 18);
        MockV3Pool p = new MockV3Pool(address(usdg), address(noFeed), 1e10, 1);
        vm.startPrank(ownerA);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.GuardMissing.selector, address(noFeed)));
        router.setPool(address(noFeed), address(p));
        router.setPool(address(intc), address(0));
        vm.stopPrank();
        (address pool,) = router.routes(address(intc));
        assertEq(pool, address(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.RouteMissing.selector, address(intc)));
        router.buyStock(address(intc), 100 * U, 0, alice, _dl());
    }

    // --- sells: an unrouted leg is handed back, never a revert, never left behind ---

    function test_sellBasket_unroutedLegHandedToRecipient() public {
        vm.startPrank(alice);
        router.buyStock(address(intc), 1000 * U, 0, alice, _dl()); // 9.97 INTC
        address[] memory t = new address[](2);
        uint256[] memory a = new uint256[](2);
        (t[0], t[1]) = (address(intc), address(rklb));
        vm.expectEmit(true, true, false, true);
        emit BasketRouter.LegReturned(bob, address(rklb), 1000 ether);
        uint256 out = router.sellBasket(t, a, BasketRouter.OutCurrency.USDG, 0, bob, _dl());
        vm.stopPrank();
        // 9.97 INTC -> 997 USDG, fee 0.3% on the sold leg only
        assertEq(out, 997 * U - (997 * U * 30) / 10_000);
        assertEq(usdg.balanceOf(bob), out);
        assertEq(rklb.balanceOf(bob), 1000 ether, "the unrouted leg arrives raw");
        assertEq(rklb.balanceOf(address(router)), 0);
        assertEq(intc.balanceOf(address(router)), 0);
        assertEq(usdg.balanceOf(address(router)), router.feesAccrued());
    }

    function test_sellBasket_onlyUnroutedLegs() public {
        address[] memory t = new address[](1);
        uint256[] memory a = new uint256[](1);
        t[0] = address(rklb);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.Slippage.selector, 0, 1));
        router.sellBasket(t, a, BasketRouter.OutCurrency.USDG, 1, bob, _dl());

        uint256 feesBefore = router.feesAccrued();
        vm.prank(alice);
        uint256 out = router.sellBasket(t, a, BasketRouter.OutCurrency.ETH, 0, bob, _dl());
        assertEq(out, 0);
        assertEq(rklb.balanceOf(bob), 1000 ether);
        assertEq(router.feesAccrued(), feesBefore, "nothing sold, nothing charged");

        vm.prank(alice); // nothing left to move at all
        vm.expectRevert(BasketRouter.ZeroInput.selector);
        router.sellBasket(t, a, BasketRouter.OutCurrency.USDG, 0, bob, _dl());
    }

    function test_playbooksShapedCaller_leavesNothingInTheEngine() public {
        EngineLike engine = new EngineLike();
        vm.startPrank(alice);
        router.buyStock(address(intc), 1000 * U, 0, alice, _dl());
        intc.approve(address(engine), type(uint256).max);
        rklb.approve(address(engine), type(uint256).max);
        vm.stopPrank();
        address[] memory t = new address[](2);
        (t[0], t[1]) = (address(intc), address(rklb));
        uint256 out = engine.run(router, t, alice, bob);
        assertGt(out, 0);
        assertEq(usdg.balanceOf(bob), out);
        assertEq(rklb.balanceOf(bob), 1000 ether);
        assertEq(intc.balanceOf(address(engine)) + rklb.balanceOf(address(engine)), 0);
    }

    // --- swap core: exact-in, measured output ---

    function test_partialFill_reverts() public {
        PartialPool pp = new PartialPool(address(usdg), address(intc));
        intc.transfer(address(pp), 1e6 ether);
        vm.prank(ownerA);
        router.setPool(address(intc), address(pp));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.PartialFill.selector, 4985 * U / 10, 997 * U));
        router.buyStock(address(intc), 1000 * U, 0, alice, _dl());
    }

    function test_poolThatReportsMoreThanItPays_isCaughtByTheFloor() public {
        LyingPool lp = new LyingPool(address(usdg), address(intc));
        intc.transfer(address(lp), 1e6 ether);
        vm.prank(ownerA);
        router.setPool(address(intc), address(lp));
        vm.prank(alice);
        vm.expectRevert(BasketRouter.BadFeed.selector);
        router.buyStock(address(intc), 1000 * U, 0, alice, _dl());
    }

    function test_coatEntry_measuresTheEthThatArrived() public {
        Token coatT = new Token("COAT", 18);
        BraggingCoatRouter cr = new BraggingCoatRouter{value: 10 ether}(IERC20(address(coatT)), 5e10);
        vm.prank(ownerA);
        router.setCoatRoute(address(coatT), address(cr));
        coatT.transfer(alice, 8_000_000e18);
        vm.startPrank(alice);
        coatT.approve(address(router), type(uint256).max);
        // 0.4 ETH arrives, the router says 0.8: a 0.5 ETH minimum must fail on what arrived
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.Slippage.selector, 0.4 ether, 0.5 ether));
        router.buyBasketCoat(0, 8_000_000e18, 0.5 ether, alice, _dl());
        vm.stopPrank();
    }

    // --- the ETH/USD floor on every ETH<->USDG leg ---

    function test_ethEntry_flooredByChainlink() public {
        ethPool.setPrice(8e8, 1); // the pool now pays half the USDG per ETH
        vm.prank(alice);
        vm.expectRevert(BasketRouter.BadFeed.selector);
        router.buyStockEth{value: 1 ether}(address(intc), 0, alice, _dl());

        vm.prank(ownerA);
        router.setEthUsdFeed(IAggregatorV3Floor(address(0)), 0); // floor off: v1 behaviour
        vm.prank(alice);
        router.buyStockEth{value: 1 ether}(address(intc), 0, alice, _dl());
    }

    function test_ethExit_andFlush_flooredByChainlink() public {
        vm.startPrank(alice);
        router.buyStock(address(intc), 10_000 * U, 0, alice, _dl());
        vm.stopPrank();
        ethPool.setPrice(2e8, 1); // USDG buys half the ETH it should
        vm.prank(alice);
        vm.expectRevert(BasketRouter.BadFeed.selector);
        router.sellStock(address(intc), 1 ether, BasketRouter.OutCurrency.ETH, 0, alice, _dl());
        vm.prank(ownerA);
        vm.expectRevert(BasketRouter.BadFeed.selector);
        router.flushFees(0);
        ethPool.setPrice(4e8, 1);
        vm.prank(ownerA);
        router.flushFees(0);
        assertEq(boosterSink.balance, 0.012 ether);
    }

    function test_staleEthFeed_blocksEthLegs_notUsdgLegs() public {
        ethFeed.set(2500e8, block.timestamp - 31 hours);
        vm.prank(alice);
        vm.expectRevert(BasketRouter.BadFeed.selector);
        router.buyBasketEth{value: 1 ether}(0, alice, _dl());
        vm.prank(alice);
        router.buyBasket(0, 100 * U, alice, _dl()); // USDG path never reads the ETH feed
        assertGt(intc.balanceOf(alice), 0);
    }

    // --- flush shares ---

    function test_flush_zeroShareSendsNothing() public {
        RefusesEth wall = new RefusesEth();
        vm.prank(ownerA);
        router.setSplit(10_000, boosterSink, address(wall));
        vm.prank(alice);
        router.buyStock(address(intc), 10_000 * U, 0, alice, _dl());
        vm.prank(ownerA);
        router.flushFees(0); // a refusing treasury with no share does not block the flush
        assertEq(boosterSink.balance, 0.012 ether);

        vm.prank(ownerA);
        router.setSplit(5000, boosterSink, address(wall));
        vm.prank(alice);
        router.buyStock(address(intc), 10_000 * U, 0, alice, _dl());
        vm.prank(ownerA);
        vm.expectRevert(BasketRouter.EthSendFailed.selector);
        router.flushFees(0);
    }

    function test_version() public view {
        assertEq(router.VERSION(), "2");
        assertEq(router.boosterShareBps(), 10_000);
        assertEq(router.feedStaleAfter(), 4 days);
    }

    // --- fuzz: custody is only ever the fee, whatever the basket and the amount ---

    function testFuzz_presetBuy_conservesAndHoldsOnlyFees(uint256 usdgIn, uint16 wIntc, uint16 wRklb) public {
        usdgIn = bound(usdgIn, 1, 1e6 * U);
        wIntc = uint16(bound(wIntc, 0, 10_000));
        wRklb = uint16(bound(wRklb, 0, 10_000 - wIntc));
        uint16 wSpcx = 10_000 - wIntc - wRklb;
        _basket3(wIntc, wRklb, wSpcx);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        if (wIntc == 0 && wSpcx == 0) {
            vm.expectRevert(BasketRouter.NothingRouted.selector);
            router.buyBasket(0, usdgIn, alice, _dl());
            return;
        }
        router.buyBasket(0, usdgIn, alice, _dl());
        uint256 fee = (usdgIn * 30) / 10_000;
        // what alice paid = the fee plus what the routed legs got (dust came back)
        uint256 paid = before - usdg.balanceOf(alice);
        assertLe(paid, usdgIn);
        assertGe(paid, fee);
        assertEq(usdg.balanceOf(address(router)), router.feesAccrued());
        assertEq(router.feesAccrued(), fee);
        assertEq(rklb.balanceOf(alice), 1000 ether);
    }

    function testFuzz_sell_neverLeavesStockBehind(uint256 buyIn, uint8 pct) public {
        buyIn = bound(buyIn, 10 * U, 1e5 * U);
        pct = uint8(bound(pct, 1, 100));
        vm.startPrank(alice);
        router.buyBasket(0, buyIn, alice, _dl());
        address[] memory t = new address[](3);
        uint256[] memory a = new uint256[](3);
        (t[0], t[1], t[2]) = (address(intc), address(rklb), address(spcx));
        a[0] = (intc.balanceOf(alice) * pct) / 100;
        a[1] = (rklb.balanceOf(alice) * pct) / 100;
        a[2] = (spcx.balanceOf(alice) * pct) / 100;
        if (a[0] == 0 && a[2] == 0) {
            vm.stopPrank();
            return;
        }
        router.sellBasket(t, a, BasketRouter.OutCurrency.USDG, 0, bob, _dl());
        vm.stopPrank();
        assertEq(intc.balanceOf(address(router)) + spcx.balanceOf(address(router)), 0);
        assertEq(rklb.balanceOf(address(router)), 0);
        assertEq(rklb.balanceOf(bob), a[1]);
        assertEq(usdg.balanceOf(address(router)), router.feesAccrued());
    }
}

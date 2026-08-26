// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BasketRouter, IWETHFloor, IStrategyRegistryFloor, IBoosterFeedFloor} from "../src/BasketRouter.sol";

contract Token is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory sym, uint8 dec_) ERC20(sym, sym) {
        _dec = dec_;
        _mint(msg.sender, 1e9 * 10 ** dec_);
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }
}

contract MockWETH is Token {
    constructor() Token("WETH", 18) {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "eth send");
    }

    receive() external payable {}
}

interface ICallback {
    function uniswapV3SwapCallback(int256, int256, bytes calldata) external;
}

contract MockV3Pool {
    address public token0;
    address public token1;
    uint256 public numer;
    uint256 public denom;

    constructor(address t0, address t1, uint256 n, uint256 d) {
        (token0, token1, numer, denom) = (t0, t1, n, d);
    }

    function setPrice(uint256 n, uint256 d) external {
        (numer, denom) = (n, d);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amtIn = uint256(amountSpecified);
        uint256 amtOut = zeroForOne ? (amtIn * numer) / denom : (amtIn * denom) / numer;
        if (zeroForOne) {
            (amount0, amount1) = (int256(amtIn), -int256(amtOut));
            IERC20(token1).transfer(recipient, amtOut);
        } else {
            (amount0, amount1) = (-int256(amtOut), int256(amtIn));
            IERC20(token0).transfer(recipient, amtOut);
        }
        ICallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

contract MockCoatRouter {
    IERC20 public coat;
    uint256 public weiPerCoat; // e.g. COAT at $0.000125, ETH $2500 -> 5e7 wei per COAT(1e18)

    constructor(IERC20 c, uint256 rate) payable {
        coat = c;
        weiPerCoat = rate;
    }

    function sell(uint256 coatIn, uint256 minEthOut, address to) external returns (uint256 out) {
        coat.transferFrom(msg.sender, address(this), coatIn);
        out = (coatIn * weiPerCoat) / 1e18;
        require(out >= minEthOut, "min");
        (bool ok,) = to.call{value: out}("");
        require(ok, "eth");
    }

    function buy(uint256 minCoatOut, address to) external payable returns (uint256 out) {
        out = (msg.value * 1e18) / weiPerCoat;
        require(out >= minCoatOut, "min");
        coat.transfer(to, out);
    }

    receive() external payable {}
}

contract MockFeed {
    int256 public answer;

    constructor(int256 a) {
        answer = a;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

contract MockBoosterFeeds {
    mapping(address => address) public stockFeed;

    function set(address t, address f) external {
        stockFeed[t] = f;
    }
}

contract MockRegistryStrat {
    address[] tokens;
    uint16[] weights;

    function setBasket(address[] memory t, uint16[] memory w) external {
        tokens = t;
        weights = w;
    }

    function getBasket(uint256) external view returns (address[] memory, uint16[] memory, uint64) {
        return (tokens, weights, 50);
    }
}

contract BasketRouterTest is Test {
    Token usdg;
    Token intc; // $100
    Token spcx; // $200
    Token nvda; // $250
    MockWETH wethT; // $2500
    MockV3Pool intcPool;
    MockV3Pool spcxPool;
    MockV3Pool nvdaPool;
    MockV3Pool ethPool;
    MockBoosterFeeds feeds;
    MockRegistryStrat strat;
    BasketRouter router;

    address ownerA = address(0xA11CE);
    address boosterSink = address(0xB005);
    address treasury = address(0x7EA5);
    address alice = address(0xAA);
    uint256 constant U = 1e6;

    function setUp() public {
        usdg = new Token("USDG", 6);
        intc = new Token("INTC", 18);
        spcx = new Token("SPCX", 18);
        nvda = new Token("NVDA", 18);
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

        intcPool = new MockV3Pool(address(usdg), address(intc), 1e10, 1); // 1 USDG -> 0.01e18
        spcxPool = new MockV3Pool(address(usdg), address(spcx), 5e9, 1); // 0.005e18
        nvdaPool = new MockV3Pool(address(usdg), address(nvda), 4e9, 1); // 0.004e18
        ethPool = new MockV3Pool(address(usdg), address(wethT), 4e8, 1); // 1 USDG -> 4e14 wei

        intc.transfer(address(intcPool), 1e6 ether);
        spcx.transfer(address(spcxPool), 1e6 ether);
        nvda.transfer(address(nvdaPool), 1e6 ether);
        wethT.transfer(address(ethPool), 1e5 ether);
        usdg.transfer(address(intcPool), 1e8 * U);
        usdg.transfer(address(spcxPool), 1e8 * U);
        usdg.transfer(address(nvdaPool), 1e8 * U);
        usdg.transfer(address(ethPool), 1e8 * U);
        vm.deal(address(wethT), 1e6 ether);

        feeds.set(address(intc), address(new MockFeed(100e8)));
        feeds.set(address(spcx), address(new MockFeed(200e8)));
        feeds.set(address(nvda), address(new MockFeed(250e8)));

        address[] memory t = new address[](2);
        uint16[] memory w = new uint16[](2);
        t[0] = address(intc);
        t[1] = address(spcx);
        w[0] = 6000;
        w[1] = 4000;
        strat.setBasket(t, w);

        vm.startPrank(ownerA);
        router.setPool(address(intc), address(intcPool));
        router.setPool(address(spcx), address(spcxPool));
        router.setPool(address(nvda), address(nvdaPool));
        router.setEthPool(address(ethPool));
        vm.stopPrank();

        usdg.transfer(alice, 1e6 * U);
        vm.deal(alice, 100 ether);
        vm.prank(alice);
        usdg.approve(address(router), type(uint256).max);
    }

    function _dl() internal view returns (uint256) {
        return block.timestamp + 600;
    }

    function test_buyStock_usdg() public {
        vm.prank(alice);
        uint256 out = router.buyStock(address(intc), 1000 * U, 0, alice, _dl());
        // fee 0.3% -> net 997 -> 9.97 INTC
        assertEq(out, 9.97 ether);
        assertEq(intc.balanceOf(alice), 9.97 ether);
        assertEq(router.feesAccrued(), 3 * U);
        assertEq(usdg.balanceOf(address(router)), 3 * U); // custody = only fees
    }

    function test_buyStock_eth() public {
        vm.prank(alice);
        uint256 out = router.buyStockEth{value: 1 ether}(address(intc), 0, alice, _dl());
        // 1 ETH -> 2500 USDG -> fee 7.5 -> 2492.5 -> 24.925 INTC
        assertEq(out, 24.925 ether);
        assertEq(router.feesAccrued(), 75 * U / 10);
    }

    function test_sellStock_toUsdgAndEth() public {
        vm.startPrank(alice);
        router.buyStock(address(intc), 1000 * U, 0, alice, _dl());
        intc.approve(address(router), type(uint256).max);
        uint256 usdgOut =
            router.sellStock(address(intc), 5 ether, BasketRouter.OutCurrency.USDG, 0, alice, _dl());
        // 5 INTC -> 500 USDG - 0.3% = 498.5
        assertEq(usdgOut, 4985 * U / 10);
        uint256 ethBefore = alice.balance;
        uint256 ethOut =
            router.sellStock(address(intc), 4.97 ether, BasketRouter.OutCurrency.ETH, 0, alice, _dl());
        assertEq(alice.balance - ethBefore, ethOut);
        assertApproxEqRel(ethOut, 0.1982 ether, 1e15); // ~497*0.997/2500
        vm.stopPrank();
    }

    function test_buyBasket_livePreset() public {
        vm.prank(alice);
        router.buyBasket(0, 1000 * U, alice, _dl());
        // net 997: 60% -> 598.2 USDG INTC = 5.982; 40% -> 398.8 SPCX = 1.994
        assertEq(intc.balanceOf(alice), 5.982 ether);
        assertEq(spcx.balanceOf(alice), 1.994 ether);
        assertEq(router.feesAccrued(), 3 * U);
    }

    function test_buyBasketEth_andDustReturns() public {
        uint256 balBefore = usdg.balanceOf(alice);
        vm.prank(alice);
        router.buyBasketEth{value: 1 ether}(0, alice, _dl());
        assertGt(intc.balanceOf(alice), 0);
        assertGt(spcx.balanceOf(alice), 0);
        // any slicing dust must come back to the CALLER, router keeps only fees
        assertEq(usdg.balanceOf(address(router)), router.feesAccrued());
        assertGe(usdg.balanceOf(alice), balBefore); // dust (if any) returned
    }

    function test_curatedPreset_setAndBuy() public {
        address[] memory t = new address[](3);
        uint16[] memory w = new uint16[](3);
        t[0] = address(intc);
        t[1] = address(spcx);
        t[2] = address(nvda);
        w[0] = 3000;
        w[1] = 3000;
        w[2] = 4000;
        vm.prank(ownerA);
        router.setPreset(1, "Chips", t, w);
        (,, string memory name) = router.preset(1);
        assertEq(name, "Chips");

        vm.prank(alice);
        router.buyBasket(1, 1000 * U, alice, _dl());
        assertGt(nvda.balanceOf(alice), 0);
    }

    function test_customBasket_validation() public {
        address[] memory t = new address[](2);
        uint16[] memory w = new uint16[](2);
        t[0] = address(intc);
        t[1] = address(spcx);
        w[0] = 5000;
        w[1] = 4000; // sum != 10000
        vm.prank(alice);
        vm.expectRevert(BasketRouter.BadBasket.selector);
        router.buyCustomBasket(t, w, 100 * U, alice, _dl());

        w[1] = 5000;
        vm.prank(alice);
        router.buyCustomBasket(t, w, 100 * U, alice, _dl());
        assertGt(intc.balanceOf(alice), 0);
    }

    function test_slippageGuard_blocksBadPool() public {
        intcPool.setPrice(1e10 / 2, 1); // pool pays half of fair
        vm.prank(alice);
        vm.expectRevert(BasketRouter.BadFeed.selector);
        router.buyStock(address(intc), 100 * U, 0, alice, _dl());
    }

    function test_userMinOut() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BasketRouter.Slippage.selector, 9.97 ether, 10 ether));
        router.buyStock(address(intc), 1000 * U, 10 ether, alice, _dl());
    }

    function test_flushFees_8020() public {
        vm.prank(alice);
        router.buyStock(address(intc), 10_000 * U, 0, alice, _dl()); // fee 30 USDG
        assertEq(router.feesAccrued(), 30 * U);
        uint256 b0 = boosterSink.balance;
        uint256 t0 = treasury.balance;
        vm.prank(ownerA);
        router.flushFees(0);
        // 30 USDG at $2500 = 0.012 ETH -> 80/20
        assertEq(boosterSink.balance - b0, 0.0096 ether);
        assertEq(treasury.balance - t0, 0.0024 ether);
        assertEq(router.feesAccrued(), 0);
    }

    function test_deadline() public {
        vm.warp(1000);
        vm.prank(alice);
        vm.expectRevert(BasketRouter.Expired.selector);
        router.buyStock(address(intc), 100 * U, 0, alice, 999);
    }

    function test_sellBasket_oneTx_fullExit() public {
        vm.startPrank(alice);
        router.buyBasket(0, 1000 * U, alice, _dl());
        intc.approve(address(router), type(uint256).max);
        spcx.approve(address(router), type(uint256).max);

        address[] memory t = new address[](2);
        uint256[] memory a = new uint256[](2); // zeros = full balances
        t[0] = address(intc);
        t[1] = address(spcx);
        uint256 ethBefore = alice.balance;
        uint256 out = router.sellBasket(t, a, BasketRouter.OutCurrency.ETH, 0, alice, _dl());
        vm.stopPrank();

        assertEq(alice.balance - ethBefore, out);
        assertEq(intc.balanceOf(alice), 0);
        assertEq(spcx.balanceOf(alice), 0);
        // 1000 in, 0.3% both ways + no spread in mocks: ~0.3988 ETH back at $2500
        assertApproxEqRel(out, 0.397 ether, 5e15);
        assertEq(usdg.balanceOf(address(router)), router.feesAccrued()); // custody = fees only
    }

    function test_sellBasket_validationAndUsdgOut() public {
        address[] memory t = new address[](1);
        uint256[] memory a = new uint256[](2);
        t[0] = address(intc);
        vm.prank(alice);
        vm.expectRevert(BasketRouter.BadBasket.selector);
        router.sellBasket(t, a, BasketRouter.OutCurrency.USDG, 0, alice, _dl());

        vm.startPrank(alice);
        router.buyStock(address(intc), 100 * U, 0, alice, _dl());
        intc.approve(address(router), type(uint256).max);
        address[] memory t2 = new address[](1);
        uint256[] memory a2 = new uint256[](1);
        t2[0] = address(intc);
        uint256 out = router.sellBasket(t2, a2, BasketRouter.OutCurrency.USDG, 0, alice, _dl());
        vm.stopPrank();
        // 99.7 worth of INTC -> USDG minus 0.3% fee once
        assertApproxEqRel(out, 994009 * U / 10000, 1e14);
    }

    function test_buyBasketCoat_oneTx() public {
        Token coatT = new Token("COAT", 18);
        MockCoatRouter cr = new MockCoatRouter{value: 10 ether}(IERC20(address(coatT)), 5e10);
        vm.prank(ownerA);
        router.setCoatRoute(address(coatT), address(cr));

        coatT.transfer(alice, 10_000_000e18);
        vm.startPrank(alice);
        coatT.approve(address(router), type(uint256).max);
        // 8M COAT * 5e10 wei = 0.4 ETH -> 1000 USDG -> fee 3 -> basket
        router.buyBasketCoat(0, 8_000_000e18, 0, alice, _dl());
        vm.stopPrank();

        assertApproxEqRel(intc.balanceOf(alice), 5.982 ether, 1e14); // 60% leg
        assertApproxEqRel(spcx.balanceOf(alice), 1.994 ether, 1e14); // 40% leg
        assertEq(router.feesAccrued(), 3 * U);
        assertEq(coatT.balanceOf(address(router)), 0); // no COAT stranded
    }

    function test_sellBasket_toCoat_oneTx() public {
        Token coatT = new Token("COAT", 18);
        MockCoatRouter cr = new MockCoatRouter{value: 10 ether}(IERC20(address(coatT)), 5e10);
        coatT.transfer(address(cr), 5e8 ether); // inventory for buys
        vm.prank(ownerA);
        router.setCoatRoute(address(coatT), address(cr));

        vm.startPrank(alice);
        router.buyBasket(0, 1000 * U, alice, _dl());
        intc.approve(address(router), type(uint256).max);
        spcx.approve(address(router), type(uint256).max);
        address[] memory t = new address[](2);
        uint256[] memory a = new uint256[](2);
        t[0] = address(intc);
        t[1] = address(spcx);
        uint256 out = router.sellBasket(t, a, BasketRouter.OutCurrency.COAT, 0, alice, _dl());
        vm.stopPrank();

        // 1000 -> basket (fee 3) -> back to ~994 USDG (fee ~2.99) -> 0.3964 ETH -> COAT at 5e10 wei
        assertEq(coatT.balanceOf(alice), out);
        assertApproxEqRel(out, 7_928_120e18, 5e15);
        assertEq(intc.balanceOf(alice), 0);
        assertEq(spcx.balanceOf(alice), 0);
    }

    function test_sweep_neverTouchesFees() public {
        vm.prank(alice);
        router.buyBasket(0, 1000 * U, alice, _dl()); // fee 3 USDG accrued
        usdg.transfer(address(router), 50 * U); // stray donation
        vm.deal(address(router), 0.5 ether); // stray ETH

        vm.startPrank(ownerA);
        router.sweep(address(usdg), ownerA);
        assertEq(usdg.balanceOf(ownerA), 50 * U); // only the excess
        assertEq(usdg.balanceOf(address(router)), 3 * U); // fee entitlement intact
        router.sweep(address(0), ownerA);
        assertEq(ownerA.balance, 0.5 ether);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert();
        router.sweep(address(usdg), alice); // owner only
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeskNFT} from "../src/DeskNFT.sol";
import {DeskAccount} from "../src/DeskAccount.sol";
import {
    DeskEngine,
    IWETHDesk,
    IDeskNFTView,
    IStrategyRegistryView,
    IBoosterFeedView
} from "../src/DeskEngine.sol";
import {TestERC6551Registry} from "./Helpers6551.sol";

// --- mocks ---

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

/// Exact-in v3 pool stub with a fixed price: out = in * numer / denom (token0->token1),
/// inverse the other way. Pays out first, then collects payment via the v3 callback.
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
        uint256 balBefore = IERC20(zeroForOne ? token0 : token1).balanceOf(address(this));
        ICallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(zeroForOne ? token0 : token1).balanceOf(address(this)) >= balBefore + amtIn, "unpaid");
    }
}

contract MockFeed {
    int256 public answer;

    constructor(int256 a) {
        answer = a;
    }

    function set(int256 a) external {
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
    uint64 epoch = 48;

    function setBasket(address[] memory t, uint16[] memory w) external {
        tokens = t;
        weights = w;
        epoch++;
    }

    function getBasket(uint256) external view returns (address[] memory, uint16[] memory, uint64) {
        return (tokens, weights, epoch);
    }
}

// --- tests ---

contract DeskEngineTest is Test {
    Token coat;
    Token usdg; // 6 decimals, like mainnet stables
    Token intc; // 18-dec stock
    Token spcx;
    MockWETH wethT;
    TestERC6551Registry reg6551;
    DeskAccount impl;
    DeskNFT desks;
    DeskEngine engine;
    MockV3Pool intcPool;
    MockV3Pool spcxPool;
    MockV3Pool ethPool;
    MockFeed intcFeed;
    MockFeed spcxFeed;
    MockBoosterFeeds feeds;
    MockRegistryStrat strat;

    address ownerA = address(0xA11CE);
    address boosterSink = address(0xB005);
    address treasury = address(0x7EA5);
    address keeper = address(0xEEE);
    address alice = address(0xAA);
    address pool = address(0xF00D);

    uint256 constant U = 1e6; // 1 USDG

    function setUp() public {
        coat = new Token("COAT", 18);
        usdg = new Token("USDG", 6);
        intc = new Token("INTC", 18);
        spcx = new Token("SPCX", 18);
        wethT = new MockWETH();
        reg6551 = new TestERC6551Registry();
        feeds = new MockBoosterFeeds();
        strat = new MockRegistryStrat();

        // engine address depends on impl which depends on engine — deploy engine first with
        // computed nonce? Simpler: deploy engine, then impl(engine), then desks(impl), then
        // point engine at desks via a second engine? Instead: deploy in dependency order using
        // CREATE address prediction.
        uint64 nonce = vm.getNonce(address(this));
        address predictedEngine = vm.computeCreateAddress(address(this), nonce + 2);
        impl = new DeskAccount(predictedEngine); // nonce
        desks = new DeskNFT(IERC20(address(coat)), pool, reg6551, address(impl), ownerA); // nonce+1
        engine = new DeskEngine( // nonce+2
            IERC20(address(usdg)),
            IWETHDesk(address(wethT)),
            IDeskNFTView(address(desks)),
            IStrategyRegistryView(address(strat)),
            IBoosterFeedView(address(feeds)),
            0,
            boosterSink,
            treasury,
            ownerA
        );
        assertEq(address(engine), predictedEngine, "engine address prediction");

        // pools priced off $100 INTC, $200 SPCX, $2500 ETH
        intcPool = new MockV3Pool(address(usdg), address(intc), 1e12 / 100, 1); // 1 USDG(1e6) -> 0.01 INTC(1e16): out = in*1e10
        // out = in * numer/denom; want in(usdg 1e6 raw)=1 USDG -> 0.01e18 stock = 1e16; factor 1e10
        intcPool.setPrice(1e10, 1);
        spcxPool = new MockV3Pool(address(usdg), address(spcx), 5e9, 1); // $200: 1 USDG -> 0.005e18 = 5e15; 5e15/1e6=5e9
        ethPool = new MockV3Pool(address(usdg), address(wethT), 4e8, 1); // $2500: 1 USDG -> 4e14 wei; 4e14/1e6=4e8

        intc.transfer(address(intcPool), 1e6 ether);
        spcx.transfer(address(spcxPool), 1e6 ether);
        wethT.transfer(address(ethPool), 1e5 ether);
        usdg.transfer(address(intcPool), 4e8 * U);
        usdg.transfer(address(spcxPool), 4e8 * U);
        vm.deal(address(wethT), 1e6 ether); // backs withdraw()

        intcFeed = new MockFeed(100e8);
        spcxFeed = new MockFeed(200e8);
        feeds.set(address(intc), address(intcFeed));
        feeds.set(address(spcx), address(spcxFeed));

        address[] memory t = new address[](2);
        uint16[] memory w = new uint16[](2);
        t[0] = address(intc);
        t[1] = address(spcx);
        w[0] = 6000;
        w[1] = 4000;
        strat.setBasket(t, w);

        vm.startPrank(ownerA);
        engine.setKeeper(keeper);
        engine.setPool(address(intc), address(intcPool));
        engine.setPool(address(spcx), address(spcxPool));
        engine.setEthPool(address(ethPool));
        desks.setMintOpen(true);
        desks.setMintPrice(0);
        vm.stopPrank();
    }

    function _openDesk(uint256 fundUsdg) internal returns (uint256 id, address acct) {
        vm.prank(alice);
        (id, acct) = desks.mint();
        usdg.transfer(acct, fundUsdg);
    }

    function test_buyBasket_endToEnd() public {
        (uint256 id, address acct) = _openDesk(600 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max);

        // fee 0.5% of 600 = 3 USDG
        assertEq(engine.feesAccrued(), 3 * U);
        // net 597: 60% INTC ($100) = 3.582 INTC, 40% SPCX ($200) = 1.194 SPCX
        assertApproxEqRel(intc.balanceOf(acct), 3.582 ether, 1e15);
        assertApproxEqRel(spcx.balanceOf(acct), 1.194 ether, 1e15);
        assertEq(usdg.balanceOf(acct), 0); // fully deployed (no dust at these numbers)
        assertEq(engine.deployedUsdg(id), 600 * U); // gross accounting
        assertEq(usdg.balanceOf(address(engine)), 3 * U); // engine holds only its fee
    }

    function test_buyBasket_capClipsAndBlocks() public {
        (uint256 id, address acct) = _openDesk(1500 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max);
        // clipped to the $1,000 pilot cap (gross)
        assertEq(engine.deployedUsdg(id), 1000 * U);
        assertEq(usdg.balanceOf(acct), 500 * U); // remainder untouched in the desk

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DeskEngine.CapExceeded.selector, 500 * U, 0));
        engine.buyBasket(id, type(uint256).max); // cap fully exhausted
    }

    function test_buyBasket_keeperOnly_andPauseBlocks() public {
        (uint256 id, address acct) = _openDesk(100 * U);
        vm.prank(alice);
        vm.expectRevert(DeskEngine.NotKeeper.selector);
        engine.buyBasket(id, type(uint256).max);

        vm.prank(alice);
        DeskAccount(payable(acct)).setEnginePaused(true);
        vm.prank(keeper);
        vm.expectRevert(DeskAccount.EnginePausedError.selector);
        engine.buyBasket(id, type(uint256).max);
    }

    function test_buyBasket_slippageGuard() public {
        (uint256 id,) = _openDesk(100 * U);
        intcPool.setPrice(1e10 / 2, 1); // pool suddenly pays half the stock (bad price)
        vm.prank(keeper);
        vm.expectRevert(DeskEngine.BadFeed.selector);
        engine.buyBasket(id, type(uint256).max);
    }

    function test_sellStock_roundTrip() public {
        (uint256 id, address acct) = _openDesk(600 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max);
        uint256 stockBal = intc.balanceOf(acct);

        vm.prank(keeper);
        engine.sellStock(id, address(intc), stockBal);
        // proceeds ~358.2 USDG minus 0.5% fee, back in the desk
        assertApproxEqRel(usdg.balanceOf(acct), 3564 * U / 10, 1e15);
        assertEq(intc.balanceOf(acct), 0);
        // deployed reduced by the returned net
        assertApproxEqRel(engine.deployedUsdg(id), 600 * U - 3564 * U / 10, 1e15);
    }

    function test_flushFees_splits8020inEth() public {
        (uint256 id,) = _openDesk(1000 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max); // fee 5 USDG
        assertEq(engine.feesAccrued(), 5 * U);

        uint256 bBefore = boosterSink.balance;
        uint256 tBefore = treasury.balance;
        vm.prank(keeper);
        engine.flushFees(0);
        // 5 USDG at $2500 = 0.002 ETH; 80/20
        assertApproxEqRel(boosterSink.balance - bBefore, 0.0016 ether, 1e15);
        assertApproxEqRel(treasury.balance - tBefore, 0.0004 ether, 1e15);
        assertEq(engine.feesAccrued(), 0);
    }
}


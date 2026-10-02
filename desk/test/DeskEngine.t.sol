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
    IBoosterFeedView,
    IAggregatorV3Desk
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

/// Shared fixture: two stocks, a 60/40 basket, mock v3 pools at the feed price.
abstract contract DeskEngineBase is Test {
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
    MockFeed ethFeed;
    MockBoosterFeeds feeds;
    MockRegistryStrat strat;

    address ownerA = address(0xA11CE);
    address boosterSink = address(0xB005);
    address treasury = address(0x7EA5);
    address keeper = address(0xEEE);
    address alice = address(0xAA);
    address pool = address(0xF00D);

    uint256 constant U = 1e6; // 1 USDG

    function setUp() public virtual {
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
        ethFeed = new MockFeed(2500e8);

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
        engine.setEthUsdFeed(IAggregatorV3Desk(address(ethFeed)));
        engine.setDepositRouter(address(this)); // this test plays the deposit router
        desks.setMintOpen(true);
        desks.setMintPrice(0);
        vm.stopPrank();
    }

    /// Mint a Desk and deposit through the "router" (this test): transfer, then book it.
    function _openDesk(uint256 fundUsdg) internal returns (uint256 id, address acct) {
        vm.prank(alice);
        (id, acct) = desks.mint();
        if (fundUsdg > 0) _deposit(id, acct, fundUsdg);
    }

    function _deposit(uint256 id, address acct, uint256 amount) internal {
        usdg.transfer(acct, amount);
        engine.recordDeposit(id, amount);
    }

    function _withdraw(address acct, Token token, uint256 amount) internal {
        vm.prank(alice);
        DeskAccount(payable(acct))
            .execute(address(token), 0, abi.encodeCall(IERC20.transfer, (alice, amount)), 0);
    }
}

contract DeskEngineTest is DeskEngineBase {
    function test_buyBasket_endToEnd() public {
        (uint256 id, address acct) = _openDesk(600 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max);

        // fee 0.5% of 600 = 3 USDG
        assertEq(engine.feesAccrued(), 3 * U);
        // net 597: 60% INTC ($100) = 3.582 INTC, 40% SPCX ($200) = 1.194 SPCX
        assertApproxEqRel(intc.balanceOf(acct), 3.582 ether, 1e15);
        assertApproxEqRel(spcx.balanceOf(acct), 1.194 ether, 1e15);
        assertEq(usdg.balanceOf(acct), 0);
        assertEq(engine.principalOf(id), 600 * U); // what the owner put in; buying does not change it
        assertEq(engine.investableOf(id), 0);
        assertEq(usdg.balanceOf(address(engine)), 3 * U); // engine holds only its fee
    }

    // --- the pilot cap: at most $1,000 put in, profit and loss outside it ---

    function test_deposit_overTheCapReverts() public {
        (uint256 id, address acct) = _openDesk(1000 * U);
        assertEq(engine.depositRoomOf(id), 0);
        usdg.transfer(acct, 1 * U);
        vm.expectRevert(abi.encodeWithSelector(DeskEngine.DepositOverCap.selector, 1 * U, 0));
        engine.recordDeposit(id, 1 * U);

        (uint256 id2, address acct2) = _openDesk(0);
        usdg.transfer(acct2, 1500 * U);
        vm.expectRevert(abi.encodeWithSelector(DeskEngine.DepositOverCap.selector, 1500 * U, 1000 * U));
        engine.recordDeposit(id2, 1500 * U);
    }

    function test_deposit_onlyTheRouterBooks() public {
        (uint256 id,) = _openDesk(0);
        vm.prank(alice);
        vm.expectRevert(DeskEngine.NotRouter.selector);
        engine.recordDeposit(id, 100 * U);
    }

    /// USDG that reaches the wallet without going through the router is never invested.
    function test_unbookedUsdgStaysIdle() public {
        (uint256 id, address acct) = _openDesk(500 * U);
        usdg.transfer(acct, 700 * U); // straight to the wallet
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max);
        assertEq(usdg.balanceOf(acct), 700 * U);
        assertEq(engine.investableOf(id), 0);
        assertEq(engine.principalOf(id), 500 * U);
    }

    /// Profit is not capped: sell proceeds, gains included, are always reinvested in full,
    /// even when the Desk is worth far more than the cap.
    function test_profitIsReinvestedBeyondTheCap() public {
        (uint256 id, address acct) = _openDesk(1000 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max); // $597 INTC, $398 SPCX
        intcFeed.set(300e8); // INTC triples
        intcPool.setPrice(1e10, 3);
        uint256 bal = intc.balanceOf(acct);
        vm.prank(keeper);
        engine.sellStock(id, address(intc), bal); // ~ $1,791 before fee
        uint256 proceeds = engine.investableOf(id);
        assertGt(proceeds, 1780 * U);
        vm.prank(keeper);
        engine.buyStock(id, address(spcx), type(uint256).max); // all of it goes back to work
        assertEq(engine.investableOf(id), 0);
        assertEq(usdg.balanceOf(acct), 0);
        assertEq(engine.principalOf(id), 1000 * U); // still what the owner put in
        assertEq(engine.depositRoomOf(id), 0);
    }

    function test_pricesNeverMoveThePrincipal() public {
        (uint256 id,) = _openDesk(800 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max);
        intcFeed.set(200e8);
        spcxFeed.set(50e8);
        assertEq(engine.principalOf(id), 800 * U);
        assertEq(engine.depositRoomOf(id), 200 * U);
    }

    /// Taking stock out frees room by what it is worth when it leaves.
    function test_withdrawal_freesRoomByItsValue() public {
        (uint256 id, address acct) = _openDesk(1000 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max);
        _withdraw(acct, intc, intc.balanceOf(acct)); // $597 of INTC at $100
        assertEq(engine.principalOf(id), 403 * U);
        assertEq(engine.depositRoomOf(id), 597 * U);

        usdg.transfer(acct, 598 * U);
        vm.expectRevert(abi.encodeWithSelector(DeskEngine.DepositOverCap.selector, 598 * U, 597 * U));
        engine.recordDeposit(id, 598 * U);
        engine.recordDeposit(id, 597 * U);
        assertEq(engine.principalOf(id), 1000 * U);
    }

    function test_withdrawal_atAProfitCanFreeTheWholeCap() public {
        (uint256 id, address acct) = _openDesk(1000 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max);
        intcFeed.set(200e8); // INTC doubles: the INTC leg is worth $1,194
        _withdraw(acct, intc, intc.balanceOf(acct));
        assertEq(engine.principalOf(id), 0); // never below zero
        assertEq(engine.depositRoomOf(id), 1000 * U);
    }

    function test_withdrawal_ofUsdgCountsOneForOne() public {
        (uint256 id, address acct) = _openDesk(1000 * U);
        _withdraw(acct, usdg, 300 * U);
        assertEq(engine.principalOf(id), 700 * U);
        assertEq(engine.investableOf(id), 700 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max); // books the withdrawal on chain as well
        (uint128 principal, uint128 booked) = engine.books(id);
        assertEq(principal, 700 * U);
        assertEq(booked, 0);
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
        // the proceeds are booked and reinvestable; the principal did not move
        assertEq(engine.investableOf(id), usdg.balanceOf(acct));
        assertEq(engine.principalOf(id), 600 * U);
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

    function test_buyStock_buysOnlyThatName() public {
        (uint256 id, address acct) = _openDesk(200 * U);
        vm.prank(keeper);
        engine.buyStock(id, address(spcx), type(uint256).max);
        // fee 1 USDG, net 199 at $200 = 0.995 SPCX, no INTC touched
        assertEq(engine.feesAccrued(), 1 * U);
        assertApproxEqRel(spcx.balanceOf(acct), 0.995 ether, 1e15);
        assertEq(intc.balanceOf(acct), 0);
        assertEq(usdg.balanceOf(acct), 0);
        assertEq(engine.heldQty(id, address(spcx)), spcx.balanceOf(acct));
    }

    function test_buyStock_rejectsNamesOutsideTheBasket() public {
        (uint256 id,) = _openDesk(100 * U);
        Token other = new Token("OTHER", 18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DeskEngine.NotInBasket.selector, address(other)));
        engine.buyStock(id, address(other), type(uint256).max);
    }

    function test_buyStock_spendsOnlyBookedUsdg() public {
        (uint256 id, address acct) = _openDesk(300 * U);
        usdg.transfer(acct, 200 * U); // unbooked
        vm.prank(keeper);
        engine.buyStock(id, address(intc), type(uint256).max);
        assertEq(usdg.balanceOf(acct), 200 * U);
        vm.prank(keeper);
        vm.expectRevert(DeskEngine.NothingToDo.selector);
        engine.buyStock(id, address(intc), type(uint256).max);
    }

    function test_buyStock_keeperOnly_pauseAndSlippageGuard() public {
        (uint256 id, address acct) = _openDesk(100 * U);
        vm.prank(alice);
        vm.expectRevert(DeskEngine.NotKeeper.selector);
        engine.buyStock(id, address(intc), type(uint256).max);

        spcxPool.setPrice(5e9 / 2, 1); // bad price
        vm.prank(keeper);
        vm.expectRevert(DeskEngine.BadFeed.selector);
        engine.buyStock(id, address(spcx), type(uint256).max);

        vm.prank(alice);
        DeskAccount(payable(acct)).setEnginePaused(true);
        vm.prank(keeper);
        vm.expectRevert(DeskAccount.EnginePausedError.selector);
        engine.buyStock(id, address(intc), type(uint256).max);
    }

    /// The reason buyStock exists: moving a desk from 60/40 to 50/50 by trading only the
    /// difference costs a fraction of selling everything and rebuying the basket.
    function test_targetedRebalance_tradesOnlyTheDifference() public {
        (uint256 id, address acct) = _openDesk(1000 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max); // 60/40 of $995
        uint256 feesBefore = engine.feesAccrued();

        address[] memory t = new address[](2);
        uint16[] memory w = new uint16[](2);
        (t[0], t[1], w[0], w[1]) = (address(intc), address(spcx), 5000, 5000);
        strat.setBasket(t, w);

        // sell 1/6 of the INTC (60% -> 50%), put the proceeds into SPCX
        uint256 sellAmt = intc.balanceOf(acct) / 6;
        vm.startPrank(keeper);
        engine.sellStock(id, address(intc), sellAmt);
        engine.buyStock(id, address(spcx), type(uint256).max);
        vm.stopPrank();

        uint256 intcUsd = intc.balanceOf(acct) * 100 / 1e18;
        uint256 spcxUsd = spcx.balanceOf(acct) * 200 / 1e18;
        assertApproxEqRel(intcUsd * 1e18 / (intcUsd + spcxUsd), 0.5e18, 5e15); // within 0.5% of 50/50
        // two legs on ~$166 of turnover: about $1.65 of fees, vs ~$9.9 for a full round trip
        assertLt(engine.feesAccrued() - feesBefore, 2 * U);
    }
}


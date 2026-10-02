// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeskAccount} from "../src/DeskAccount.sol";
import {DeskEngine} from "../src/DeskEngine.sol";
import {DeskEngineBase, Token, MockV3Pool, MockFeed, ICallback} from "./DeskEngine.t.sol";

// --- adversarial venues ---

/// Takes only half of the input (a pool that runs out of range) and pays a fair price for it.
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
        uint256 out = zeroForOne ? half * 1e10 : half / 1e10; // $100 stock, 6-dec USDG
        IERC20(zeroForOne ? token1 : token0).transfer(recipient, out);
        (amount0, amount1) = zeroForOne ? (int256(half), -int256(out)) : (-int256(out), int256(half));
        ICallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

/// Reports a generous fill but delivers nothing.
contract LyingPool {
    address public token0;
    address public token1;

    constructor(address t0, address t1) {
        (token0, token1) = (t0, t1);
    }

    function swap(address, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        (amount0, amount1) = zeroForOne ? (amountSpecified, int256(-1e30)) : (int256(-1e30), amountSpecified);
        ICallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

/// Delivers a fair fill, then asks to be paid twice the input.
contract GreedyPool {
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
        IERC20(token1).transfer(recipient, amtIn * 1e10);
        (amount0, amount1) = (int256(amtIn * 2), -int256(amtIn * 1e10));
        zeroForOne; // buys only
        ICallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

/// Fair fill, but calls the callback twice to be paid twice.
contract DoubleDipPool {
    address public token0;
    address public token1;

    constructor(address t0, address t1) {
        (token0, token1) = (t0, t1);
    }

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amtIn = uint256(amountSpecified);
        IERC20(token1).transfer(recipient, amtIn * 1e10);
        (amount0, amount1) = (amountSpecified, -int256(amtIn * 1e10));
        ICallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        ICallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

/// A feed frozen at a fixed timestamp.
contract StaleFeed {
    int256 public answer;
    uint256 public updatedAt;

    constructor(int256 a, uint256 t) {
        (answer, updatedAt) = (a, t);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

/// The promises, one test each, against hostile pools, hostile owners and broken feeds.
contract DeskAuditTest is DeskEngineBase {
    address bob = address(0xB0B);

    // --- the pilot cap holds against every way around it ---

    /// Stock the owner puts in the wallet themselves is never touched by the engine. If the
    /// keeper could sell it, the proceeds would be booked as investable USDG and a $1,000 Desk
    /// could invest any amount.
    function test_audit_stockPutInDirectly_isNeverSold() public {
        (uint256 id, address acct) = _openDesk(1000 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max);
        uint256 held = engine.heldQty(id, address(intc));

        intc.transfer(acct, 500 ether); // $50,000 of INTC, straight to the wallet
        uint256 wallet = intc.balanceOf(acct);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DeskEngine.NotHeld.selector, address(intc), wallet, held));
        engine.sellStock(id, address(intc), wallet);

        vm.prank(keeper);
        engine.sellStock(id, address(intc), held); // what the engine bought, it may sell
        assertEq(intc.balanceOf(acct), 500 ether); // the owner's shares, untouched
        assertLt(engine.investableOf(id), 1000 * U); // proceeds of the held leg only
        assertEq(engine.principalOf(id), 1000 * U);
    }

    function testFuzz_audit_capNeverExceeded(uint256[6] memory amounts) public {
        (uint256 id, address acct) = _openDesk(0);
        for (uint256 i; i < amounts.length; ++i) {
            uint256 a = bound(amounts[i], 1, 1200 * U);
            uint256 room = engine.depositRoomOf(id);
            usdg.transfer(acct, a);
            if (a > room) {
                vm.expectRevert(abi.encodeWithSelector(DeskEngine.DepositOverCap.selector, a, room));
                engine.recordDeposit(id, a);
            } else {
                engine.recordDeposit(id, a);
            }
            assertLe(engine.principalOf(id), engine.pilotCapUsdg());
        }
    }

    /// Prices never move the room; only money in and money out do.
    function testFuzz_audit_pricesNeverMoveTheRoom(uint256 deposit, uint256 intcPx, uint256 spcxPx) public {
        deposit = bound(deposit, 10 * U, 1000 * U);
        (uint256 id,) = _openDesk(deposit);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max);
        intcFeed.set(int256(bound(intcPx, 1, 100_000)) * 1e8);
        spcxFeed.set(int256(bound(spcxPx, 1, 100_000)) * 1e8);
        assertEq(engine.principalOf(id), deposit);
        assertEq(engine.depositRoomOf(id), 1000 * U - deposit);
    }

    /// Taking stock out frees exactly what it is worth at the feed price, never below zero.
    function testFuzz_audit_withdrawalFreesItsValue(uint256 pxUsd, uint256 fracBps) public {
        (uint256 id, address acct) = _openDesk(1000 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max); // $597 INTC at $100
        pxUsd = bound(pxUsd, 1, 1000);
        fracBps = bound(fracBps, 1, 10_000);
        intcFeed.set(int256(pxUsd) * 1e8);
        uint256 qty = (intc.balanceOf(acct) * fracBps) / 10_000;
        _withdraw(acct, intc, qty);
        uint256 value = (qty * pxUsd * U) / 1e18;
        uint256 expected = value >= 1000 * U ? 0 : 1000 * U - value;
        assertApproxEqAbs(engine.principalOf(id), expected, 1);
    }

    // --- every swap: exact input, real output, one payment ---

    function _routeIntcThrough(address pool) internal {
        intc.transfer(pool, 1e5 ether);
        vm.prank(ownerA);
        engine.setPool(address(intc), pool);
    }

    function test_audit_partialFillReverts_nothingStranded() public {
        (uint256 id, address acct) = _openDesk(100 * U);
        _routeIntcThrough(address(new PartialPool(address(usdg), address(intc))));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DeskEngine.PartialFill.selector, 49_750_000, 99_500_000));
        engine.buyStock(id, address(intc), type(uint256).max);
        assertEq(usdg.balanceOf(acct), 100 * U);
        assertEq(usdg.balanceOf(address(engine)), 0);
    }

    function test_audit_poolThatLiesAboutTheFill_reverts() public {
        (uint256 id, address acct) = _openDesk(100 * U);
        _routeIntcThrough(address(new LyingPool(address(usdg), address(intc))));
        vm.prank(keeper);
        vm.expectRevert(DeskEngine.InvalidPool.selector);
        engine.buyStock(id, address(intc), type(uint256).max);
        assertEq(usdg.balanceOf(acct), 100 * U);
    }

    function test_audit_poolCannotTakeMoreThanTheInput() public {
        (uint256 id,) = _openDesk(100 * U);
        _routeIntcThrough(address(new GreedyPool(address(usdg), address(intc))));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(DeskEngine.PartialFill.selector, 199_000_000, 99_500_000));
        engine.buyStock(id, address(intc), type(uint256).max);
    }

    function test_audit_poolCannotBePaidTwice() public {
        (uint256 id,) = _openDesk(100 * U);
        _routeIntcThrough(address(new DoubleDipPool(address(usdg), address(intc))));
        vm.prank(keeper);
        vm.expectRevert(DeskEngine.BadCallback.selector);
        engine.buyStock(id, address(intc), type(uint256).max);
    }

    function test_audit_strangerCannotCallTheSwapCallback() public {
        _openDesk(100 * U);
        vm.prank(address(intcPool)); // even a real pool, outside a swap
        vm.expectRevert(DeskEngine.BadCallback.selector);
        engine.uniswapV3SwapCallback(1, 0, "");
    }

    /// The fee conversion is floored by Chainlink ETH/USD even when the keeper passes 0.
    function test_audit_feeFlushHasAChainlinkFloor() public {
        (uint256 id,) = _openDesk(1000 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max); // 5 USDG of fees
        ethPool.setPrice(2e8, 1); // the pool now pays half the ETH
        vm.prank(keeper);
        vm.expectRevert(DeskEngine.BadFeed.selector);
        engine.flushFees(0);
        assertEq(engine.feesAccrued(), 5 * U);
    }

    // --- the basket is bought as published, and nothing blocks a Desk ---

    /// A basket name the engine has no pool for is skipped; the rest keep their relative weights.
    function test_audit_unroutedBasketName_isSkipped() public {
        Token orcl = new Token("ORCL", 18);
        address[] memory t = new address[](3);
        uint16[] memory w = new uint16[](3);
        (t[0], t[1], t[2]) = (address(intc), address(spcx), address(orcl));
        (w[0], w[1], w[2]) = (5000, 3000, 2000);
        strat.setBasket(t, w);

        (uint256 id, address acct) = _openDesk(800 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max);
        // net 796: INTC 5/8 = $497.50, SPCX 3/8 = $298.50
        assertApproxEqRel(intc.balanceOf(acct), 4.975 ether, 1e14);
        assertApproxEqRel(spcx.balanceOf(acct), 1.4925 ether, 1e14);
        assertEq(usdg.balanceOf(acct), 0);
        assertEq(usdg.balanceOf(address(engine)), engine.feesAccrued());
    }

    /// A stale or missing feed never locks a Desk: deposits, the room and the metadata keep
    /// working; only buying that name waits for a fresh price.
    function test_audit_brokenFeedNeverLocksADesk() public {
        (uint256 id, address acct) = _openDesk(600 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max); // $358.20 INTC, $238.80 SPCX
        vm.warp(block.timestamp + 30 days);
        feeds.set(address(intc), address(new StaleFeed(100e8, 1)));
        _withdraw(acct, intc, intc.balanceOf(acct) / 2); // $179.10 at the stale price

        assertApproxEqAbs(engine.principalOf(id), 420.9e6, 1);
        engine.recordDeposit(id, 0); // the book syncs without reverting
        _deposit(id, acct, 100 * U);
        assertApproxEqAbs(engine.principalOf(id), 520.9e6, 1);

        feeds.set(address(spcx), address(0)); // no feed at all: taking SPCX out frees nothing
        _withdraw(acct, spcx, spcx.balanceOf(acct));
        assertApproxEqAbs(engine.principalOf(id), 520.9e6, 1);

        vm.prank(keeper);
        vm.expectRevert(DeskEngine.BadFeed.selector); // the swap guard itself stays strict
        engine.buyStock(id, address(intc), type(uint256).max);
    }

    // --- custody: the owner's wallet, the owner's call ---

    function test_audit_walletFollowsTheNft() public {
        (uint256 id, address acct) = _openDesk(500 * U);
        DeskAccount wallet = DeskAccount(payable(acct));

        vm.prank(bob);
        vm.expectRevert(DeskAccount.InvalidSigner.selector);
        wallet.execute(address(usdg), 0, abi.encodeCall(IERC20.transfer, (bob, 1)), 0);
        vm.prank(bob);
        vm.expectRevert(DeskAccount.InvalidSigner.selector);
        wallet.setEnginePaused(true);

        vm.prank(alice);
        wallet.setEnginePaused(true);
        vm.prank(alice);
        desks.transferFrom(alice, bob, id); // sold whole, portfolio inside

        vm.prank(alice);
        vm.expectRevert(DeskAccount.InvalidSigner.selector);
        wallet.execute(address(usdg), 0, abi.encodeCall(IERC20.transfer, (alice, 1)), 0);
        assertTrue(wallet.enginePaused()); // the setting travels with the Desk
        vm.prank(bob);
        wallet.setEnginePaused(false);
        vm.prank(bob);
        wallet.execute(address(usdg), 0, abi.encodeCall(IERC20.transfer, (bob, 500 * U)), 0);
        assertEq(usdg.balanceOf(bob), 500 * U);
    }

    function test_audit_onlyTheEngineCanPull_andOnlyWhileUnpaused() public {
        (, address acct) = _openDesk(500 * U);
        DeskAccount wallet = DeskAccount(payable(acct));
        vm.prank(keeper);
        vm.expectRevert(DeskAccount.OnlyEngine.selector);
        wallet.enginePull(address(usdg), 1);
        vm.prank(ownerA);
        vm.expectRevert(DeskAccount.OnlyEngine.selector);
        wallet.enginePull(address(usdg), 1);

        vm.prank(alice);
        wallet.setEnginePaused(true);
        vm.prank(address(engine));
        vm.expectRevert(DeskAccount.EnginePausedError.selector);
        wallet.enginePull(address(usdg), 1);
    }

    /// Pausing the engine never stops the owner: everything can leave, any time.
    function test_audit_ownerWithdrawsEverything_evenWhilePaused() public {
        (uint256 id, address acct) = _openDesk(1000 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max);
        vm.prank(alice);
        DeskAccount(payable(acct)).setEnginePaused(true);
        _withdraw(acct, intc, intc.balanceOf(acct));
        _withdraw(acct, spcx, spcx.balanceOf(acct));
        assertEq(intc.balanceOf(acct) + spcx.balanceOf(acct) + usdg.balanceOf(acct), 0);
        assertGt(intc.balanceOf(alice), 0);
        assertEq(engine.principalOf(id), 5 * U); // the $5 fee is the only part not taken back out
    }

    function test_audit_desksAreIsolated() public {
        (uint256 a, address acctA) = _openDesk(1000 * U);
        (uint256 b, address acctB) = _openDesk(300 * U);
        vm.startPrank(keeper);
        engine.buyBasket(a, type(uint256).max);
        engine.sellStock(a, address(intc), engine.heldQty(a, address(intc)));
        engine.buyStock(a, address(spcx), type(uint256).max);
        vm.stopPrank();
        assertEq(usdg.balanceOf(acctB), 300 * U);
        assertEq(intc.balanceOf(acctB) + spcx.balanceOf(acctB), 0);
        (uint128 principalB, uint128 usdgB) = engine.books(b);
        assertEq(principalB, 300 * U);
        assertEq(usdgB, 300 * U);
        assertGt(spcx.balanceOf(acctA), 0);
    }

    function test_audit_unmintedDeskCannotBeFunded() public {
        vm.expectRevert(); // ERC721NonexistentToken
        engine.recordDeposit(77, 1 * U);
    }

    // --- the published fee, and nothing more ---

    function test_audit_feeIsExactlyTheRate_andCapped() public {
        (uint256 id,) = _openDesk(777 * U);
        vm.prank(keeper);
        engine.buyBasket(id, type(uint256).max);
        assertEq(engine.feesAccrued(), (777 * U * 50) / 10_000);
        vm.prank(ownerA);
        vm.expectRevert(DeskEngine.FeeTooHigh.selector);
        engine.setFeeBps(101);
        vm.prank(keeper);
        vm.expectRevert(); // not the owner
        engine.setFeeBps(10);
    }

    function test_audit_keeperCannotRetuneTheEngine() public {
        vm.startPrank(keeper);
        vm.expectRevert();
        engine.setPool(address(intc), address(intcPool));
        vm.expectRevert();
        engine.setPilotCap(1e30);
        vm.expectRevert();
        engine.setDepositRouter(keeper);
        vm.expectRevert();
        engine.setSplit(0, keeper, keeper);
        vm.stopPrank();
    }
}

/// Random sequences of everything a user, the keeper and the market can do to two Desks.
contract DeskHandler is Test {
    DeskEngine engine;
    Token usdg;
    Token intc;
    Token spcx;
    MockV3Pool intcPool;
    MockV3Pool spcxPool;
    MockFeed intcFeed;
    MockFeed spcxFeed;
    address keeper;
    address alice;
    uint256 public id;
    address public acct;

    /// shares the engine delivered to the Desk and shares it sold, per stock
    mapping(address => uint256) public bought;
    mapping(address => uint256) public sold;
    uint256 public calls;

    struct Env {
        DeskEngine engine;
        Token usdg;
        Token intc;
        Token spcx;
        MockV3Pool intcPool;
        MockV3Pool spcxPool;
        MockFeed intcFeed;
        MockFeed spcxFeed;
        address keeper;
        address alice;
        uint256 id;
        address acct;
    }

    constructor(Env memory e) {
        (engine, usdg, intc, spcx) = (e.engine, e.usdg, e.intc, e.spcx);
        (intcPool, spcxPool, intcFeed, spcxFeed) = (e.intcPool, e.spcxPool, e.intcFeed, e.spcxFeed);
        (keeper, alice, id, acct) = (e.keeper, e.alice, e.id, e.acct);
    }

    function deposit(uint256 amount) external {
        ++calls;
        amount = bound(amount, 1, 1100e6);
        if (amount > engine.depositRoomOf(id)) return;
        usdg.transfer(acct, amount);
        engine.recordDeposit(id, amount);
    }

    function sendUnbookedUsdg(uint256 amount) external {
        ++calls;
        usdg.transfer(acct, bound(amount, 1, 5000e6));
    }

    /// The owner puts shares in the wallet themselves (outside the engine and the cap).
    function sendOwnStock(uint256 amount, bool which) external {
        ++calls;
        (which ? intc : spcx).transfer(acct, bound(amount, 1, 50 ether));
    }

    function withdrawUsdg(uint256 fracBps) external {
        ++calls;
        uint256 amt = (usdg.balanceOf(acct) * bound(fracBps, 0, 10_000)) / 10_000;
        vm.prank(alice);
        DeskAccount(payable(acct)).execute(address(usdg), 0, abi.encodeCall(IERC20.transfer, (alice, amt)), 0);
    }

    function withdrawStock(uint256 fracBps, bool which) external {
        ++calls;
        Token t = which ? intc : spcx;
        uint256 amt = (t.balanceOf(acct) * bound(fracBps, 0, 10_000)) / 10_000;
        vm.prank(alice);
        DeskAccount(payable(acct)).execute(address(t), 0, abi.encodeCall(IERC20.transfer, (alice, amt)), 0);
    }

    function buyBasket(uint256 maxSpend) external {
        ++calls;
        (uint256 i0, uint256 s0) = (intc.balanceOf(acct), spcx.balanceOf(acct));
        vm.prank(keeper);
        try engine.buyBasket(id, bound(maxSpend, 1, 2000e6)) {
            bought[address(intc)] += intc.balanceOf(acct) - i0;
            bought[address(spcx)] += spcx.balanceOf(acct) - s0;
        } catch {}
    }

    function buyStock(uint256 maxSpend, bool which) external {
        ++calls;
        Token t = which ? intc : spcx;
        uint256 b0 = t.balanceOf(acct);
        vm.prank(keeper);
        try engine.buyStock(id, address(t), bound(maxSpend, 1, 2000e6)) {
            bought[address(t)] += t.balanceOf(acct) - b0;
        } catch {}
    }

    /// The keeper tries to sell a share of the WALLET balance, as the old keeper did.
    function sellFromWallet(uint256 fracBps, bool which) external {
        ++calls;
        Token t = which ? intc : spcx;
        uint256 amt = (t.balanceOf(acct) * bound(fracBps, 1, 10_000)) / 10_000;
        if (amt == 0) return;
        vm.prank(keeper);
        try engine.sellStock(id, address(t), amt) {
            sold[address(t)] += amt;
        } catch {}
    }

    function movePrice(uint256 usd, bool which) external {
        ++calls;
        usd = bound(usd, 20, 500);
        if (which) {
            intcFeed.set(int256(usd) * 1e8);
            intcPool.setPrice(1e12, usd);
        } else {
            spcxFeed.set(int256(usd) * 1e8);
            spcxPool.setPrice(1e12, usd);
        }
    }

    function flush() external {
        ++calls;
        vm.prank(keeper);
        try engine.flushFees(0) {} catch {}
    }
}

contract DeskInvariantTest is DeskEngineBase {
    DeskHandler handler;
    uint256 deskB;
    address acctB;

    function setUp() public override {
        super.setUp();
        (uint256 idA, address acctA) = _openDesk(0);
        (deskB, acctB) = _openDesk(400 * U); // a bystander Desk nobody touches
        handler = new DeskHandler(
            DeskHandler.Env(
                engine, usdg, intc, spcx, intcPool, spcxPool, intcFeed, spcxFeed, keeper, alice, idA, acctA
            )
        );
        usdg.transfer(address(handler), 1e8 * U);
        intc.transfer(address(handler), 1e4 ether);
        spcx.transfer(address(handler), 1e4 ether);
        vm.prank(ownerA);
        engine.setDepositRouter(address(handler));
        targetContract(address(handler));
    }

    /// The engine holds nothing between transactions but its own USDG fees.
    function invariant_engineHoldsOnlyItsFees() public view {
        assertEq(usdg.balanceOf(address(engine)), engine.feesAccrued());
        assertEq(intc.balanceOf(address(engine)), 0);
        assertEq(spcx.balanceOf(address(engine)), 0);
        assertEq(wethT.balanceOf(address(engine)), 0);
        assertEq(address(engine).balance, 0);
    }

    function invariant_principalNeverAboveTheCap() public view {
        assertLe(engine.principalOf(handler.id()), engine.pilotCapUsdg());
    }

    /// The engine only invests USDG that really sits in the wallet.
    function invariant_investableIsBacked() public view {
        assertLe(engine.investableOf(handler.id()), usdg.balanceOf(handler.acct()));
    }

    /// The engine never sells more shares than it bought: shares the owner put in themselves
    /// are never turned into investable USDG, so the cap cannot be walked around with stock.
    /// (Shares are fungible: if the owner takes bought shares out and puts their own back in,
    /// the engine keeps managing the same count and the withdrawal frees no room.)
    function invariant_engineNeverSellsMoreThanItBought() public view {
        assertLe(handler.sold(address(intc)), handler.bought(address(intc)));
        assertLe(handler.sold(address(spcx)), handler.bought(address(spcx)));
        uint256 id = handler.id();
        assertLe(
            engine.heldQty(id, address(intc)), handler.bought(address(intc)) - handler.sold(address(intc))
        );
        assertLe(
            engine.heldQty(id, address(spcx)), handler.bought(address(spcx)) - handler.sold(address(spcx))
        );
    }

    function invariant_bystanderDeskUnchanged() public view {
        assertEq(usdg.balanceOf(acctB), 400 * U);
        assertEq(intc.balanceOf(acctB) + spcx.balanceOf(acctB), 0);
        (uint128 p, uint128 u) = engine.books(deskB);
        assertEq(p, 400 * U);
        assertEq(u, 400 * U);
    }
}

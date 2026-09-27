// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    DeskTestAsset,
    DeskTestFeed,
    DeskTestPool,
    DeskTestnetOnly,
    IDeskTestFeed
} from "../src/testnet/DeskTestVenue.sol";

/// The rehearsal venue has to behave like a v3 pool from the engine's side (exact-in, output
/// first, input through the callback) and must refuse to exist anywhere but testnet.
contract DeskTestVenueTest is Test {
    DeskTestAsset usdg;
    DeskTestAsset stock;
    DeskTestFeed feed;
    DeskTestPool pool;
    bool payInCallback = true;

    function setUp() public {
        vm.chainId(46630);
        usdg = new DeskTestAsset("Test USDG", "tUSDG", 6, address(this));
        stock = new DeskTestAsset("Test Stock", "tSTK", 18, address(this));
        feed = new DeskTestFeed(address(this), 200e8);
        pool = new DeskTestPool(address(usdg), address(stock), IDeskTestFeed(address(feed)), 30);
        usdg.mint(address(pool), 1_000_000e6);
        stock.mint(address(pool), 1_000e18);
        usdg.mint(address(this), 10_000e6);
        stock.mint(address(this), 10e18);
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        if (!payInCallback) return;
        if (a0 > 0) IERC20(pool.token0()).transfer(msg.sender, uint256(a0));
        if (a1 > 0) IERC20(pool.token1()).transfer(msg.sender, uint256(a1));
    }

    function _swap(address tokenIn, uint256 amountIn) internal returns (uint256 out) {
        bool zeroForOne = tokenIn == pool.token0();
        (int256 a0, int256 a1) = pool.swap(address(this), zeroForOne, int256(amountIn), 0, "");
        out = uint256(-(zeroForOne ? a1 : a0));
    }

    function test_buysAtFeedMinusSpread() public {
        uint256 before = stock.balanceOf(address(this));
        uint256 out = _swap(address(usdg), 1_000e6); // $1,000 at $200 = 5 shares, minus 0.30%
        assertEq(out, 4.985e18);
        assertEq(stock.balanceOf(address(this)) - before, out);
    }

    function test_sellsAtFeedMinusSpread() public {
        uint256 out = _swap(address(stock), 1e18); // 1 share at $200, minus 0.30%
        assertEq(out, 199.4e6);
    }

    function test_followsTheFeed() public {
        feed.setAnswer(400e8);
        assertEq(pool.quote(address(usdg), 1_000e6), 2.4925e18);
    }

    function test_revertsWhenCallbackDoesNotPay() public {
        payInCallback = false;
        bool zeroForOne = address(usdg) == pool.token0();
        vm.expectRevert(bytes("unpaid"));
        pool.swap(address(this), zeroForOne, int256(1_000e6), 0, "");
    }

    function test_refusesAnyOtherChain() public {
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(DeskTestnetOnly.WrongTestnet.selector, 4663));
        new DeskTestAsset("x", "x", 6, address(this));
    }
}

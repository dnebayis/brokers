// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StockRouter} from "../src/StockRouter.sol";
import {MockERC20, MockWETH} from "./Mocks.sol";

interface IV3CallbackTest {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

contract MockV3PoolRoute {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable rate;

    constructor(address token0_, address token1_, uint256 rate_) {
        token0 = token0_;
        token1 = token1_;
        rate = rate_;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        uint256 out = amountIn * rate;
        amount0 = zeroForOne ? int256(amountIn) : -int256(out);
        amount1 = zeroForOne ? -int256(out) : int256(amountIn);
        IV3CallbackTest(msg.sender).uniswapV3SwapCallback(amount0, amount1, "");
        MockERC20(zeroForOne ? token1 : token0).mint(recipient, out);
    }
}

contract MockRialtoPoolRoute {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable rate;

    constructor(address token0_, address token1_, uint256 rate_) {
        token0 = token0_;
        token1 = token1_;
        rate = rate_;
    }

    function swapExactIn(bool zeroForOne, uint256 amountIn, uint256, address to, uint256)
        external
        returns (uint256 out)
    {
        MockERC20(zeroForOne ? token0 : token1).transferFrom(msg.sender, address(this), amountIn);
        out = amountIn * rate;
        MockERC20(zeroForOne ? token1 : token0).mint(to, out);
    }
}

contract StockRouterTest is Test {
    MockWETH weth;
    MockERC20 mid;
    MockERC20 stock;
    MockV3PoolRoute midPool;
    StockRouter router;
    address user = makeAddr("user");

    function setUp() public {
        weth = new MockWETH();
        mid = new MockERC20("USDG", "USDG");
        stock = new MockERC20("Stock", "STK");
        midPool = new MockV3PoolRoute(address(weth), address(mid), 2);
        router = new StockRouter(address(weth), address(this));
    }

    function test_rialtoRouteValidatesPairsAndMeasuresOutput() public {
        MockRialtoPoolRoute stockPool = new MockRialtoPoolRoute(address(stock), address(mid), 3);
        router.setRoute(
            address(stock), address(midPool), address(mid), address(stockPool), StockRouter.PoolKind.Rialto
        );
        assertTrue(router.routeReady(address(stock)));

        uint256 out =
            router.swapExactETHForStock{value: 1 ether}(address(stock), 6 ether, user, block.timestamp);
        assertEq(out, 6 ether);
        assertEq(stock.balanceOf(user), 6 ether);
        assertEq(stock.balanceOf(address(router)), 0);
        assertEq(mid.balanceOf(address(router)), 0);
    }

    function test_v3SecondHopAndSlippage() public {
        MockV3PoolRoute stockPool = new MockV3PoolRoute(address(mid), address(stock), 4);
        router.setRoute(
            address(stock), address(midPool), address(mid), address(stockPool), StockRouter.PoolKind.V3
        );
        vm.expectRevert(abi.encodeWithSelector(StockRouter.Slippage.selector, 8 ether, 9 ether));
        router.swapExactETHForStock{value: 1 ether}(address(stock), 9 ether, user, block.timestamp);

        uint256 out =
            router.swapExactETHForStock{value: 1 ether}(address(stock), 8 ether, user, block.timestamp);
        assertEq(out, 8 ether);
    }

    function test_badPairsCallbackAndClearedRouteFailClosed() public {
        MockRialtoPoolRoute bad = new MockRialtoPoolRoute(address(weth), address(stock), 1);
        vm.expectRevert(StockRouter.InvalidRoute.selector);
        router.setRoute(
            address(stock), address(midPool), address(mid), address(bad), StockRouter.PoolKind.Rialto
        );

        vm.expectRevert(StockRouter.BadCallback.selector);
        router.uniswapV3SwapCallback(1, -1, "");

        MockRialtoPoolRoute good = new MockRialtoPoolRoute(address(mid), address(stock), 1);
        router.setRoute(
            address(stock), address(midPool), address(mid), address(good), StockRouter.PoolKind.Rialto
        );
        router.clearRoute(address(stock));
        vm.expectRevert(StockRouter.RouteNotSet.selector);
        router.swapExactETHForStock{value: 1}(address(stock), 0, user, block.timestamp);
    }
}

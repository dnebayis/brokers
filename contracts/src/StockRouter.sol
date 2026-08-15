// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface IWETHStockRouter {
    function deposit() external payable;
}

interface IV3PoolStockRouter {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IRialtoStockPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swapExactIn(
        bool zeroForOne,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        uint256 deadline
    ) external returns (uint256 amountOut);
}

/// @title StockRouter
/// @notice Allowlisted two-hop Robinhood stock route: ETH -> WETH -> mid token -> stock.
///         Pool pairs and directions are verified onchain when a route is installed.
contract StockRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for int256;
    using SafeCast for uint256;

    uint160 private constant MIN_SQRT_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    enum PoolKind {
        Rialto,
        V3
    }

    struct Route {
        address midPool;
        address midToken;
        address stockPool;
        PoolKind stockPoolKind;
        bool midZeroForOne;
        bool stockZeroForOne;
    }

    IWETHStockRouter public immutable weth;
    mapping(address stock => Route) public routes;
    address private _expectedPool;
    address private _payToken;

    error ZeroAddress();
    error InvalidRoute();
    error RouteNotSet();
    error Expired();
    error BadCallback();
    error Slippage(uint256 received, uint256 minimum);
    error ZeroInput();

    event RouteSet(
        address indexed stock,
        address midPool,
        address midToken,
        address stockPool,
        PoolKind kind,
        bool midZeroForOne,
        bool stockZeroForOne
    );
    event RouteCleared(address indexed stock);
    event StockBought(
        address indexed stock, uint256 ethIn, uint256 midOut, uint256 stockOut, address indexed to
    );

    constructor(address weth_, address owner_) Ownable(owner_) {
        if (weth_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        weth = IWETHStockRouter(weth_);
    }

    function setRoute(address stock, address midPool, address midToken, address stockPool, PoolKind kind)
        external
        onlyOwner
    {
        if (stock == address(0) || midPool == address(0) || midToken == address(0) || stockPool == address(0))
        {
            revert ZeroAddress();
        }
        (address m0, address m1) = _tokens(midPool);
        bool midDirection;
        if (m0 == address(weth) && m1 == midToken) midDirection = true;
        else if (m1 == address(weth) && m0 == midToken) midDirection = false;
        else revert InvalidRoute();

        (address s0, address s1) = _tokens(stockPool);
        bool stockDirection;
        if (s0 == midToken && s1 == stock) stockDirection = true;
        else if (s1 == midToken && s0 == stock) stockDirection = false;
        else revert InvalidRoute();

        routes[stock] = Route({
            midPool: midPool,
            midToken: midToken,
            stockPool: stockPool,
            stockPoolKind: kind,
            midZeroForOne: midDirection,
            stockZeroForOne: stockDirection
        });
        emit RouteSet(stock, midPool, midToken, stockPool, kind, midDirection, stockDirection);
    }

    function clearRoute(address stock) external onlyOwner {
        delete routes[stock];
        emit RouteCleared(stock);
    }

    function routeReady(address stock) external view returns (bool) {
        return routes[stock].stockPool != address(0);
    }

    function swapExactETHForStock(address stock, uint256 minOut, address to, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 amountOut)
    {
        if (to == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroInput();
        if (block.timestamp > deadline) revert Expired();
        Route memory route = routes[stock];
        if (route.stockPool == address(0)) revert RouteNotSet();

        weth.deposit{value: msg.value}();
        uint256 midOut = _v3Swap(route.midPool, address(weth), route.midZeroForOne, msg.value);

        uint256 beforeBalance = IERC20(stock).balanceOf(address(this));
        uint256 recipientBefore = IERC20(stock).balanceOf(to);
        if (route.stockPoolKind == PoolKind.Rialto) {
            IERC20(route.midToken).forceApprove(route.stockPool, midOut);
            IRialtoStockPool(route.stockPool)
                .swapExactIn(route.stockZeroForOne, midOut, minOut, address(this), deadline);
        } else {
            _v3Swap(route.stockPool, route.midToken, route.stockZeroForOne, midOut);
        }
        uint256 routerOut = IERC20(stock).balanceOf(address(this)) - beforeBalance;
        IERC20(stock).safeTransfer(to, routerOut);
        amountOut = IERC20(stock).balanceOf(to) - recipientBefore;
        if (amountOut < minOut) revert Slippage(amountOut, minOut);
        emit StockBought(stock, msg.value, midOut, amountOut, to);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != _expectedPool || _expectedPool == address(0)) revert BadCallback();
        int256 positive = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (positive <= 0) revert BadCallback();
        IERC20(_payToken).safeTransfer(msg.sender, positive.toUint256());
    }

    function _v3Swap(address pool, address payToken, bool zeroForOne, uint256 amountIn)
        internal
        returns (uint256 amountOut)
    {
        _expectedPool = pool;
        _payToken = payToken;
        (int256 amount0, int256 amount1) = IV3PoolStockRouter(pool)
            .swap(
                address(this),
                zeroForOne,
                amountIn.toInt256(),
                zeroForOne ? MIN_SQRT_PLUS_ONE : MAX_SQRT_MINUS_ONE,
                ""
            );
        _expectedPool = address(0);
        _payToken = address(0);
        int256 output = -(zeroForOne ? amount1 : amount0);
        if (output <= 0) revert InvalidRoute();
        amountOut = output.toUint256();
    }

    function _tokens(address pool) internal view returns (address token0, address token1) {
        token0 = IV3PoolStockRouter(pool).token0();
        token1 = IV3PoolStockRouter(pool).token1();
    }
}

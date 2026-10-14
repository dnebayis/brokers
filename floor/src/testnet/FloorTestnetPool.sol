// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface IFloorV3Callback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice TWO-WAY fixed-price v3-shaped test pool, deployable only on chain 46630.
///         The core repo's TestnetV3Pool is one-directional; the Floor needs sells and
///         fee flushes too, so this one honors both directions of the v3 swap interface.
contract FloorTestnetPool {
    using SafeERC20 for IERC20;
    using SafeCast for int256;
    using SafeCast for uint256;

    address public immutable token0;
    address public immutable token1;
    uint256 public immutable numerator; // out = in * numerator / denominator for 0 -> 1
    uint256 public immutable denominator;

    error WrongTestnet(uint256 chainId);

    constructor(address token0_, address token1_, uint256 numerator_, uint256 denominator_) {
        if (block.chainid != 46630) revert WrongTestnet(block.chainid);
        require(
            token0_ != address(0) && token1_ != address(0) && numerator_ != 0 && denominator_ != 0, "config"
        );
        token0 = token0_;
        token1 = token1_;
        numerator = numerator_;
        denominator = denominator_;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact-in only");
        uint256 amountIn = amountSpecified.toUint256();
        uint256 amountOut =
            zeroForOne ? amountIn * numerator / denominator : amountIn * denominator / numerator;
        (address inTok, address outTok) = zeroForOne ? (token0, token1) : (token1, token0);
        (amount0, amount1) =
            zeroForOne ? (amountSpecified, -amountOut.toInt256()) : (-amountOut.toInt256(), amountSpecified);
        uint256 beforeIn = IERC20(inTok).balanceOf(address(this));
        IERC20(outTok).safeTransfer(recipient, amountOut);
        IFloorV3Callback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(inTok).balanceOf(address(this)) - beforeIn == amountIn, "unpaid");
    }
}

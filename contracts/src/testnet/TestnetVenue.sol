// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface ITestnetV3Callback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

abstract contract TestnetOnly {
    error WrongTestnet(uint256 chainId);

    constructor() {
        if (block.chainid != 46630) revert WrongTestnet(block.chainid);
    }
}

/// @notice Explicitly test-only ERC-20 used for USDG and stock lifecycle testing.
contract TestnetAsset is ERC20, Ownable, TestnetOnly {
    constructor(string memory name_, string memory symbol_, address owner_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}

/// @notice Chainlink-compatible fixed test feed. It cannot be deployed on mainnet.
contract TestnetFeed is Ownable, TestnetOnly {
    int256 public answer;
    uint256 public updatedAt;

    constructor(address owner_, int256 answer_) Ownable(owner_) {
        setAnswer(answer_);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function setAnswer(int256 answer_) public onlyOwner {
        require(answer_ > 0, "answer");
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 value, uint256 startedAt, uint256 time, uint80 answeredInRound)
    {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @notice Inventory-funded v3-shaped pool for the WETH -> test USDG first hop.
contract TestnetV3Pool is TestnetOnly {
    using SafeERC20 for IERC20;
    using SafeCast for int256;
    using SafeCast for uint256;

    address public immutable token0;
    address public immutable token1;
    uint256 public immutable numerator;
    uint256 public immutable denominator;

    constructor(address token0_, address token1_, uint256 numerator_, uint256 denominator_) {
        require(token0_ != address(0) && token1_ != address(0) && denominator_ != 0, "config");
        token0 = token0_;
        token1 = token1_;
        numerator = numerator_;
        denominator = denominator_;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(zeroForOne && amountSpecified > 0, "direction");
        uint256 amountIn = amountSpecified.toUint256();
        uint256 amountOut = amountIn * numerator / denominator;
        uint256 beforeInput = IERC20(token0).balanceOf(address(this));
        ITestnetV3Callback(msg.sender).uniswapV3SwapCallback(amountSpecified, -amountOut.toInt256(), data);
        require(IERC20(token0).balanceOf(address(this)) - beforeInput == amountIn, "input");
        IERC20(token1).safeTransfer(recipient, amountOut);
        return (amountSpecified, -amountOut.toInt256());
    }
}

/// @notice Inventory-funded Rialto-shaped pool for test USDG -> test stock.
contract TestnetRialtoPool is TestnetOnly {
    using SafeERC20 for IERC20;

    address public immutable token0;
    address public immutable token1;
    uint256 public immutable numerator;
    uint256 public immutable denominator;

    constructor(address token0_, address token1_, uint256 numerator_, uint256 denominator_) {
        require(token0_ != address(0) && token1_ != address(0) && denominator_ != 0, "config");
        token0 = token0_;
        token1 = token1_;
        numerator = numerator_;
        denominator = denominator_;
    }

    function swapExactIn(
        bool zeroForOne,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        require(zeroForOne && block.timestamp <= deadline, "swap");
        amountOut = amountIn * numerator / denominator;
        require(amountOut >= minAmountOut, "slippage");
        IERC20(token0).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(token1).safeTransfer(to, amountOut);
    }
}

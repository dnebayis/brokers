// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// Test venue for the Desk rehearsal on Robinhood Chain testnet (46630), which has no USDG
/// and no Uniswap v3 USDG pools. Everything here refuses to deploy on any other chain, so it
/// can never end up next to the mainnet contracts.

interface IDeskTestCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

interface IDeskTestFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

abstract contract DeskTestnetOnly {
    error WrongTestnet(uint256 chainId);

    constructor() {
        if (block.chainid != 46630) revert WrongTestnet(block.chainid);
    }
}

/// @notice Owner-mintable test ERC-20 (test USDG at 6 decimals, extra test stocks at 18).
contract DeskTestAsset is ERC20, Ownable, DeskTestnetOnly {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address owner_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        _dec = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}

/// @notice Chainlink-shaped test feed (8 decimals) whose answer the owner sets.
contract DeskTestFeed is Ownable, DeskTestnetOnly {
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

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @notice Inventory-funded, v3-shaped USDG pool that fills at its feed's price minus a fixed
///         spread, in both directions. The engine sees the same interface as a real v3 pool:
///         exact-in `swap`, output paid first, input collected through the swap callback.
contract DeskTestPool is DeskTestnetOnly {
    using SafeERC20 for IERC20;

    address public immutable token0;
    address public immutable token1;
    address public immutable usdg;
    address public immutable asset;
    IDeskTestFeed public immutable feed;
    uint256 public immutable spreadBps;
    uint256 private immutable _usdgUnit;
    uint256 private immutable _assetUnit;

    constructor(address usdg_, address asset_, IDeskTestFeed feed_, uint256 spreadBps_) {
        require(usdg_ != address(0) && asset_ != address(0) && address(feed_) != address(0), "config");
        require(spreadBps_ < 10_000, "spread");
        (token0, token1) = usdg_ < asset_ ? (usdg_, asset_) : (asset_, usdg_);
        usdg = usdg_;
        asset = asset_;
        feed = feed_;
        spreadBps = spreadBps_;
        _usdgUnit = 10 ** IERC20Metadata(usdg_).decimals();
        _assetUnit = 10 ** IERC20Metadata(asset_).decimals();
    }

    /// @notice Output for an exact input at the feed price minus the spread.
    function quote(address tokenIn, uint256 amountIn) public view returns (uint256 out) {
        (, int256 px,,,) = feed.latestRoundData();
        require(px > 0, "feed");
        uint256 price = uint256(px); // USD, 8 decimals
        if (tokenIn == usdg) out = Math.mulDiv(amountIn * _assetUnit, 1e8, _usdgUnit * price);
        else out = Math.mulDiv(amountIn * price, _usdgUnit, _assetUnit * 1e8);
        out = (out * (10_000 - spreadBps)) / 10_000;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact-in only");
        uint256 amountIn = uint256(amountSpecified);
        (address tokenIn, address tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 amountOut = quote(tokenIn, amountIn);
        require(amountOut > 0, "dust");

        (amount0, amount1) =
            zeroForOne ? (amountSpecified, -int256(amountOut)) : (-int256(amountOut), amountSpecified);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        uint256 before = IERC20(tokenIn).balanceOf(address(this));
        IDeskTestCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(tokenIn).balanceOf(address(this)) >= before + amountIn, "unpaid");
    }
}

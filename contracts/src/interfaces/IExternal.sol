// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal external interfaces Coattail composes with on Robinhood Chain.
/// @dev These are the *existing* protocols we build on — we deploy none of them.

/// ERC-6551 canonical registry (same address on every EVM chain).
/// Address: 0x000000006551c19487814612e58FE06813775758
interface IERC6551Registry {
    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address account);

    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address account);
}

/// Robinhood ERC-8056 tokenized stock: `uiMultiplier` maps raw balance → display shares.
/// Official on-chain Chainlink stock feeds already quote the multiplier-adjusted token
/// price, so Booster must not apply this value a second time in its slippage floor.
interface IERC8056 {
    function uiMultiplier() external view returns (uint256);
}

/// Chainlink price feed (per-stock USD feeds for Booster slippage guards; optional ETH/USD).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// Uniswap v3 SwapRouter02 (verified on RH Chain: 0xcaf681a66d020601342297493863e78c959e5cb2).
/// v4 routing via UniversalRouter is an alternative; interface kept minimal for the skeleton.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// Canonical WETH on RH Chain: 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73.
interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IStockRouter {
    function swapExactETHForStock(address stock, uint256 minOut, address to, uint256 deadline)
        external
        payable
        returns (uint256 amountOut);
}

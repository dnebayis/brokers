// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title V4Types
/// @notice Minimal, self-contained Uniswap v4 types needed to build a hook. We intentionally
///         do NOT vendor the whole v4 monorepo — these mirror v4-core exactly (same struct
///         layout, same BalanceDelta packing, same IHooks selectors) so the deployed RH Chain
///         PoolManager encodes/decodes them identically.

type Currency is address;

using {currencyEquals as ==} for Currency global;

function currencyEquals(Currency a, Currency b) pure returns (bool) {
    return Currency.unwrap(a) == Currency.unwrap(b);
}

struct PoolKey {
    Currency currency0;
    Currency currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// v4-core SwapParams. amountSpecified < 0 => exact-input; > 0 => exact-output.
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

/// v4-core BalanceDelta: amount0 packed in the high 128 bits, amount1 in the low 128 bits.
/// Values are from the swapper's perspective (positive = credited/received, negative = owed).
type BalanceDelta is int256;

library BalanceDeltaLibrary {
    function amount0(BalanceDelta d) internal pure returns (int128) {
        return int128(BalanceDelta.unwrap(d) >> 128);
    }

    function amount1(BalanceDelta d) internal pure returns (int128) {
        return int128(BalanceDelta.unwrap(d));
    }
}

/// Only the PoolManager entrypoints a hook actually needs. `take` pulls a currency out of the
/// pool to `to`, creating a hook debt that the returned afterSwap delta settles.
interface IPoolManagerMinimal {
    function take(Currency currency, address to, uint256 amount) external;
}

/// Full IHooks selector surface (for `.afterSwap.selector`); a hook only implements the
/// callbacks its address-encoded permission flags enable — PoolManager never calls the rest.
interface IHooks {
    function beforeInitialize(address, PoolKey calldata, uint160) external returns (bytes4);
    function afterInitialize(address, PoolKey calldata, uint160, int24) external returns (bytes4);
    function beforeAddLiquidity(address, PoolKey calldata, bytes calldata, bytes calldata)
        external
        returns (bytes4);
    function afterAddLiquidity(
        address,
        PoolKey calldata,
        bytes calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external returns (bytes4, BalanceDelta);
    function beforeRemoveLiquidity(address, PoolKey calldata, bytes calldata, bytes calldata)
        external
        returns (bytes4);
    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        bytes calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external returns (bytes4, BalanceDelta);
    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        returns (bytes4, int256, uint24);
    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        returns (bytes4, int128);
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        returns (bytes4);
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        returns (bytes4);
}

/// v4-core Hooks permission flag bit positions (low 14 bits of the hook address).
library HookFlags {
    uint160 internal constant BEFORE_INITIALIZE_FLAG = 1 << 13;
    uint160 internal constant AFTER_INITIALIZE_FLAG = 1 << 12;
    uint160 internal constant BEFORE_ADD_LIQUIDITY_FLAG = 1 << 11;
    uint160 internal constant AFTER_ADD_LIQUIDITY_FLAG = 1 << 10;
    uint160 internal constant BEFORE_REMOVE_LIQUIDITY_FLAG = 1 << 9;
    uint160 internal constant AFTER_REMOVE_LIQUIDITY_FLAG = 1 << 8;
    uint160 internal constant BEFORE_SWAP_FLAG = 1 << 7;
    uint160 internal constant AFTER_SWAP_FLAG = 1 << 6;
    uint160 internal constant BEFORE_DONATE_FLAG = 1 << 5;
    uint160 internal constant AFTER_DONATE_FLAG = 1 << 4;
    uint160 internal constant BEFORE_SWAP_RETURNS_DELTA_FLAG = 1 << 3;
    uint160 internal constant AFTER_SWAP_RETURNS_DELTA_FLAG = 1 << 2;
    uint160 internal constant AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG = 1 << 1;
    uint160 internal constant AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG = 1 << 0;
    uint160 internal constant ALL_FLAGS_MASK = 0x3FFF; // low 14 bits
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Currency, PoolKey, SwapParams, BalanceDelta, BalanceDeltaLibrary} from "./v4/V4Types.sol";

interface IPoolManagerFull {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (BalanceDelta);
    function settle() external payable returns (uint256);
    function sync(Currency currency) external;
    function take(Currency currency, address to, uint256 amount) external;
}

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

/// @title CoatRouter
/// @notice A tiny, single-pool swap router for the $COAT/ETH Uniswap v4 pool (with the CoatFeeHook).
///         Gives a dapp one-call `buy` (ETH→COAT) and `sell` (COAT→ETH) with a caller-supplied
///         minimum-out, plus spot-price `quoteBuy`/`quoteSell` views for UI estimates.
/// @dev Pinned to one PoolKey built from the $COAT token + hook. ETH is always currency0 (address(0)).
contract CoatRouter {
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    IPoolManagerFull public immutable pm;
    IStateView public immutable state;
    address public immutable coat;
    PoolKey public key;
    bytes32 public immutable poolId;

    uint24 constant FEE = 10000;
    int24 constant TICK_SPACING = 200;
    uint160 constant MIN_SQRT = 4295128739;
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970342;
    uint256 constant Q96 = 0x1000000000000000000000000;

    error Slippage(uint256 out, uint256 min);
    error NotPoolManager();
    error RefundFailed();

    enum Kind {
        Buy,
        Sell
    }

    constructor(IPoolManagerFull pm_, IStateView state_, address coat_, address hook_) {
        pm = pm_;
        state = state_;
        coat = coat_;
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(coat_),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: hook_
        });
        poolId = keccak256(abi.encode(key));
    }

    /// @notice Swap ETH (msg.value) for $COAT, sending it to `to`. Reverts if out < `minCoatOut`.
    function buy(uint256 minCoatOut, address to) external payable returns (uint256 out) {
        uint256 balanceBefore = address(this).balance - msg.value;
        out = abi.decode(pm.unlock(abi.encode(Kind.Buy, msg.value, to)), (uint256));
        if (out < minCoatOut) revert Slippage(out, minCoatOut);
        uint256 refund = address(this).balance - balanceBefore;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice Swap `coatIn` $COAT for ETH, sending it to `to`. Caller must approve this router
    ///         for `coatIn` $COAT first. Reverts if out < `minEthOut`.
    function sell(uint256 coatIn, uint256 minEthOut, address to) external returns (uint256 out) {
        uint256 balanceBefore = IERC20(coat).balanceOf(address(this));
        IERC20(coat).safeTransferFrom(msg.sender, address(this), coatIn);
        out = abi.decode(pm.unlock(abi.encode(Kind.Sell, coatIn, to)), (uint256));
        if (out < minEthOut) revert Slippage(out, minEthOut);
        uint256 refund = IERC20(coat).balanceOf(address(this)) - balanceBefore;
        if (refund > 0) IERC20(coat).safeTransfer(msg.sender, refund);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(pm)) revert NotPoolManager();
        (Kind kind, uint256 amountIn, address to) = abi.decode(data, (Kind, uint256, address));

        if (kind == Kind.Buy) {
            BalanceDelta d = pm.swap(
                key,
                SwapParams({
                    zeroForOne: true, amountSpecified: -amountIn.toInt256(), sqrtPriceLimitX96: MIN_SQRT + 1
                }),
                ""
            );
            // owe currency0 (ETH), receive currency1 (COAT)
            pm.settle{value: uint256(uint128(-d.amount0()))}();
            uint256 out = uint256(uint128(d.amount1()));
            pm.take(key.currency1, to, out);
            return abi.encode(out);
        } else {
            BalanceDelta d = pm.swap(
                key,
                SwapParams({
                    zeroForOne: false, amountSpecified: -amountIn.toInt256(), sqrtPriceLimitX96: MAX_SQRT - 1
                }),
                ""
            );
            // owe currency1 (COAT), receive currency0 (ETH)
            pm.sync(key.currency1);
            IERC20(coat).safeTransfer(address(pm), uint256(uint128(-d.amount1())));
            pm.settle();
            uint256 out = uint256(uint128(d.amount0()));
            pm.take(key.currency0, to, out);
            return abi.encode(out);
        }
    }

    /// @notice Spot-price estimate of $COAT out for `ethIn` (ignores tick-crossing/slippage).
    function quoteBuy(uint256 ethIn) external view returns (uint256) {
        (uint160 sqrtP,,,) = state.getSlot0(poolId);
        // COAT per ETH = (sqrtP/2^96)^2 ; done in two mulDivs for full precision.
        return Math.mulDiv(Math.mulDiv(ethIn, sqrtP, Q96), sqrtP, Q96);
    }

    /// @notice Spot-price estimate of ETH out for `coatIn`.
    function quoteSell(uint256 coatIn) external view returns (uint256) {
        (uint160 sqrtP,,,) = state.getSlot0(poolId);
        return Math.mulDiv(Math.mulDiv(coatIn, Q96, sqrtP), Q96, sqrtP);
    }

    receive() external payable {}
}

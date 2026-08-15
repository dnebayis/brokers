// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {
    Currency,
    PoolKey,
    SwapParams,
    BalanceDelta,
    BalanceDeltaLibrary,
    IPoolManagerMinimal,
    IHooks,
    HookFlags
} from "./v4/V4Types.sol";

interface IStateViewHook {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

interface ICoatFeeBurn {
    function burn(uint256 amount) external;
}

interface ICoatLaunchGuard {
    function tradingEnabled() external view returns (bool);
    function restrictionsEndBlock() external view returns (uint256);
    function MAX_BUY() external view returns (uint256);
}

/// @title CoatFeeHook
/// @notice A Uniswap v4 `afterSwap` hook attached to the $COAT/ETH pool that skims a small
///         protocol fee from every swap and accrues it in the hook. `flush()` (permissionless)
///         then routes the ETH share to the FeeSplitter — the real engine of the flywheel per
///         FEE_MODEL — and the $COAT share to a burn/buyback sink.
///
/// @dev Why afterSwap + accrue + flush (not forward-per-swap): forwarding inside the swap would
///      let a reverting/hostile sink brick all trading. Accruing and flushing separately means a
///      swap can NEVER be blocked by downstream logic. The fee is taken on the *unspecified*
///      currency (the output on exact-input swaps, the input on exact-output) by returning a
///      positive hook delta, the canonical v4 fee-taking pattern.
///
///      DEPLOYMENT: v4 encodes a hook's permissions in its ADDRESS. This hook needs
///      BEFORE_INITIALIZE_FLAG | AFTER_SWAP_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG, i.e.
///      `uint160(addr) & 0x3FFF == 0x2044`. Deploy through AtomicV4Launcher with a mined salt;
///      the initializer gate and constructor permission check fail closed.
contract CoatFeeHook is Ownable2Step {
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeCast for int256;
    using SafeCast for uint256;

    IPoolManagerMinimal public immutable poolManager;
    IStateViewHook public immutable stateView;
    address public immutable coat; // $COAT token (currency1 in the pool)
    address public immutable launchInitializer;
    bytes32 public immutable poolId;

    uint256 internal constant Q96 = 1 << 96;
    uint16 internal constant OBSERVATION_CAPACITY = 64;
    uint64 internal constant MIN_OBSERVATION_SPACING = 30 seconds;

    struct Observation {
        uint64 timestamp;
        int24 tick;
        int256 tickCumulative;
        uint256 priceX96;
        uint256 priceCumulativeX96;
    }

    Observation[OBSERVATION_CAPACITY] public observations;
    uint16 public observationCount;
    uint16 public observationIndex;
    uint64 public liveTimestamp;
    int24 public liveTick;
    int256 public liveTickCumulative;
    uint256 public livePriceX96;
    uint256 public livePriceCumulativeX96;

    address payable public ethSink; // FeeSplitter — ETH fees fuel the flywheel

    uint16 public constant FEE_BPS = 100; // immutable 1% protocol fee

    uint160 internal constant REQUIRED_FLAGS = HookFlags.BEFORE_INITIALIZE_FLAG | HookFlags.AFTER_SWAP_FLAG
        | HookFlags.AFTER_SWAP_RETURNS_DELTA_FLAG; // 0x2044

    event FeeTaken(Currency indexed currency, uint256 amount);
    event Flushed(uint256 ethOut, uint256 coatOut);
    event EthSinkUpdated(address ethSink);

    error NotPoolManager();
    error InvalidHookAddress();
    error WrongPool();
    error InsufficientHistory();
    error ProtectedSwapTooLarge();
    error NotLaunchInitializer();

    modifier onlyPoolManager() {
        _checkPoolManager();
        _;
    }

    function _checkPoolManager() internal view {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
    }

    constructor(
        address owner_,
        IPoolManagerMinimal poolManager_,
        IStateViewHook stateView_,
        address coat_,
        address payable ethSink_,
        address launchInitializer_
    ) Ownable(owner_) {
        // fail fast if CREATE2 landed us at an address without the right permission bits
        if (uint160(address(this)) & HookFlags.ALL_FLAGS_MASK != REQUIRED_FLAGS) {
            revert InvalidHookAddress();
        }
        poolManager = poolManager_;
        stateView = stateView_;
        coat = coat_;
        if (launchInitializer_ == address(0)) revert NotLaunchInitializer();
        launchInitializer = launchInitializer_;
        PoolKey memory expectedKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(coat_),
            fee: 10_000,
            tickSpacing: 200,
            hooks: address(this)
        });
        poolId = keccak256(abi.encode(expectedKey));
        ethSink = ethSink_;
    }

    /// @notice Only the one-shot atomic launch contract may initialize this hook's pool.
    /// This closes the permissionless pre-initialization race for a publicly predictable key.
    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (keccak256(abi.encode(key)) != poolId) revert WrongPool();
        if (sender != launchInitializer) revert NotLaunchInitializer();
        return IHooks.beforeInitialize.selector;
    }

    /// @notice v4 callback after each swap. Skims `feeBps` of the unspecified-currency amount and
    ///         returns it as a positive hook delta (the swapper covers it). Never reverts on a
    ///         zero/near-zero fee — trading must not be blockable.
    function afterSwap(
        address, /* sender */
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata /* hookData */
    ) external onlyPoolManager returns (bytes4, int128) {
        if (keccak256(abi.encode(key)) != poolId) revert WrongPool();
        _recordObservation();

        // Token-level transfer caps remain useful for recipient concentration, but a custom
        // v4 unlock callback can settle one swap credit through several PoolManager.take calls.
        // Enforce the advertised per-buy ceiling here against the aggregate swap delta too.
        int128 coatDelta = delta.amount1();
        if (
            params.zeroForOne && coatDelta > 0 && ICoatLaunchGuard(coat).tradingEnabled()
                && block.number <= ICoatLaunchGuard(coat).restrictionsEndBlock()
                && int256(coatDelta).toUint256() > ICoatLaunchGuard(coat).MAX_BUY()
        ) revert ProtectedSwapTooLarge();
        uint16 bps = FEE_BPS;

        // Pick the *unspecified* currency and the swapper's delta on it (canonical v4 logic).
        (Currency feeCurrency, int128 unspecified) = (params.amountSpecified < 0 == params.zeroForOne)
            ? (key.currency1, delta.amount1())
            : (key.currency0, delta.amount0());

        int256 base = unspecified >= 0 ? int256(unspecified) : -int256(unspecified);
        uint256 feeAmount = (base.toUint256() * bps) / 10_000;
        if (feeAmount == 0) return (IHooks.afterSwap.selector, int128(0));

        // Pull the fee out of the pool into this hook; the returned positive delta settles it.
        poolManager.take(feeCurrency, address(this), feeAmount);
        emit FeeTaken(feeCurrency, feeAmount);

        return (IHooks.afterSwap.selector, feeAmount.toInt256().toInt128());
    }

    /// @notice Arithmetic-mean tick over a completed historical window.
    function consult(uint32 secondsAgo) external view returns (int24 arithmeticMeanTick) {
        if (secondsAgo == 0 || observationCount == 0 || secondsAgo > block.timestamp) {
            revert InsufficientHistory();
        }
        (int256 currentTickCumulative,, uint64 nowTs) = _currentCumulatives();
        (int256 targetCumulative,) = _cumulativesAt(uint64(nowTs - secondsAgo));
        int256 delta = currentTickCumulative - targetCumulative;
        int256 mean = delta / int256(uint256(secondsAgo));
        if (delta < 0 && delta % int256(uint256(secondsAgo)) != 0) --mean;
        if (mean < type(int24).min || mean > type(int24).max) revert InsufficientHistory();
        return mean.toInt24();
    }

    /// @notice Time-weighted COAT-per-ETH price, scaled by Q96.
    function consultPriceX96(uint32 secondsAgo) external view returns (uint256) {
        if (secondsAgo == 0 || observationCount == 0 || secondsAgo > block.timestamp) {
            revert InsufficientHistory();
        }
        (, uint256 currentPriceCumulative, uint64 nowTs) = _currentCumulatives();
        (, uint256 targetCumulative) = _cumulativesAt(uint64(nowTs - secondsAgo));
        return (currentPriceCumulative - targetCumulative) / secondsAgo;
    }

    function _recordObservation() internal {
        (uint160 sqrtPriceX96, int24 tick,,) = stateView.getSlot0(poolId);
        uint64 nowTs = uint64(block.timestamp);
        uint256 priceX96 = Math.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), Q96);

        if (observationCount == 0) {
            observations[0] = Observation({
                timestamp: nowTs, tick: tick, tickCumulative: 0, priceX96: priceX96, priceCumulativeX96: 0
            });
            observationCount = 1;
            observationIndex = 0;
            liveTimestamp = nowTs;
            liveTick = tick;
            livePriceX96 = priceX96;
            return;
        }

        uint256 liveElapsed = nowTs - liveTimestamp;
        liveTickCumulative += int256(liveTick) * liveElapsed.toInt256();
        livePriceCumulativeX96 += livePriceX96 * liveElapsed;
        liveTimestamp = nowTs;
        liveTick = tick;
        livePriceX96 = priceX96;

        Observation memory last = observations[observationIndex];
        uint256 elapsed = nowTs - last.timestamp;
        // Every swap updates the exact live accumulator above. Only historical checkpoints
        // are rate-limited, preventing dust-swap spam from evicting the 30-minute window.
        if (elapsed < MIN_OBSERVATION_SPACING) return;
        uint16 next = uint16((uint256(observationIndex) + 1) % OBSERVATION_CAPACITY);
        observations[next] = Observation({
            timestamp: nowTs,
            tick: tick,
            tickCumulative: liveTickCumulative,
            priceX96: priceX96,
            priceCumulativeX96: livePriceCumulativeX96
        });
        observationIndex = next;
        if (observationCount < OBSERVATION_CAPACITY) ++observationCount;
    }

    function _currentCumulatives()
        internal
        view
        returns (int256 tickCumulative, uint256 priceCumulative, uint64 nowTs)
    {
        if (observationCount == 0) revert InsufficientHistory();
        nowTs = uint64(block.timestamp);
        uint256 elapsed = nowTs - liveTimestamp;
        tickCumulative = liveTickCumulative + int256(liveTick) * elapsed.toInt256();
        priceCumulative = livePriceCumulativeX96 + livePriceX96 * elapsed;
    }

    function _cumulativesAt(uint64 target)
        internal
        view
        returns (int256 tickCumulative, uint256 priceCumulative)
    {
        Observation memory beforeOrAt;
        Observation memory afterOrAt;
        bool foundBefore;
        bool foundAfter;
        for (uint256 i; i < observationCount; ++i) {
            Observation memory candidate = observations[i];
            if (candidate.timestamp <= target && (!foundBefore || candidate.timestamp > beforeOrAt.timestamp))
            {
                beforeOrAt = candidate;
                foundBefore = true;
            }
            if (candidate.timestamp >= target && (!foundAfter || candidate.timestamp < afterOrAt.timestamp)) {
                afterOrAt = candidate;
                foundAfter = true;
            }
        }
        if (!foundBefore) revert InsufficientHistory();
        if (beforeOrAt.timestamp == target) {
            return (beforeOrAt.tickCumulative, beforeOrAt.priceCumulativeX96);
        }

        uint64 afterTimestamp;
        int256 afterTickCumulative;
        uint256 afterPriceCumulative;
        if (foundAfter) {
            afterTimestamp = afterOrAt.timestamp;
            afterTickCumulative = afterOrAt.tickCumulative;
            afterPriceCumulative = afterOrAt.priceCumulativeX96;
        } else {
            (afterTickCumulative, afterPriceCumulative, afterTimestamp) = _currentCumulatives();
        }
        uint256 span = afterTimestamp - beforeOrAt.timestamp;
        uint256 offset = target - beforeOrAt.timestamp;
        tickCumulative = beforeOrAt.tickCumulative
            + ((afterTickCumulative - beforeOrAt.tickCumulative) * offset.toInt256()) / span.toInt256();
        priceCumulative = beforeOrAt.priceCumulativeX96
            + Math.mulDiv(afterPriceCumulative - beforeOrAt.priceCumulativeX96, offset, span);
    }

    /// @notice Push accrued fees onward: ETH -> FeeSplitter (flywheel), $COAT -> real burn.
    ///         Permissionless. A failed ETH send does not revert (funds stay accrued, retryable).
    function flush() external {
        uint256 ethBal = address(this).balance;
        uint256 coatBal = IERC20(coat).balanceOf(address(this));
        uint256 ethOut;

        if (ethBal > 0 && ethSink != address(0)) {
            (bool ok,) = ethSink.call{value: ethBal}("");
            if (ok) ethOut = ethBal; // otherwise leave it accrued for a later retry
        }
        if (coatBal > 0) ICoatFeeBurn(coat).burn(coatBal);
        emit Flushed(ethOut, coatBal);
    }

    // --- admin ---
    function setEthSink(address payable ethSink_) external onlyOwner {
        ethSink = ethSink_;
        emit EthSinkUpdated(ethSink_);
    }

    receive() external payable {} // accepts ETH taken from the pool via PoolManager.take
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {DeskAccount} from "./DeskAccount.sol";

interface IDeskNFTView {
    function accountOf(uint256 tokenId) external view returns (address);
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IStrategyRegistryView {
    function getBasket(uint256 strategyId)
        external
        view
        returns (address[] memory tokens, uint16[] memory weightsBps, uint64 epoch);
}

interface IBoosterFeedView {
    function stockFeed(address token) external view returns (address);
}

interface IAggregatorV3Desk {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}

interface IV3PoolDesk {
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

interface IWETHDesk {
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
}

/// @title DeskEngine
/// @notice Executes the Congress basket for Desks: pulls USDG from a Desk's 6551 wallet
///         (through the wallet's narrow, owner-revocable `enginePull`), buys the live basket
///         through allowlisted Uniswap v3 USDG pools, and delivers every stock DIRECTLY into
///         the same Desk. Charges the service fee (0.5%, settable) and splits it
///         80% Booster (as native ETH) / 20% treasury — both shares settable.
/// @dev Price safety mirrors Booster: every swap carries a Chainlink-derived `minOut` floor,
///      with feeds READ from the deployed Booster's public `stockFeed` mapping (single source
///      of truth, zero core changes). Pool pairs and directions are verified on install, the
///      StockRouter pattern. The engine holds no user funds between transactions — only its
///      own accrued fees.
contract DeskEngine is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for int256;
    using SafeCast for uint256;

    uint160 private constant MIN_SQRT_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_MINUS_ONE = 1461446703485210103287273052203988822378723970341;
    uint16 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 100; // 1% hard ceiling on the service fee
    uint256 public constant MAX_SLIPPAGE_CEILING_BPS = 2000; // Booster's comparison-hardening rule

    // --- immutables ---
    IERC20 public immutable usdg;
    IWETHDesk public immutable weth;
    IDeskNFTView public immutable desks;
    IStrategyRegistryView public immutable registry;
    IBoosterFeedView public immutable boosterFeeds;
    uint256 public immutable strategyId;
    uint256 private immutable _usdgUnit; // 10**usdg.decimals()

    // --- settable levers (the 36,750 lesson) ---
    address public keeper;
    uint256 public feeBps = 50; // 0.5% — community vote
    uint256 public pilotCapUsdg; // per-desk deployed-capital ceiling (raw USDG units)
    uint256 public boosterShareBps = 8000; // 80/20 — user decision 2026-08-26
    address public boosterSink; // receives the ETH share (Booster's receive())
    address public treasury;
    uint256 public maxSlippageBps = 500;
    uint256 public feedStaleAfter = 1 days; // equities update slowly; Booster's default

    struct Route {
        address pool;
        bool usdgIsToken0;
    }

    mapping(address stock => Route) public routes;
    /// @notice USDG the engine has put to work per Desk, net of what sells returned.
    mapping(uint256 deskId => uint256) public deployedUsdg;
    /// @notice Service fees accrued (USDG), awaiting flush to Booster/treasury.
    uint256 public feesAccrued;
    address public ethPool; // WETH/USDG v3 pool used to convert fees to native ETH
    bool private _ethPoolUsdgIsToken0;

    address private _expectedPool;
    address private _payToken;

    event KeeperSet(address keeper);
    event FeeBpsSet(uint256 bps);
    event PilotCapSet(uint256 capRaw);
    event SplitSet(uint256 boosterShareBps, address boosterSink, address treasury);
    event SlippageSet(uint256 bps);
    event StaleWindowSet(uint256 secondsAfter);
    event PoolSet(address indexed stock, address pool);
    event EthPoolSet(address pool);
    event BasketBought(uint256 indexed deskId, uint256 usdgSpent, uint256 fee, uint64 epoch);
    event StockSold(
        uint256 indexed deskId, address indexed stock, uint256 stockIn, uint256 usdgOut, uint256 fee
    );
    event FeesFlushed(uint256 usdgIn, uint256 ethOut, uint256 toBooster, uint256 toTreasury);

    error NotKeeper();
    error ZeroAddress();
    error FeeTooHigh();
    error SlippageTooHigh();
    error InvalidPool();
    error RouteMissing(address stock);
    error NothingToDo();
    error GuardMissing(address stock);
    error BadFeed();
    error BadCallback();
    error CapExceeded(uint256 want, uint256 capLeft);
    error EthSendFailed();

    modifier onlyKeeper() {
        if (msg.sender != keeper && msg.sender != owner()) revert NotKeeper();
        _;
    }

    constructor(
        IERC20 usdg_,
        IWETHDesk weth_,
        IDeskNFTView desks_,
        IStrategyRegistryView registry_,
        IBoosterFeedView boosterFeeds_,
        uint256 strategyId_,
        address boosterSink_,
        address treasury_,
        address owner_
    ) Ownable(owner_) {
        if (
            address(usdg_) == address(0) || address(weth_) == address(0) || address(desks_) == address(0)
                || address(registry_) == address(0) || address(boosterFeeds_) == address(0)
                || boosterSink_ == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        usdg = usdg_;
        weth = weth_;
        desks = desks_;
        registry = registry_;
        boosterFeeds = boosterFeeds_;
        strategyId = strategyId_;
        boosterSink = boosterSink_;
        treasury = treasury_;
        keeper = owner_;
        _usdgUnit = 10 ** IERC20Metadata(address(usdg_)).decimals();
        pilotCapUsdg = 1000 * _usdgUnit; // $1,000 pilot cap — community vote
    }

    receive() external payable {} // WETH.withdraw pays native ETH here during fee flush

    // --- admin ---

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setFeeBps(uint256 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
        emit FeeBpsSet(bps);
    }

    function setPilotCap(uint256 capRaw) external onlyOwner {
        pilotCapUsdg = capRaw;
        emit PilotCapSet(capRaw);
    }

    function setSplit(uint256 boosterShareBps_, address boosterSink_, address treasury_) external onlyOwner {
        if (boosterShareBps_ > BPS) revert FeeTooHigh();
        if (boosterSink_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        boosterShareBps = boosterShareBps_;
        boosterSink = boosterSink_;
        treasury = treasury_;
        emit SplitSet(boosterShareBps_, boosterSink_, treasury_);
    }

    function setMaxSlippageBps(uint256 bps) external onlyOwner {
        if (bps > MAX_SLIPPAGE_CEILING_BPS) revert SlippageTooHigh();
        maxSlippageBps = bps;
        emit SlippageSet(bps);
    }

    function setFeedStaleAfter(uint256 secondsAfter) external onlyOwner {
        feedStaleAfter = secondsAfter;
        emit StaleWindowSet(secondsAfter);
    }

    /// @notice Allowlist the USDG/stock v3 pool for a stock. Pair verified onchain.
    function setPool(address stock, address pool) external onlyOwner {
        (address t0, address t1) = (IV3PoolDesk(pool).token0(), IV3PoolDesk(pool).token1());
        bool usdgIs0;
        if (t0 == address(usdg) && t1 == stock) usdgIs0 = true;
        else if (t1 == address(usdg) && t0 == stock) usdgIs0 = false;
        else revert InvalidPool();
        routes[stock] = Route({pool: pool, usdgIsToken0: usdgIs0});
        emit PoolSet(stock, pool);
    }

    /// @notice The WETH/USDG v3 pool used to convert accrued USDG fees into native ETH.
    function setEthPool(address pool) external onlyOwner {
        (address t0, address t1) = (IV3PoolDesk(pool).token0(), IV3PoolDesk(pool).token1());
        bool usdgIs0;
        if (t0 == address(usdg) && t1 == address(weth)) usdgIs0 = true;
        else if (t1 == address(usdg) && t0 == address(weth)) usdgIs0 = false;
        else revert InvalidPool();
        ethPool = pool;
        _ethPoolUsdgIsToken0 = usdgIs0;
        emit EthPoolSet(pool);
    }

    // --- execution (keeper) ---

    /// @notice Put a Desk's idle USDG to work on the live basket. Stock lands directly in the
    ///         Desk's wallet; the engine keeps only the service fee.
    function buyBasket(uint256 deskId, uint256 maxSpend) external nonReentrant onlyKeeper {
        address acct = desks.accountOf(deskId);
        uint256 bal = usdg.balanceOf(acct);
        uint256 spend = Math.min(bal, maxSpend);
        if (spend == 0) revert NothingToDo();
        uint256 capLeft = pilotCapUsdg > deployedUsdg[deskId] ? pilotCapUsdg - deployedUsdg[deskId] : 0;
        if (capLeft == 0) revert CapExceeded(spend, 0);
        spend = Math.min(spend, capLeft);

        (address[] memory tokens, uint16[] memory weights, uint64 epoch) = registry.getBasket(strategyId);
        if (tokens.length == 0) revert NothingToDo();

        DeskAccount(payable(acct)).enginePull(address(usdg), spend);
        uint256 fee = (spend * feeBps) / BPS;
        feesAccrued += fee;
        uint256 net = spend - fee;

        uint256 spent;
        for (uint256 i; i < tokens.length; ++i) {
            uint256 slice = (net * weights[i]) / BPS;
            if (slice == 0) continue;
            _swapUsdgForStock(tokens[i], slice, acct);
            spent += slice;
        }
        // rounding dust from slicing goes back to the desk, never stays here
        uint256 dust = net - spent;
        if (dust > 0) usdg.safeTransfer(acct, dust);

        // Cap accounting is GROSS (what left the desk), so fee shaving can never let a desk
        // creep past the pilot ceiling through repeated buys.
        deployedUsdg[deskId] += spend;
        emit BasketBought(deskId, spend, fee, epoch);
    }

    /// @notice Sell part of a Desk's stock back to USDG (rebalance / cash-out leg). Proceeds
    ///         return to the Desk net of the service fee.
    function sellStock(uint256 deskId, address stock, uint256 amount) external nonReentrant onlyKeeper {
        if (amount == 0) revert NothingToDo();
        address acct = desks.accountOf(deskId);
        DeskAccount(payable(acct)).enginePull(stock, amount);

        uint256 usdgOut = _swapStockForUsdg(stock, amount);
        uint256 fee = (usdgOut * feeBps) / BPS;
        feesAccrued += fee;
        uint256 net = usdgOut - fee;
        usdg.safeTransfer(acct, net);

        uint256 dep = deployedUsdg[deskId];
        deployedUsdg[deskId] = dep > net ? dep - net : 0;
        emit StockSold(deskId, stock, amount, usdgOut, fee);
    }

    /// @notice Convert accrued USDG fees to native ETH and split: boosterShare to the Booster's
    ///         receive() (native ETH is the only asset it accounts — the Zia lesson), rest to
    ///         treasury. `minEthOut` is the keeper's explicit sandwich floor.
    function flushFees(uint256 minEthOut) external nonReentrant onlyKeeper {
        uint256 amount = feesAccrued;
        if (amount == 0 || ethPool == address(0)) revert NothingToDo();
        feesAccrued = 0;

        uint256 wethOut = _v3Swap(ethPool, address(usdg), _ethPoolUsdgIsToken0, amount, address(this));
        if (wethOut < minEthOut) revert BadFeed();
        weth.withdraw(wethOut);

        uint256 toBooster = (wethOut * boosterShareBps) / BPS;
        uint256 toTreasury = wethOut - toBooster;
        (bool ok1,) = boosterSink.call{value: toBooster}("");
        (bool ok2,) = treasury.call{value: toTreasury}("");
        if (!ok1 || !ok2) revert EthSendFailed();
        emit FeesFlushed(amount, wethOut, toBooster, toTreasury);
    }

    // --- views ---

    function capLeftOf(uint256 deskId) external view returns (uint256) {
        uint256 dep = deployedUsdg[deskId];
        return pilotCapUsdg > dep ? pilotCapUsdg - dep : 0;
    }

    /// @notice Chainlink floor for buying `stock` with `usdgIn` (raw USDG units).
    function minStockOut(address stock, uint256 usdgIn) public view returns (uint256) {
        uint256 stockUsd8 = _stockUsd8(stock);
        // stocks are 18-dec; usd value(8dec) = usdgIn * 1e8 / usdgUnit
        uint256 expected = Math.mulDiv(usdgIn * (10 ** 18), 10 ** 8, _usdgUnit * stockUsd8);
        return (expected * (BPS - maxSlippageBps)) / BPS;
    }

    /// @notice Chainlink floor for selling `amount` of `stock` into USDG (raw units).
    function minUsdgOut(address stock, uint256 amount) public view returns (uint256) {
        uint256 stockUsd8 = _stockUsd8(stock);
        uint256 expected = Math.mulDiv(amount, stockUsd8 * _usdgUnit, 10 ** 26); // 1e18 * 1e8
        return (expected * (BPS - maxSlippageBps)) / BPS;
    }

    // --- internal ---

    function _stockUsd8(address stock) internal view returns (uint256) {
        address feed = boosterFeeds.stockFeed(stock);
        if (feed == address(0)) revert GuardMissing(stock);
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3Desk(feed).latestRoundData();
        if (answer <= 0) revert BadFeed();
        if (block.timestamp - updatedAt > feedStaleAfter) revert BadFeed();
        uint8 dec = IAggregatorV3Desk(feed).decimals();
        uint256 a = answer.toUint256();
        if (dec == 8) return a;
        if (dec < 8) return a * (10 ** (8 - dec));
        return a / (10 ** (dec - 8));
    }

    function _swapUsdgForStock(address stock, uint256 usdgIn, address recipient) internal {
        Route memory r = routes[stock];
        if (r.pool == address(0)) revert RouteMissing(stock);
        uint256 out = _v3Swap(r.pool, address(usdg), r.usdgIsToken0, usdgIn, recipient);
        if (out < minStockOut(stock, usdgIn)) revert BadFeed();
    }

    function _swapStockForUsdg(address stock, uint256 amount) internal returns (uint256 out) {
        Route memory r = routes[stock];
        if (r.pool == address(0)) revert RouteMissing(stock);
        out = _v3Swap(r.pool, stock, !r.usdgIsToken0, amount, address(this));
        if (out < minUsdgOut(stock, amount)) revert BadFeed();
    }

    function _v3Swap(address pool, address payToken, bool zeroForOne, uint256 amountIn, address recipient)
        internal
        returns (uint256 amountOut)
    {
        _expectedPool = pool;
        _payToken = payToken;
        (int256 a0, int256 a1) = IV3PoolDesk(pool)
            .swap(
                recipient,
                zeroForOne,
                amountIn.toInt256(),
                zeroForOne ? MIN_SQRT_PLUS_ONE : MAX_SQRT_MINUS_ONE,
                ""
            );
        _expectedPool = address(0);
        _payToken = address(0);
        int256 output = -(zeroForOne ? a1 : a0);
        if (output <= 0) revert InvalidPool();
        amountOut = output.toUint256();
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != _expectedPool || _expectedPool == address(0)) revert BadCallback();
        int256 positive = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (positive <= 0) revert BadCallback();
        IERC20(_payToken).safeTransfer(msg.sender, positive.toUint256());
    }
}

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

interface IStrategyRegistryFloor {
    function getBasket(uint256 strategyId)
        external
        view
        returns (address[] memory tokens, uint16[] memory weightsBps, uint64 epoch);
}

interface IBoosterFeedFloor {
    function stockFeed(address token) external view returns (address);
}

interface IAggregatorV3Floor {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}

interface IV3PoolFloor {
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

interface ICoatRouterFloor {
    function sell(uint256 coatIn, uint256 minEthOut, address to) external returns (uint256 out);
    function buy(uint256 minCoatOut, address to) external payable returns (uint256 out);
}

interface IWETHFloor {
    function deposit() external payable;
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
}

/// @title BasketRouter (The Floor), v2
/// @notice The Exchange Floor's execution contract: public single-stock swaps and
///         ONE-TRANSACTION basket buys over the allowlisted Uniswap v3 USDG stock pools of
///         Robinhood Chain. Preset 0 is always the LIVE Congress basket read from the
///         deployed StrategyRegistry; further presets are owner-curated. A service fee
///         (0.3%, settable, hard-capped at 1%) accrues here and is flushed as native ETH to
///         the Booster (Broker payroll), with an optional settable treasury share.
/// @dev Sibling of DeskEngine: same v3-callback swap core, same Chainlink floors (feeds READ
///      from the deployed Booster's public stockFeed mapping, zero core changes), same
///      no-custody rule: every output lands at `recipient` inside the same transaction, the
///      contract only ever holds its own accrued fees.
///
///      v2 (2026-10-14), against the deployed v1.3 (0x478F22A3):
///      - A basket preset skips names this router has no pool for and spreads their weight
///        over the routed names, like DeskEngine.buyBasket. v1 reverted the whole buy, so the
///        live basket stopped being buyable the day the registry posted a name outside the
///        router's seven pools. A custom basket still reverts on an unrouted leg: there the
///        caller chose the names.
///      - `sellBasket` hands a leg it has no pool for to `recipient` unchanged instead of
///        reverting: a Playbooks run, which pulls every claimed stock first, can no longer be
///        stopped, or leave stock in the engine, because one name has no pool here.
///      - Every swap is exact-in with one callback payment of exactly the input, and the
///        output is measured on the recipient's balance (DeskEngine audit 2026-10-02, fixes
///        2 and 3): a partial fill reverts instead of leaving input here, and a pool that
///        reports more than it pays is caught by the floor.
///      - Every ETH<->USDG leg (ETH and COAT entries, ETH and COAT exits, fee flush) is floored
///        by Chainlink ETH/USD when `ethUsdFeed` is set; v1 floored only the stock legs.
///      - `setPool` requires a Booster feed for the stock (every routed name is guarded) and
///        a pool can be removed; curated presets may only name routed stocks.
///      - A zero fee share sends nothing, so a treasury that refuses ETH never blocks a flush.
contract BasketRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for int256;
    using SafeCast for uint256;

    string public constant VERSION = "2";
    uint160 private constant MIN_SQRT_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_MINUS_ONE = 1461446703485210103287273052203988822378723970341;
    uint16 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 100; // 1% hard ceiling
    uint256 public constant MAX_SLIPPAGE_CEILING_BPS = 2000;
    uint256 public constant MAX_BASKET_LEGS = 12;
    uint256 public constant LIVE_CONGRESS_PRESET = 0;

    /// @notice Exit currency for sells: the same three doors the buys have.
    enum OutCurrency {
        USDG,
        ETH,
        COAT
    }

    // --- immutables ---
    IERC20 public immutable usdg;
    IWETHFloor public immutable weth;
    IStrategyRegistryFloor public immutable registry;
    IBoosterFeedFloor public immutable boosterFeeds;
    uint256 public immutable strategyId;
    uint256 private immutable _usdgUnit;

    // --- settable levers ---
    address public keeper;
    uint256 public feeBps = 30; // 0.3%
    uint256 public boosterShareBps = BPS; // every fee to the Booster unless a share is set
    address public boosterSink;
    address public treasury;
    uint256 public maxSlippageBps = 500;
    uint256 public feedStaleAfter = 4 days; // stock feeds: weekends trade at Friday's close
    IAggregatorV3Floor public ethUsdFeed; // optional Chainlink floor on every ETH<->USDG leg
    uint256 public ethFeedStaleAfter = 30 hours; // the Booster's ETH window (24h-heartbeat feed)

    struct Route {
        address pool;
        bool usdgIsToken0;
    }

    mapping(address stock => Route) public routes;
    address public ethPool; // WETH/USDG v3: ETH entry/exit leg + fee flush
    bool private _ethPoolUsdgIsToken0;
    // COAT entry leg: COAT -> native ETH through the hooked pool (CoatRouter), so paying with
    // COAT routes volume through the 1% hook, a basket buy that feeds the flywheel twice.
    address public coat;
    address public coatRouter;

    struct Preset {
        address[] tokens;
        uint16[] weightsBps;
        string name;
    }

    mapping(uint256 id => Preset) private _presets; // ids >= 1; 0 is the live registry basket
    uint256 public presetCount; // highest assigned curated preset id

    uint256 public feesAccrued; // USDG

    address private _expectedPool;
    address private _payToken;
    uint256 private _payAmount;

    event PoolSet(address indexed stock, address pool);
    event EthPoolSet(address pool);
    event EthUsdFeedSet(address feed, uint256 staleAfter);
    event CoatRouteSet(address coat, address coatRouter);
    event PresetSet(uint256 indexed id, string name, address[] tokens, uint16[] weightsBps);
    event KeeperSet(address keeper);
    event FeeBpsSet(uint256 bps);
    event SplitSet(uint256 boosterShareBps, address boosterSink, address treasury);
    event SlippageSet(uint256 bps);
    event StaleWindowSet(uint256 secondsAfter);
    event StockBought(
        address indexed recipient, address indexed stock, uint256 usdgIn, uint256 stockOut, uint256 fee
    );
    event StockSold(
        address indexed recipient, address indexed stock, uint256 stockIn, uint256 usdgOut, uint256 fee
    );
    /// @dev `legs` = names actually bought (a preset's unrouted names are skipped)
    event BasketBought(
        address indexed recipient, uint256 indexed presetId, uint256 usdgIn, uint256 legs, uint256 fee
    );
    /// @dev `legs` = names actually sold (legs handed back are reported by LegReturned)
    event BasketSold(
        address indexed recipient, uint256 usdgGross, uint256 legs, uint256 fee, uint8 outCurrency
    );
    /// @notice A sell leg this router has no pool for, handed to the recipient unchanged.
    event LegReturned(address indexed recipient, address indexed stock, uint256 amount);
    event FeesFlushed(uint256 usdgIn, uint256 ethOut, uint256 toBooster, uint256 toTreasury);

    error ZeroAddress();
    error Expired();
    error NotKeeper();
    error FeeTooHigh();
    error SlippageTooHigh();
    error InvalidPool();
    error RouteMissing(address stock);
    error GuardMissing(address stock);
    error BadFeed();
    error BadCallback();
    error BadBasket();
    error UnknownPreset();
    error ZeroInput();
    error NothingRouted();
    error Slippage(uint256 received, uint256 minimum);
    error PartialFill(uint256 paid, uint256 amountIn);
    error EthSendFailed();

    modifier notExpired(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    constructor(
        IERC20 usdg_,
        IWETHFloor weth_,
        IStrategyRegistryFloor registry_,
        IBoosterFeedFloor boosterFeeds_,
        uint256 strategyId_,
        address boosterSink_,
        address treasury_,
        address owner_
    ) Ownable(owner_) {
        if (
            address(usdg_) == address(0) || address(weth_) == address(0) || address(registry_) == address(0)
                || address(boosterFeeds_) == address(0) || boosterSink_ == address(0)
                || treasury_ == address(0)
        ) revert ZeroAddress();
        usdg = usdg_;
        weth = weth_;
        registry = registry_;
        boosterFeeds = boosterFeeds_;
        strategyId = strategyId_;
        boosterSink = boosterSink_;
        treasury = treasury_;
        keeper = owner_;
        _usdgUnit = 10 ** IERC20Metadata(address(usdg_)).decimals();
    }

    receive() external payable {} // WETH.withdraw during ETH exits and the flush, COAT sells

    // --- deployer levers ---

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

    /// @notice Chainlink ETH/USD floor for every ETH<->USDG leg. address(0) turns it off.
    function setEthUsdFeed(IAggregatorV3Floor feed, uint256 staleAfter) external onlyOwner {
        ethUsdFeed = feed;
        ethFeedStaleAfter = staleAfter;
        emit EthUsdFeedSet(address(feed), staleAfter);
    }

    /// @notice Route `stock` through `pool`, which must pair it with USDG; the stock must have
    ///         a Booster feed, so every routed leg is guarded. `pool == address(0)` removes it.
    function setPool(address stock, address pool) external onlyOwner {
        if (pool == address(0)) {
            delete routes[stock];
            emit PoolSet(stock, address(0));
            return;
        }
        if (boosterFeeds.stockFeed(stock) == address(0)) revert GuardMissing(stock);
        (address t0, address t1) = (IV3PoolFloor(pool).token0(), IV3PoolFloor(pool).token1());
        bool usdgIs0;
        if (t0 == address(usdg) && t1 == stock) usdgIs0 = true;
        else if (t1 == address(usdg) && t0 == stock) usdgIs0 = false;
        else revert InvalidPool();
        routes[stock] = Route({pool: pool, usdgIsToken0: usdgIs0});
        emit PoolSet(stock, pool);
    }

    function setEthPool(address pool) external onlyOwner {
        (address t0, address t1) = (IV3PoolFloor(pool).token0(), IV3PoolFloor(pool).token1());
        bool usdgIs0;
        if (t0 == address(usdg) && t1 == address(weth)) usdgIs0 = true;
        else if (t1 == address(usdg) && t0 == address(weth)) usdgIs0 = false;
        else revert InvalidPool();
        ethPool = pool;
        _ethPoolUsdgIsToken0 = usdgIs0;
        emit EthPoolSet(pool);
    }

    /// @notice Wire the COAT entry/exit leg (the hooked-pool router).
    function setCoatRoute(address coat_, address coatRouter_) external onlyOwner {
        if (coat_ == address(0) || coatRouter_ == address(0)) revert ZeroAddress();
        coat = coat_;
        coatRouter = coatRouter_;
        emit CoatRouteSet(coat_, coatRouter_);
    }

    /// @notice Create/replace a curated preset (id >= 1), routed names only. Id 0 is reserved:
    ///         the live Congress basket, read from the registry at execution time.
    function setPreset(uint256 id, string calldata name, address[] calldata tokens, uint16[] calldata weights)
        external
        onlyOwner
    {
        if (id == LIVE_CONGRESS_PRESET) revert UnknownPreset();
        _validateBasket(tokens, weights);
        for (uint256 i; i < tokens.length; ++i) {
            if (routes[tokens[i]].pool == address(0)) revert RouteMissing(tokens[i]);
        }
        _presets[id] = Preset({tokens: tokens, weightsBps: weights, name: name});
        if (id > presetCount) presetCount = id;
        emit PresetSet(id, name, tokens, weights);
    }

    /// @notice A preset as defined (preset 0: the registry basket as posted, every name).
    function preset(uint256 id)
        public
        view
        returns (address[] memory tokens, uint16[] memory weights, string memory name)
    {
        if (id == LIVE_CONGRESS_PRESET) {
            (tokens, weights,) = registry.getBasket(strategyId);
            return (tokens, weights, "Congress Live");
        }
        Preset storage p = _presets[id];
        if (p.tokens.length == 0) revert UnknownPreset();
        return (p.tokens, p.weightsBps, p.name);
    }

    /// @notice What a basket buy of preset `id` actually buys: the routed names with their
    ///         weights spread to sum 10,000 (the last routed name takes the rounding), and the
    ///         names skipped for want of a pool here. For display; the buy slices on the raw
    ///         routed weights.
    function basketLegs(uint256 id)
        external
        view
        returns (address[] memory tokens, uint16[] memory weights, address[] memory skipped)
    {
        (address[] memory all, uint16[] memory w,) = preset(id);
        uint256 routedWeight;
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            if (routes[all[i]].pool != address(0)) {
                routedWeight += w[i];
                ++n;
            }
        }
        tokens = new address[](n);
        weights = new uint16[](n);
        skipped = new address[](all.length - n);
        uint256 j;
        uint256 k;
        uint256 sum;
        for (uint256 i; i < all.length; ++i) {
            if (routes[all[i]].pool == address(0)) {
                skipped[k++] = all[i];
                continue;
            }
            tokens[j] = all[i];
            uint256 s = (uint256(w[i]) * BPS) / routedWeight;
            // s <= BPS: each routed weight is part of routedWeight
            // forge-lint: disable-next-line(unsafe-typecast)
            weights[j] = uint16(s);
            sum += s;
            ++j;
        }
        // the shares are floored, so BPS - sum is below n and fits uint16
        // forge-lint: disable-next-line(unsafe-typecast)
        if (n > 0) weights[n - 1] += uint16(BPS - sum);
    }

    // --- single-stock swaps ---

    /// @notice Buy one stock with USDG (caller approves USDG). Output lands at `recipient`.
    function buyStock(address stock, uint256 usdgIn, uint256 minOut, address recipient, uint256 deadline)
        external
        nonReentrant
        notExpired(deadline)
        returns (uint256 out)
    {
        if (usdgIn == 0) revert ZeroInput();
        usdg.safeTransferFrom(msg.sender, address(this), usdgIn);
        out = _buyAfterFee(stock, usdgIn, minOut, recipient);
    }

    /// @notice Buy one stock with native ETH (converted through the WETH/USDG pool first).
    function buyStockEth(address stock, uint256 minOut, address recipient, uint256 deadline)
        external
        payable
        nonReentrant
        notExpired(deadline)
        returns (uint256 out)
    {
        uint256 usdgIn = _ethToUsdg(msg.value);
        out = _buyAfterFee(stock, usdgIn, minOut, recipient);
    }

    /// @notice Sell one stock into USDG, native ETH or COAT. Caller approves the stock.
    function sellStock(
        address stock,
        uint256 amountIn,
        OutCurrency outCur,
        uint256 minOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant notExpired(deadline) returns (uint256 out) {
        if (amountIn == 0) revert ZeroInput();
        if (recipient == address(0)) revert ZeroAddress();
        if (routes[stock].pool == address(0)) revert RouteMissing(stock);
        IERC20(stock).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 usdgOut = _swapStockForUsdg(stock, amountIn);
        uint256 fee = (usdgOut * feeBps) / BPS;
        feesAccrued += fee;
        out = _payOut(usdgOut - fee, outCur, recipient, minOut);
        if (out < minOut) revert Slippage(out, minOut);
        emit StockSold(recipient, stock, amountIn, usdgOut, fee);
    }

    // --- the star product: one-transaction baskets ---

    /// @notice Buy a whole basket in ONE transaction, paying USDG. `presetId` 0 = the live
    ///         Congress basket. Names without a pool here are skipped and their weight spread
    ///         over the rest. Every leg is Chainlink-guarded; slicing dust returns to the caller.
    function buyBasket(uint256 presetId, uint256 usdgIn, address recipient, uint256 deadline)
        external
        nonReentrant
        notExpired(deadline)
    {
        if (usdgIn == 0) revert ZeroInput();
        usdg.safeTransferFrom(msg.sender, address(this), usdgIn);
        _buyBasketAfterFee(presetId, usdgIn, recipient);
    }

    /// @notice Same, paying native ETH.
    function buyBasketEth(uint256 presetId, address recipient, uint256 deadline)
        external
        payable
        nonReentrant
        notExpired(deadline)
    {
        uint256 usdgIn = _ethToUsdg(msg.value);
        _buyBasketAfterFee(presetId, usdgIn, recipient);
    }

    /// @notice Same, paying $COAT: sold for native ETH through the hooked pool (its 1% fee
    ///         flows back into the flywheel), then routed like an ETH buy. One transaction.
    function buyBasketCoat(
        uint256 presetId,
        uint256 coatIn,
        uint256 minEthFromCoat,
        address recipient,
        uint256 deadline
    ) external nonReentrant notExpired(deadline) {
        if (coatIn == 0) revert ZeroInput();
        if (coatRouter == address(0)) revert RouteMissing(coat);
        IERC20(coat).safeTransferFrom(msg.sender, address(this), coatIn);
        IERC20(coat).forceApprove(coatRouter, coatIn);
        uint256 ethBefore = address(this).balance;
        ICoatRouterFloor(coatRouter).sell(coatIn, minEthFromCoat, address(this));
        // measured, not reported: the ETH that actually arrived is what gets spent
        uint256 ethOut = address(this).balance - ethBefore;
        if (ethOut < minEthFromCoat) revert Slippage(ethOut, minEthFromCoat);
        uint256 usdgIn = _ethToUsdg(ethOut);
        _buyBasketAfterFee(presetId, usdgIn, recipient);
    }

    /// @notice One-transaction CUSTOM basket: caller supplies tokens and weights (sum 10000,
    ///         max 12 legs, every name routed), pays USDG.
    function buyCustomBasket(
        address[] calldata tokens,
        uint16[] calldata weights,
        uint256 usdgIn,
        address recipient,
        uint256 deadline
    ) external nonReentrant notExpired(deadline) {
        if (usdgIn == 0) revert ZeroInput();
        _validateBasket(tokens, weights);
        usdg.safeTransferFrom(msg.sender, address(this), usdgIn);
        _executeBasket(tokens, weights, usdgIn, recipient, type(uint256).max, false);
    }

    /// @notice Sell a whole set of stocks in ONE transaction. `amounts[i] == 0` means "my
    ///         entire balance of that stock", so a full basket exit is one approval set and
    ///         one click. Proceeds arrive as USDG, native ETH or COAT, fee charged once on the
    ///         total. A leg with no pool here is handed to `recipient` unchanged, fee-free.
    function sellBasket(
        address[] calldata tokens,
        uint256[] calldata amounts,
        OutCurrency outCur,
        uint256 minOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant notExpired(deadline) returns (uint256 out) {
        if (recipient == address(0)) revert ZeroAddress();
        if (tokens.length == 0 || tokens.length > MAX_BASKET_LEGS || tokens.length != amounts.length) {
            revert BadBasket();
        }
        (uint256 gross, uint256 sold, uint256 returned) = _sellLegs(tokens, amounts, recipient);
        if (gross == 0) {
            // nothing was sold: fine only if a leg was handed back and no minimum was asked
            if (returned == 0) revert ZeroInput();
            if (minOut > 0) revert Slippage(0, minOut);
            emit BasketSold(recipient, 0, 0, 0, uint8(outCur));
            return 0;
        }
        uint256 fee = (gross * feeBps) / BPS;
        feesAccrued += fee;
        out = _payOut(gross - fee, outCur, recipient, minOut);
        if (out < minOut) revert Slippage(out, minOut);
        emit BasketSold(recipient, gross, sold, fee, uint8(outCur));
    }

    function _sellLegs(address[] calldata tokens, uint256[] calldata amounts, address recipient)
        internal
        returns (uint256 gross, uint256 sold, uint256 returned)
    {
        for (uint256 i; i < tokens.length; ++i) {
            uint256 amt = amounts[i] == 0 ? IERC20(tokens[i]).balanceOf(msg.sender) : amounts[i];
            if (amt == 0) continue;
            if (routes[tokens[i]].pool == address(0)) {
                IERC20(tokens[i]).safeTransferFrom(msg.sender, recipient, amt);
                emit LegReturned(recipient, tokens[i], amt);
                ++returned;
                continue;
            }
            IERC20(tokens[i]).safeTransferFrom(msg.sender, address(this), amt);
            gross += _swapStockForUsdg(tokens[i], amt);
            ++sold;
        }
    }

    function _payOut(uint256 netUsdg, OutCurrency outCur, address recipient, uint256 minOut)
        internal
        returns (uint256 out)
    {
        if (outCur == OutCurrency.USDG) {
            out = netUsdg;
            usdg.safeTransfer(recipient, out);
            return out;
        }
        uint256 ethOut = _usdgToEth(netUsdg);
        if (outCur == OutCurrency.ETH) {
            out = ethOut;
            (bool ok,) = recipient.call{value: out}("");
            if (!ok) revert EthSendFailed();
        } else {
            // COAT exit: buy COAT through the hooked pool, the exit trade feeds the flywheel too
            if (coatRouter == address(0)) revert RouteMissing(coat);
            uint256 before = IERC20(coat).balanceOf(recipient);
            ICoatRouterFloor(coatRouter).buy{value: ethOut}(minOut, recipient);
            out = IERC20(coat).balanceOf(recipient) - before;
        }
    }

    // --- fee flush ---

    /// @notice Convert accrued USDG fees to native ETH and split: boosterShare to the
    ///         Booster's receive() (native ETH only, the Zia lesson), the rest to treasury.
    function flushFees(uint256 minEthOut_) external nonReentrant {
        if (msg.sender != keeper && msg.sender != owner()) revert NotKeeper();
        uint256 amount = feesAccrued;
        if (amount == 0 || ethPool == address(0)) revert ZeroInput();
        feesAccrued = 0;
        uint256 ethOut = _usdgToEth(amount);
        if (ethOut < minEthOut_) revert Slippage(ethOut, minEthOut_);
        uint256 toBooster = (ethOut * boosterShareBps) / BPS;
        uint256 toTreasury = ethOut - toBooster;
        if (toBooster > 0) {
            (bool ok,) = boosterSink.call{value: toBooster}("");
            if (!ok) revert EthSendFailed();
        }
        if (toTreasury > 0) {
            (bool ok,) = treasury.call{value: toTreasury}("");
            if (!ok) revert EthSendFailed();
        }
        emit FeesFlushed(amount, ethOut, toBooster, toTreasury);
    }

    // --- recovery (Booster's conservation rule: accrued fees are untouchable) ---

    /// @notice Recover tokens accidentally sent here: any token fully, except USDG, which can
    ///         only be swept ABOVE `feesAccrued`. Stray native ETH is recoverable with
    ///         token = address(0).
    function sweep(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) {
            uint256 ethBal = address(this).balance;
            if (ethBal == 0) return;
            (bool ok,) = to.call{value: ethBal}("");
            if (!ok) revert EthSendFailed();
            return;
        }
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 amount = token == address(usdg) ? bal - feesAccrued : bal;
        if (amount == 0) return;
        IERC20(token).safeTransfer(to, amount);
    }

    // --- views ---

    /// @notice Chainlink floor for buying `stock` with `usdgIn` raw units (before user slack).
    function minStockOut(address stock, uint256 usdgIn) public view returns (uint256) {
        uint256 stockUsd8 = _stockUsd8(stock);
        uint256 expected = Math.mulDiv(usdgIn * (10 ** 18), 10 ** 8, _usdgUnit * stockUsd8);
        return (expected * (BPS - maxSlippageBps)) / BPS;
    }

    function minUsdgOut(address stock, uint256 amount) public view returns (uint256) {
        uint256 stockUsd8 = _stockUsd8(stock);
        uint256 expected = Math.mulDiv(amount, stockUsd8 * _usdgUnit, 10 ** 26);
        return (expected * (BPS - maxSlippageBps)) / BPS;
    }

    /// @notice Chainlink floor for `usdgIn` raw USDG -> ETH (wei); 0 when no ETH/USD feed is set.
    function minEthOut(uint256 usdgIn) public view returns (uint256) {
        if (address(ethUsdFeed) == address(0)) return 0;
        uint256 expected = Math.mulDiv(usdgIn * (10 ** 18), 10 ** 8, _usdgUnit * _ethUsd8());
        return (expected * (BPS - maxSlippageBps)) / BPS;
    }

    /// @notice Chainlink floor for `ethIn` wei -> USDG (raw); 0 when no ETH/USD feed is set.
    function minUsdgForEth(uint256 ethIn) public view returns (uint256) {
        if (address(ethUsdFeed) == address(0)) return 0;
        uint256 expected = Math.mulDiv(ethIn, _ethUsd8() * _usdgUnit, 10 ** 26);
        return (expected * (BPS - maxSlippageBps)) / BPS;
    }

    // --- internal ---

    function _ethToUsdg(uint256 ethIn) internal returns (uint256 usdgOut) {
        if (ethIn == 0) revert ZeroInput();
        if (ethPool == address(0)) revert RouteMissing(address(weth));
        weth.deposit{value: ethIn}();
        usdgOut = _v3Swap(ethPool, address(weth), !_ethPoolUsdgIsToken0, ethIn, address(this));
        if (usdgOut < minUsdgForEth(ethIn)) revert BadFeed();
    }

    function _usdgToEth(uint256 usdgIn) internal returns (uint256 ethOut) {
        if (ethPool == address(0)) revert RouteMissing(address(weth));
        ethOut = _v3Swap(ethPool, address(usdg), _ethPoolUsdgIsToken0, usdgIn, address(this));
        if (ethOut < minEthOut(usdgIn)) revert BadFeed();
        weth.withdraw(ethOut);
    }

    function _buyAfterFee(address stock, uint256 usdgIn, uint256 minOut, address recipient)
        internal
        returns (uint256 out)
    {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 fee = (usdgIn * feeBps) / BPS;
        feesAccrued += fee;
        uint256 net = usdgIn - fee;
        out = _swapUsdgForStock(stock, net, recipient);
        if (out < minOut) revert Slippage(out, minOut);
        emit StockBought(recipient, stock, usdgIn, out, fee);
    }

    function _buyBasketAfterFee(uint256 presetId, uint256 usdgIn, address recipient) internal {
        (address[] memory tokens, uint16[] memory weights,) = preset(presetId);
        if (tokens.length == 0 || tokens.length > MAX_BASKET_LEGS || tokens.length != weights.length) {
            revert BadBasket();
        }
        _executeBasket(tokens, weights, usdgIn, recipient, presetId, true);
    }

    /// @dev `skipUnrouted`: a preset skips names without a pool and slices over the routed
    ///      weight; a custom basket reverts on one (the caller picked it).
    function _executeBasket(
        address[] memory tokens,
        uint16[] memory weights,
        uint256 usdgIn,
        address recipient,
        uint256 presetId,
        bool skipUnrouted
    ) internal {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 routedWeight;
        for (uint256 i; i < tokens.length; ++i) {
            if (routes[tokens[i]].pool != address(0)) routedWeight += weights[i];
            else if (!skipUnrouted) revert RouteMissing(tokens[i]);
        }
        if (routedWeight == 0) revert NothingRouted();
        uint256 fee = (usdgIn * feeBps) / BPS;
        feesAccrued += fee;
        uint256 net = usdgIn - fee;
        uint256 spent;
        uint256 legs;
        for (uint256 i; i < tokens.length; ++i) {
            if (routes[tokens[i]].pool == address(0)) continue;
            uint256 slice = (net * weights[i]) / routedWeight;
            if (slice == 0) continue;
            _swapUsdgForStock(tokens[i], slice, recipient);
            spent += slice;
            ++legs;
        }
        uint256 dust = net - spent;
        if (dust > 0) usdg.safeTransfer(msg.sender, dust);
        emit BasketBought(recipient, presetId, usdgIn, legs, fee);
    }

    function _validateBasket(address[] calldata tokens, uint16[] calldata weights) internal pure {
        if (tokens.length == 0 || tokens.length > MAX_BASKET_LEGS || tokens.length != weights.length) {
            revert BadBasket();
        }
        uint256 sum;
        for (uint256 i; i < weights.length; ++i) {
            sum += weights[i];
        }
        if (sum != BPS) revert BadBasket();
    }

    function _stockUsd8(address stock) internal view returns (uint256) {
        address feed = boosterFeeds.stockFeed(stock);
        if (feed == address(0)) revert GuardMissing(stock);
        return _read8(IAggregatorV3Floor(feed), feedStaleAfter);
    }

    function _ethUsd8() internal view returns (uint256) {
        return _read8(ethUsdFeed, ethFeedStaleAfter);
    }

    function _read8(IAggregatorV3Floor feed, uint256 staleAfter) internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert BadFeed();
        if (block.timestamp - updatedAt > staleAfter) revert BadFeed();
        uint8 dec = feed.decimals();
        uint256 a = answer.toUint256();
        if (dec == 8) return a;
        if (dec < 8) return a * (10 ** (8 - dec));
        return a / (10 ** (dec - 8));
    }

    function _swapUsdgForStock(address stock, uint256 usdgIn, address recipient)
        internal
        returns (uint256 out)
    {
        Route memory r = routes[stock];
        if (r.pool == address(0)) revert RouteMissing(stock);
        out = _v3Swap(r.pool, address(usdg), r.usdgIsToken0, usdgIn, recipient);
        if (out < minStockOut(stock, usdgIn)) revert BadFeed();
    }

    function _swapStockForUsdg(address stock, uint256 amount) internal returns (uint256 out) {
        Route memory r = routes[stock];
        if (r.pool == address(0)) revert RouteMissing(stock);
        out = _v3Swap(r.pool, stock, !r.usdgIsToken0, amount, address(this));
        if (out < minUsdgOut(stock, amount)) revert BadFeed();
    }

    /// @dev Exact-in: the pool must take exactly `amountIn` (once, in the callback), and the
    ///      output is what the recipient's balance actually gained, not what the pool reports.
    function _v3Swap(address pool, address payToken, bool zeroForOne, uint256 amountIn, address recipient)
        internal
        returns (uint256 amountOut)
    {
        IERC20 outToken = IERC20(zeroForOne ? IV3PoolFloor(pool).token1() : IV3PoolFloor(pool).token0());
        uint256 before = outToken.balanceOf(recipient);
        _expectedPool = pool;
        _payToken = payToken;
        _payAmount = amountIn;
        (int256 a0, int256 a1) = IV3PoolFloor(pool)
            .swap(
                recipient,
                zeroForOne,
                amountIn.toInt256(),
                zeroForOne ? MIN_SQRT_PLUS_ONE : MAX_SQRT_MINUS_ONE,
                ""
            );
        _expectedPool = address(0);
        _payToken = address(0);
        _payAmount = 0;
        int256 paid = zeroForOne ? a0 : a1;
        if (paid != amountIn.toInt256()) revert PartialFill(paid > 0 ? paid.toUint256() : 0, amountIn);
        amountOut = outToken.balanceOf(recipient) - before;
        if (amountOut == 0) revert InvalidPool();
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != _expectedPool || _expectedPool == address(0)) revert BadCallback();
        int256 positive = amount0Delta > 0 ? amount0Delta : amount1Delta;
        // exactly the input, once: a pool can neither take more nor leave part of it here
        if (positive <= 0 || positive.toUint256() != _payAmount) {
            revert PartialFill(positive > 0 ? positive.toUint256() : 0, _payAmount);
        }
        _expectedPool = address(0);
        IERC20(_payToken).safeTransfer(msg.sender, _payAmount);
    }
}

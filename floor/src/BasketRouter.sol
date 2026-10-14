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

/// @title BasketRouter
/// @notice The Exchange Floor's execution contract: public single-stock swaps and
///         ONE-TRANSACTION basket buys over the allowlisted Uniswap v3 USDG stock pools of
///         Robinhood Chain. Preset 0 is always the LIVE Congress basket read from the
///         deployed StrategyRegistry; further presets are owner-curated. A service fee
///         (0.3%, settable, hard-capped at 1%) accrues here and is flushed as native ETH,
///         80% to the Booster (Broker payroll) / 20% to treasury — both settable.
/// @dev Sibling of DeskEngine: same v3-callback swap core, same Chainlink `minOut` floors
///      (feeds READ from the deployed Booster's public stockFeed mapping — zero core
///      changes), same no-custody rule: every output lands at `recipient` inside the same
///      transaction, the contract only ever holds its own accrued fees.
contract BasketRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for int256;
    using SafeCast for uint256;

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
    uint256 public boosterShareBps = 8000;
    address public boosterSink;
    address public treasury;
    uint256 public maxSlippageBps = 500;
    uint256 public feedStaleAfter = 1 days;

    struct Route {
        address pool;
        bool usdgIsToken0;
    }

    mapping(address stock => Route) public routes;
    address public ethPool; // WETH/USDG v3: ETH entry leg + fee flush
    bool private _ethPoolUsdgIsToken0;
    // COAT entry leg: COAT -> native ETH through the hooked pool (CoatRouter), so paying with
    // COAT routes volume through the 1% hook — a basket buy that feeds the flywheel twice.
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

    event PoolSet(address indexed stock, address pool);
    event EthPoolSet(address pool);
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
    event BasketBought(
        address indexed recipient, uint256 indexed presetId, uint256 usdgIn, uint256 legs, uint256 fee
    );
    event BasketSold(
        address indexed recipient, uint256 usdgGross, uint256 legs, uint256 fee, uint8 outCurrency
    );
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
    error Slippage(uint256 received, uint256 minimum);
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

    receive() external payable {} // WETH.withdraw during ETH exits and fee flush

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

    function setPool(address stock, address pool) external onlyOwner {
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

    /// @notice Wire the COAT entry leg (the hooked-pool router). Settable like every lever.
    function setCoatRoute(address coat_, address coatRouter_) external onlyOwner {
        if (coat_ == address(0) || coatRouter_ == address(0)) revert ZeroAddress();
        coat = coat_;
        coatRouter = coatRouter_;
        emit CoatRouteSet(coat_, coatRouter_);
    }

    /// @notice Create/replace a curated preset (id >= 1). Id 0 is reserved: the live Congress
    ///         basket, read from the registry at execution time and never stored here.
    function setPreset(uint256 id, string calldata name, address[] calldata tokens, uint16[] calldata weights)
        external
        onlyOwner
    {
        if (id == LIVE_CONGRESS_PRESET) revert UnknownPreset();
        _validateBasket(tokens, weights);
        _presets[id] = Preset({tokens: tokens, weightsBps: weights, name: name});
        if (id > presetCount) presetCount = id;
        emit PresetSet(id, name, tokens, weights);
    }

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
        uint256 usdgIn = _ethToUsdg();
        out = _buyAfterFee(stock, usdgIn, minOut, recipient);
    }

    /// @notice Sell one stock into USDG (or native ETH). Caller approves the stock.
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
    ///         Congress basket. Every leg is Chainlink-guarded; slicing dust returns to the
    ///         caller, never stays here.
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
        uint256 usdgIn = _ethToUsdg();
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
        uint256 ethOut = ICoatRouterFloor(coatRouter).sell(coatIn, minEthFromCoat, address(this));
        weth.deposit{value: ethOut}();
        uint256 usdgIn = _v3Swap(ethPool, address(weth), !_ethPoolUsdgIsToken0, ethOut, address(this));
        _buyBasketAfterFee(presetId, usdgIn, recipient);
    }

    /// @notice One-transaction CUSTOM basket: caller supplies tokens and weights (sum 10000,
    ///         max 12 legs), pays USDG.
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
        _executeBasket(tokens, weights, usdgIn, recipient, type(uint256).max);
    }

    /// @notice Sell a whole set of stocks in ONE transaction. `amounts[i] == 0` means "my
    ///         entire balance of that stock" — so a full basket exit is one approval set and
    ///         one click. Proceeds arrive as USDG or native ETH, fee charged once on the total.
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
        uint256 gross = _sellLegs(tokens, amounts);
        if (gross == 0) revert ZeroInput();
        uint256 fee = (gross * feeBps) / BPS;
        feesAccrued += fee;
        out = _payOut(gross - fee, outCur, recipient, minOut);
        if (out < minOut) revert Slippage(out, minOut);
        emit BasketSold(recipient, gross, tokens.length, fee, uint8(outCur));
    }

    function _sellLegs(address[] calldata tokens, uint256[] calldata amounts)
        internal
        returns (uint256 gross)
    {
        for (uint256 i; i < tokens.length; ++i) {
            uint256 amt = amounts[i] == 0 ? IERC20(tokens[i]).balanceOf(msg.sender) : amounts[i];
            if (amt == 0) continue;
            IERC20(tokens[i]).safeTransferFrom(msg.sender, address(this), amt);
            gross += _swapStockForUsdg(tokens[i], amt);
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
        uint256 ethOut = _v3Swap(ethPool, address(usdg), _ethPoolUsdgIsToken0, netUsdg, address(this));
        weth.withdraw(ethOut);
        if (outCur == OutCurrency.ETH) {
            out = ethOut;
            (bool ok,) = recipient.call{value: out}("");
            if (!ok) revert EthSendFailed();
        } else {
            // COAT exit: buy COAT through the hooked pool — the exit trade feeds the flywheel too
            if (coatRouter == address(0)) revert RouteMissing(coat);
            out = ICoatRouterFloor(coatRouter).buy{value: ethOut}(minOut, recipient);
        }
    }

    // --- fee flush ---

    /// @notice Convert accrued USDG fees to native ETH and split: boosterShare to the
    ///         Booster's receive() (native ETH only — the Zia lesson), rest to treasury.
    function flushFees(uint256 minEthOut) external nonReentrant {
        if (msg.sender != keeper && msg.sender != owner()) revert NotKeeper();
        uint256 amount = feesAccrued;
        if (amount == 0 || ethPool == address(0)) revert ZeroInput();
        feesAccrued = 0;
        uint256 wethOut = _v3Swap(ethPool, address(usdg), _ethPoolUsdgIsToken0, amount, address(this));
        if (wethOut < minEthOut) revert Slippage(wethOut, minEthOut);
        weth.withdraw(wethOut);
        uint256 toBooster = (wethOut * boosterShareBps) / BPS;
        uint256 toTreasury = wethOut - toBooster;
        (bool ok1,) = boosterSink.call{value: toBooster}("");
        (bool ok2,) = treasury.call{value: toTreasury}("");
        if (!ok1 || !ok2) revert EthSendFailed();
        emit FeesFlushed(amount, wethOut, toBooster, toTreasury);
    }

    // --- recovery (Booster's conservation rule: accrued fees are untouchable) ---

    /// @notice Recover tokens accidentally sent here: any token fully, except USDG, which can
    ///         only be swept ABOVE `feesAccrued` — the fee entitlement can never leave through
    ///         this door. Stray native ETH (there is none in normal operation) is recoverable
    ///         with token = address(0).
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

    // --- internal ---

    function _ethToUsdg() internal returns (uint256 usdgIn) {
        if (msg.value == 0) revert ZeroInput();
        if (ethPool == address(0)) revert RouteMissing(address(weth));
        weth.deposit{value: msg.value}();
        usdgIn = _v3Swap(ethPool, address(weth), !_ethPoolUsdgIsToken0, msg.value, address(this));
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
        if (tokens.length == 0 || tokens.length > MAX_BASKET_LEGS) revert BadBasket();
        _executeBasket(tokens, weights, usdgIn, recipient, presetId);
    }

    function _executeBasket(
        address[] memory tokens,
        uint16[] memory weights,
        uint256 usdgIn,
        address recipient,
        uint256 presetId
    ) internal {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 fee = (usdgIn * feeBps) / BPS;
        feesAccrued += fee;
        uint256 net = usdgIn - fee;
        uint256 spent;
        for (uint256 i; i < tokens.length; ++i) {
            uint256 slice = (net * weights[i]) / BPS;
            if (slice == 0) continue;
            _swapUsdgForStock(tokens[i], slice, recipient);
            spent += slice;
        }
        uint256 dust = net - spent;
        if (dust > 0) usdg.safeTransfer(msg.sender, dust);
        emit BasketBought(recipient, presetId, usdgIn, tokens.length, fee);
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
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3Floor(feed).latestRoundData();
        if (answer <= 0) revert BadFeed();
        if (block.timestamp - updatedAt > feedStaleAfter) revert BadFeed();
        uint8 dec = IAggregatorV3Floor(feed).decimals();
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

    function _v3Swap(address pool, address payToken, bool zeroForOne, uint256 amountIn, address recipient)
        internal
        returns (uint256 amountOut)
    {
        _expectedPool = pool;
        _payToken = payToken;
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

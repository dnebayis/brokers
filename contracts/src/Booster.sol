// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {StrategyRegistry} from "./StrategyRegistry.sol";
import {CoattailBroker} from "./CoattailBroker.sol";
import {IStockRouter, IWETH, IAggregatorV3} from "./interfaces/IExternal.sol";

/// @title Booster
/// @notice The engine of the flywheel. Receives fee ETH, and — when poked — buys the
///         strategy's target basket of real stock tokens on Uniswap and credits them
///         to Brokers via a pull-based accumulator. Owners `claim` their accrued stock
///         into their Broker's ERC-6551 wallet.
/// @dev Pull-based (MasterChef-style) so we never loop over 1,776 wallets. Only *active*
///      Brokers earn: accPerShare = amountBought / activeShares. A Broker becomes a share
///      when its owner burns $COAT to activate, and stops being one when transferred.
///      Rewards accrued while active are crystallized on deactivation so an inactive
///      Broker can never claim rewards bought while it was off.
contract Booster is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;
    using SafeCast for int256;
    // --- immutables ---
    CoattailBroker public immutable brokers;
    StrategyRegistry public immutable registry;
    IStockRouter public immutable router;
    IWETH public immutable weth;
    uint256 public strategyId; // v1: 0 (The Politician)

    // --- keeper config ---
    uint256 public pokeThreshold = 0.02 ether; // min buffered ETH before a poke is allowed
    uint256 public constant MAX_POKE_BATCH = 1 ether;
    uint256 public constant SCALE = 1e18;
    uint16 public constant BPS = 10_000;

    // --- slippage guard (Chainlink-derived amountOutMinimum) ---
    // Expected out for an ETH slice is priced from feeds: expectedTokens ≈ ethIn * (ETH/USD) / (stock/USD).
    // A swap must return at least (1 - maxSlippageBps) of that, or it reverts — bounding sandwiches.
    IAggregatorV3 public ethUsdFeed; // ETH/USD; may be unset on RH Chain
    uint256 public ethUsdManualE8; // owner fallback price (8 decimals)
    uint64 public ethUsdManualAt; // when the manual price was set
    mapping(address token => IAggregatorV3) public stockFeed; // per-stock USD feed
    mapping(address token => bool) public allowUnguarded; // explicit opt-out (fresh pools/bootstrap)
    uint256 public maxSlippageBps = 500; // 5% default
    // Hard ceiling on the tolerance the owner may set (comparison hardening): even a compromised
    // owner cannot silently zero the sandwich guard for ALL tokens by cranking this to 100%. The
    // only way to fully drop the floor is the per-token, event-logged `allowUnguarded` opt-out.
    uint256 public constant MAX_SLIPPAGE_CEILING_BPS = 2000; // 20%
    uint256 public ethFeedStaleAfter = 1 hours;
    uint256 public stockFeedStaleAfter = 1 days; // equities update slowly; wide window
    // M-2: the manual ETH/USD fallback backs the sandwich guard, so it must stay fresh. A tight
    // default forces the refresher bot to keep it current; a day-stale price would let ETH drift
    // far enough to loosen the min-out floor. Owner can retune via setStaleWindows.
    uint256 public manualStaleAfter = 30 minutes;

    // --- reward accounting ---
    // accPerShare[token] = cumulative token bought per *active* Broker share, scaled by 1e18.
    mapping(address token => uint256) public accPerShare;
    // conservation counters (M-4): let the owner recover only tokens that are NOT owed to any
    // Broker (accidental transfers / airdrops), never the entitlement itself.
    mapping(address token => uint256) public totalBought; // raw units the Booster has purchased
    mapping(address token => uint256) public totalClaimed; // raw units already paid out
    // debt[tokenId][token] = accPerShare checkpoint already accounted to this Broker.
    mapping(uint256 tokenId => mapping(address token => uint256)) public rewardDebt;
    // pending[tokenId][token] = rewards crystallized at deactivation, awaiting claim.
    mapping(uint256 tokenId => mapping(address token => uint256)) public pending;
    // activeShares = number of currently-active Brokers (the poke denominator).
    uint256 public activeShares;
    mapping(uint256 tokenId => bool) public isActive;
    // every token the Booster has ever bought (so claim can iterate the current basket).
    // Bounded (H-2): activate/deactivate/claim iterate this, and deactivate runs inside the
    // NFT transfer path — an unbounded set would eventually make active Brokers untransferable.
    // The tokenizable Congress universe is small and stable (~40-60 mega-cap names), so a hard
    // cap keeps every loop within a deterministic gas bound. If v1 ever exhausts it, that is a
    // migrate/redeploy event, not a silent failure.
    uint256 public constant MAX_KNOWN_TOKENS = 128;
    uint256 public constant MAX_CLAIM_BATCH = 5;
    address[] public knownTokens;
    mapping(address => bool) public isKnownToken;

    event Poked(address indexed caller, uint256 ethSpent, uint64 epoch);
    event Bought(address indexed token, uint256 ethIn, uint256 tokenOut);
    event Claimed(uint256 indexed tokenId, address indexed to, address token, uint256 amount);
    event Activated(uint256 indexed tokenId, uint256 activeShares);
    event Deactivated(uint256 indexed tokenId, uint256 activeShares);

    event SlippageConfig(uint256 maxSlippageBps);
    event StockFeedSet(address indexed token, address feed);
    event UnguardedSet(address indexed token, bool allowed);
    event EthUsdFeedSet(address feed);
    event EthUsdManualSet(uint256 priceE8);
    event PokeThresholdUpdated(uint256 wei_);

    error BelowThreshold(uint256 have, uint256 need);
    error NotBrokerOwner();
    error OnlyBrokers();
    error AlreadyActive();
    error NotActive();
    error GuardMissing(address token);
    error NoEthPrice();
    error BadFeed();
    error SlippageTooHigh();
    error TokenCapReached();
    error SweepFailed();
    error UnguardedForbiddenOnMainnet();
    error ClaimBatchTooLarge();
    error InvalidPokeBatch();

    constructor(
        CoattailBroker brokers_,
        StrategyRegistry registry_,
        IStockRouter router_,
        IWETH weth_,
        uint256 strategyId_,
        address owner_
    ) Ownable(owner_) {
        brokers = brokers_;
        registry = registry_;
        router = router_;
        weth = weth_;
        strategyId = strategyId_;
    }

    // --- slippage-guard admin (owner) ---

    function setMaxSlippageBps(uint256 bps) external onlyOwner {
        if (bps > MAX_SLIPPAGE_CEILING_BPS) revert SlippageTooHigh();
        maxSlippageBps = bps;
        emit SlippageConfig(bps);
    }

    function setStockFeed(address token, IAggregatorV3 feed) external onlyOwner {
        stockFeed[token] = feed;
        emit StockFeedSet(token, address(feed));
    }

    function setEthUsdFeed(IAggregatorV3 feed) external onlyOwner {
        ethUsdFeed = feed;
        emit EthUsdFeedSet(address(feed));
    }

    /// @notice Fallback ETH/USD price (8 decimals) for chains without an ETH/USD feed.
    ///         Refresh within `manualStaleAfter` or the guard reverts.
    function setEthUsdManual(uint256 priceE8) external onlyOwner {
        ethUsdManualE8 = priceE8;
        ethUsdManualAt = uint64(block.timestamp);
        emit EthUsdManualSet(priceE8);
    }

    /// @notice Explicitly allow swapping a token with NO price guard (min-out 0).
    ///         Use only for a brand-new pool with no reliable feed yet; it is unsafe
    ///         and event-logged so the choice is auditable.
    function setAllowUnguarded(address token, bool allowed) external onlyOwner {
        if (allowed && block.chainid == 4663) revert UnguardedForbiddenOnMainnet();
        allowUnguarded[token] = allowed;
        emit UnguardedSet(token, allowed);
    }

    function setStaleWindows(uint256 ethAfter, uint256 stockAfter, uint256 manualAfter) external onlyOwner {
        ethFeedStaleAfter = ethAfter;
        stockFeedStaleAfter = stockAfter;
        manualStaleAfter = manualAfter;
    }

    /// @notice Tune the minimum buffered ETH before a `poke` is allowed.
    function setPokeThreshold(uint256 wei_) external onlyOwner {
        pokeThreshold = wei_;
        emit PokeThresholdUpdated(wei_);
    }

    /// @notice The FeeSplitter (or anyone) funds the Booster's buy buffer with ETH.
    receive() external payable {}

    /// @notice Bring a Broker online as an earning share. Called by CoattailBroker after
    ///         the owner burns $COAT. Checkpoints debt to now so it only earns going forward.
    function activate(uint256 tokenId) external {
        if (msg.sender != address(brokers)) revert OnlyBrokers();
        if (isActive[tokenId]) revert AlreadyActive();
        uint256 n = knownTokens.length;
        for (uint256 i; i < n; ++i) {
            address token = knownTokens[i];
            rewardDebt[tokenId][token] = accPerShare[token];
        }
        isActive[tokenId] = true;
        ++activeShares;
        emit Activated(tokenId, activeShares);
    }

    /// @notice Take a Broker offline (called by CoattailBroker on transfer). Crystallizes
    ///         everything earned while active into `pending`, then removes it as a share so
    ///         it accrues nothing while off. The pending balance is still claimable by the
    ///         current owner (the buyer), matching "accrued stays with the NFT".
    function deactivate(uint256 tokenId) external {
        if (msg.sender != address(brokers)) revert OnlyBrokers();
        if (!isActive[tokenId]) revert NotActive();
        uint256 n = knownTokens.length;
        for (uint256 i; i < n; ++i) {
            address token = knownTokens[i];
            pending[tokenId][token] += accPerShare[token] - rewardDebt[tokenId][token];
        }
        isActive[tokenId] = false;
        --activeShares;
        emit Deactivated(tokenId, activeShares);
    }

    /// @notice Permissionless "Clock In": spend the buffered ETH on the live basket.
    /// @dev Anyone can call once the buffer >= pokeThreshold. Our keeper calls it on a
    ///      schedule; because it's public it can never stall on us.
    function poke() external nonReentrant {
        uint256 available = address(this).balance;
        if (available < pokeThreshold) revert BelowThreshold(available, pokeThreshold);
        _poke(Math.min(available, MAX_POKE_BATCH));
    }

    /// @notice Select a smaller batch when a thin route cannot safely execute the default batch.
    function poke(uint256 maxSpend) external nonReentrant {
        uint256 available = address(this).balance;
        if (available < pokeThreshold) revert BelowThreshold(available, pokeThreshold);
        if (maxSpend == 0 || maxSpend > MAX_POKE_BATCH) revert InvalidPokeBatch();
        _poke(Math.min(available, maxSpend));
    }

    function _poke(uint256 buffer) internal {
        (address[] memory tokens, uint16[] memory weightsBps, uint64 epoch) = registry.getBasket(strategyId);
        // H-1: never wrap ETH with nothing to buy. An empty basket would otherwise strand the
        // whole buffer as WETH (Booster reads native balance on the next poke, ignoring WETH).
        if (tokens.length == 0) return;
        uint256 totalShares = activeShares; // only active Brokers earn
        if (totalShares == 0) return;

        // Price the slices first. Any rounding remainder stays as native ETH and rolls into the
        // next poke. StockRouter wraps each slice and executes the validated two-hop route.
        uint256[] memory slices = new uint256[](tokens.length);
        uint256 spend;
        for (uint256 i; i < tokens.length; ++i) {
            uint256 ethSlice = (buffer * weightsBps[i]) / 10_000;
            slices[i] = ethSlice;
            spend += ethSlice;
        }
        if (spend == 0) return;

        for (uint256 i; i < tokens.length; ++i) {
            uint256 ethSlice = slices[i];
            if (ethSlice == 0) continue;

            _trackToken(tokens[i]); // enforces MAX_KNOWN_TOKENS before we commit to buying
            uint256 out = _swap(tokens[i], ethSlice);
            totalBought[tokens[i]] += out;
            accPerShare[tokens[i]] += (out * SCALE) / totalShares;
            emit Bought(tokens[i], ethSlice, out);
        }

        emit Poked(msg.sender, spend, epoch);
    }

    /// @notice Recover WETH held by the Booster (legacy dust from an older poke, or a stray
    ///         deposit) back to native ETH and forward it. Owner-only. The current poke path
    ///         no longer strands WETH, so this is a safety valve.
    function sweepWeth(address payable to) external onlyOwner {
        if (to == address(0)) revert SweepFailed();
        uint256 wbal = weth.balanceOf(address(this));
        if (wbal == 0) return;
        weth.withdraw(wbal);
        (bool ok,) = to.call{value: wbal}("");
        if (!ok) revert SweepFailed();
    }

    /// @notice Claim a Broker's accrued stock into its ERC-6551 wallet.
    /// @dev Callable by the Broker owner. Rewards route to the token-bound account.
    ///      Those assets follow a later NFT transfer only while the owner leaves them there.
    function claim(uint256 tokenId) external nonReentrant {
        if (brokers.ownerOf(tokenId) != msg.sender) revert NotBrokerOwner();
        _claim(tokenId);
    }

    /// @notice Permissionlessly moves a Broker's accrued stock to that Broker's TBA.
    ///         The caller cannot choose or redirect the destination.
    function claimFor(uint256 tokenId) external nonReentrant {
        brokers.ownerOf(tokenId); // existence check; the owner is intentionally not the caller gate
        _claim(tokenId);
    }

    /// @notice Keeper-friendly bounded claims. A hard cap keeps the 128-token worst case
    ///         below a predictable gas ceiling; callers resume with the next batch.
    function claimBatch(uint256[] calldata tokenIds) external nonReentrant {
        if (tokenIds.length > MAX_CLAIM_BATCH) revert ClaimBatchTooLarge();
        for (uint256 i; i < tokenIds.length; ++i) {
            brokers.ownerOf(tokenIds[i]);
            _claim(tokenIds[i]);
        }
    }

    function _claim(uint256 tokenId) internal {
        address tba = brokers.accountOf(tokenId);
        bool active = isActive[tokenId];

        uint256 n = knownTokens.length;
        bool moved;
        for (uint256 i; i < n; ++i) {
            address token = knownTokens[i];
            // pending (crystallized while active) + live accrual if still active. Everything is
            // kept in SCALE-scaled units until the final floor so no fraction is lost.
            uint256 owedScaled = pending[tokenId][token];
            if (active) {
                uint256 acc = accPerShare[token];
                owedScaled += acc - rewardDebt[tokenId][token];
                rewardDebt[tokenId][token] = acc;
            }
            uint256 whole = owedScaled / SCALE;
            // M-4: carry the sub-unit remainder forward instead of discarding it. Over repeated
            // claims these fractions accumulate into whole units rather than leaking to dust.
            pending[tokenId][token] = owedScaled - whole * SCALE;
            if (whole > 0) {
                totalClaimed[token] += whole;
                IERC20(token).safeTransfer(tba, whole);
                emit Claimed(tokenId, tba, token, whole);
                moved = true;
            }
        }
        // A claim changed the TBA holdings → signal an EIP-4906 metadata refresh on the NFT.
        if (moved) brokers.refreshMetadata(tokenId);
    }

    /// @notice Recover tokens the Booster holds that are NOT owed to any Broker — i.e. accidental
    ///         transfers or airdrops. It can never touch reward entitlement: it leaves the full
    ///         outstanding balance (`totalBought - totalClaimed`) behind and only sweeps the excess.
    function sweepToken(address token, address to) external onlyOwner {
        if (to == address(0)) revert SweepFailed();
        uint256 outstanding = totalBought[token] - totalClaimed[token];
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > outstanding) {
            IERC20(token).safeTransfer(to, bal - outstanding);
        }
    }

    /// @notice View a Broker's unclaimed balances across the whole basket.
    function claimable(uint256 tokenId)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        bool active = isActive[tokenId];
        uint256 n = knownTokens.length;
        tokens = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            address token = knownTokens[i];
            tokens[i] = token;
            uint256 owed = pending[tokenId][token];
            if (active) owed += accPerShare[token] - rewardDebt[tokenId][token];
            amounts[i] = owed / SCALE;
        }
    }

    // --- internal ---

    function _swap(address tokenOut, uint256 ethIn) internal returns (uint256) {
        return router.swapExactETHForStock{value: ethIn}(
            tokenOut, minOut(tokenOut, ethIn), address(this), block.timestamp
        );
    }

    /// @notice The slippage floor for buying `tokenOut` with `ethIn` wei, from feeds.
    /// @dev Robinhood's on-chain stock feed is already adjusted by `uiMultiplier`, so its
    ///      answer is the USD price of one raw token unit. Applying the multiplier again would
    ///      double-adjust corporate actions and weaken (or over-tighten) the guard.
    function minOut(address tokenOut, uint256 ethIn) public view returns (uint256) {
        IAggregatorV3 feed = stockFeed[tokenOut];
        if (address(feed) == address(0)) {
            if (allowUnguarded[tokenOut]) return 0; // explicit, logged opt-out
            revert GuardMissing(tokenOut);
        }
        uint256 ethUsd8 = _ethUsdE8();
        uint256 stockUsd8 = _readFeedE8(feed, stockFeedStaleAfter);
        uint256 expectedRaw = Math.mulDiv(ethIn, ethUsd8, stockUsd8);
        return (expectedRaw * (BPS - maxSlippageBps)) / BPS;
    }

    /// @dev ETH/USD (8 dec): prefer the feed, else the (fresh) manual fallback, else revert.
    function _ethUsdE8() internal view returns (uint256) {
        if (address(ethUsdFeed) != address(0)) {
            return _readFeedE8(ethUsdFeed, ethFeedStaleAfter);
        }
        if (ethUsdManualE8 != 0 && block.timestamp - ethUsdManualAt <= manualStaleAfter) {
            return ethUsdManualE8;
        }
        revert NoEthPrice();
    }

    /// @dev Read a Chainlink feed, validate freshness/positivity, normalize to 8 decimals.
    function _readFeedE8(IAggregatorV3 feed, uint256 staleAfter) internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert BadFeed();
        if (block.timestamp - updatedAt > staleAfter) revert BadFeed();
        uint8 dec = feed.decimals();
        uint256 a = answer.toUint256();
        if (dec == 8) return a;
        if (dec < 8) return a * (10 ** (8 - dec));
        return a / (10 ** (dec - 8));
    }

    function _trackToken(address token) internal {
        if (!isKnownToken[token]) {
            // H-2: hard-bound the set every reward loop iterates (activate/deactivate/claim).
            // deactivate() runs in the NFT transfer path, so an unbounded set would eventually
            // make active Brokers untransferable. If this ever trips, the owner must migrate to
            // a fresh Booster — poke reverts loudly rather than silently distorting allocation.
            if (knownTokens.length >= MAX_KNOWN_TOKENS) revert TokenCapReached();
            isKnownToken[token] = true;
            knownTokens.push(token);
        }
    }

    function knownTokenCount() external view returns (uint256) {
        return knownTokens.length;
    }
}

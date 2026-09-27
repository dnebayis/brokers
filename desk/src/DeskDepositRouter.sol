// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IDeskNFTView, IAggregatorV3Desk, IV3PoolDesk} from "./DeskEngine.sol";

interface IWETHDeposit {
    function deposit() external payable;
}

/// @notice The engine's deposit book: enforces the per-Desk pilot cap on what owners put in.
interface IDeskDepositBook {
    function recordDeposit(uint256 deskId, uint256 amount) external;
}

/// @notice The live COAT router (native ETH/COAT v4 pool behind the fee hook).
interface ICoatRouterSell {
    function sell(uint256 coatIn, uint256 minEthOut, address to) external returns (uint256 out);
}

/// @title DeskDepositRouter
/// @notice Lets a Desk be funded in ETH or COAT as well as USDG. Everything is converted to USDG
///         in the same transaction and lands in the Desk's own 6551 wallet, where the engine
///         picks it up like any USDG deposit. The router holds nothing between transactions and
///         has no path to any Desk's assets: it only ever sends USDG INTO a Desk wallet.
///         Every deposit is booked with the engine in the same transaction; a deposit that would
///         take the Desk's principal over the pilot cap reverts as a whole.
/// @dev ETH -> USDG goes through the WETH/USDG v3 pool with a Chainlink ETH/USD floor (the same
///      guard shape as the engine). COAT -> ETH goes through the COAT router, so the fee hook's
///      skim still funds the Booster; COAT has no Chainlink feed, so that leg's floor is the
///      caller's `minEthOut` (the UI quotes it). Levers ship settable (the 36,750 lesson).
contract DeskDepositRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 public constant BPS = 10_000;
    uint160 internal constant MIN_SQRT_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    IERC20 public immutable usdg;
    address public immutable weth;
    IERC20 public immutable coat;
    IDeskNFTView public immutable desks;
    IDeskDepositBook public engine;

    ICoatRouterSell public coatRouter;
    address public ethPool; // WETH/USDG v3 pool
    bool private _usdgIsToken0;
    IAggregatorV3Desk public ethUsdFeed;
    uint256 public maxSlippageBps = 300;
    uint256 public feedStaleAfter = 1 days;
    uint256 private immutable _usdgUnit;

    address private _expectedPool;
    bool private _awaitingEth;

    event Deposited(
        uint256 indexed deskId, address indexed from, address tokenIn, uint256 amountIn, uint256 usdgOut
    );
    event CoatRouterSet(address router);
    event EthPoolSet(address pool);
    event EthUsdFeedSet(address feed);
    event EngineSet(address engine);
    event GuardsSet(uint256 maxSlippageBps, uint256 feedStaleAfter);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidPool();
    error BadFeed();
    error SlippageTooHigh();
    error BelowFloor(uint256 got, uint256 floor);
    error BadCallback();
    error UnexpectedEth();

    constructor(
        IERC20 usdg_,
        address weth_,
        IERC20 coat_,
        IDeskNFTView desks_,
        IDeskDepositBook engine_,
        ICoatRouterSell coatRouter_,
        address ethPool_,
        IAggregatorV3Desk ethUsdFeed_,
        address owner_
    ) Ownable(owner_) {
        if (
            address(usdg_) == address(0) || weth_ == address(0) || address(coat_) == address(0)
                || address(desks_) == address(0)
        ) revert ZeroAddress();
        usdg = usdg_;
        weth = weth_;
        coat = coat_;
        desks = desks_;
        _usdgUnit = 10 ** IERC20Metadata(address(usdg_)).decimals();
        _setEngine(engine_);
        _setCoatRouter(coatRouter_);
        _setEthPool(ethPool_);
        _setEthUsdFeed(ethUsdFeed_);
    }

    /// @dev Native ETH is only expected mid-`depositCoat`, paid out by the v4 PoolManager on the
    ///      COAT router's behalf (not by the COAT router itself). Anything else is a mistake.
    receive() external payable {
        if (!_awaitingEth) revert UnexpectedEth();
    }

    // --- admin ---

    function setEngine(IDeskDepositBook engine_) external onlyOwner {
        _setEngine(engine_);
    }

    function setCoatRouter(ICoatRouterSell router) external onlyOwner {
        _setCoatRouter(router);
    }

    function setEthPool(address pool) external onlyOwner {
        _setEthPool(pool);
    }

    function setEthUsdFeed(IAggregatorV3Desk feed) external onlyOwner {
        _setEthUsdFeed(feed);
    }

    function setGuards(uint256 maxSlippageBps_, uint256 feedStaleAfter_) external onlyOwner {
        if (maxSlippageBps_ > 1_000) revert SlippageTooHigh();
        maxSlippageBps = maxSlippageBps_;
        feedStaleAfter = feedStaleAfter_;
        emit GuardsSet(maxSlippageBps_, feedStaleAfter_);
    }

    // --- deposits ---

    /// @notice Fund a Desk with USDG. Same as a plain transfer to the Desk wallet, offered so the
    ///         UI has one door for all three currencies.
    function depositUsdg(uint256 deskId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        address acct = desks.accountOf(deskId);
        usdg.safeTransferFrom(msg.sender, acct, amount);
        engine.recordDeposit(deskId, amount);
        emit Deposited(deskId, msg.sender, address(usdg), amount, amount);
    }

    /// @notice Fund a Desk with native ETH: swapped to USDG at the WETH/USDG pool, floored by
    ///         Chainlink ETH/USD and by the caller's own `minUsdgOut`.
    function depositEth(uint256 deskId, uint256 minUsdgOut)
        external
        payable
        nonReentrant
        returns (uint256 out)
    {
        if (msg.value == 0) revert ZeroAmount();
        out = _ethToDesk(deskId, msg.value, minUsdgOut);
        emit Deposited(deskId, msg.sender, address(0), msg.value, out);
    }

    /// @notice Fund a Desk with COAT: sold for ETH through the COAT router (the fee hook's skim
    ///         still goes to the Booster), then ETH -> USDG as in `depositEth`.
    function depositCoat(uint256 deskId, uint256 coatIn, uint256 minEthOut, uint256 minUsdgOut)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (coatIn == 0) revert ZeroAmount();
        coat.safeTransferFrom(msg.sender, address(this), coatIn);
        coat.forceApprove(address(coatRouter), coatIn);
        _awaitingEth = true;
        uint256 ethOut = coatRouter.sell(coatIn, minEthOut, address(this));
        _awaitingEth = false;
        // the COAT router refunds any unsold COAT to its caller (this router): hand it back
        uint256 leftover = coat.balanceOf(address(this));
        if (leftover > 0) coat.safeTransfer(msg.sender, leftover);
        out = _ethToDesk(deskId, ethOut, minUsdgOut);
        emit Deposited(deskId, msg.sender, address(coat), coatIn, out);
    }

    // --- views ---

    /// @notice Chainlink floor for `ethIn` wei into USDG (raw units).
    function minUsdgForEth(uint256 ethIn) public view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = ethUsdFeed.latestRoundData();
        if (answer <= 0 || block.timestamp - updatedAt > feedStaleAfter) revert BadFeed();
        uint8 dec = ethUsdFeed.decimals();
        uint256 expected = Math.mulDiv(ethIn, answer.toUint256() * _usdgUnit, 10 ** (18 + uint256(dec)));
        return (expected * (BPS - maxSlippageBps)) / BPS;
    }

    // --- internal ---

    function _ethToDesk(uint256 deskId, uint256 ethIn, uint256 minUsdgOut) internal returns (uint256 out) {
        address acct = desks.accountOf(deskId);
        IWETHDeposit(weth).deposit{value: ethIn}();
        bool zeroForOne = !_usdgIsToken0; // WETH in
        _expectedPool = ethPool;
        (int256 a0, int256 a1) = IV3PoolDesk(ethPool)
            .swap(acct, zeroForOne, ethIn.toInt256(), zeroForOne ? MIN_SQRT_PLUS_ONE : MAX_SQRT_MINUS_ONE, "");
        _expectedPool = address(0);
        int256 output = -(zeroForOne ? a1 : a0);
        if (output <= 0) revert InvalidPool();
        out = output.toUint256();
        uint256 floor = Math.max(minUsdgOut, minUsdgForEth(ethIn));
        if (out < floor) revert BelowFloor(out, floor);
        engine.recordDeposit(deskId, out);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != _expectedPool || _expectedPool == address(0)) revert BadCallback();
        int256 owed = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (owed <= 0) revert BadCallback();
        IERC20(weth).safeTransfer(msg.sender, owed.toUint256());
    }

    function _setEngine(IDeskDepositBook engine_) internal {
        if (address(engine_) == address(0)) revert ZeroAddress();
        engine = engine_;
        emit EngineSet(address(engine_));
    }

    function _setCoatRouter(ICoatRouterSell router) internal {
        if (address(router) == address(0)) revert ZeroAddress();
        coatRouter = router;
        emit CoatRouterSet(address(router));
    }

    function _setEthPool(address pool) internal {
        (address t0, address t1) = (IV3PoolDesk(pool).token0(), IV3PoolDesk(pool).token1());
        if (t0 == address(usdg) && t1 == weth) _usdgIsToken0 = true;
        else if (t1 == address(usdg) && t0 == weth) _usdgIsToken0 = false;
        else revert InvalidPool();
        ethPool = pool;
        emit EthPoolSet(pool);
    }

    function _setEthUsdFeed(IAggregatorV3Desk feed) internal {
        if (address(feed) == address(0)) revert ZeroAddress();
        ethUsdFeed = feed;
        emit EthUsdFeedSet(address(feed));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Rialto publishes the active router through a registry; feature 2 is the taker-submitted flow.
interface IRialtoRouterRegistry {
    function ownerOf(uint256 featureId) external view returns (address);
}

interface IBoosterPoke {
    function poke() external;
    function poke(uint256 maxSpend) external;
}

/// @title RialtoLeg
/// @notice A per-stock adapter that lets the deployed StockRouter buy through Rialto's router.
///
///         Rialto's liquidity is propAMMs that only fill through Rialto's own router, with calldata
///         its API builds per trade. Our Booster and StockRouter are immutable and only know two pool
///         shapes; this contract wears the `swapExactIn` shape the StockRouter already calls
///         (PoolKind.Rialto) and, inside, executes one API-built quote against the Rialto router.
///
///         Trust model: the adapter has no owner and no withdraw path. Whatever calldata is staged,
///         it can only (1) approve exactly the staged sell amount of USDG to the router the Rialto
///         registry currently publishes, (2) hand out stock it actually received, and (3) never
///         return less than the `minAmountOut` the StockRouter passes, which the Booster derives
///         from Chainlink. USDG left over after a fill (the ETH->USDG hop is only priced at
///         execution) stays here as carry and is sold in the next quote.
contract RialtoLeg is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant RIALTO_TAKER_FEATURE = 2;

    /// @dev StockRouter.setRoute reads these to derive direction: token0 = mid token (USDG).
    address public immutable token0;
    address public immutable token1;
    address public immutable stockRouter;
    address public immutable runner;
    IRialtoRouterRegistry public immutable registry;

    bytes private _stagedData;
    uint256 private _stagedSell;

    event Staged(uint256 sellAmount, uint256 dataLength);
    event Cleared();
    event Filled(address indexed router, uint256 sellAmount, uint256 amountOut, uint256 carry);

    error NotRunner();
    error NotStockRouter();
    error AlreadyStaged();
    error NotStaged();
    error WrongDirection();
    error ShortOfSellAmount(uint256 have, uint256 need);
    error RouterUnavailable();
    error Slippage(uint256 got, uint256 min);
    error ZeroAddress();

    constructor(
        address usdg,
        address stock,
        address stockRouter_,
        address runner_,
        IRialtoRouterRegistry registry_
    ) {
        if (
            usdg == address(0) || stock == address(0) || stockRouter_ == address(0) || runner_ == address(0)
                || address(registry_) == address(0)
        ) revert ZeroAddress();
        token0 = usdg;
        token1 = stock;
        stockRouter = stockRouter_;
        runner = runner_;
        registry = registry_;
    }

    function isStaged() external view returns (bool) {
        return _stagedSell != 0;
    }

    function stagedSell() external view returns (uint256) {
        return _stagedSell;
    }

    /// @notice USDG held here between fills; the keeper adds it to the next quote's sell amount.
    function carry() external view returns (uint256) {
        return IERC20(token0).balanceOf(address(this));
    }

    /// @notice Stage one Rialto quote (its `tx.data`, built with this contract as taker) for the
    ///         very next StockRouter call. Only the runner can stage, and only inside its own
    ///         stage -> poke -> clear transaction.
    function stage(bytes calldata data, uint256 sellAmount) external {
        if (msg.sender != runner) revert NotRunner();
        if (_stagedSell != 0) revert AlreadyStaged();
        if (sellAmount == 0 || data.length == 0) revert NotStaged();
        _stagedData = data;
        _stagedSell = sellAmount;
        emit Staged(sellAmount, data.length);
    }

    function clear() external {
        if (msg.sender != runner) revert NotRunner();
        delete _stagedData;
        delete _stagedSell;
        emit Cleared();
    }

    /// @notice The StockRouter's Rialto-shaped hop: it has approved `amountIn` of token0 to this
    ///         contract and expects `to` to end up with at least `minAmountOut` of token1.
    function swapExactIn(bool zeroForOne, uint256 amountIn, uint256 minAmountOut, address to, uint256)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.sender != stockRouter) revert NotStockRouter();
        if (!zeroForOne) revert WrongDirection();
        uint256 sell = _stagedSell;
        if (sell == 0) revert NotStaged();
        bytes memory data = _stagedData;
        delete _stagedData;
        delete _stagedSell;

        IERC20 usdg = IERC20(token0);
        IERC20 stock = IERC20(token1);
        usdg.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 have = usdg.balanceOf(address(this));
        if (have < sell) revert ShortOfSellAmount(have, sell);

        address router = registry.ownerOf(RIALTO_TAKER_FEATURE);
        if (router == address(0)) revert RouterUnavailable();

        usdg.forceApprove(router, sell);
        (bool ok, bytes memory result) = router.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
        usdg.forceApprove(router, 0);

        amountOut = stock.balanceOf(address(this));
        if (amountOut < minAmountOut) revert Slippage(amountOut, minAmountOut);
        stock.safeTransfer(to, amountOut);
        emit Filled(router, sell, amountOut, usdg.balanceOf(address(this)));
    }
}

/// @title RialtoPokeRunner
/// @notice Stages the hour's Rialto quotes into their RialtoLeg adapters and pokes the Booster in
///         the same transaction, so a quote can never sit staged for anyone else's poke.
///
///         Only allowlisted stagers may run. A permissionless runner would let a stranger choose
///         the route (and an integrator fee) for our buy; the Chainlink floor bounds the damage but
///         does not remove it. Owner only manages that allowlist; it holds no funds.
contract RialtoPokeRunner is Ownable2Step {
    struct Leg {
        RialtoLeg leg;
        bytes data;
        uint256 sellAmount;
    }

    IBoosterPoke public immutable booster;
    mapping(address => bool) public stagers;

    event StagerSet(address indexed stager, bool allowed);
    event Ran(address indexed stager, uint256 legs, uint256 maxSpend);

    error NotStager();
    error ZeroAddress();

    constructor(IBoosterPoke booster_, address owner_, address firstStager) Ownable(owner_) {
        if (address(booster_) == address(0)) revert ZeroAddress();
        booster = booster_;
        if (firstStager != address(0)) {
            stagers[firstStager] = true;
            emit StagerSet(firstStager, true);
        }
    }

    function setStager(address stager, bool allowed) external onlyOwner {
        if (stager == address(0)) revert ZeroAddress();
        stagers[stager] = allowed;
        emit StagerSet(stager, allowed);
    }

    /// @param legs one staged quote per Rialto-routed basket name
    /// @param maxSpend forwarded to Booster.poke(maxSpend); 0 means Booster.poke()
    function run(Leg[] calldata legs, uint256 maxSpend) external {
        if (!stagers[msg.sender]) revert NotStager();
        for (uint256 i; i < legs.length; ++i) {
            legs[i].leg.stage(legs[i].data, legs[i].sellAmount);
        }
        if (maxSpend == 0) booster.poke();
        else booster.poke(maxSpend);
        // A leg the basket did not touch this hour (weights moved between quote and poke) must
        // not linger for a later, unrelated call.
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].leg.isStaged()) legs[i].leg.clear();
        }
        emit Ran(msg.sender, legs.length, maxSpend);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CoatFeeHook, IStateViewHook} from "./CoatFeeHook.sol";
import {Currency, PoolKey, IPoolManagerMinimal} from "./v4/V4Types.sol";
import {
    PermanentV4LiquidityLocker,
    IV4PositionManagerLocker,
    IV4StateViewLocker
} from "./PermanentV4LiquidityLocker.sol";

interface IAtomicPoolManager {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24);
}

interface IAtomicPositionManager is IV4PositionManagerLocker {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IAtomicPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice One-shot launch executor. Hook creation, guarded pool initialization, locker binding
/// and LP mint occur inside one transaction, so public mempool ordering cannot consume the
/// predicted PositionManager token ID between those operations.
contract AtomicV4Launcher {
    using SafeERC20 for IERC20;

    uint24 public constant FEE = 10_000;
    int24 public constant TICK_SPACING = 200;
    int24 public constant TICK_LOWER = 138_000;
    int24 public constant TICK_UPPER = 184_200;
    uint160 public constant SQRT_PRICE_X96 = 799603176048022585010545010154905;
    uint160 public constant SQRT_LOWER_X96 = 78588986356927097284479352776873;
    uint160 public constant SQRT_UPPER_X96 = 791647387308859959733601586197955;
    uint128 public constant LIQUIDITY = 111110341605252461876272;
    uint128 public constant AMOUNT1_MAX = 1_000_000_000 ether;
    uint256 public constant LAUNCH_ALLOCATION = 1_000_000_000 ether;

    uint8 private constant MINT_POSITION = 0x02;
    uint8 private constant SETTLE_PAIR = 0x0d;

    address public immutable launcher;
    IAtomicPoolManager public immutable poolManager;
    IAtomicPositionManager public immutable positionManager;
    IStateViewHook public immutable stateView;
    IAtomicPermit2 public immutable permit2;

    bool public launched;
    CoatFeeHook public hook;
    PermanentV4LiquidityLocker public locker;

    error NotLauncher();
    error AlreadyLaunched();
    error InvalidDependency();
    error PositionNotLocked();

    constructor(
        address launcher_,
        IAtomicPoolManager poolManager_,
        IAtomicPositionManager positionManager_,
        IStateViewHook stateView_,
        IAtomicPermit2 permit2_
    ) {
        if (
            launcher_ == address(0) || address(poolManager_).code.length == 0
                || address(positionManager_).code.length == 0 || address(stateView_).code.length == 0
                || address(permit2_).code.length == 0
        ) revert InvalidDependency();
        launcher = launcher_;
        poolManager = poolManager_;
        positionManager = positionManager_;
        stateView = stateView_;
        permit2 = permit2_;
    }

    function launch(
        address coat,
        address payable feeSink,
        address payable feeTreasury,
        address hookOwner,
        bytes32 hookSalt
    ) external returns (CoatFeeHook deployedHook, PermanentV4LiquidityLocker deployedLocker) {
        if (msg.sender != launcher) revert NotLauncher();
        if (launched) revert AlreadyLaunched();
        if (
            coat.code.length == 0 || feeSink.code.length == 0 || feeTreasury == address(0)
                || hookOwner == address(0)
        ) revert InvalidDependency();
        launched = true;

        IERC20(coat).safeTransferFrom(msg.sender, address(this), LAUNCH_ALLOCATION);
        deployedHook = new CoatFeeHook{salt: hookSalt}(
            hookOwner, IPoolManagerMinimal(address(poolManager)), stateView, coat, feeSink, address(this)
        );
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(coat),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: address(deployedHook)
        });

        uint256 positionTokenId = positionManager.nextTokenId();
        deployedLocker = new PermanentV4LiquidityLocker(
            IV4PositionManagerLocker(address(positionManager)),
            IV4StateViewLocker(address(stateView)),
            feeTreasury,
            positionTokenId,
            keccak256(abi.encode(key)),
            key.currency0,
            key.currency1,
            LIQUIDITY,
            SQRT_LOWER_X96,
            SQRT_UPPER_X96
        );

        IERC20(coat).forceApprove(address(permit2), type(uint256).max);
        permit2.approve(coat, address(positionManager), AMOUNT1_MAX, uint48(block.timestamp + 1 hours));
        poolManager.initialize(key, SQRT_PRICE_X96);
        bytes memory actions = abi.encodePacked(MINT_POSITION, SETTLE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            TICK_LOWER,
            TICK_UPPER,
            LIQUIDITY,
            uint128(0),
            AMOUNT1_MAX,
            address(deployedLocker),
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp + 1 hours);
        if (positionManager.ownerOf(positionTokenId) != address(deployedLocker)) {
            revert PositionNotLocked();
        }

        uint256 remainder = IERC20(coat).balanceOf(address(this));
        if (remainder != 0) IERC20(coat).safeTransfer(launcher, remainder);
        hook = deployedHook;
        locker = deployedLocker;
    }
}

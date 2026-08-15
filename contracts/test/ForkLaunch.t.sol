// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {COAT} from "../src/COAT.sol";
import {CoatFeeHook, IStateViewHook} from "../src/CoatFeeHook.sol";
import {Currency, PoolKey, HookFlags} from "../src/v4/V4Types.sol";
import {
    AtomicV4Launcher,
    IAtomicPoolManager,
    IAtomicPositionManager,
    IAtomicPermit2
} from "../src/AtomicV4Launcher.sol";
import {PermanentV4LiquidityLocker} from "../src/PermanentV4LiquidityLocker.sol";

interface IPoolManager {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24);
}

interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IAllowanceTransfer {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

/// Definitive launch proof: fork RH mainnet and run the LaunchWithHook single-sided seed flow
/// against the REAL Uniswap v4 PoolManager / PositionManager / Permit2 — depositing ONLY
/// $COAT, zero ETH. Proves the v4 mint calldata is correct and the pool is really seeded.
///
///   forge test --match-contract ForkLaunch --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract ForkLaunchTest is Test {
    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IPositionManager constant POSM = IPositionManager(0x58daec3116aae6D93017bAAea7749052E8a04fA7);
    IAllowanceTransfer constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    IStateView constant STATE = IStateView(0xF3334192D15450CdD385c8B70e03f9A6bD9E673b);

    // pool params from launch/compute_params.py
    uint24 constant FEE = 10000;
    int24 constant TICK_SPACING = 200;
    int24 constant TICK_UPPER = 184200;
    uint160 constant SQRT_PRICE_X96 = 799603176048022585010545010154905;

    function test_singleSidedLaunch_realV4() public {
        if (block.chainid != 4663) {
            require(!vm.envOr("REQUIRE_MAINNET_FORK", false), "required RH mainnet fork missing");
            return;
        }

        COAT coat = new COAT(address(this), address(PM)); // 1B to this contract
        uint256 coatBefore = coat.balanceOf(address(this));
        uint256 poolManagerEthBefore = address(PM).balance;

        AtomicV4Launcher atomic = new AtomicV4Launcher(
            address(this),
            IAtomicPoolManager(address(PM)),
            IAtomicPositionManager(address(POSM)),
            IStateViewHook(address(STATE)),
            IAtomicPermit2(address(PERMIT2))
        );
        (bytes32 salt, address predicted) = _mineHook(atomic, coat);

        coat.approve(address(atomic), coatBefore);
        (CoatFeeHook hook, PermanentV4LiquidityLocker locker) = atomic.launch(
            address(coat), payable(address(this)), payable(makeAddr("treasury")), address(this), salt
        );
        assertEq(address(hook), predicted, "hook address mismatch");

        // currency0 = native ETH (0x0), currency1 = COAT (0x0 < any address)
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(coat)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: address(hook)
        });

        // confirm it initialized at our starting tick (above the range => all-COAT position)
        bytes32 poolId = keccak256(abi.encode(key));
        (uint160 sqrtP, int24 tick,,) = STATE.getSlot0(poolId);
        emit log_named_int("pool start tick", tick);
        assertEq(sqrtP, SQRT_PRICE_X96, "pool not initialized at target price");
        assertGt(tick, TICK_UPPER, "start must be above the range for a 100% COAT position");

        // Verify: the pool now holds real COAT liquidity, seeded with zero ETH.
        uint256 coatInPool = coat.balanceOf(address(PM));
        uint256 coatSpent = coatBefore - coat.balanceOf(address(this));
        emit log_named_uint("COAT seeded into pool", coatInPool);
        emit log_named_uint("ETH used (wei)", 0);
        assertGt(coatInPool, 999_999_999 ether, "pool not seeded with full supply");
        assertEq(coatInPool, coatSpent, "all spent COAT should be in the pool");
        assertEq(address(PM).balance, poolManagerEthBefore, "launch unexpectedly supplied ETH");
        assertEq(POSM.ownerOf(locker.tokenId()), address(locker), "LP NFT is not permanently locked");
        assertEq(coat.balanceOf(address(this)), 8_393, "unexpected Q96 rounding remainder");
        coat.burn(coat.balanceOf(address(this)));
        assertEq(coat.balanceOf(address(this)), 0, "no team/reserve balance may remain");
    }

    function _mineHook(AtomicV4Launcher atomic, COAT coat)
        internal
        view
        returns (bytes32 salt, address predicted)
    {
        bytes memory hookArgs = abi.encode(
            address(this), address(PM), address(STATE), address(coat), payable(address(this)), address(atomic)
        );
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(CoatFeeHook).creationCode, hookArgs));
        uint160 targetFlags = HookFlags.BEFORE_INITIALIZE_FLAG | HookFlags.AFTER_SWAP_FLAG
            | HookFlags.AFTER_SWAP_RETURNS_DELTA_FLAG;
        for (uint256 i; i < 1_000_000; ++i) {
            address candidate = vm.computeCreate2Address(bytes32(i), initCodeHash, address(atomic));
            if (uint160(candidate) & HookFlags.ALL_FLAGS_MASK == targetFlags) {
                return (bytes32(i), candidate);
            }
        }
        revert("hook salt not found");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CoatFeeHook, IStateViewHook} from "../src/CoatFeeHook.sol";
import {MockERC20} from "./Mocks.sol";
import {
    Currency,
    PoolKey,
    SwapParams,
    BalanceDelta,
    IPoolManagerMinimal,
    IHooks,
    HookFlags
} from "../src/v4/V4Types.sol";

contract MockHookState is IStateViewHook {
    uint160 public sqrtPriceX96;
    int24 public tick;

    function set(uint160 sqrtPriceX96_, int24 tick_) external {
        sqrtPriceX96 = sqrtPriceX96_;
        tick = tick_;
    }

    function getSlot0(bytes32) external view returns (uint160, int24, uint24, uint24) {
        return (sqrtPriceX96, tick, 0, 0);
    }
}

contract MockHookPoolManager is IPoolManagerMinimal {
    Currency public lastCurrency;
    address public lastTo;
    uint256 public lastAmount;

    function take(Currency currency, address to, uint256 amount) external {
        lastCurrency = currency;
        lastTo = to;
        lastAmount = amount;
    }

    function callAfter(CoatFeeHook hook, PoolKey memory key, SwapParams memory params, BalanceDelta delta)
        external
        returns (bytes4, int128)
    {
        return hook.afterSwap(address(this), key, params, delta, "");
    }

    function callBefore(CoatFeeHook hook, address sender, PoolKey memory key) external view returns (bytes4) {
        return hook.beforeInitialize(sender, key, 0);
    }
}

contract RejectHookEth {
    receive() external payable {
        revert("reject");
    }
}

contract CoatFeeHookTest is Test {
    uint256 constant Q96 = 1 << 96;
    MockERC20 coat;
    MockHookState state;
    MockHookPoolManager pm;
    CoatFeeHook hook;
    PoolKey key;
    address payable ethSink = payable(makeAddr("ethSink"));

    function setUp() public {
        coat = new MockERC20("COAT", "COAT");
        state = new MockHookState();
        pm = new MockHookPoolManager();
        hook = _deployFlagged();
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(coat)),
            fee: 10_000,
            tickSpacing: 200,
            hooks: address(hook)
        });
        state.set(uint160(10 * Q96), 100);
    }

    function test_observationRequiresFullWindowAndReturnsTimeWeightedValues() public {
        vm.expectRevert(CoatFeeHook.InsufficientHistory.selector);
        hook.consultPriceX96(1800);
        _observe(BalanceDelta.wrap(0));
        vm.expectRevert(CoatFeeHook.InsufficientHistory.selector);
        hook.consult(1800);

        vm.warp(block.timestamp + 1800);
        assertEq(hook.consult(1800), 100);
        assertEq(hook.consultPriceX96(1800), 100 * Q96);

        state.set(uint160(20 * Q96), 200);
        _observe(BalanceDelta.wrap(0));
        vm.warp(block.timestamp + 900);
        assertEq(hook.consult(1800), 150);
        assertEq(hook.consultPriceX96(1800), 250 * Q96);
    }

    function test_sameBlockUpdatesLatestObservationAndRingIsBounded() public {
        _observe(BalanceDelta.wrap(0));
        state.set(uint160(11 * Q96), 110);
        _observe(BalanceDelta.wrap(0));
        assertEq(hook.observationCount(), 1);

        for (uint256 i = 1; i <= 70; ++i) {
            vm.warp(block.timestamp + 30);
            _observe(BalanceDelta.wrap(0));
        }
        assertEq(hook.observationCount(), 64);
    }

    function test_subSpacingPriceReversalCannotForgeFullTwapWindow() public {
        _observe(BalanceDelta.wrap(0));
        vm.warp(block.timestamp + 30);
        state.set(uint160(5 * Q96), 50); // momentary manipulated price: 25 Q96
        _observe(BalanceDelta.wrap(0));
        state.set(uint160(10 * Q96), 100); // reverse inside the checkpoint spacing
        _observe(BalanceDelta.wrap(0));

        vm.warp(block.timestamp + 1800);
        assertEq(hook.consultPriceX96(1800), 100 * Q96);
        assertEq(hook.consult(1800), 100);
    }

    function test_aggregateProtectedBuyCannotBeFragmentedAtSettlement() public {
        coat.setLaunchGuard(true, block.number + 2);
        vm.expectRevert(CoatFeeHook.ProtectedSwapTooLarge.selector);
        _observe(BalanceDelta.wrap(int256(56_000_000 ether)));
    }

    function test_feeBranchesAndFlushUseSafeTransfers() public {
        _observe(BalanceDelta.wrap(10_000));
        assertEq(Currency.unwrap(pm.lastCurrency()), address(coat));
        assertEq(pm.lastAmount(), 100);

        SwapParams memory p = SwapParams({zeroForOne: false, amountSpecified: -1, sqrtPriceLimitX96: 0});
        pm.callAfter(hook, key, p, BalanceDelta.wrap(int256(10_000) << 128));
        assertEq(Currency.unwrap(pm.lastCurrency()), address(0));

        vm.deal(address(hook), 1 ether);
        coat.mint(address(hook), 5 ether);
        hook.flush();
        assertEq(ethSink.balance, 1 ether);
        assertEq(coat.balanceOf(address(hook)), 0);
    }

    function test_accessPoolAndFeeBounds() public {
        vm.expectRevert(CoatFeeHook.NotPoolManager.selector);
        hook.afterSwap(address(this), key, SwapParams(false, -1, 0), BalanceDelta.wrap(0), "");

        PoolKey memory wrong = key;
        wrong.fee = 500;
        vm.expectRevert(CoatFeeHook.WrongPool.selector);
        pm.callAfter(hook, wrong, SwapParams(false, -1, 0), BalanceDelta.wrap(0));

        vm.expectRevert();
        vm.prank(makeAddr("notOwner"));
        hook.setEthSink(payable(address(1)));
    }

    function test_beforeInitializeAcceptsOnlyAtomicLauncherAndExpectedPool() public {
        assertEq(pm.callBefore(hook, address(this), key), IHooks.beforeInitialize.selector);

        PoolKey memory wrong = key;
        wrong.fee = 500;
        vm.expectRevert(CoatFeeHook.WrongPool.selector);
        pm.callBefore(hook, address(this), wrong);

        vm.expectRevert(CoatFeeHook.NotLaunchInitializer.selector);
        pm.callBefore(hook, makeAddr("attacker"), key);
    }

    function test_constructorRejectsZeroLaunchInitializer() public {
        bytes memory args = abi.encode(
            address(this), IPoolManagerMinimal(address(pm)), IStateViewHook(address(state)), address(coat), ethSink, address(0)
        );
        bytes32 hash = keccak256(abi.encodePacked(type(CoatFeeHook).creationCode, args));
        uint160 target = HookFlags.BEFORE_INITIALIZE_FLAG | HookFlags.AFTER_SWAP_FLAG
            | HookFlags.AFTER_SWAP_RETURNS_DELTA_FLAG;
        for (uint256 i; i < 1_000_000; ++i) {
            bytes32 salt = bytes32(i);
            if (uint160(vm.computeCreate2Address(salt, hash, address(this))) & HookFlags.ALL_FLAGS_MASK == target) {
                vm.expectRevert(CoatFeeHook.NotLaunchInitializer.selector);
                new CoatFeeHook{salt: salt}(
                    address(this), IPoolManagerMinimal(address(pm)), IStateViewHook(address(state)), address(coat), ethSink, address(0)
                );
                return;
            }
        }
        revert("salt");
    }

    function test_consultsRejectPreHistoryAndInterpolateBetweenCheckpoints() public {
        _observe(BalanceDelta.wrap(0));
        vm.warp(block.timestamp + 1);
        vm.expectRevert(CoatFeeHook.InsufficientHistory.selector);
        hook.consultPriceX96(2);

        vm.warp(block.timestamp + 59);
        state.set(uint160(20 * Q96), 200);
        _observe(BalanceDelta.wrap(0));
        vm.warp(block.timestamp + 30);
        assertEq(hook.consult(60), 150);
    }

    function test_zeroAmountFailedSinkAndEmptyFlushBranches() public {
        _observe(BalanceDelta.wrap(1)); // floor fee is zero
        assertEq(pm.lastAmount(), 0);

        hook.setEthSink(payable(address(0)));
        vm.deal(address(hook), 1 ether);
        coat.mint(address(hook), 1 ether);
        hook.flush();
        assertEq(address(hook).balance, 1 ether);
        assertEq(coat.balanceOf(address(hook)), 0);

        RejectHookEth rejector = new RejectHookEth();
        hook.setEthSink(payable(address(rejector)));
        hook.flush();
        assertEq(address(hook).balance, 1 ether);

        hook.setEthSink(ethSink);
        hook.flush();
        hook.flush(); // empty balances
        assertEq(ethSink.balance, 1 ether);
    }

    function test_negativeTickRoundsTowardNegativeInfinity() public {
        state.set(uint160(10 * Q96), -100);
        _observe(BalanceDelta.wrap(0));
        vm.warp(block.timestamp + 1799);
        state.set(uint160(10 * Q96), -101);
        _observe(BalanceDelta.wrap(0));
        vm.warp(block.timestamp + 1);
        assertEq(hook.consult(1800), -101);
    }

    function test_constructorRejectsBadFlags() public {
        vm.expectRevert(CoatFeeHook.InvalidHookAddress.selector);
        new CoatFeeHook(
            address(this),
            IPoolManagerMinimal(address(pm)),
            IStateViewHook(address(state)),
            address(coat),
            ethSink,
            address(this)
        );
    }

    function _observe(BalanceDelta delta) internal {
        pm.callAfter(
            hook, key, SwapParams({zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: 0}), delta
        );
    }

    function _deployFlagged() internal returns (CoatFeeHook deployed) {
        return _deployFlaggedFixedFee();
    }

    function _deployFlaggedFixedFee() internal returns (CoatFeeHook deployed) {
        bytes memory args = abi.encode(
            address(this),
            IPoolManagerMinimal(address(pm)),
            IStateViewHook(address(state)),
            address(coat),
            ethSink,
            address(this)
        );
        bytes32 hash = keccak256(abi.encodePacked(type(CoatFeeHook).creationCode, args));
        uint160 target = HookFlags.BEFORE_INITIALIZE_FLAG | HookFlags.AFTER_SWAP_FLAG
            | HookFlags.AFTER_SWAP_RETURNS_DELTA_FLAG;
        for (uint256 i; i < 1_000_000; ++i) {
            bytes32 salt = bytes32(i);
            address predicted = vm.computeCreate2Address(salt, hash, address(this));
            if (uint160(predicted) & HookFlags.ALL_FLAGS_MASK == target) {
                deployed = new CoatFeeHook{salt: salt}(
                    address(this),
                    IPoolManagerMinimal(address(pm)),
                    IStateViewHook(address(state)),
                    address(coat),
                    ethSink,
                    address(this)
                );
                return deployed;
            }
        }
        revert("salt");
    }
}

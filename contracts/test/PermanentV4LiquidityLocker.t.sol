// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {
    PermanentV4LiquidityLocker,
    IV4PositionManagerLocker,
    IV4StateViewLocker
} from "../src/PermanentV4LiquidityLocker.sol";
import {Currency} from "../src/v4/V4Types.sol";

contract MockLockerPositionManager is IV4PositionManagerLocker {
    address public nftOwner;
    uint128 public liquidity;
    bytes public lastUnlockData;

    function setPosition(address owner_, uint128 liquidity_) external {
        nftOwner = owner_;
        liquidity = liquidity_;
    }

    function modifyLiquidities(bytes calldata unlockData, uint256) external payable {
        lastUnlockData = unlockData;
    }

    function ownerOf(uint256) external view returns (address) {
        return nftOwner;
    }

    function getPositionLiquidity(uint256) external view returns (uint128) {
        return liquidity;
    }
}

contract MockLockerState is IV4StateViewLocker {
    uint160 public sqrtPrice;

    function set(uint160 value) external {
        sqrtPrice = value;
    }

    function getSlot0(bytes32) external view returns (uint160, int24, uint24, uint24) {
        return (sqrtPrice, 0, 0, 0);
    }
}

contract PermanentV4LiquidityLockerTest is Test {
    uint160 constant Q96 = 1 << 96;
    MockLockerPositionManager manager;
    MockLockerState state;
    PermanentV4LiquidityLocker locker;

    function setUp() public {
        manager = new MockLockerPositionManager();
        state = new MockLockerState();
        locker = new PermanentV4LiquidityLocker(
            manager,
            state,
            payable(makeAddr("treasury")),
            7,
            keccak256("pool"),
            Currency.wrap(address(0)),
            Currency.wrap(makeAddr("coat")),
            uint128(10 ether),
            Q96,
            2 * Q96
        );
        manager.setPosition(address(locker), uint128(10 ether));
    }

    function test_principalExcludesFeesAndGraduates() public {
        state.set(2 * Q96);
        assertEq(locker.pairedPrincipal(), 0);
        assertFalse(locker.graduated());

        state.set(Q96);
        assertEq(locker.pairedPrincipal(), 5 ether);
        assertTrue(locker.graduated());
    }

    function test_permissionlessFeeCollectUsesZeroLiquidityOnly() public {
        vm.prank(makeAddr("anyone"));
        locker.collectFees();
        (bytes memory actions,) = abi.decode(manager.lastUnlockData(), (bytes, bytes[]));
        assertEq(actions, hex"0111");
        assertEq(manager.liquidity(), 10 ether);
    }

    function test_collectFailsIfPrincipalOrCustodyChanged() public {
        manager.setPosition(address(locker), uint128(9 ether));
        vm.expectRevert(PermanentV4LiquidityLocker.PrincipalChanged.selector);
        locker.collectFees();

        manager.setPosition(address(this), uint128(10 ether));
        vm.expectRevert(PermanentV4LiquidityLocker.PositionNotLocked.selector);
        locker.collectFees();
    }
}

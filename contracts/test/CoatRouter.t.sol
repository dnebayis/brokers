// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CoatRouter, IPoolManagerFull, IStateView} from "../src/CoatRouter.sol";
import {MockERC20} from "./Mocks.sol";
import {Currency, PoolKey, SwapParams, BalanceDelta} from "../src/v4/V4Types.sol";

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

contract RejectRouterRefund {
    function buy(CoatRouter router, uint256 minOut) external payable {
        router.buy{value: msg.value}(minOut, address(this));
    }

    receive() external payable {
        revert("reject");
    }
}

contract MockPoolManagerRouter is IPoolManagerFull, IStateView {
    MockERC20 public immutable coat;
    uint256 public consumed;
    uint256 public output;

    constructor(MockERC20 coat_) {
        coat = coat_;
    }

    function configure(uint256 consumed_, uint256 output_) external {
        consumed = consumed_;
        output = output_;
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        return IUnlockCallback(msg.sender).unlockCallback(data);
    }

    function swap(PoolKey memory, SwapParams memory params, bytes calldata)
        external
        view
        returns (BalanceDelta)
    {
        if (params.zeroForOne) return _pack(-int128(uint128(consumed)), int128(uint128(output)));
        return _pack(int128(uint128(output)), -int128(uint128(consumed)));
    }

    function settle() external payable returns (uint256) {
        return msg.value;
    }
    function sync(Currency) external {}

    function take(Currency currency, address to, uint256 amount) external {
        if (Currency.unwrap(currency) == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            require(ok, "eth transfer");
        } else {
            coat.transfer(to, amount);
        }
    }

    function getSlot0(bytes32) external pure returns (uint160, int24, uint24, uint24) {
        return (uint160(1 << 96), 0, 0, 0);
    }

    function _pack(int128 amount0, int128 amount1) internal pure returns (BalanceDelta) {
        int256 raw = (int256(amount0) << 128) | int256(uint256(uint128(amount1)));
        return BalanceDelta.wrap(raw);
    }
    receive() external payable {}
}

contract CoatRouterTest is Test {
    MockERC20 coat;
    MockPoolManagerRouter pm;
    CoatRouter router;
    address user = makeAddr("user");

    function setUp() public {
        coat = new MockERC20("COAT", "COAT");
        pm = new MockPoolManagerRouter(coat);
        router = new CoatRouter(
            IPoolManagerFull(address(pm)), IStateView(address(pm)), address(coat), address(0x44)
        );
        coat.mint(address(pm), 1_000_000 ether);
        vm.deal(address(pm), 1_000_000 ether);
    }

    function testFuzz_buyRefundsEveryUnconsumedWei(uint96 requestedRaw, uint96 consumedRaw) public {
        uint256 requested = bound(uint256(requestedRaw), 1, 100 ether);
        uint256 consumed = bound(uint256(consumedRaw), 0, requested);
        uint256 out = consumed * 2;
        pm.configure(consumed, out);
        vm.deal(user, requested + 1 ether);
        uint256 before = user.balance;

        vm.prank(user);
        uint256 received = router.buy{value: requested}(out, user);

        assertEq(received, out);
        assertEq(before - user.balance, consumed);
        assertEq(address(router).balance, 0);
        assertEq(address(pm).balance, 1_000_000 ether + consumed);
    }

    function testFuzz_sellRefundsEveryUnconsumedToken(uint96 requestedRaw, uint96 consumedRaw) public {
        uint256 requested = bound(uint256(requestedRaw), 1, 100 ether);
        uint256 consumed = bound(uint256(consumedRaw), 0, requested);
        uint256 out = consumed / 2;
        pm.configure(consumed, out);
        coat.mint(user, requested);
        vm.prank(user);
        coat.approve(address(router), requested);

        vm.prank(user);
        uint256 received = router.sell(requested, out, user);

        assertEq(received, out);
        assertEq(coat.balanceOf(user), requested - consumed);
        assertEq(coat.balanceOf(address(router)), 0);
        assertEq(coat.balanceOf(address(pm)), 1_000_000 ether + consumed);
    }

    function test_fullFillsLeaveNoRefundAndQuotesSpot() public {
        pm.configure(1 ether, 2 ether);
        vm.deal(user, 2 ether);
        vm.prank(user);
        router.buy{value: 1 ether}(2 ether, user);
        assertEq(address(router).balance, 0);
        assertEq(router.quoteBuy(3 ether), 3 ether);
        assertEq(router.quoteSell(3 ether), 3 ether);

        coat.mint(user, 1 ether);
        vm.prank(user);
        coat.approve(address(router), 1 ether);
        pm.configure(1 ether, 0.5 ether);
        vm.prank(user);
        router.sell(1 ether, 0.5 ether, user);
        assertEq(coat.balanceOf(address(router)), 0);
    }

    function test_slippageAndCallbackAuthorization() public {
        pm.configure(1 ether, 1 ether);
        vm.deal(user, 2 ether);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(CoatRouter.Slippage.selector, 1 ether, 2 ether));
        router.buy{value: 1 ether}(2 ether, user);

        vm.expectRevert(CoatRouter.NotPoolManager.selector);
        router.unlockCallback(abi.encode(uint8(0), 1 ether, user));

        coat.mint(user, 1 ether);
        vm.prank(user);
        coat.approve(address(router), 1 ether);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(CoatRouter.Slippage.selector, 1 ether, 2 ether));
        router.sell(1 ether, 2 ether, user);
    }

    function test_refundFailureRevertsAtomically() public {
        RejectRouterRefund rejector = new RejectRouterRefund();
        vm.deal(address(rejector), 2 ether);
        pm.configure(0.5 ether, 1 ether);
        vm.expectRevert(CoatRouter.RefundFailed.selector);
        rejector.buy{value: 1 ether}(router, 1 ether);
    }
}

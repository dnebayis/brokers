// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {COAT} from "../src/COAT.sol";

contract LaunchRelay {
    function forward(COAT coat, address to, uint256 amount) external {
        coat.transfer(to, amount);
    }
}

contract TokenomicsTest is Test {
    address liquidity = makeAddr("liquidity");
    address poolManager = makeAddr("poolManager");
    COAT coat;

    function setUp() public {
        coat = new COAT(liquidity, poolManager);
    }

    function test_supplyAllocationIsEnforced() public view {
        assertEq(coat.totalSupply(), 1_000_000_000 ether);
        assertEq(coat.balanceOf(liquidity), 1_000_000_000 ether);
        assertEq(coat.LIQUIDITY_SUPPLY(), coat.MAX_SUPPLY());
    }

    function test_launchProtectionCannotBeBypassedByPoolTransfer() public {
        uint256 supply = coat.MAX_SUPPLY();
        vm.prank(liquidity);
        coat.transfer(poolManager, supply);
        vm.prank(liquidity);
        coat.enableTrading();

        address buyer = makeAddr("buyer");
        vm.prank(poolManager);
        vm.expectRevert(COAT.LaunchBlockBuyBlocked.selector);
        coat.transfer(buyer, 1 ether);

        vm.roll(block.number + 1);
        vm.prank(poolManager);
        vm.expectRevert(COAT.ProtectedWalletTooLarge.selector);
        coat.transfer(buyer, 50_000_000 ether + 1);

        vm.prank(poolManager);
        coat.transfer(buyer, 50_000_000 ether);
        assertEq(coat.balanceOf(buyer), 50_000_000 ether);

        vm.prank(buyer);
        coat.transfer(poolManager, 1_000_000 ether);
        vm.prank(buyer);
        coat.transfer(makeAddr("peer"), 1_000_000 ether);

        // A router/callback cannot TAKE to itself and then overfill the real recipient.
        LaunchRelay relay = new LaunchRelay();
        LaunchRelay secondRelay = new LaunchRelay();
        address routedBuyer = makeAddr("routedBuyer");
        vm.prank(poolManager);
        coat.transfer(address(relay), 50_000_000 ether);
        relay.forward(coat, routedBuyer, 50_000_000 ether);
        vm.prank(poolManager);
        coat.transfer(address(secondRelay), 1 ether);
        vm.expectRevert(COAT.ProtectedWalletTooLarge.selector);
        secondRelay.forward(coat, routedBuyer, 1 ether);

        vm.roll(coat.restrictionsEndBlock() + 1);
        vm.prank(poolManager);
        coat.transfer(buyer, 60_000_000 ether);
    }

    function test_tradingCanOnlyBeEnabledOnceAfterSeed() public {
        vm.prank(liquidity);
        vm.expectRevert(COAT.LiquidityNotSeeded.selector);
        coat.enableTrading();

        vm.prank(liquidity);
        coat.transfer(poolManager, 1 ether);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(COAT.NotLaunchController.selector);
        coat.enableTrading();

        vm.prank(liquidity);
        coat.enableTrading();
        vm.prank(liquidity);
        vm.expectRevert(COAT.TradingAlreadyEnabled.selector);
        coat.enableTrading();
    }
}

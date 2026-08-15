// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";

/// A recipient that rejects ETH until toggled — models a broken/hostile sink.
contract Reverter {
    bool public accept;

    function setAccept(bool v) external {
        accept = v;
    }

    receive() external payable {
        require(accept, "reject");
    }
}

contract FeeSplitterTest is Test {
    FeeSplitter splitter;
    address owner = makeAddr("owner");
    address booster = makeAddr("booster");
    address treasury = makeAddr("treasury");
    address buyback = makeAddr("buyback");

    function setUp() public {
        splitter = new FeeSplitter(owner, payable(booster), payable(treasury), payable(buyback));
    }

    function test_defaultSplit_80_10_10() public {
        vm.deal(address(splitter), 10 ether);
        splitter.flush();
        assertEq(booster.balance, 8 ether);
        assertEq(treasury.balance, 1 ether);
        assertEq(buyback.balance, 1 ether);
        assertEq(address(splitter).balance, 0);
    }

    function test_flush_isPermissionless() public {
        vm.deal(address(splitter), 3 ether);
        vm.prank(makeAddr("anyone"));
        splitter.flush();
        assertEq(booster.balance, 2.4 ether);
    }

    // --- M-1: a reverting leg cannot block the others ---

    function test_M1_revertingLeg_doesNotBlockOthers_andParks() public {
        Reverter badTreasury = new Reverter(); // rejects ETH
        FeeSplitter s =
            new FeeSplitter(owner, payable(booster), payable(address(badTreasury)), payable(buyback));

        vm.deal(address(s), 10 ether);
        s.flush(); // must NOT revert despite the treasury leg failing

        assertEq(booster.balance, 8 ether); // paid
        assertEq(buyback.balance, 1 ether); // paid
        assertEq(s.owed(address(badTreasury)), 1 ether); // parked, not lost
        assertEq(s.totalOwed(), 1 ether);
        assertEq(address(s).balance, 1 ether); // exactly the parked amount stays
    }

    function test_M1_parkedFundsNotReSplitOnNextFlush() public {
        Reverter badTreasury = new Reverter();
        FeeSplitter s =
            new FeeSplitter(owner, payable(booster), payable(address(badTreasury)), payable(buyback));

        vm.deal(address(s), 10 ether);
        s.flush(); // treasury 1 parked (contract keeps 1)

        vm.deal(address(s), address(s).balance + 10 ether); // ADD a fresh 10 on top of the parked 1
        s.flush(); // must split the fresh 10 only, not the parked 1

        assertEq(booster.balance, 16 ether); // 8 + 8
        assertEq(buyback.balance, 2 ether); // 1 + 1
        assertEq(s.owed(address(badTreasury)), 2 ether); // 1 + 1 parked
        assertEq(s.totalOwed(), 2 ether);
    }

    function test_M1_release_retriesParkedLeg() public {
        Reverter badTreasury = new Reverter();
        FeeSplitter s =
            new FeeSplitter(owner, payable(booster), payable(address(badTreasury)), payable(buyback));

        vm.deal(address(s), 10 ether);
        s.flush();
        assertEq(s.owed(address(badTreasury)), 1 ether);

        // while still reverting, release restores the earmark and reverts (funds never leave)
        vm.expectRevert(FeeSplitter.NothingOwed.selector);
        s.release(payable(address(badTreasury)));
        assertEq(s.owed(address(badTreasury)), 1 ether);

        // fix the recipient, then release succeeds
        badTreasury.setAccept(true);
        s.release(payable(address(badTreasury)));
        assertEq(address(badTreasury).balance, 1 ether);
        assertEq(s.owed(address(badTreasury)), 0);
        assertEq(s.totalOwed(), 0);
    }

    function test_M1_release_revertsWhenNothingOwed() public {
        vm.expectRevert(FeeSplitter.NothingOwed.selector);
        splitter.release(payable(treasury));
    }

    function test_M1_zeroSink_rejected() public {
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        new FeeSplitter(owner, payable(address(0)), payable(treasury), payable(buyback));

        vm.prank(owner);
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        splitter.setSinks(payable(booster), payable(address(0)), payable(buyback));
    }
}

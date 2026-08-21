// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClaimSweeper} from "../src/ClaimSweeper.sol";

/// Minimal Booster stand-in: records every claimFor and can be told to revert for an id,
/// modelling a nonexistent token making the whole sweep atomic.
contract BoosterMock {
    uint256[] public claimed;
    uint256 public revertId;
    bool public hasRevertId;

    function setRevertId(uint256 id) external {
        revertId = id;
        hasRevertId = true;
    }

    function claimFor(uint256 tokenId) external {
        require(!hasRevertId || tokenId != revertId, "nonexistent token");
        claimed.push(tokenId);
    }

    function claimedCount() external view returns (uint256) {
        return claimed.length;
    }
}

contract ClaimSweeperTest is Test {
    BoosterMock booster;
    ClaimSweeper sweeper;

    function setUp() public {
        booster = new BoosterMock();
        sweeper = new ClaimSweeper(address(booster));
    }

    function test_sweeps_far_beyond_the_claimBatch_cap_in_one_call() public {
        uint256 n = 60; // 12x the Booster's 5-id claimBatch cap
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = i + 1;
        }
        sweeper.claimMany(ids);
        assertEq(booster.claimedCount(), n);
        assertEq(booster.claimed(0), 1);
        assertEq(booster.claimed(n - 1), n);
    }

    function test_any_caller_may_sweep_any_ids() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1776;
        vm.prank(makeAddr("stranger"));
        sweeper.claimMany(ids);
        assertEq(booster.claimedCount(), 1);
    }

    function test_reverts_atomically_when_one_claim_reverts() public {
        booster.setRevertId(2);
        uint256[] memory ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (1, 2, 3);
        vm.expectRevert(bytes("nonexistent token"));
        sweeper.claimMany(ids);
        assertEq(booster.claimedCount(), 0); // nothing partial
    }

    function test_rejects_empty_batch_and_zero_booster() public {
        vm.expectRevert(ClaimSweeper.EmptyBatch.selector);
        sweeper.claimMany(new uint256[](0));
        vm.expectRevert(ClaimSweeper.ZeroAddress.selector);
        new ClaimSweeper(address(0));
    }
}

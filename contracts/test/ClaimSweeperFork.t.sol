// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClaimSweeper} from "../src/ClaimSweeper.sol";

/// Mainnet-fork proof that one ClaimSweeper transaction sweeps well past the Booster's
/// 5-id claimBatch cap against the REAL deployed Booster. Runs only when RH_FORK_URL is
/// set (CI and local runs without an RPC skip it cleanly).
contract ClaimSweeperForkTest is Test {
    address constant BOOSTER = 0x7bAf435847A4b45c2e22a7fd13549C3192C95953;

    function test_fork_sweeps_20_brokers_in_one_tx() public {
        string memory rpc = vm.envOr("RH_FORK_URL", string(""));
        vm.skip(bytes(rpc).length == 0);
        vm.createSelectFork(rpc);

        ClaimSweeper sweeper = new ClaimSweeper(BOOSTER);
        // The collection is sold out (1,776/1,776), so every id exists; claimFor on a
        // Broker with nothing pending is a documented no-op rather than a revert.
        uint256 n = 20; // 4x the claimBatch cap, in a single transaction
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = i + 1;
        }
        vm.prank(makeAddr("anyone"));
        sweeper.claimMany(ids);
    }
}

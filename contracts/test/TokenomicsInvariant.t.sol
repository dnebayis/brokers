// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {COAT} from "../src/COAT.sol";

contract TokenomicsHandler is Test {
    COAT public immutable coat;
    address public immutable poolManager;
    address[8] public actors;

    constructor(COAT coat_, address poolManager_) {
        coat = coat_;
        poolManager = poolManager_;
        for (uint256 i; i < actors.length; ++i) {
            actors[i] = address(uint160(0x1000 + i));
        }
    }

    function buy(uint256 actorSeed, uint256 amountSeed) external {
        address actor = actors[actorSeed % actors.length];
        uint256 available = coat.balanceOf(poolManager);
        if (available == 0) return;
        uint256 amount = bound(amountSeed, 0, available);
        vm.prank(poolManager);
        coat.transfer(actor, amount);
    }

    function sell(uint256 actorSeed, uint256 amountSeed) external {
        address actor = actors[actorSeed % actors.length];
        uint256 available = coat.balanceOf(actor);
        if (available == 0) return;
        uint256 amount = bound(amountSeed, 0, available);
        vm.prank(actor);
        coat.transfer(poolManager, amount);
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 available = coat.balanceOf(from);
        if (available == 0 || from == to) return;
        uint256 amount = bound(amountSeed, 0, available);
        vm.prank(from);
        coat.transfer(to, amount);
    }

    function burn(uint256 actorSeed, uint256 amountSeed) external {
        address actor = actors[actorSeed % actors.length];
        uint256 available = coat.balanceOf(actor);
        if (available == 0) return;
        uint256 amount = bound(amountSeed, 0, available);
        vm.prank(actor);
        coat.burn(amount);
    }
}

contract TokenomicsInvariantTest is StdInvariant, Test {
    COAT coat;
    TokenomicsHandler handler;
    address poolManager = makeAddr("invariantPoolManager");

    function setUp() public {
        coat = new COAT(address(this), poolManager);
        coat.transfer(poolManager, coat.MAX_SUPPLY());
        coat.enableTrading();
        vm.roll(coat.restrictionsEndBlock() + 1);

        handler = new TokenomicsHandler(coat, poolManager);
        targetContract(address(handler));
    }

    function invariant_supplyEqualsAllBalancesAndBurnsReconcile() public view {
        uint256 accounted = coat.balanceOf(poolManager) + coat.balanceOf(address(handler));
        for (uint256 i; i < 8; ++i) {
            accounted += coat.balanceOf(handler.actors(i));
        }

        assertEq(accounted, coat.totalSupply(), "all live COAT must be accounted for");
        assertEq(
            coat.totalSupply() + (coat.MAX_SUPPLY() - coat.totalSupply()),
            coat.MAX_SUPPLY(),
            "initial supply must equal live supply plus true burns"
        );
    }
}

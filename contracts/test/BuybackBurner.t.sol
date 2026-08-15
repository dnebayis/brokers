// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {BuybackBurner, ICoatBuybackRouter, ICoatTwap, ICoatBurn} from "../src/BuybackBurner.sol";

contract MockBurnCoat is ERC20, ERC20Burnable {
    constructor() ERC20("COAT", "COAT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockTwap is ICoatTwap {
    uint256 public priceX96;
    bool public ready;

    function set(uint256 priceX96_, bool ready_) external {
        priceX96 = priceX96_;
        ready = ready_;
    }

    function consultPriceX96(uint32) external view returns (uint256) {
        require(ready, "history");
        return priceX96;
    }
}

contract MockBuybackRouter is ICoatBuybackRouter {
    MockBurnCoat public immutable coat;
    uint256 public quote;
    uint256 public actualRate;

    constructor(MockBurnCoat coat_) {
        coat = coat_;
    }

    function set(uint256 quote_, uint256 actualRate_) external {
        quote = quote_;
        actualRate = actualRate_;
    }

    function quoteBuy(uint256 ethIn) external view returns (uint256) {
        return quote * ethIn / 1 ether;
    }

    function buy(uint256 minOut, address to) external payable returns (uint256 out) {
        out = actualRate * msg.value / 1 ether;
        require(out >= minOut, "slippage");
        coat.mint(to, out);
    }
}

contract BuybackBurnerTest is Test {
    uint256 constant Q96 = 1 << 96;
    MockBurnCoat coat;
    MockTwap hook;
    MockBuybackRouter router;
    BuybackBurner burner;

    function setUp() public {
        coat = new MockBurnCoat();
        hook = new MockTwap();
        router = new MockBuybackRouter(coat);
        burner = new BuybackBurner(
            ICoatBuybackRouter(address(router)), ICoatTwap(address(hook)), ICoatBurn(address(coat))
        );
        vm.deal(address(burner), 1 ether);
    }

    function test_revertsWithoutThirtyMinuteHistory() public {
        hook.set(100 * Q96, false);
        vm.expectRevert("history");
        burner.executeBuyback();
    }

    function test_revertsWhenSpotDeviationExceedsFivePercent() public {
        hook.set(100 * Q96, true);
        router.set(106 ether, 100 ether);
        vm.expectRevert(
            abi.encodeWithSelector(BuybackBurner.SpotTooFarFromTwap.selector, 106 ether, 100 ether)
        );
        burner.executeBuyback();
    }

    function test_permissionlessBuybackBurnsBoundedOutput() public {
        hook.set(100 * Q96, true);
        router.set(102 ether, 100 ether);
        vm.prank(makeAddr("keeper"));
        uint256 burned = burner.executeBuyback();
        assertEq(burned, 1 ether);
        assertEq(coat.totalSupply(), 0);
        assertEq(coat.balanceOf(address(burner)), 0);
        assertEq(address(burner).balance, 0.99 ether);
    }

    function test_emptyBalanceAndLowerSpotBranch() public {
        vm.deal(address(burner), 0);
        vm.expectRevert(BuybackBurner.EmptyBalance.selector);
        burner.executeBuyback();

        vm.deal(address(burner), 1 ether);
        hook.set(100 * Q96, true);
        router.set(97 ether, 100 ether);
        assertEq(burner.executeBuyback(), 1 ether);
    }

    function test_oversizedDonationCanAlwaysDrainInSmallerBatches() public {
        hook.set(100 * Q96, true);
        router.set(100 ether, 100 ether);
        assertEq(burner.executeBuyback(0.001 ether), 0.1 ether);
        assertEq(address(burner).balance, 0.999 ether);

        vm.expectRevert(BuybackBurner.InvalidBatch.selector);
        burner.executeBuyback(0.02 ether);
    }
}

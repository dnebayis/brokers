// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RialtoLeg, RialtoPokeRunner, IRialtoRouterRegistry, IBoosterPoke} from "../src/RialtoLeg.sol";

contract MockToken is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, uint8 d) ERC20(n, n) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// Stands in for the Rialto router: pulls `sell` of USDG from the taker named in the calldata
/// and pays `out` of stock, the way an API-built quote settles.
contract MockRialtoRouter {
    MockToken public usdg;
    MockToken public stock;

    constructor(MockToken u, MockToken s) {
        usdg = u;
        stock = s;
    }

    function fill(address taker, uint256 sell, uint256 out) external {
        usdg.transferFrom(taker, address(this), sell);
        stock.mint(taker, out);
    }
}

contract MockRegistry is IRialtoRouterRegistry {
    address public router;

    constructor(address r) {
        router = r;
    }

    function set(address r) external {
        router = r;
    }

    function ownerOf(uint256) external view returns (address) {
        return router;
    }
}

/// The only thing the StockRouter does around the hop: approve the adapter and call it.
contract MockStockRouter {
    function hop(RialtoLeg leg, MockToken usdg, uint256 amountIn, uint256 minOut) external returns (uint256) {
        usdg.approve(address(leg), amountIn);
        return leg.swapExactIn(true, amountIn, minOut, address(this), block.timestamp);
    }
}

contract MockBooster is IBoosterPoke {
    RialtoLeg public leg;
    MockStockRouter public router;
    MockToken public usdg;
    uint256 public amountIn;
    uint256 public minOut;
    uint256 public bought;
    bool public touchLeg = true;

    function configure(RialtoLeg l, MockStockRouter r, MockToken u, uint256 a, uint256 m) external {
        leg = l;
        router = r;
        usdg = u;
        amountIn = a;
        minOut = m;
    }

    function setTouchLeg(bool t) external {
        touchLeg = t;
    }

    function poke() external {
        if (touchLeg) bought = router.hop(leg, usdg, amountIn, minOut);
    }

    function poke(uint256) external {
        if (touchLeg) bought = router.hop(leg, usdg, amountIn, minOut);
    }
}

contract RialtoLegTest is Test {
    MockToken usdg;
    MockToken stock;
    MockRialtoRouter rialto;
    MockRegistry registry;
    MockStockRouter stockRouter;
    MockBooster booster;
    RialtoPokeRunner runner;
    RialtoLeg leg;
    address keeper = address(0x4EE9);

    function setUp() public {
        usdg = new MockToken("USDG", 6);
        stock = new MockToken("NBIS", 18);
        rialto = new MockRialtoRouter(usdg, stock);
        registry = new MockRegistry(address(rialto));
        stockRouter = new MockStockRouter();
        booster = new MockBooster();
        runner = new RialtoPokeRunner(booster, address(this), keeper);
        leg = new RialtoLeg(address(usdg), address(stock), address(stockRouter), address(runner), registry);
    }

    function _fillData(uint256 sell, uint256 out) internal view returns (bytes memory) {
        return abi.encodeCall(MockRialtoRouter.fill, (address(leg), sell, out));
    }

    function test_token_order_matches_stockrouter_expectations() public view {
        assertEq(leg.token0(), address(usdg));
        assertEq(leg.token1(), address(stock));
    }

    function test_fill_pays_the_router_and_keeps_the_remainder_as_carry() public {
        usdg.mint(address(stockRouter), 100e6);
        vm.prank(address(runner));
        leg.stage(_fillData(95e6, 1e18), 95e6);

        uint256 out = stockRouter.hop(leg, usdg, 100e6, 0.9e18);

        assertEq(out, 1e18);
        assertEq(stock.balanceOf(address(stockRouter)), 1e18, "stock forwarded to the caller");
        assertEq(stock.balanceOf(address(leg)), 0);
        assertEq(leg.carry(), 5e6, "unsold USDG carried");
        assertEq(usdg.allowance(address(leg), address(rialto)), 0, "allowance reset");
        assertFalse(leg.isStaged(), "quote consumed");
    }

    function test_carry_is_spent_by_a_later_quote() public {
        usdg.mint(address(leg), 5e6); // carry from an earlier hour
        usdg.mint(address(stockRouter), 100e6);
        vm.prank(address(runner));
        leg.stage(_fillData(105e6, 1e18), 105e6);
        stockRouter.hop(leg, usdg, 100e6, 0);
        assertEq(leg.carry(), 0);
    }

    function test_reverts_when_the_router_gives_less_usdg_than_the_quote_sells() public {
        usdg.mint(address(stockRouter), 90e6);
        vm.prank(address(runner));
        leg.stage(_fillData(95e6, 1e18), 95e6);
        vm.expectRevert(abi.encodeWithSelector(RialtoLeg.ShortOfSellAmount.selector, 90e6, 95e6));
        stockRouter.hop(leg, usdg, 90e6, 0);
    }

    function test_reverts_below_the_min_out_the_stockrouter_demands() public {
        usdg.mint(address(stockRouter), 100e6);
        vm.prank(address(runner));
        leg.stage(_fillData(100e6, 0.5e18), 100e6);
        vm.expectRevert(abi.encodeWithSelector(RialtoLeg.Slippage.selector, 0.5e18, 0.9e18));
        stockRouter.hop(leg, usdg, 100e6, 0.9e18);
    }

    function test_unstaged_and_wrong_direction_and_wrong_caller_revert() public {
        usdg.mint(address(stockRouter), 100e6);
        vm.expectRevert(RialtoLeg.NotStaged.selector);
        stockRouter.hop(leg, usdg, 100e6, 0);

        vm.prank(address(runner));
        leg.stage(_fillData(100e6, 1e18), 100e6);
        vm.prank(address(stockRouter));
        vm.expectRevert(RialtoLeg.WrongDirection.selector);
        leg.swapExactIn(false, 100e6, 0, address(this), block.timestamp);

        vm.expectRevert(RialtoLeg.NotStockRouter.selector);
        leg.swapExactIn(true, 100e6, 0, address(this), block.timestamp);
    }

    function test_stage_is_runner_only_and_single_shot() public {
        vm.expectRevert(RialtoLeg.NotRunner.selector);
        leg.stage(hex"01", 1);
        vm.startPrank(address(runner));
        leg.stage(hex"01", 1);
        vm.expectRevert(RialtoLeg.AlreadyStaged.selector);
        leg.stage(hex"02", 2);
        leg.clear();
        assertFalse(leg.isStaged());
        vm.stopPrank();
    }

    function test_follows_the_registry_when_rialto_migrates_its_router() public {
        MockRialtoRouter next = new MockRialtoRouter(usdg, stock);
        registry.set(address(next));
        usdg.mint(address(stockRouter), 100e6);
        vm.prank(address(runner));
        leg.stage(abi.encodeCall(MockRialtoRouter.fill, (address(leg), 100e6, 1e18)), 100e6);
        stockRouter.hop(leg, usdg, 100e6, 0);
        assertEq(usdg.balanceOf(address(next)), 100e6, "paid the router the registry names now");
    }

    function test_runner_stages_pokes_and_clears_in_one_transaction() public {
        usdg.mint(address(stockRouter), 100e6);
        booster.configure(leg, stockRouter, usdg, 100e6, 0.9e18);
        RialtoPokeRunner.Leg[] memory legs = new RialtoPokeRunner.Leg[](1);
        legs[0] = RialtoPokeRunner.Leg({leg: leg, data: _fillData(99e6, 1e18), sellAmount: 99e6});

        vm.prank(keeper);
        runner.run(legs, 0.5 ether);

        assertEq(booster.bought(), 1e18);
        assertFalse(leg.isStaged());
        assertEq(leg.carry(), 1e6);
    }

    function test_runner_clears_a_leg_the_basket_did_not_touch() public {
        booster.configure(leg, stockRouter, usdg, 0, 0);
        booster.setTouchLeg(false);
        RialtoPokeRunner.Leg[] memory legs = new RialtoPokeRunner.Leg[](1);
        legs[0] = RialtoPokeRunner.Leg({leg: leg, data: _fillData(1, 1), sellAmount: 1});
        vm.prank(keeper);
        runner.run(legs, 0);
        assertFalse(leg.isStaged(), "nothing left staged for a stranger's poke");
    }

    function test_runner_allowlist() public {
        booster.setTouchLeg(false);
        RialtoPokeRunner.Leg[] memory legs = new RialtoPokeRunner.Leg[](0);
        vm.prank(address(0xBAD));
        vm.expectRevert(RialtoPokeRunner.NotStager.selector);
        runner.run(legs, 0);

        runner.setStager(address(0xBAD), true);
        vm.prank(address(0xBAD));
        runner.run(legs, 0);

        vm.prank(address(0xBAD));
        vm.expectRevert();
        runner.setStager(address(0xBAD), false);
    }
}

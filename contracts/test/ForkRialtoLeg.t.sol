// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAggregatorV3} from "../src/interfaces/IExternal.sol";
import {StockRouter} from "../src/StockRouter.sol";
import {Booster} from "../src/Booster.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";
import {RialtoLeg, RialtoPokeRunner, IRialtoRouterRegistry, IBoosterPoke} from "../src/RialtoLeg.sol";

/// Robinhood Chain is an Arbitrum Orbit chain; IMC's propAMMs read ArbSys (0x64). Foundry's EVM
/// has no such precompile, so the fork installs this stand-in.
contract ArbSysMock {
    function arbBlockNumber() external view returns (uint256) {
        return block.number;
    }

    function arbBlockHash(uint256 n) external view returns (bytes32) {
        return blockhash(n);
    }

    function arbChainID() external view returns (uint256) {
        return block.chainid;
    }
}

/// The RialtoLeg adapter against DEPLOYED mainnet core on a fork: the real StockRouter gets a
/// Rialto-kind route pointing at the adapter, the real Booster gets the Chainlink feed, and the
/// real basket is repointed at a name that has no v3 liquidity (NBIS). Needs the API key in
/// indexer/.env and ffi:
///   forge test --match-contract ForkRialtoLeg --fork-url https://rpc.mainnet.chain.robinhood.com --ffi \
///     --gas-limit 8000000 --gas-price 150000000 -vv
contract ForkRialtoLegTest is Test {
    address constant OWNER = 0x9e643731dc9D8795573Aa34C410664407FfDC440; // StockRouter/Booster owner, registry updater
    StockRouter constant STOCK_ROUTER = StockRouter(payable(0x99F3f896B58bcb8A515ED3C7174c017B5a55075a));
    Booster constant BOOSTER = Booster(payable(0x7bAf435847A4b45c2e22a7fd13549C3192C95953));
    StrategyRegistry constant STRATEGIES = StrategyRegistry(0xA20f9D47E0c41e52a57d65feA9A9322732aF86Aa);
    IRialtoRouterRegistry constant RIALTO_REGISTRY =
        IRialtoRouterRegistry(0x71a120CbBf3Ce7cD910a3c50fF77aFc62735687E);
    address constant MID_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NBIS = 0x9D9c6684F596F66a64C030B93A886D51Fd4D7931;
    address constant NBIS_FEED = 0xE1D87B116Ba0fe898998f1D140339D1fA1E09705;
    address constant INTC = 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681;
    address constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    RialtoPokeRunner runner;
    RialtoLeg leg;

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        vm.etch(address(0x64), address(new ArbSysMock()).code);
        runner = new RialtoPokeRunner(IBoosterPoke(address(BOOSTER)), address(this), address(this));
        leg = new RialtoLeg(USDG, NBIS, address(STOCK_ROUTER), address(runner), RIALTO_REGISTRY);
        vm.prank(OWNER);
        STOCK_ROUTER.setRoute(NBIS, MID_POOL, USDG, address(leg), StockRouter.PoolKind.Rialto);
        vm.prank(OWNER);
        BOOSTER.setStockFeed(NBIS, IAggregatorV3(NBIS_FEED));
    }

    /// The keeper's sizing rule: the ETH slice at the Chainlink ETH/USD price, less 1% for the
    /// mid-pool fee and drift, plus whatever USDG the adapter is already carrying.
    function _sellFor(uint256 ethIn) internal view returns (uint256) {
        (, int256 px,,,) = IAggregatorV3(ETH_USD_FEED).latestRoundData();
        uint256 usd6 = ethIn * uint256(px) / 1e8 / 1e12;
        return usd6 * 99 / 100 + leg.carry();
    }

    function _quote(uint256 sell) internal returns (bytes memory data, uint256 minBuy) {
        string[] memory cmd = new string[](6);
        cmd[0] = "python3";
        cmd[1] = "test/ffi/rialto_quote.py";
        cmd[2] = vm.toString(USDG);
        cmd[3] = vm.toString(NBIS);
        cmd[4] = string.concat("raw6:", vm.toString(sell));
        cmd[5] = vm.toString(address(leg));
        (address to, bytes memory d, uint256 m, uint256 sellRaw) =
            abi.decode(vm.ffi(cmd), (address, bytes, uint256, uint256));
        assertEq(sellRaw, sell, "quote sell amount");
        assertEq(to, RIALTO_REGISTRY.ownerOf(2), "quote targets the registry's active router");
        return (d, m);
    }

    function test_route_is_installed_on_the_deployed_router() public view {
        (,, address stockPool, StockRouter.PoolKind kind,, bool stockZeroForOne) = STOCK_ROUTER.routes(NBIS);
        assertEq(stockPool, address(leg));
        assertEq(uint8(kind), uint8(StockRouter.PoolKind.Rialto));
        assertTrue(stockZeroForOne, "USDG is token0, so the router sells token0 for token1");
    }

    function test_stockrouter_buys_through_the_adapter() public {
        uint256 ethIn = 0.02 ether;
        uint256 sell = _sellFor(ethIn);
        (bytes memory data, uint256 rialtoMin) = _quote(sell);
        vm.prank(address(runner));
        leg.stage(data, sell);

        uint256 minOut = BOOSTER.minOut(NBIS, ethIn);
        uint256 before = IERC20(NBIS).balanceOf(address(this));
        uint256 out = STOCK_ROUTER.swapExactETHForStock{value: ethIn}(
            NBIS, minOut, address(this), block.timestamp + 60
        );
        uint256 got = IERC20(NBIS).balanceOf(address(this)) - before;

        emit log_named_uint("sell USDG (1e6)", sell);
        emit log_named_uint("chainlink floor (1e18)", minOut);
        emit log_named_uint("rialto min (1e18)", rialtoMin);
        emit log_named_uint("got NBIS (1e18)", got);
        emit log_named_uint("carry after (1e6)", leg.carry());
        assertEq(out, got);
        assertGe(got, rialtoMin);
        assertGe(got, minOut);
        assertFalse(leg.isStaged(), "quote consumed");
        assertEq(IERC20(USDG).allowance(address(leg), RIALTO_REGISTRY.ownerOf(2)), 0, "allowance reset");
        assertEq(IERC20(NBIS).balanceOf(address(leg)), 0, "adapter keeps no stock");
        assertLt(leg.carry(), 5e6, "carry is dust");
    }

    function test_runner_stages_and_pokes_the_real_booster() public {
        // Repoint the live basket at NBIS (Rialto leg) + INTC (existing v3 route), 50/50.
        address[] memory tokens = new address[](2);
        tokens[0] = NBIS;
        tokens[1] = INTC;
        uint16[] memory weights = new uint16[](2);
        weights[0] = 5000;
        weights[1] = 5000;
        vm.prank(OWNER);
        STRATEGIES.setStrategy(0, tokens, weights);

        uint256 maxSpend = 0.04 ether;
        vm.deal(address(BOOSTER), 0.1 ether); // buffer >= maxSpend, so each slice is exactly 0.02 ETH
        uint256 sell = _sellFor(maxSpend / 2);
        (bytes memory data,) = _quote(sell);

        RialtoPokeRunner.Leg[] memory legs = new RialtoPokeRunner.Leg[](1);
        legs[0] = RialtoPokeRunner.Leg({leg: leg, data: data, sellAmount: sell});
        uint256 nbisBefore = BOOSTER.totalBought(NBIS);
        uint256 intcBefore = BOOSTER.totalBought(INTC);
        uint256 boosterNbisBefore = IERC20(NBIS).balanceOf(address(BOOSTER));
        runner.run(legs, maxSpend);

        uint256 nbisGot = BOOSTER.totalBought(NBIS) - nbisBefore;
        emit log_named_uint("booster bought NBIS (1e18)", nbisGot);
        emit log_named_uint("booster bought INTC (1e18)", BOOSTER.totalBought(INTC) - intcBefore);
        emit log_named_uint("carry after (1e6)", leg.carry());
        assertGt(nbisGot, 0, "NBIS leg filled through Rialto");
        assertGt(BOOSTER.totalBought(INTC) - intcBefore, 0, "v3 leg still fills");
        assertGe(nbisGot, BOOSTER.minOut(NBIS, maxSpend / 2), "at or above the Chainlink floor");
        assertEq(
            IERC20(NBIS).balanceOf(address(BOOSTER)) - boosterNbisBefore,
            nbisGot,
            "stock landed in the Booster"
        );
        assertFalse(leg.isStaged());
    }

    function test_unstaged_leg_reverts_the_poke_instead_of_filling_blind() public {
        address[] memory tokens = new address[](1);
        tokens[0] = NBIS;
        uint16[] memory weights = new uint16[](1);
        weights[0] = 10_000;
        vm.prank(OWNER);
        STRATEGIES.setStrategy(0, tokens, weights);
        vm.deal(address(BOOSTER), 0.1 ether);
        vm.expectRevert(RialtoLeg.NotStaged.selector);
        BOOSTER.poke(0.02 ether);
    }

    function test_only_runner_stages_and_only_router_swaps() public {
        vm.expectRevert(RialtoLeg.NotRunner.selector);
        leg.stage(hex"01", 1);
        vm.expectRevert(RialtoLeg.NotStockRouter.selector);
        leg.swapExactIn(true, 1, 0, address(this), block.timestamp);
        RialtoPokeRunner.Leg[] memory legs = new RialtoPokeRunner.Leg[](0);
        vm.prank(address(0xBEEF));
        vm.expectRevert(RialtoPokeRunner.NotStager.selector);
        runner.run(legs, 0);
    }

    receive() external payable {}
}

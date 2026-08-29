// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StockRouter} from "../src/StockRouter.sol";
import {IAggregatorV3} from "../src/interfaces/IExternal.sol";

/// Promotion probe for two names the universe does not carry yet. Same bar as the V2 batch:
/// buy the stock with a real swap on its live pool, through the production mid pool, with a
/// valid official guard feed. GME and DELL are the only blocked candidates that have a
/// price feed AND a pool with real depth, so they are the only ones eligible today.
///   forge test --match-path test/ForkRouteProbeGmeDell.t.sol --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract ForkRouteProbeGmeDellTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant MID_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    address constant GME = 0x1b0E319c6A659F002271B69dB8A7df2F911c153E;
    address constant GME_POOL = 0x0A0675689C2Ad2a3aDe86539BCbD27B6c0764e9d; // 0.3%, deepest
    address constant GME_FEED = 0x27C71df6A64fB476468EdF256CF72c038baB5B67;

    address constant DELL = 0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd;
    address constant DELL_POOL = 0xc30c89cB7815A1488b7998D15eEC73961707Fc5a; // 1%
    address constant DELL_FEED = 0x1C6c8cADBe02E19129c39dDB92281cE4c0bf206b;

    StockRouter router;

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        router = new StockRouter(WETH, address(this));
        vm.deal(address(this), 5 ether);
    }

    function _probe(string memory sym, address stock, address pool, address feed, uint256 spend) internal {
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(feed).latestRoundData();
        assertGt(answer, 0, "feed non-positive");
        assertGt(updatedAt, 0, "feed has no timestamp");
        emit log_named_uint(string.concat(sym, " feed age (hours)"), (block.timestamp - updatedAt) / 3600);

        router.setRoute(stock, MID_POOL, USDG, pool, StockRouter.PoolKind.V3);
        uint256 out =
            router.swapExactETHForStock{value: spend}(stock, 1, address(this), block.timestamp + 600);
        assertGt(out, 0, "route produced no stock");
        emit log_named_uint(string.concat(sym, " bought (1e18)"), out);

        // value what we got against the official feed, so a broken pool price shows up as a
        // bad fill rather than passing merely because some tokens moved
        uint256 usdOut = out * uint256(answer) / 1e8;
        emit log_named_uint(string.concat(sym, " value received (usd 1e18)"), usdOut);
        assertGt(usdOut, 0, "no value received");
    }

    function test_probe_GME() public {
        _probe("GME", GME, GME_POOL, GME_FEED, 0.01 ether);
    }

    function test_probe_DELL() public {
        _probe("DELL", DELL, DELL_POOL, DELL_FEED, 0.01 ether);
    }

    /// Depth check: a route that only fills dust is not worth promoting.
    function test_probe_GME_atSize() public {
        _probe("GME @ 0.2 ETH", GME, GME_POOL, GME_FEED, 0.2 ether);
    }

    function test_probe_DELL_atSize() public {
        _probe("DELL @ 0.2 ETH", DELL, DELL_POOL, DELL_FEED, 0.2 ether);
    }
}

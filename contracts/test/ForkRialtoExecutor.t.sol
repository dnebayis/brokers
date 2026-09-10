// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAggregatorV3} from "../src/interfaces/IExternal.sol";

/// A contract that holds USDG, approves the Rialto router for exactly one quote, executes the
/// quote's calldata and resets the allowance. This is the "executor" pattern Rialto documents
/// for liquidators; it is the shape a StockRouter-facing adapter would take.
contract RialtoExecutorHarness {
    function run(address sellToken, address spender, uint256 sellAmount, bytes calldata data) external {
        IERC20(sellToken).approve(spender, sellAmount);
        (bool ok, bytes memory result) = spender.call(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        IERC20(sellToken).approve(spender, 0);
    }
}

/// Robinhood Chain is an Arbitrum Orbit chain; IMC's propAMMs read ArbSys (0x64) for the L2 block
/// number. Foundry's EVM has no such precompile, so the fork installs this stand-in.
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

/// Feasibility probe, against DEPLOYED mainnet state on a fork: can a contract (not an EOA) buy a
/// Robinhood stock through the Rialto router with allowance settlement, using calldata the API
/// built for that contract as taker? Needs the API key in indexer/.env and ffi:
///   forge test --match-contract ForkRialtoExecutor --fork-url https://rpc.mainnet.chain.robinhood.com --ffi -vv
contract ForkRialtoExecutorTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NBIS = 0x9D9c6684F596F66a64C030B93A886D51Fd4D7931;
    address constant NBIS_FEED = 0xE1D87B116Ba0fe898998f1D140339D1fA1E09705;
    address constant COIN = 0x6330D8C3178a418788dF01a47479c0ce7CCF450b;
    address constant COIN_FEED = 0xA3a468A452940B7D6b69991207B508c609a98Ef2;
    uint256 constant SELL = 250e6; // 250 USDG, about one hourly basket leg

    RialtoExecutorHarness harness;

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        vm.etch(address(0x64), address(new ArbSysMock()).code);
        harness = new RialtoExecutorHarness();
        deal(USDG, address(harness), SELL);
    }

    function _quote(address buy)
        internal
        returns (address to, bytes memory data, uint256 minBuy, uint256 sellRaw)
    {
        string[] memory cmd = new string[](6);
        cmd[0] = "python3";
        cmd[1] = "test/ffi/rialto_quote.py";
        cmd[2] = vm.toString(USDG);
        cmd[3] = vm.toString(buy);
        cmd[4] = "250";
        cmd[5] = vm.toString(address(harness));
        bytes memory raw = vm.ffi(cmd);
        (to, data, minBuy, sellRaw) = abi.decode(raw, (address, bytes, uint256, uint256));
    }

    function _buy(address stock, address feed, string memory name) internal {
        (address to, bytes memory data, uint256 minBuy, uint256 sellRaw) = _quote(stock);
        assertEq(sellRaw, SELL, "quote sell amount");
        uint256 before = IERC20(stock).balanceOf(address(harness));
        harness.run(USDG, to, sellRaw, data);
        uint256 got = IERC20(stock).balanceOf(address(harness)) - before;
        emit log_named_address(string.concat(name, " router"), to);
        emit log_named_uint(string.concat(name, " min out (1e18)"), minBuy);
        emit log_named_uint(string.concat(name, " got (1e18)"), got);
        assertGe(got, minBuy, "fill below quoted minimum");
        assertEq(IERC20(USDG).allowance(address(harness), to), 0, "allowance not reset");
        // Sanity against Chainlink: 250 USDG at the feed price, within 3%.
        (, int256 px,,,) = IAggregatorV3(feed).latestRoundData();
        uint256 expected = SELL * 1e18 * 1e8 / uint256(px) / 1e6;
        emit log_named_uint(string.concat(name, " chainlink-implied (1e18)"), expected);
        assertGe(got * 10000, expected * 9700, "more than 3% below the feed");
    }

    function test_contract_taker_buys_nbis_via_rialto() public {
        _buy(NBIS, NBIS_FEED, "NBIS");
    }

    function test_contract_taker_buys_coin_via_rialto() public {
        _buy(COIN, COIN_FEED, "COIN");
    }
}

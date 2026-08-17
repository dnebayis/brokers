// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StockRouter} from "../src/StockRouter.sol";
import {IAggregatorV3} from "../src/interfaces/IExternal.sol";

interface IRialtoPoolFork {
    function fermi() external view returns (address);
}

interface IFermiFork {
    function lastUpdateBlock() external view returns (uint256);
}

/// @notice V2 universe expansion probe. Attempts a real 0.001 ETH -> stock buy on each
///         candidate's live Rialto route and checks its official guard feed, one at a time,
///         recording pass/fail per symbol without ever failing the run. Discovery output —
///         `reports/route-candidate-probe.json` — is the deliverable, so a candidate that
///         cannot route today does not break the mandatory fork gate. Only candidates that
///         pass here are promoted into `route-ready.mainnet.json`.
///
///         Runs only on a real RH mainnet fork (chainid 4663); a no-op elsewhere.
contract ForkStockRoutesV2ProbeTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant MID_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    StockRouter internal router;

    string[18] internal symbols = [
        "NVDA",
        "TSLA",
        "MSFT",
        "GOOGL",
        "META",
        "PLTR",
        "ORCL",
        "MU",
        "INTC",
        "CRWV",
        "SNDK",
        "USAR",
        "SPCX",
        "QQQ",
        "SGOV",
        "SLV",
        "SPY",
        "USO"
    ];
    address[18] internal tokens = [
        0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,
        0x322F0929c4625eD5bAd873c95208D54E1c003b2d,
        0xe93237C50D904957Cf27E7B1133b510C669c2e74,
        0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3,
        0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35,
        0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A,
        0xb0992820E760d836549ba69BC7598b4af75dEE03,
        0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD,
        0xc72b96e0E48ecd4DC75E1e45396e26300BC39681,
        0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3,
        0xB90A19fF0Af67f7779afF50A882A9CfF42446400,
        0xd917B029C761D264c6A312BBbcDA868658eF86a6,
        0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa,
        0xD5f3879160bc7c32ebb4dC785F8a4F505888de68,
        0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5,
        0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f,
        0x117cc2133c37B721F49dE2A7a74833232B3B4C0C,
        0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344
    ];
    address[18] internal pools = [
        0x682fd352329026885366D6649D61CB4EE505E7A4,
        0x08b29F180ae8873897B3b8C2E0EA041172236E63,
        0xEE3045339447359e6C021eD63537305DEBDbd610,
        0x7DA0e2609E8dcf31055A8710465516056CF96E64,
        0xB535F7D16c28Cc86769bE67fa13cdF929c9b5b6d,
        0x4bf0949F64739F4e493415bCdAA595Dee6aa9840,
        0xFdE9fD3207B26c3607a6eD30b27615C186131698,
        0xA84a59b1Bc44E4F99e7aB84Cf68D998f7d5a74e9,
        0xb1742eDaC0794f792f84e7beb6aB7004e2C26bda,
        0x67C574d4D5025E93822fC434002d1D36E603D77C,
        0x38dd9f56D7b061dffa19f9c9E0930810285A1eD6,
        0x4fA3B64Df2756fC6d9d9efef713D9451002e3d58,
        0x10fF8720e7B2731399838fF3Fe3B73e1D143Aa74,
        0xaF86C97Bce104b1836b9972D20eC7c014D32f47D,
        0xA6dc89ABa15ba2A4d1757E986d5e85ACD36E27C6,
        0xE3fedEFadc1B128eC0C40117B2f67E99162ceD4A,
        0x434dc3ED0aEd78385B34041e7836c867c6790844,
        0xAA3625Dd1D51e3c5d6EE3576da526982b1ebaA3C
    ];
    address[18] internal feeds = [
        0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15,
        0x4A1166a659A55625345e9515b32adECea5547C38,
        0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E,
        0xF6f373a037c30F0e5010d854385cA89185AE638b,
        0x7C38C00C30BEe9378381E7B6135d7283356D71b1,
        0x820ABedFF239034956B7A9d2F0a331f9F075eB4c,
        0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844,
        0x425EEFdCf05ed6526C3cE61Af99429A228a6d596,
        0x3f390C5C24628Ac7C489515402235FeAD71D1913,
        0xe1b3aABCAFAd1c94708dc1367dcfF8Aa4407487C,
        0xfb133Fa4B7b385802B693a293606682Df47109A3,
        0xA994d3684e8400A6c8078226925779FdeE682DD9,
        0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb,
        0x80901d846d5D7B030F26B480776EE3b29374C2ae,
        0xa0DF4ee0fFf975306345875E3548Fcc519577A11,
        0x209b73908e92Ae021826eD79609845451Ecba2ce,
        0x319724394D3A0e3669269846abE664Cd621f9f6A,
        0x75a9c76Ef439e2C7c2E5a34Ab105EcFe3766431c
    ];

    /// @dev External so the harness can wrap each candidate in try/catch and continue past
    ///      a route that reverts. Self-call keeps vm cheatcodes available (roll to the pool's
    ///      last-update block) and the router owner (address(this)) intact.
    function probeOne(uint256 i) external returns (uint256 out) {
        require(msg.sender == address(this), "self only");
        router.setRoute(tokens[i], MID_POOL, USDG, pools[i], StockRouter.PoolKind.Rialto);

        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(feeds[i]).latestRoundData();
        require(answer > 0, "feed non-positive");
        require(updatedAt > 0, "feed no timestamp");

        address fermi = IRialtoPoolFork(pools[i]).fermi();
        vm.roll(IFermiFork(fermi).lastUpdateBlock());
        out = router.swapExactETHForStock{value: 0.001 ether}(tokens[i], 1, address(this), block.timestamp);
        require(out > 0, "route produced no stock");
    }

    function test_probeV2Candidates() public {
        if (block.chainid != 4663) {
            // Never gate on this probe — it is a discovery run, not a release assertion.
            return;
        }

        emit log_named_uint("V2 probe L2 block", block.number);
        router = new StockRouter(WETH, address(this));
        vm.deal(address(this), 1 ether);

        uint256 passCount;
        string memory rows = "";
        for (uint256 i; i < symbols.length; ++i) {
            // Fresh router per candidate so a wedged route can't taint the next probe.
            router = new StockRouter(WETH, address(this));
            vm.deal(address(this), 1 ether);

            bool ok;
            uint256 out;
            string memory err = "";
            try this.probeOne(i) returns (uint256 amountOut) {
                ok = true;
                out = amountOut;
            } catch Error(string memory reason) {
                err = reason;
            } catch (bytes memory lowLevel) {
                err = lowLevel.length == 0 ? "revert (no reason)" : vm.toString(lowLevel);
            }

            if (ok) {
                ++passCount;
                emit log_named_string("PASS", symbols[i]);
            } else {
                emit log_named_string("FAIL", string.concat(symbols[i], ": ", err));
            }

            rows = string.concat(
                rows,
                i == 0 ? "" : ",",
                "\n    {\"symbol\":\"",
                symbols[i],
                "\",\"token\":\"",
                vm.toString(tokens[i]),
                "\",\"stockPool\":\"",
                vm.toString(pools[i]),
                "\",\"feed\":\"",
                vm.toString(feeds[i]),
                "\",\"ok\":",
                ok ? "true" : "false",
                ",\"out\":\"",
                vm.toString(out),
                "\",\"err\":\"",
                err,
                "\"}"
            );
        }

        string memory json = string.concat(
            "{\n  \"chainId\": 4663,\n  \"l2Block\": ",
            vm.toString(block.number),
            ",\n  \"passCount\": ",
            vm.toString(passCount),
            ",\n  \"total\": ",
            vm.toString(symbols.length),
            ",\n  \"results\": [",
            rows,
            "\n  ]\n}\n"
        );
        vm.writeFile("reports/route-candidate-probe.json", json);
        emit log_named_uint("V2 candidates passed", passCount);
        emit log_named_uint("V2 candidates total", symbols.length);
    }
}

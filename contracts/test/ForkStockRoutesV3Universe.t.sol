// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StockRouter} from "../src/StockRouter.sol";
import {IAggregatorV3} from "../src/interfaces/IExternal.sol";

interface IERC20Dec {
    function decimals() external view returns (uint8);
}

/// The V3 universe rewire, probed against the DEPLOYED mainnet state: every target pool must
/// accept a real 0.001 ETH buy through a fresh StockRouter and fill within 3% of the name's
/// Chainlink feed. Pools come from a survey of the same factory as the WETH/USDG mid pool
/// (Rialto's venue has reverted "ACF" since 2026-08-25; only V3 pools trade). Run with
///   forge test --match-contract ForkStockRoutesV3Universe --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract ForkStockRoutesV3UniverseTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant MID_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    uint256 constant MAX_DEV_BPS = 300;

    string[22] internal symbols = [
        "AAPL",
        "AMD",
        "AMZN",
        "ASML",
        "BABA",
        "CRCL",
        "GME",
        "GOOGL",
        "META",
        "MSFT",
        "MSTR",
        "NVDA",
        "PLTR",
        "QQQ",
        "SGOV",
        "SLV",
        "SNDK",
        "SPY",
        "TSLA",
        "TSM",
        "USAR",
        "USO"
    ];
    address[22] internal tokens = [
        0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9,
        0x86923f96303D656E4aa86D9d42D1e57ad2023fdC,
        0x12f190a9F9d7D37a250758b26824B97CE941bF54,
        0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA,
        0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4,
        0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5,
        0x1b0E319c6A659F002271B69dB8A7df2F911c153E,
        0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3,
        0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35,
        0xe93237C50D904957Cf27E7B1133b510C669c2e74,
        0xec262a75e413fAfD0dF80480274532C79D42da09,
        0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,
        0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A,
        0xD5f3879160bc7c32ebb4dC785F8a4F505888de68,
        0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5,
        0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f,
        0xB90A19fF0Af67f7779afF50A882A9CfF42446400,
        0x117cc2133c37B721F49dE2A7a74833232B3B4C0C,
        0x322F0929c4625eD5bAd873c95208D54E1c003b2d,
        0x58FfE4a942d3885bAa22D7520691F611EF09e7AA,
        0xd917B029C761D264c6A312BBbcDA868658eF86a6,
        0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344
    ];
    address[22] internal pools = [
        0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D,
        0x48D284A2A4d3DC1b3Da08231Fe44317e7e7Aa51f,
        0x8AC92DA74AB5F3b1d024Dc1943Ad7e15Dc4179Ef,
        0xedb22516B14Eb2d1C86927Db373B0E8bF70F5cD1,
        0xa57ab582b310dd6f9e934EA1EEEa152741545E6A,
        0x654E4143e82a5824445Ade0824351C2A9ACD95a8,
        0xE2b46c905E12Ab8E2f864e4821a4325884C1B126,
        0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7,
        0x107a7Cb40d8665360ba10E59471Af06150A50922,
        0xeb60bCD1D920ad6E102690CCFC6fB488899E1510,
        0x17578C0e0D15da44f31677263114F71aE76653EA,
        0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3,
        0x851680416A4f4E1c463d45171d61ACDdBc8554c0,
        0xD60A5d14dB690B7Afad71F76B108071D7175597d,
        0xfAb520051f96F4D2a32c22B6a3dD7fFfdf231bFe,
        0x8cB787e6c315D464775289BaD00FDD67d53Ecb3D,
        0xA1e1C9519cD5ae47e9A935645E1A7b935b944559,
        0xa7Bb1AC63BBaB0C44316E6c8C455213441689167,
        0xf4ACdAEEB7022862A763C9B1B885e11191c889E3,
        0x07e8Ea83D4C1340774c8965125e26e12bf943bf1,
        0x04391780F519B7d3ba59c9590459D76e23d225C4,
        0x02175608F1b5E6b5ed221cCFdC7Be197D111D915
    ];
    address[22] internal feeds = [
        0xBb11A21267cFDb63d4935d99a499133DD1744ACb,
        0xdAD54b8Ee51Af258e5A6Faa9a84a3300f4775f7d,
        0x93503dFc97157cdB8aADcCaf70452621d598FDeb,
        0xF795030a46ad6CA4b07Bf5fB704dC36039118c9F,
        0xFf5F85e4888782e66f1dd9cabaDF4822Fbeb1439,
        0x901D8DF245E48Dfc82D6483FC45b5BE6ddc5281a,
        0xf83Cde62D1Cd90dE8d2Bf3332B90c590985aD679,
        0x11eD6d598eF565DDA86fAfE7E779303e7CC6b2Bd,
        0xc190B6164B9e320A6400cdaB0085a2e0E2b9738e,
        0xc3b117F52cf17Dd4369eaF5eaf7cF0E2f91b4E30,
        0x55bd01F666c99E4590E084FdEfF88041BB50CCD1,
        0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2,
        0x315afd0f71D5407B99ad19ab001a67af40fbAAF4,
        0x25e996ce8b3529885D429241156e83e7b7744049,
        0x0E96B7708487f91baAC09697593D3e8bf253f2d8,
        0xcdF6F7043b3aF6Afa0CAAACe1230B355096B5386,
        0x7B2FdfcEa772f093DD33b3aCF8EE294B368f6c23,
        0x78BCB218fA04B9b3a278eBc865Ed320BF8DEFBAc,
        0x7A6b81ba7FbCB90104d8C496158Cf383cD7233b1,
        0x2B3A9A18998e9464760658233ab093e6aEbF45d0,
        0x76ba75c6c362900B275D9D4d5C422F0275e85578,
        0xa6aC45e27D19f91c55109191D71CfBA4A9f5fBe1
    ];

    function test_v3UniverseBuysWithinFeed() public {
        if (block.chainid != 4663) {
            require(!vm.envOr("REQUIRE_MAINNET_FORK", false), "required RH mainnet fork missing");
            return;
        }
        StockRouter router = new StockRouter(WETH, address(this));
        vm.deal(address(this), 10 ether);
        (, int256 ethUsd,,,) = IAggregatorV3(ETH_USD_FEED).latestRoundData();
        uint8 ethDec = IAggregatorV3(ETH_USD_FEED).decimals();
        string memory report = "[";
        for (uint256 i; i < tokens.length; ++i) {
            router.setRoute(tokens[i], MID_POOL, USDG, pools[i], StockRouter.PoolKind.V3);
            assertTrue(router.routeReady(tokens[i]), "route not ready");
            (, int256 px,, uint256 updatedAt,) = IAggregatorV3(feeds[i]).latestRoundData();
            uint8 fdec = IAggregatorV3(feeds[i]).decimals();
            assertGt(px, 0, "feed non-positive");
            assertGt(updatedAt, 0, "feed has no timestamp");
            uint256 out =
                router.swapExactETHForStock{value: 0.001 ether}(tokens[i], 1, address(this), block.timestamp);
            assertGt(out, 0, string.concat(symbols[i], ": no stock out"));
            // implied fill in USD per share vs feed: 0.001 ETH * ethUsd / out
            uint8 tdec = IERC20Dec(tokens[i]).decimals();
            uint256 usdIn = (0.001 ether * uint256(ethUsd)) / (10 ** ethDec); // 18-dec USD
            uint256 fill = (usdIn * (10 ** tdec)) / out; // 18-dec USD per share
            uint256 feedUsd = (uint256(px) * 1e18) / (10 ** fdec);
            uint256 dev = fill > feedUsd
                ? ((fill - feedUsd) * 10_000) / feedUsd
                : ((feedUsd - fill) * 10_000) / feedUsd;
            emit log_named_string("name", symbols[i]);
            emit log_named_uint("  fill usd/share (1e18)", fill);
            emit log_named_uint("  feed usd/share (1e18)", feedUsd);
            emit log_named_uint("  deviation bps", dev);
            assertLt(dev, MAX_DEV_BPS, string.concat(symbols[i], ": fill too far from feed"));
            report = string.concat(
                report,
                i == 0 ? "" : ",",
                '{"symbol":"',
                symbols[i],
                '","pool":"',
                vm.toString(pools[i]),
                '","devBps":',
                vm.toString(dev),
                ',"block":',
                vm.toString(block.number),
                "}"
            );
        }
        report = string.concat(report, "]");
        vm.writeFile("reports/route-v3-universe-probe.json", report);
    }
}

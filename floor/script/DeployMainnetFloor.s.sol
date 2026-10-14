// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BasketRouter, IWETHFloor, IStrategyRegistryFloor, IBoosterFeedFloor} from "../src/BasketRouter.sol";

interface IV3FactoryFloor {
    function getPool(address, address, uint24) external view returns (address);
}

/// @notice Mainnet (4663) soft deploy of The Floor: deploy + wire ONLY (owner config txs,
///         no trading). Pools are resolved from the same Uniswap v3 factory the production
///         keeper has been buying through since the 2026-08-26 rewire, and every setPool
///         re-verifies the pair on-chain. The UI stays dark until the launch commit pastes
///         this address into frontend/src/lib/floor.ts.
contract DeployMainnetFloor is Script {
    address constant REGISTRY = 0xA20f9D47E0c41e52a57d65feA9A9322732aF86Aa;
    address constant BOOSTER = 0x7bAf435847A4b45c2e22a7fd13549C3192C95953;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant COAT = 0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833;
    address constant COAT_ROUTER = 0x740baEEF895444a659fD0fc5Dc213BEDe7d1EaaF;
    address constant ETH_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // WETH/USDG v3
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;

    address constant INTC = 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681;
    address constant SPCX = 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa;
    address constant MU = 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant MSFT = 0xe93237C50D904957Cf27E7B1133b510C669c2e74;
    address constant AMD = 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC;

    function run() external {
        require(block.chainid == 4663, "mainnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        // relay wallet that runs the hourly keeper (flushes fees); falls back to owner
        address keeper = vm.envOr("FLOOR_KEEPER", me);
        vm.startBroadcast(pk);

        BasketRouter router = new BasketRouter(
            IERC20(USDG),
            IWETHFloor(WETH),
            IStrategyRegistryFloor(REGISTRY),
            IBoosterFeedFloor(BOOSTER),
            0,
            BOOSTER, // 80% of fees arrive here as native ETH — straight into payroll
            me, // treasury = owner ops wallet (settable later via setSplit)
            me
        );

        // stock pools: resolved live from the factory, pair-verified inside setPool
        address[7] memory stocks = [INTC, SPCX, MU, NVDA, AAPL, MSFT, AMD];
        uint24[7] memory fees = [uint24(3000), 500, 3000, 500, 500, 3000, 3000];
        for (uint256 i; i < stocks.length; ++i) {
            address pool = IV3FactoryFloor(FACTORY).getPool(stocks[i], USDG, fees[i]);
            require(pool != address(0), "pool missing");
            router.setPool(stocks[i], pool);
            console2.log("pool", stocks[i], pool);
        }
        router.setEthPool(ETH_POOL);
        router.setCoatRoute(COAT, COAT_ROUTER);
        if (keeper != me) router.setKeeper(keeper);

        // curated preset 1: Chips (Congress Live is always preset 0, read from the registry)
        address[] memory t = new address[](4);
        uint16[] memory w = new uint16[](4);
        t[0] = NVDA;
        t[1] = AMD;
        t[2] = INTC;
        t[3] = MU;
        w[0] = 4000;
        w[1] = 2500;
        w[2] = 2000;
        w[3] = 1500;
        router.setPreset(1, "Chips", t, w);

        console2.log("The Floor (mainnet BasketRouter):", address(router));
        vm.stopBroadcast();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    BasketRouter,
    IWETHFloor,
    IStrategyRegistryFloor,
    IBoosterFeedFloor,
    IAggregatorV3Floor
} from "../src/BasketRouter.sol";

/// The Floor v2 on Robinhood Chain mainnet (4663), wired to the live core and nothing else new:
/// real USDG and WETH, the WETH/USDG v3 pool, the Booster's Chainlink stock feeds and its
/// ETH/USD feed, the live basket (strategy 0), the live COAT router. The core is only READ.
///
/// Routes: every V3 entry of indexer/route-ready.mainnet.json (the manifest the Booster's routes
/// are kept in sync with). setPool checks each pool's pair on chain and that the stock has a
/// Booster feed, so a wrong pool stops the deploy; a name without a feed is skipped here. The
/// Rialto-routed names have no v3 pool: a basket buy skips them, a sell hands them back.
///
/// Settings match the live v1 (0x478F22A3) as read on 2026-10-14: fee 30 bps, every fee to the
/// Booster, 5% Chainlink band, 96h stock-feed window, the keeper relay flushes. New in v2: the
/// ETH/USD floor (the Booster's feed, 30h like the Booster's ETH window).
///
///   env: DEPLOYER (default the core owner), FLOOR_KEEPER (default the keeper relay),
///        FLOOR_TREASURY (default DEPLOYER; receives nothing while every fee goes to the
///        Booster), FLOOR_OUT (default rehearsal/floor-v2-mainnet.json)
///
///   dry run:   forge script script/DeployMainnetFloorV2.s.sol --rpc-url <mainnet rpc> --sender <deployer>
///   broadcast: add --broadcast --slow --interactives 1 (the deployer signs in their own terminal)
contract DeployMainnetFloorV2 is Script {
    address constant REGISTRY = 0xA20f9D47E0c41e52a57d65feA9A9322732aF86Aa;
    address constant BOOSTER = 0x7bAf435847A4b45c2e22a7fd13549C3192C95953;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant COAT = 0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833;
    address constant COAT_ROUTER = 0x740baEEF895444a659fD0fc5Dc213BEDe7d1EaaF;
    address constant ETH_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // WETH/USDG v3, 1 bp
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9; // Booster.ethUsdFeed
    address constant KEEPER_RELAY = 0xa492c8fFa033016144B169501D2e428BeDD518CA;
    uint256 constant FEED_STALE_AFTER = 345_600; // 96h, as the live v1 and the Booster
    uint256 constant ETH_STALE_AFTER = 108_000; // 30h, the Booster's ETH window

    address constant INTC = 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681;
    address constant MU = 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant AMD = 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC;

    function run() external returns (BasketRouter router, uint256 routes) {
        require(block.chainid == 4663, "mainnet only");
        address deployer = vm.envOr("DEPLOYER", address(0x9e643731dc9D8795573Aa34C410664407FfDC440));
        address keeper = vm.envOr("FLOOR_KEEPER", KEEPER_RELAY);
        address treasury = vm.envOr("FLOOR_TREASURY", deployer);
        string memory manifest = vm.readFile("../indexer/route-ready.mainnet.json");
        require(vm.parseJsonUint(manifest, ".chainId") == 4663, "route manifest chain");

        vm.startBroadcast(deployer);
        router = new BasketRouter(
            IERC20(USDG),
            IWETHFloor(WETH),
            IStrategyRegistryFloor(REGISTRY),
            IBoosterFeedFloor(BOOSTER),
            0,
            BOOSTER,
            treasury,
            deployer
        );
        routes = _wireRoutes(router, manifest);
        router.setEthPool(ETH_POOL);
        router.setEthUsdFeed(IAggregatorV3Floor(ETH_USD), ETH_STALE_AFTER);
        router.setFeedStaleAfter(FEED_STALE_AFTER);
        router.setCoatRoute(COAT, COAT_ROUTER);
        if (keeper != deployer) router.setKeeper(keeper);
        _chips(router);
        vm.stopBroadcast();

        _write(router, routes, deployer, keeper, treasury);
    }

    function _wireRoutes(BasketRouter router, string memory manifest) internal returns (uint256 wired) {
        string[] memory names = vm.parseJsonKeys(manifest, ".entries");
        for (uint256 i; i < names.length; ++i) {
            string memory base = string.concat(".entries.", names[i]);
            if (
                keccak256(bytes(vm.parseJsonString(manifest, string.concat(base, ".poolKind"))))
                    != keccak256("V3")
            ) {
                continue;
            }
            require(
                vm.parseJsonAddress(manifest, string.concat(base, ".midToken")) == USDG,
                "route not USDG-paired"
            );
            address token = vm.parseJsonAddress(manifest, string.concat(base, ".token"));
            address pool = vm.parseJsonAddress(manifest, string.concat(base, ".stockPool"));
            if (IBoosterFeedFloor(BOOSTER).stockFeed(token) == address(0)) {
                console2.log("skipped, no Booster feed:", names[i]);
                continue;
            }
            router.setPool(token, pool); // reverts unless the pool pairs USDG with token
            ++wired;
        }
        console2.log("routes wired:", wired);
    }

    /// Curated preset 1, as on v1: Chips (Congress Live is always preset 0).
    function _chips(BasketRouter router) internal {
        address[] memory t = new address[](4);
        uint16[] memory w = new uint16[](4);
        (t[0], t[1], t[2], t[3]) = (NVDA, AMD, INTC, MU);
        (w[0], w[1], w[2], w[3]) = (4000, 2500, 2000, 1500);
        router.setPreset(1, "Chips", t, w);
    }

    function _write(BasketRouter router, uint256 routes, address deployer, address keeper, address treasury)
        internal
    {
        string memory k = "floor";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeString(k, "version", router.VERSION());
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "keeper", keeper);
        vm.serializeAddress(k, "treasury", treasury);
        vm.serializeAddress(k, "booster", BOOSTER);
        vm.serializeAddress(k, "registry", REGISTRY);
        vm.serializeAddress(k, "usdg", USDG);
        vm.serializeAddress(k, "weth", WETH);
        vm.serializeAddress(k, "ethPool", ETH_POOL);
        vm.serializeAddress(k, "ethFeed", ETH_USD);
        vm.serializeAddress(k, "coat", COAT);
        vm.serializeAddress(k, "coatRouter", COAT_ROUTER);
        vm.serializeAddress(k, "previous", 0x478F22A32663cF37702d65352A7579A73e61FDc7);
        vm.serializeUint(k, "routes", routes);
        string memory json = vm.serializeAddress(k, "router", address(router));
        string memory path = vm.envOr("FLOOR_OUT", string("rehearsal/floor-v2-mainnet.json"));
        vm.writeJson(json, path);
        console2.log("The Floor v2:", address(router), "->", path);
    }
}

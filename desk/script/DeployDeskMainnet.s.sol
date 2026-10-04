// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeskNFT, IERC6551RegistryDesk} from "../src/DeskNFT.sol";
import {DeskAccount} from "../src/DeskAccount.sol";
import {DeskRenderer, IDeskEngineView} from "../src/DeskRenderer.sol";
import {CoatBonusPool, ICoattailBrokerView} from "../src/CoatBonusPool.sol";
import {
    DeskEngine,
    IWETHDesk,
    IDeskNFTView,
    IStrategyRegistryView,
    IBoosterFeedView,
    IAggregatorV3Desk
} from "../src/DeskEngine.sol";
import {DeskDepositRouter, ICoatRouterSell, IDeskDepositBook} from "../src/DeskDepositRouter.sol";

/// The Desk on Robinhood Chain mainnet (4663), wired to the live core and nothing else new:
/// real USDG, the WETH/USDG v3 pool every Booster buy already routes through, the Booster's own
/// Chainlink stock feeds and ETH/USD feed, the live basket (strategy 0, the one Broker salaries
/// are paid in), the canonical 6551 registry and the live COAT router. The core is only READ:
/// no Booster, registry or feed is changed.
///
/// Routes: every V3 entry of indexer/route-ready.mainnet.json (the manifest the Booster's routes
/// are kept in sync with; all USDG-paired). DeskEngine.setPool checks each pool's pair on chain,
/// so a wrong pool stops the deploy. A name without a Booster feed is skipped (the engine could
/// not price it). The Rialto-routed names have no v3 USDG pool; buyBasket skips them on chain.
///
/// The mint stays CLOSED unless DESK_OPEN_MINT=true: open it after the post-deploy checks with
/// one setMintOpen(true) from the deployer.
///
///   env: DEPLOYER (default the core owner), DESK_TREASURY (20% fee share, default DEPLOYER),
///        DESK_KEEPER (engine keeper; default DEPLOYER), DESK_POSTER (bonus-round poster;
///        default DESK_KEEPER or DEPLOYER), DESK_OPEN_MINT (default false),
///        DESK_OUT (default rehearsal/mainnet-4663.json)
///
///   dry run:  forge script script/DeployDeskMainnet.s.sol --rpc-url <mainnet rpc> --sender <deployer>
///   broadcast: add --broadcast --slow --interactives 1 (the deployer signs in their own terminal)
contract DeployDeskMainnet is Script {
    address constant BROKERS = 0x1122dB21998707F8c2eD8182734356C947fA5e98;
    address constant COAT = 0x93a887Beda77a9E2F6D6ed0C9742f04CcEBc8833;
    address constant BOOSTER = 0x7bAf435847A4b45c2e22a7fd13549C3192C95953;
    address constant REGISTRY = 0xA20f9D47E0c41e52a57d65feA9A9322732aF86Aa;
    address constant REGISTRY_6551 = 0x000000006551c19487814612e58FE06813775758;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant ETH_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // WETH/USDG v3, 1 bp
    address constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9; // Booster.ethUsdFeed
    address constant COAT_ROUTER = 0x740baEEF895444a659fD0fc5Dc213BEDe7d1EaaF;
    uint256 constant STRATEGY_ID = 0; // the live basket
    uint256 constant CHUNK = 50; // trait words per upload tx

    struct Out {
        address bonus;
        address accountImpl;
        address desks;
        address renderer;
        address engine;
        address depositRouter;
        uint256 routes;
    }

    struct Cfg {
        address deployer;
        address treasury;
        address keeper;
        address poster;
        bool openMint;
    }

    function run() external returns (Out memory o) {
        require(block.chainid == 4663, "mainnet only");
        Cfg memory c = _cfg();
        bytes memory blob = vm.parseBytes(vm.readFile("art/traits-packed.hex"));
        require(blob.length == 8000, "traits blob");
        string memory manifest = vm.readFile("../indexer/route-ready.mainnet.json");
        require(vm.parseJsonUint(manifest, ".chainId") == 4663, "route manifest chain");

        vm.startBroadcast(c.deployer);
        _deployDesk(o, c, blob);
        o.routes = _wireRoutes(DeskEngine(payable(o.engine)), manifest);
        _finish(o, c);
        vm.stopBroadcast();

        _write(o, c);
    }

    function _cfg() internal view returns (Cfg memory c) {
        c.deployer = vm.envOr("DEPLOYER", address(0x9e643731dc9D8795573Aa34C410664407FfDC440));
        c.treasury = vm.envOr("DESK_TREASURY", c.deployer);
        c.keeper = vm.envOr("DESK_KEEPER", c.deployer);
        c.poster = vm.envOr("DESK_POSTER", c.keeper);
        c.openMint = vm.envOr("DESK_OPEN_MINT", false);
    }

    /// Bonus pool, account implementation, Desk NFT, renderer (traits uploaded and frozen), engine.
    function _deployDesk(Out memory o, Cfg memory c, bytes memory blob) internal {
        o.bonus = address(new CoatBonusPool(IERC20(COAT), ICoattailBrokerView(BROKERS), c.poster, c.deployer));
        // DeskAccount pins the engine immutably, so the engine address is predicted from the
        // deployer nonce: account impl (n), DeskNFT (n+1), renderer (n+2), engine (n+3).
        uint64 n = vm.getNonce(c.deployer);
        address predictedEngine = vm.computeCreateAddress(c.deployer, n + 3);
        o.accountImpl = address(new DeskAccount(predictedEngine));
        o.desks = address(
            new DeskNFT(IERC20(COAT), o.bonus, IERC6551RegistryDesk(REGISTRY_6551), o.accountImpl, c.deployer)
        );
        o.renderer = address(new DeskRenderer(keccak256(blob), c.deployer));
        o.engine = address(
            new DeskEngine(
                IERC20(USDG),
                IWETHDesk(WETH),
                IDeskNFTView(o.desks),
                IStrategyRegistryView(REGISTRY),
                IBoosterFeedView(BOOSTER),
                STRATEGY_ID,
                BOOSTER,
                c.treasury,
                c.deployer
            )
        );
        require(o.engine == predictedEngine, "engine address prediction");

        for (uint256 start; start < 250; start += CHUNK) {
            bytes32[] memory words = new bytes32[](CHUNK);
            for (uint256 i; i < CHUNK; ++i) {
                words[i] = _word(blob, start + i);
            }
            DeskRenderer(o.renderer).uploadTraits(start, words);
        }
        DeskRenderer(o.renderer).freezeTraits();
        DeskRenderer(o.renderer).setEngine(IDeskEngineView(o.engine));
        DeskNFT(o.desks).setRenderer(o.renderer);
    }

    /// Fee conversion, keeper, the deposit router (deposits are booked and capped only there),
    /// and the mint only if asked.
    function _finish(Out memory o, Cfg memory c) internal {
        DeskEngine engine = DeskEngine(payable(o.engine));
        engine.setEthPool(ETH_POOL);
        engine.setEthUsdFeed(IAggregatorV3Desk(ETH_USD));
        if (c.keeper != c.deployer) engine.setKeeper(c.keeper);
        o.depositRouter = address(
            new DeskDepositRouter(
                IERC20(USDG),
                WETH,
                IERC20(COAT),
                IDeskNFTView(o.desks),
                IDeskDepositBook(o.engine),
                ICoatRouterSell(COAT_ROUTER),
                ETH_POOL,
                IAggregatorV3Desk(ETH_USD),
                c.deployer
            )
        );
        engine.setDepositRouter(o.depositRouter);
        if (c.openMint) DeskNFT(o.desks).setMintOpen(true);
    }

    function _wireRoutes(DeskEngine engine, string memory manifest) internal returns (uint256 wired) {
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
            if (IBoosterFeedView(BOOSTER).stockFeed(token) == address(0)) {
                console2.log("skipped, no Booster feed:", names[i]);
                continue;
            }
            engine.setPool(token, pool); // reverts InvalidPool unless the pool pairs USDG with token
            ++wired;
        }
        console2.log("routes wired:", wired);
    }

    function _word(bytes memory blob, uint256 w) internal pure returns (bytes32 word) {
        assembly {
            word := mload(add(add(blob, 32), mul(w, 32)))
        }
    }

    function _write(Out memory o, Cfg memory c) internal {
        string memory k = "desk";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeAddress(k, "deployer", c.deployer);
        vm.serializeAddress(k, "treasury", c.treasury);
        vm.serializeAddress(k, "keeper", c.keeper);
        vm.serializeAddress(k, "poster", c.poster);
        vm.serializeBool(k, "mintOpen", c.openMint);
        vm.serializeAddress(k, "brokers", BROKERS);
        vm.serializeAddress(k, "coat", COAT);
        vm.serializeAddress(k, "booster", BOOSTER);
        vm.serializeAddress(k, "registry", REGISTRY);
        vm.serializeUint(k, "strategyId", STRATEGY_ID);
        vm.serializeAddress(k, "usdg", USDG);
        vm.serializeAddress(k, "weth", WETH);
        vm.serializeAddress(k, "ethPool", ETH_POOL);
        vm.serializeAddress(k, "ethFeed", ETH_USD);
        vm.serializeAddress(k, "coatRouter", COAT_ROUTER);
        vm.serializeUint(k, "routes", o.routes);
        vm.serializeAddress(k, "bonus", o.bonus);
        vm.serializeAddress(k, "accountImpl", o.accountImpl);
        vm.serializeAddress(k, "desks", o.desks);
        vm.serializeAddress(k, "renderer", o.renderer);
        vm.serializeAddress(k, "depositRouter", o.depositRouter);
        string memory json = vm.serializeAddress(k, "engine", o.engine);
        string memory path = vm.envOr("DESK_OUT", string("rehearsal/mainnet-4663.json"));
        vm.writeJson(json, path);
        console2.log("addresses ->", path);
    }
}

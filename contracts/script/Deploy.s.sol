// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {BrokerAccount} from "../src/BrokerAccount.sol";
import {COAT} from "../src/COAT.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";
import {CoattailBroker, IBoosterHook, ICoatBurnable} from "../src/CoattailBroker.sol";
import {Booster} from "../src/Booster.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {BrokerRenderer} from "../src/BrokerRenderer.sol";
import {StockRouter} from "../src/StockRouter.sol";
import {IERC6551Registry, IStockRouter, IWETH} from "../src/interfaces/IExternal.sol";

/// @title Deploy
/// @notice Full-system deploy for Coattail Brokers. Deploys every contract, wires them in
///         the correct order, and (if OWNER differs from the deployer) hands all ownership
///         to a multisig/timelock — 2-step, so the multisig must `acceptOwnership()` after.
/// @dev Works for **testnet (46630)** and **mainnet (4663)** — external addresses default to
///      the bytecode-verified mainnet ones (ADDRESSES.md) and are overridable by env for
///      testnet. Confirm the testnet ERC-6551 registry / WETH / router before running there.
///
///      RUN:
///        PRIVATE_KEY=0x... [OWNER=0x.. TREASURY=0x.. CREATOR=0x.. BUYBACK=0x.. UPDATER=0x.. ORACLE_SIGNER=0x..
///         ERC6551_REGISTRY=0x.. WETH=0x.. SWAP_ROUTER=0x.. MAX_DRIFT_BPS=3000 ETH_USD_E8=300000000000] \
///        forge script script/Deploy.s.sol --rpc-url $RH_RPC --broadcast
contract Deploy is Script {
    using SafeCast for uint256;
    // Mainnet (chain 4663) defaults — override via env for testnet.
    address constant DEF_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address constant DEF_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant TESTNET_WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa;
    address constant DEF_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    struct Deployed {
        address accountImpl;
        address coat;
        address registry;
        address broker;
        address booster;
        address stockRouter;
        address feeSplitter;
        address renderer;
    }

    struct Config {
        address owner; // final hardware-wallet admin
        address treasury;
        address creator;
        address buyback;
        address updater; // indexer relayer / ops role
        address oracleSigner; // EIP-712 signer key
        uint16 maxDriftBps;
        uint256 ethUsdE8; // optional manual ETH/USD (0 = skip)
        string baseURI;
        address registry6551;
        address weth;
    }

    function _config(address deployer) internal view returns (Config memory c) {
        bool mainnet = block.chainid == 4663;
        c.owner = mainnet ? vm.envAddress("OWNER") : vm.envOr("OWNER", deployer);
        c.treasury = mainnet ? vm.envAddress("TREASURY") : vm.envOr("TREASURY", deployer);
        c.creator = mainnet ? vm.envAddress("CREATOR") : vm.envOr("CREATOR", c.treasury);
        c.buyback = mainnet ? vm.envAddress("BUYBACK") : vm.envOr("BUYBACK", deployer);
        c.updater = mainnet ? vm.envAddress("UPDATER") : vm.envOr("UPDATER", deployer);
        c.oracleSigner = mainnet ? vm.envAddress("ORACLE_SIGNER") : vm.envOr("ORACLE_SIGNER", deployer);
        uint256 maxDriftBps = vm.envOr("MAX_DRIFT_BPS", uint256(10_000));
        require(maxDriftBps <= 10_000, "MAX_DRIFT_BPS out of range");
        c.maxDriftBps = maxDriftBps.toUint16();
        c.ethUsdE8 = vm.envOr("ETH_USD_E8", uint256(0));
        c.baseURI = vm.envOr("BASE_URI", string("ipfs://coattail/"));
        c.registry6551 = vm.envOr("ERC6551_REGISTRY", DEF_REGISTRY);
        c.weth = vm.envOr("WETH", mainnet ? DEF_WETH : TESTNET_WETH);
        require(c.registry6551.code.length != 0 && c.weth.code.length != 0, "dependency has no code");
        (bool registryOk, bytes memory registryResult) = c.registry6551
            .staticcall(
                abi.encodeCall(
                    IERC6551Registry.account, (address(1), bytes32(0), block.chainid, address(1), uint256(1))
                )
            );
        (bool wethOk, bytes memory wethResult) =
            c.weth.staticcall(abi.encodeCall(IWETH.balanceOf, (deployer)));
        require(
            registryOk && registryResult.length == 32 && wethOk && wethResult.length == 32,
            "dependency interface probe failed"
        );
        require(
            c.owner != address(0) && c.treasury != address(0) && c.creator != address(0)
                && c.buyback != address(0),
            "zero sink"
        );
        require(c.updater != address(0) && c.oracleSigner != address(0), "zero operator");
        if (mainnet) {
            require(c.registry6551 == DEF_REGISTRY && c.weth == DEF_WETH, "non-canonical dependency");
            require(
                c.owner != deployer && c.treasury != deployer && c.creator != deployer
                    && c.buyback != deployer && c.updater != deployer && c.oracleSigner != deployer,
                "deployer fallback"
            );
            require(c.owner != deployer, "OWNER must be distinct hardware wallet");
        }
    }

    function run() external returns (Deployed memory d) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        Config memory c = _config(deployer);

        vm.startBroadcast(pk);
        d = _deployAndWire(c, deployer);
        vm.stopBroadcast();

        _report(d, c.owner, deployer);
    }

    /// @dev All new()/wiring in one frame (keeps `run` shallow). Deployer is the interim
    ///      admin/owner so it can wire, then hands off to `c.owner`.
    function _deployAndWire(Config memory c, address deployer) internal returns (Deployed memory d) {
        BrokerAccount accountImpl = new BrokerAccount();
        COAT coat = new COAT(deployer, DEF_POOL_MANAGER);
        StrategyRegistry registry = new StrategyRegistry(deployer, c.updater);
        registry.createStrategy("The Politician"); // strategy id 0

        CoattailBroker broker = new CoattailBroker(
            deployer, c.creator, IERC6551Registry(c.registry6551), address(accountImpl), c.baseURI
        );
        StockRouter stockRouter = new StockRouter(c.weth, deployer);
        Booster booster =
            new Booster(broker, registry, IStockRouter(address(stockRouter)), IWETH(c.weth), 0, deployer);
        BrokerRenderer renderer = new BrokerRenderer(deployer);
        FeeSplitter feeSplitter =
            new FeeSplitter(deployer, payable(address(booster)), payable(c.treasury), payable(c.buyback));

        // wire Broker <-> Booster/COAT (renderer wired only AFTER art upload — it reverts before)
        broker.setBooster(IBoosterHook(address(booster)));
        broker.setCoat(ICoatBurnable(address(coat)));

        // slippage guard: optional manual ETH/USD (per-token stock feeds set post-deploy)
        if (c.ethUsdE8 != 0) booster.setEthUsdManual(c.ethUsdE8);

        // oracle signer + per-epoch drift cap
        registry.setOracleSigner(c.oracleSigner);
        if (c.maxDriftBps < 10_000) registry.setMaxDriftBps(c.maxDriftBps);

        // hand off to the hardware-wallet owner (2-step: it must acceptOwnership()).
        if (c.owner != deployer) {
            broker.transferOwnership(c.owner);
            booster.transferOwnership(c.owner);
            stockRouter.transferOwnership(c.owner);
            renderer.transferOwnership(c.owner);
            feeSplitter.transferOwnership(c.owner);
            bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();
            registry.grantRole(adminRole, c.owner);
            registry.renounceRole(adminRole, deployer);
            require(
                broker.pendingOwner() == c.owner && booster.pendingOwner() == c.owner
                    && stockRouter.pendingOwner() == c.owner,
                "bad pending owner"
            );
            require(
                renderer.pendingOwner() == c.owner && feeSplitter.pendingOwner() == c.owner,
                "bad pending owner"
            );
            require(
                registry.hasRole(adminRole, c.owner) && !registry.hasRole(adminRole, deployer),
                "bad registry admin"
            );
        }

        require(coat.totalSupply() == coat.MAX_SUPPLY(), "bad total supply");
        require(coat.balanceOf(deployer) == coat.LIQUIDITY_SUPPLY(), "bad liquidity allocation");
        require(
            address(broker.booster()) == address(booster) && address(broker.coat()) == address(coat),
            "bad wiring"
        );
        require(broker.creator() == c.creator, "bad creator");
        require(
            feeSplitter.BOOSTER_BPS() == 8_000 && feeSplitter.TREASURY_BPS() == 1_000
                && feeSplitter.BUYBACK_BPS() == 1_000,
            "bad fee split"
        );

        d = Deployed({
            accountImpl: address(accountImpl),
            coat: address(coat),
            registry: address(registry),
            broker: address(broker),
            booster: address(booster),
            stockRouter: address(stockRouter),
            feeSplitter: address(feeSplitter),
            renderer: address(renderer)
        });
    }

    function _report(Deployed memory d, address owner, address deployer) internal pure {
        console2.log("== Coattail Brokers deployed ==");
        console2.log("BrokerAccount (6551 impl):", d.accountImpl);
        console2.log("COAT:                      ", d.coat);
        console2.log("StrategyRegistry:          ", d.registry);
        console2.log("CoattailBroker:            ", d.broker);
        console2.log("Booster:                   ", d.booster);
        console2.log("StockRouter:               ", d.stockRouter);
        console2.log("FeeSplitter:               ", d.feeSplitter);
        console2.log("BrokerRenderer:            ", d.renderer);
        if (owner != deployer) {
            console2.log("Ownership transferred to:  ", owner);
            console2.log(
                ">> hardware wallet must acceptOwnership() on Broker/Booster/StockRouter/Renderer/FeeSplitter"
            );
        }
        console2.log("NEXT: set per-token stock feeds, run LaunchWithHook, upload art + setRenderer.");
    }
}

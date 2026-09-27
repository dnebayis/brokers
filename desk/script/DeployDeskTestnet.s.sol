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
    IBoosterFeedView
} from "../src/DeskEngine.sol";
import {DeskTestAsset, DeskTestFeed, DeskTestPool, IDeskTestFeed} from "../src/testnet/DeskTestVenue.sol";

interface ITestnetOwned {
    function mint(address to, uint256 amount) external; // testnet tAAPL (TestnetAsset)
    function setAnswer(int256 answer) external; // testnet tAAPL feed (TestnetFeed)
}

interface IBoosterAdmin {
    function setStockFeed(address token, address feed) external;
}

interface IRegistryAdmin {
    function createStrategy(string calldata name) external returns (uint256 id);
    function setStrategy(uint256 strategyId, address[] calldata tokens, uint16[] calldata weightsBps) external;
}

interface IWETH9 {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
}

/// Build order step 5, deploy half: every Desk contract on Robinhood Chain testnet (46630),
/// wired to the live testnet core (CoattailBroker, COAT, Booster feeds, StrategyRegistry,
/// canonical 6551 registry) plus a test venue, because testnet has no USDG and no v3 pools.
///
/// The Desk gets its OWN strategy slot on the testnet registry, so the Booster's strategy 0
/// is never touched. The one change to shared testnet state is a feed entry for the extra
/// test stock (tMSFT) on the testnet Booster, which only matters for tokens in its basket.
///
/// Every transaction here is the deployer's (the testnet owner of the core). Output:
/// rehearsal/testnet-46630.json with every address, read by script/rehearse-local.sh.
///
///   local rehearsal (anvil fork):   script/rehearse-local.sh
///   real testnet:                   forge script script/DeployDeskTestnet.s.sol \
///                                     --rpc-url https://rpc.testnet.chain.robinhood.com \
///                                     --broadcast --account <deployer keystore>
contract DeployDeskTestnet is Script {
    // testnet (chain 46630): see ADDRESSES.md "Active testnet staging"
    address constant BROKERS = 0x2Dc7BAD968061bBb5B19066F3769EC90271e09C7;
    address constant COAT = 0x1fa24Ce38f1B956ADfe1ffF87d2f1d234844203E;
    address constant BOOSTER = 0xE683Db9bbb74a6296Cd24F4e1B8E540C19d6BeA7;
    address constant REGISTRY = 0x90252Ef04cC9b40d3E684edff9b7ae213e454e6A;
    address constant REGISTRY_6551 = 0x000000006551c19487814612e58FE06813775758;
    address constant WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa;
    address constant TAAPL = 0xd70A1Cc63a99Aa0bD8C27c7bd43f46d6700586aE;
    address constant TAAPL_FEED = 0x9A1e65F136f69980BEf2Acb307e16b79E1EF5CE4;

    uint256 constant SPREAD_BPS = 30; // test venue fills at feed price minus 0.30%
    uint256 constant CHUNK = 50; // trait words per upload tx

    struct Out {
        address usdg;
        address tmsft;
        address msftFeed;
        address ethFeed;
        address aaplPool;
        address msftPool;
        address ethPool;
        uint256 strategyId;
        address bonus;
        address accountImpl;
        address desks;
        address renderer;
        address engine;
    }

    function run() external returns (Out memory o) {
        require(block.chainid == 46630, "testnet only");
        address deployer = vm.envOr("DEPLOYER", address(0x9e643731dc9D8795573Aa34C410664407FfDC440));
        address treasury = vm.envOr("DESK_TREASURY", deployer);
        bytes memory blob = vm.parseBytes(vm.readFile("art/traits-packed.hex"));
        require(blob.length == 8000, "traits blob");

        vm.startBroadcast(deployer);

        // --- test venue ---
        o.usdg = address(new DeskTestAsset("Test USDG", "tUSDG", 6, deployer));
        o.tmsft = address(new DeskTestAsset("Test Microsoft", "tMSFT", 18, deployer));
        o.msftFeed = address(new DeskTestFeed(deployer, 500e8));
        o.ethFeed = address(new DeskTestFeed(deployer, 2700e8));
        ITestnetOwned(TAAPL_FEED).setAnswer(200e8); // the staging feed is weeks old; refresh it
        IBoosterAdmin(BOOSTER).setStockFeed(o.tmsft, o.msftFeed);

        o.aaplPool = address(new DeskTestPool(o.usdg, TAAPL, IDeskTestFeed(TAAPL_FEED), SPREAD_BPS));
        o.msftPool = address(new DeskTestPool(o.usdg, o.tmsft, IDeskTestFeed(o.msftFeed), SPREAD_BPS));
        o.ethPool = address(new DeskTestPool(o.usdg, WETH, IDeskTestFeed(o.ethFeed), SPREAD_BPS));
        ITestnetOwned(TAAPL).mint(o.aaplPool, 100e18);
        DeskTestAsset(o.tmsft).mint(o.msftPool, 100e18);
        DeskTestAsset(o.usdg).mint(o.aaplPool, 100_000e6);
        DeskTestAsset(o.usdg).mint(o.msftPool, 100_000e6);
        IWETH9(WETH).deposit{value: 0.015 ether}();
        IWETH9(WETH).transfer(o.ethPool, 0.015 ether);

        // --- the Desk's own basket slot (epoch 1: tAAPL 100%) ---
        o.strategyId = IRegistryAdmin(REGISTRY).createStrategy("desk rehearsal");
        address[] memory t = new address[](1);
        uint16[] memory w = new uint16[](1);
        (t[0], w[0]) = (TAAPL, 10_000);
        IRegistryAdmin(REGISTRY).setStrategy(o.strategyId, t, w);

        // --- desk contracts ---
        o.bonus = address(new CoatBonusPool(IERC20(COAT), ICoattailBrokerView(BROKERS), deployer, deployer));
        // DeskAccount pins the engine immutably, so the engine address is predicted from the
        // deployer nonce: account impl (n), DeskNFT (n+1), renderer (n+2), engine (n+3).
        uint64 n = vm.getNonce(deployer);
        address predictedEngine = vm.computeCreateAddress(deployer, n + 3);
        o.accountImpl = address(new DeskAccount(predictedEngine));
        o.desks = address(
            new DeskNFT(IERC20(COAT), o.bonus, IERC6551RegistryDesk(REGISTRY_6551), o.accountImpl, deployer)
        );
        o.renderer = address(new DeskRenderer(keccak256(blob), deployer));
        o.engine = address(
            new DeskEngine(
                IERC20(o.usdg),
                IWETHDesk(WETH),
                IDeskNFTView(o.desks),
                IStrategyRegistryView(REGISTRY),
                IBoosterFeedView(BOOSTER),
                o.strategyId,
                BOOSTER,
                treasury,
                deployer
            )
        );
        require(o.engine == predictedEngine, "engine address prediction");

        // --- traits: upload, freeze against the deploy-time commit ---
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

        // --- engine routes, then open the mint at the real pilot price ---
        DeskEngine(payable(o.engine)).setPool(TAAPL, o.aaplPool);
        DeskEngine(payable(o.engine)).setPool(o.tmsft, o.msftPool);
        DeskEngine(payable(o.engine)).setEthPool(o.ethPool);
        DeskNFT(o.desks).setMintOpen(true);

        vm.stopBroadcast();

        _write(o, deployer, treasury);
    }

    function _word(bytes memory blob, uint256 w) internal pure returns (bytes32 word) {
        assembly {
            word := mload(add(add(blob, 32), mul(w, 32)))
        }
    }

    function _write(Out memory o, address deployer, address treasury) internal {
        string memory k = "desk";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "treasury", treasury);
        vm.serializeAddress(k, "brokers", BROKERS);
        vm.serializeAddress(k, "coat", COAT);
        vm.serializeAddress(k, "booster", BOOSTER);
        vm.serializeAddress(k, "registry", REGISTRY);
        vm.serializeAddress(k, "weth", WETH);
        vm.serializeAddress(k, "taapl", TAAPL);
        vm.serializeAddress(k, "taaplFeed", TAAPL_FEED);
        vm.serializeAddress(k, "usdg", o.usdg);
        vm.serializeAddress(k, "tmsft", o.tmsft);
        vm.serializeAddress(k, "msftFeed", o.msftFeed);
        vm.serializeAddress(k, "ethFeed", o.ethFeed);
        vm.serializeAddress(k, "aaplPool", o.aaplPool);
        vm.serializeAddress(k, "msftPool", o.msftPool);
        vm.serializeAddress(k, "ethPool", o.ethPool);
        vm.serializeUint(k, "strategyId", o.strategyId);
        vm.serializeAddress(k, "bonus", o.bonus);
        vm.serializeAddress(k, "accountImpl", o.accountImpl);
        vm.serializeAddress(k, "desks", o.desks);
        vm.serializeAddress(k, "renderer", o.renderer);
        string memory json = vm.serializeAddress(k, "engine", o.engine);
        string memory path = vm.envOr("DESK_OUT", string("rehearsal/testnet-46630.json"));
        vm.writeJson(json, path);
        console2.log("addresses ->", path);
    }
}

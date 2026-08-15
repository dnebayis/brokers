// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {StockRouter} from "../src/StockRouter.sol";
import {Booster} from "../src/Booster.sol";
import {IAggregatorV3} from "../src/interfaces/IExternal.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {TestnetAsset, TestnetFeed, TestnetV3Pool, TestnetRialtoPool} from "../src/testnet/TestnetVenue.sol";

/// @notice Deploys a deterministic inventory-funded stock venue only on chain 46630.
/// It is invoked by deploy_all.sh before ownership is accepted by the hardware wallet.
contract DeployTestnetVenue is Script {
    using SafeCast for uint256;
    uint256 constant INVENTORY = 1_000_000 ether;

    function run() external {
        require(block.chainid == 46630, "testnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address weth = vm.envAddress("WETH");
        StockRouter router = StockRouter(vm.envAddress("STOCK_ROUTER"));
        Booster booster = Booster(payable(vm.envAddress("BOOSTER")));

        vm.startBroadcast(pk);
        TestnetAsset usdg = new TestnetAsset("Test USDG", "tUSDG", deployer);
        TestnetV3Pool midPool = new TestnetV3Pool(weth, address(usdg), 2_000, 1);
        usdg.mint(address(midPool), 10_000_000 ether);

        string[5] memory names = ["Test AAPL", "Test AMD", "Test AMZN", "Test COIN", "Test CRCL"];
        string[5] memory symbols = ["tAAPL", "tAMD", "tAMZN", "tCOIN", "tCRCL"];
        uint256[5] memory prices = [uint256(200), 100, 150, 300, 100];
        address[5] memory stocks;
        address[5] memory pools;
        address[5] memory feeds;

        for (uint256 i; i < 5; ++i) {
            TestnetAsset stock = new TestnetAsset(names[i], symbols[i], deployer);
            TestnetRialtoPool pool = new TestnetRialtoPool(address(usdg), address(stock), 1, prices[i]);
            TestnetFeed feed = new TestnetFeed(deployer, (prices[i] * 1e8).toInt256());
            stock.mint(address(pool), INVENTORY);
            router.setRoute(
                address(stock), address(midPool), address(usdg), address(pool), StockRouter.PoolKind.Rialto
            );
            booster.setStockFeed(address(stock), IAggregatorV3(address(feed)));
            stocks[i] = address(stock);
            pools[i] = address(pool);
            feeds[i] = address(feed);
        }
        vm.stopBroadcast();

        string memory object = "testnetVenue";
        vm.serializeUint(object, "chainId", block.chainid);
        vm.serializeAddress(object, "usdg", address(usdg));
        vm.serializeAddress(object, "midPool", address(midPool));
        vm.serializeAddress(object, "stock0", stocks[0]);
        vm.serializeAddress(object, "stock1", stocks[1]);
        vm.serializeAddress(object, "stock2", stocks[2]);
        vm.serializeAddress(object, "stock3", stocks[3]);
        vm.serializeAddress(object, "stock4", stocks[4]);
        vm.serializeAddress(object, "stockPool0", pools[0]);
        vm.serializeAddress(object, "stockPool1", pools[1]);
        vm.serializeAddress(object, "stockPool2", pools[2]);
        vm.serializeAddress(object, "stockPool3", pools[3]);
        vm.serializeAddress(object, "stockPool4", pools[4]);
        vm.serializeAddress(object, "feed0", feeds[0]);
        vm.serializeAddress(object, "feed1", feeds[1]);
        vm.serializeAddress(object, "feed2", feeds[2]);
        vm.serializeAddress(object, "feed3", feeds[3]);
        string memory json = vm.serializeAddress(object, "feed4", feeds[4]);
        vm.writeJson(json, "reports/testnet-venue-46630.json");
        console2.log("Testnet venue manifest: reports/testnet-venue-46630.json");
    }
}

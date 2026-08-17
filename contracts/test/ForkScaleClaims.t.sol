// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BrokerAccount} from "../src/BrokerAccount.sol";
import {Booster} from "../src/Booster.sol";
import {COAT} from "../src/COAT.sol";
import {CoattailBroker, IBoosterHook, ICoatBurnable} from "../src/CoattailBroker.sol";
import {StockRouter} from "../src/StockRouter.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";
import {IERC6551Registry, IAggregatorV3, IStockRouter, IWETH} from "../src/interfaces/IExternal.sol";

interface IRialtoScalePool {
    function fermi() external view returns (address);
}

interface IFermiScale {
    function lastUpdateBlock() external view returns (uint256);
}

/// Deterministic, storage-free registry used only to prevent the public fork RPC from
/// fetching metadata for 1,776 freshly-computed CREATE2 addresses. Canonical registry
/// deployment/account behavior is covered by ForkFullSystemTest.
contract ScaleRegistry is IERC6551Registry {
    function createAccount(address, bytes32, uint256, address tokenContract, uint256 tokenId)
        external
        pure
        returns (address)
    {
        return _account(tokenContract, tokenId);
    }

    function account(address, bytes32, uint256, address tokenContract, uint256 tokenId)
        external
        pure
        returns (address)
    {
        return _account(tokenContract, tokenId);
    }

    function _account(address tokenContract, uint256 tokenId) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("COAT_SCALE_TBA", tokenContract, tokenId)))));
    }
}

contract ForkScaleActor {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    function mintAndActivate(CoattailBroker broker, COAT coat)
        external
        payable
        returns (uint256[] memory pair)
    {
        pair = broker.mint{value: msg.value}(2);
        coat.approve(address(broker), 2 * 36_750 ether);
        broker.activate(pair[0]);
        broker.activate(pair[1]);
    }
}

contract ForkScaleTreasury {
    receive() external payable {}
}

/// @notice Release-scale proof on a real mainnet fork. It mints the complete random
/// collection to 888 distinct owners, activates all 1,776 token IDs, buys live AAPL
/// through the production StockRouter, and permissionlessly claims every share to its TBA.
contract ForkScaleClaimsTest is Test {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant MID_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant AAPL_POOL = 0x957BB4b86CCC706D44983fb889ED63c6F9Bdc662;
    address constant AAPL_FEED = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;

    uint256 constant ACTORS = 888;
    uint256 constant SUPPLY = 1_776;
    uint256 constant BURN = 36_750 ether;

    COAT internal scaleCoat;
    CoattailBroker internal scaleBroker;
    Booster internal scaleBooster;
    ForkScaleTreasury internal scaleTreasury;

    receive() external payable {}

    function test_allRandomIdsClaimRealStockToDistinctTbas() public {
        if (block.chainid != 4663) {
            require(!vm.envOr("REQUIRE_MAINNET_FORK", false), "required RH mainnet fork missing");
            return;
        }
        uint256 forkL2Block = block.number;

        _deployScaleSystem();
        uint256[] memory ids = _mintAndActivateAll();
        _buyAndClaimAll(ids, forkL2Block);
    }

    function _deployScaleSystem() internal {
        scaleCoat = new COAT(address(this), address(this));
        scaleCoat.enableTrading();
        vm.roll(scaleCoat.restrictionsEndBlock() + 1);
        StrategyRegistry strategy = new StrategyRegistry(address(this), address(this));
        strategy.createStrategy("The Politician");
        scaleTreasury = new ForkScaleTreasury();
        scaleBroker = new CoattailBroker(
            address(this),
            address(scaleTreasury),
            IERC6551Registry(address(new ScaleRegistry())),
            address(new BrokerAccount()),
            ""
        );
        StockRouter stockRouter = new StockRouter(WETH, address(this));
        scaleBooster = new Booster(
            scaleBroker, strategy, IStockRouter(address(stockRouter)), IWETH(WETH), 0, address(this)
        );

        scaleBroker.setBooster(IBoosterHook(address(scaleBooster)));
        scaleBroker.setCoat(ICoatBurnable(address(scaleCoat)));
        scaleBroker.setMintOpen(true);
        stockRouter.setRoute(AAPL, MID_POOL, USDG, AAPL_POOL, StockRouter.PoolKind.Rialto);
        address[] memory tokens = new address[](1);
        uint16[] memory weights = new uint16[](1);
        tokens[0] = AAPL;
        weights[0] = 10_000;
        strategy.setStrategy(0, tokens, weights);
        scaleBooster.setEthUsdManual(1_880e8);
        scaleBooster.setStockFeed(AAPL, IAggregatorV3(AAPL_FEED));
        scaleBooster.setPokeThreshold(1);
    }

    function _mintAndActivateAll() internal returns (uint256[] memory ids) {
        ids = new uint256[](SUPPLY);
        bool[] memory seen = new bool[](SUPPLY + 1);
        bool nonMonotonic;
        uint256 cursor;
        vm.deal(address(this), 3 ether);
        uint256 treasuryBefore = address(scaleTreasury).balance;
        for (uint256 i; i < ACTORS; ++i) {
            ForkScaleActor actor = new ForkScaleActor();
            scaleCoat.transfer(address(actor), 2 * BURN);
            uint256[] memory pair =
                actor.mintAndActivate{value: 2 * scaleBroker.mintPriceWei()}(scaleBroker, scaleCoat);

            for (uint256 j; j < 2; ++j) {
                uint256 tokenId = pair[j];
                assertGe(tokenId, 1);
                assertLe(tokenId, SUPPLY);
                assertFalse(seen[tokenId], "duplicate random ID");
                seen[tokenId] = true;
                ids[cursor] = tokenId;
                if (cursor != 0 && tokenId < ids[cursor - 1]) nonMonotonic = true;
                ++cursor;
            }
        }

        assertEq(cursor, SUPPLY);
        assertTrue(nonMonotonic, "mint sequence unexpectedly monotonic");
        for (uint256 id = 1; id <= SUPPLY; ++id) {
            assertTrue(seen[id], "permutation gap");
        }
        assertEq(
            address(scaleTreasury).balance - treasuryBefore,
            SUPPLY * scaleBroker.mintPriceWei(),
            "mint revenue mismatch"
        );
        assertEq(scaleBooster.activeShares(), SUPPLY);
        assertEq(scaleCoat.totalSupply(), scaleCoat.MAX_SUPPLY() - SUPPLY * BURN, "activation burn mismatch");
    }

    function _buyAndClaimAll(uint256[] memory ids, uint256 forkL2Block) internal {
        vm.deal(address(scaleBooster), 1 ether);
        address fermi = IRialtoScalePool(AAPL_POOL).fermi();
        vm.roll(IFermiScale(fermi).lastUpdateBlock());
        scaleBooster.poke();
        vm.roll(forkL2Block);
        uint256 bought = scaleBooster.totalBought(AAPL);
        assertGt(bought, 0, "no live stock bought");

        for (uint256 i; i < SUPPLY; i += scaleBooster.MAX_CLAIM_BATCH()) {
            uint256 length = SUPPLY - i;
            if (length > scaleBooster.MAX_CLAIM_BATCH()) length = scaleBooster.MAX_CLAIM_BATCH();
            uint256[] memory batch = new uint256[](length);
            for (uint256 j; j < length; ++j) {
                batch[j] = ids[i + j];
            }
            scaleBooster.claimBatch(batch);
        }

        for (uint256 i; i < SUPPLY; ++i) {
            assertGt(IERC20(AAPL).balanceOf(scaleBroker.accountOf(ids[i])), 0, "TBA received no stock");
        }
        assertLe(scaleBooster.totalClaimed(AAPL), bought);
        emit log_named_bytes32("random ID permutation hash", keccak256(abi.encode(ids)));
        emit log_named_uint("real AAPL bought", bought);
        emit log_named_uint("real AAPL claimed", scaleBooster.totalClaimed(AAPL));
    }
}

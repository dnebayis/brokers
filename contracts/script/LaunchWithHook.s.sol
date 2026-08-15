// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CoatFeeHook, IStateViewHook} from "../src/CoatFeeHook.sol";
import {PoolKey, IPoolManagerMinimal, HookFlags} from "../src/v4/V4Types.sol";
import {CoatRouter, IPoolManagerFull, IStateView} from "../src/CoatRouter.sol";
import {BuybackBurner, ICoatBuybackRouter, ICoatTwap, ICoatBurn} from "../src/BuybackBurner.sol";
import {COAT} from "../src/COAT.sol";
import {PermanentV4LiquidityLocker} from "../src/PermanentV4LiquidityLocker.sol";
import {
    AtomicV4Launcher,
    IAtomicPoolManager,
    IAtomicPositionManager,
    IAtomicPermit2
} from "../src/AtomicV4Launcher.sol";

interface IFeeSplitterLaunch {
    function owner() external view returns (address);
    function booster() external view returns (address payable);
    function treasury() external view returns (address payable);
    function setSinks(address payable booster, address payable treasury, address payable buyback) external;
    function buyback() external view returns (address payable);
}

interface IPoolManagerInit {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24);
}

interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IAllowanceTransfer {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IERC20 {
    function approve(address spender, uint256 value) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title LaunchWithHook
/// @notice The complete $COAT fair-launch in one broadcast: (1) mine + deploy the CoatFeeHook at a
///         flag-valid address, (2) initialize the $COAT/ETH v4 pool WITH that hook, (3) seed it
///         single-sided (full 1B $COAT, zero ETH). Same canonical v4 addresses on RH testnet (46630)
///         and mainnet (4663) — dry-run on testnet first, then mainnet.
///
///   DRY-RUN (simulate against real testnet state, spends nothing):
///     COAT_ADDRESS=0x.. FEE_SPLITTER=0x.. forge script script/LaunchWithHook.s.sol --rpc-url $TESTNET
///   LIVE: add --broadcast
contract LaunchWithHook is Script {
    // canonical v4 (verified present on both RH testnet + mainnet)
    IPoolManagerInit constant POOL_MANAGER = IPoolManagerInit(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IPositionManager constant POSM = IPositionManager(0x58daec3116aae6D93017bAAea7749052E8a04fA7);
    IStateViewHook constant STATE_VIEW = IStateViewHook(0xF3334192D15450CdD385c8B70e03f9A6bD9E673b);
    IAllowanceTransfer constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    uint256 constant LAUNCH_ALLOCATION = 1_000_000_000 ether;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        address coat = vm.envAddress("COAT_ADDRESS");
        address payable feeSplitter = payable(vm.envAddress("FEE_SPLITTER"));
        bool mainnet = block.chainid == 4663;
        address hookOwner = mainnet ? vm.envAddress("HOOK_OWNER") : vm.envOr("HOOK_OWNER", me);
        require(coat != address(0) && feeSplitter != address(0), "zero address");
        require(hookOwner != address(0), "zero admin");
        require(COAT(coat).poolManager() == address(POOL_MANAGER), "wrong COAT pool manager");
        require(COAT(coat).launchController() == me, "wrong COAT launch controller");
        IFeeSplitterLaunch configuredSplitter = IFeeSplitterLaunch(feeSplitter);
        require(
            configuredSplitter.booster() != address(0) && configuredSplitter.treasury() != address(0),
            "unwired fee splitter"
        );
        if (mainnet) {
            require(hookOwner != me, "deployer fallback");
            require(coat.code.length != 0 && feeSplitter.code.length != 0, "deployment contracts required");
        }

        require(IERC20(coat).balanceOf(me) == LAUNCH_ALLOCATION, "distributor must hold full 1B");

        vm.startBroadcast(pk);
        AtomicV4Launcher atomicLauncher = new AtomicV4Launcher(
            me,
            IAtomicPoolManager(address(POOL_MANAGER)),
            IAtomicPositionManager(address(POSM)),
            STATE_VIEW,
            IAtomicPermit2(address(PERMIT2))
        );

        // Mine the 0x2044 permission address for CREATE2 from the atomic launcher.
        bytes32 salt;
        address predicted;
        {
            bytes memory args = abi.encode(
                hookOwner,
                IPoolManagerMinimal(address(POOL_MANAGER)),
                STATE_VIEW,
                coat,
                feeSplitter,
                address(atomicLauncher)
            );
            bytes32 initCodeHash = keccak256(abi.encodePacked(type(CoatFeeHook).creationCode, args));
            uint160 targetFlags = HookFlags.BEFORE_INITIALIZE_FLAG | HookFlags.AFTER_SWAP_FLAG
                | HookFlags.AFTER_SWAP_RETURNS_DELTA_FLAG;
            (salt, predicted) = _mine(initCodeHash, targetFlags, address(atomicLauncher));
        }
        console2.log("mined hook address:", predicted);

        // Hook deploy, guarded pool initialize, locker binding and LP mint are one transaction.
        IERC20(coat).approve(address(atomicLauncher), LAUNCH_ALLOCATION);
        (CoatFeeHook hook, PermanentV4LiquidityLocker locker) =
            atomicLauncher.launch(coat, feeSplitter, splitterTreasury(feeSplitter), hookOwner, salt);
        require(address(hook) == predicted, "hook address mismatch");

        // Exact SqrtPriceMath rounding leaves only a few token-wei. Burn that remainder so no
        // reserve/team allocation remains, then open the one-shot launch protection window.
        uint256 remainder = IERC20(coat).balanceOf(me);
        if (remainder != 0) COAT(coat).burn(remainder);
        COAT(coat).enableTrading();

        // 4) deploy the permanent router + TWAP buyback burner and enforce the 10% sink.
        CoatRouter router = new CoatRouter(
            IPoolManagerFull(address(POOL_MANAGER)), IStateView(address(STATE_VIEW)), coat, address(hook)
        );
        BuybackBurner burner =
            new BuybackBurner(ICoatBuybackRouter(address(router)), ICoatTwap(address(hook)), ICoatBurn(coat));
        IFeeSplitterLaunch splitter = configuredSplitter;
        require(splitter.owner() == me, "deployer must own FeeSplitter until launch wiring");
        splitter.setSinks(splitter.booster(), splitter.treasury(), payable(address(burner)));
        require(splitter.buyback() == address(burner), "buyback wiring failed");

        vm.stopBroadcast();

        // `hook` and `locker` are created by AtomicV4Launcher, so Foundry's top-level
        // broadcast file does not list them as standalone creations. Persist their
        // canonical addresses for the deploy manifest and downstream verification.
        string memory report = "launch";
        vm.serializeAddress(report, "atomicLauncher", address(atomicLauncher));
        vm.serializeAddress(report, "feeHook", address(hook));
        vm.serializeAddress(report, "lpLocker", address(locker));
        vm.serializeAddress(report, "router", address(router));
        string memory json = vm.serializeAddress(report, "buybackBurner", address(burner));
        vm.writeJson(json, string.concat("reports/launch-", vm.toString(block.chainid), ".json"));

        console2.log("hook deployed + pool initialized + seeded single-sided.");
        console2.log("hook:", address(hook));
        console2.log("fee splitter (ETH sink):", feeSplitter);
        console2.log("buy-side COAT fees: real totalSupply burn");
        console2.log("permanent LP locker:", address(locker));
        console2.log("CoatRouter:", address(router));
        console2.log("BuybackBurner (10% sink):", address(burner));
        console2.log("COAT now in PoolManager:", IERC20(coat).balanceOf(address(POOL_MANAGER)));
    }

    function splitterTreasury(address splitter) internal view returns (address payable) {
        return IFeeSplitterLaunch(splitter).treasury();
    }

    function _mine(bytes32 initCodeHash, uint160 targetFlags, address deployer)
        internal
        pure
        returns (bytes32, address)
    {
        for (uint256 i; i < 1_000_000; ++i) {
            address a = vm.computeCreate2Address(bytes32(i), initCodeHash, deployer);
            if (uint160(a) & HookFlags.ALL_FLAGS_MASK == targetFlags) return (bytes32(i), a);
        }
        revert("no salt found");
    }
}

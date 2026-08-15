// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {COAT} from "../src/COAT.sol";
import {CoatFeeHook, IStateViewHook} from "../src/CoatFeeHook.sol";
import {
    Currency,
    PoolKey,
    SwapParams,
    BalanceDelta,
    BalanceDeltaLibrary,
    IPoolManagerMinimal,
    HookFlags
} from "../src/v4/V4Types.sol";

/// Extended PoolManager surface used by the test-only swap router.
interface IPoolManagerFull {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24);
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (BalanceDelta);
    function settle() external payable returns (uint256);
    function sync(Currency currency) external;
    function take(Currency currency, address to, uint256 amount) external;
}

interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
}

interface IAllowanceTransfer {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IERC20T {
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 v) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

/// Minimal PoolSwapTest-style router: unlocks the PoolManager, performs one swap, settles the
/// owed side (native ETH via settle{value}, ERC-20 via sync+transfer+settle) and takes the output.
contract SwapRouterHelper {
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManagerFull public immutable pm;
    address public immutable coat;

    constructor(IPoolManagerFull pm_, address coat_) {
        pm = pm_;
        coat = coat_;
    }

    function swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified, address recipient)
        external
        payable
        returns (BalanceDelta)
    {
        bytes memory res = pm.unlock(abi.encode(key, zeroForOne, amountSpecified, recipient));
        return abi.decode(res, (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "not pm");
        (PoolKey memory key, bool zeroForOne, int256 amountSpecified, address recipient) =
            abi.decode(data, (PoolKey, bool, int256, address));

        uint160 limit =
            zeroForOne ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341);
        BalanceDelta d = pm.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: amountSpecified, sqrtPriceLimitX96: limit}),
            ""
        );

        int128 a0 = d.amount0();
        int128 a1 = d.amount1();

        // settle currency0 (native ETH) if we owe it; take it if we're owed it
        if (a0 < 0) {
            pm.settle{value: uint256(uint128(-a0))}();
        } else if (a0 > 0) {
            pm.take(key.currency0, recipient, uint256(uint128(a0)));
        }
        // settle currency1 (COAT) if we owe it; take it if we're owed it
        if (a1 < 0) {
            pm.sync(key.currency1);
            IERC20T(coat).transfer(address(pm), uint256(uint128(-a1)));
            pm.settle();
        } else if (a1 > 0) {
            pm.take(key.currency1, recipient, uint256(uint128(a1)));
        }

        return abi.encode(d);
    }

    receive() external payable {}
}

/// Definitive fee-hook proof: fork RH mainnet, deploy CoatFeeHook at a mined (flag-valid) address
/// via CREATE2, initialize the real v4 pool WITH the hook, seed single-sided liquidity, then run a
/// BUY (ETH->COAT) and a SELL (COAT->ETH) against the REAL PoolManager. Proves the hook skims a fee
/// on every swap and that flush() routes ETH to the flywheel sink and COAT to the burn sink.
///
///   forge test --match-contract ForkHook --fork-url https://rpc.mainnet.chain.robinhood.com -vv
contract ForkHookTest is Test {
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManagerFull constant PM = IPoolManagerFull(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IPositionManager constant POSM = IPositionManager(0x58daec3116aae6D93017bAAea7749052E8a04fA7);
    IAllowanceTransfer constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    IStateView constant STATE = IStateView(0xF3334192D15450CdD385c8B70e03f9A6bD9E673b);

    uint24 constant FEE = 10000;
    int24 constant TICK_SPACING = 200;
    int24 constant TICK_LOWER = 138000;
    int24 constant TICK_UPPER = 184200;
    uint160 constant SQRT_PRICE_X96 = 799603176048022585010545010154905;
    uint256 constant LIQUIDITY = 111110341605252461876272;
    uint128 constant AMOUNT1_MAX = 1_000_000_000 ether;
    uint8 constant MINT_POSITION = 0x02;
    uint8 constant SETTLE_PAIR = 0x0d;

    COAT coat;
    CoatFeeHook hook;
    address ethSink;

    function _mineAndDeployHook() internal {
        bytes memory initCode = abi.encodePacked(
            type(CoatFeeHook).creationCode,
            abi.encode(
                address(this),
                IPoolManagerMinimal(address(PM)),
                IStateViewHook(address(STATE)),
                address(coat),
                payable(ethSink),
                address(this)
            )
        );
        bytes32 initCodeHash = keccak256(initCode);
        uint160 target = HookFlags.BEFORE_INITIALIZE_FLAG | HookFlags.AFTER_SWAP_FLAG
            | HookFlags.AFTER_SWAP_RETURNS_DELTA_FLAG; // 0x2044
        bytes32 salt;
        address hookAddr;
        for (uint256 i; i < 300_000; ++i) {
            address a = vm.computeCreate2Address(bytes32(i), initCodeHash, address(this));
            if (uint160(a) & HookFlags.ALL_FLAGS_MASK == target) {
                salt = bytes32(i);
                hookAddr = a;
                break;
            }
        }
        require(hookAddr != address(0), "no salt found");
        hook = new CoatFeeHook{salt: salt}(
            address(this),
            IPoolManagerMinimal(address(PM)),
            IStateViewHook(address(STATE)),
            address(coat),
            payable(ethSink),
            address(this)
        );
        assertEq(address(hook), hookAddr, "hook address mismatch");
    }

    function _key() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(coat)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: address(hook)
        });
    }

    function _initAndSeed(PoolKey memory key) internal {
        coat.approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(address(coat), address(POSM), AMOUNT1_MAX, uint48(block.timestamp + 1 hours));
        PM.initialize(key, SQRT_PRICE_X96);
        bytes memory actions = abi.encodePacked(MINT_POSITION, SETTLE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, TICK_LOWER, TICK_UPPER, LIQUIDITY, uint128(0), AMOUNT1_MAX, address(this), bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        POSM.modifyLiquidities{value: 0}(abi.encode(actions, params), block.timestamp + 1 hours);
    }

    function test_feeHook_skimsSwaps_routesToFlywheel() public {
        if (block.chainid != 4663) {
            require(!vm.envOr("REQUIRE_MAINNET_FORK", false), "required RH mainnet fork missing");
            return;
        }

        ethSink = makeAddr("feeSplitter"); // stands in for the FeeSplitter (flywheel)
        coat = new COAT(address(this), address(PM));

        _mineAndDeployHook();
        emit log_named_address("hook deployed at", address(hook));

        PoolKey memory key = _key();
        _initAndSeed(key);
        uint256 remainder = coat.balanceOf(address(this));
        if (remainder != 0) coat.burn(remainder);
        coat.enableTrading();
        vm.roll(coat.restrictionsEndBlock() + 1);

        SwapRouterHelper router = new SwapRouterHelper(PM, address(coat));

        // === BUY: 5 ETH -> COAT. Fee taken on unspecified output (COAT) -> burn sink. ===
        vm.deal(address(router), 5 ether);
        BalanceDelta buy = router.swap{value: 0}(key, true, -int256(5 ether), address(this));
        uint256 coatFeeAccrued = coat.balanceOf(address(hook));
        emit log_named_uint("hook accrued COAT (buy fee)", coatFeeAccrued);
        assertGt(coatFeeAccrued, 0, "no COAT fee skimmed on buy");

        // === SELL: half the COAT back -> ETH. Fee taken on unspecified output (ETH) -> flywheel. ===
        uint256 coatToSell = uint256(uint128(buy.amount1())) / 2;
        coat.transfer(address(router), coatToSell);
        router.swap(key, false, -int256(coatToSell), address(this));
        uint256 ethFeeAccrued = address(hook).balance;
        emit log_named_uint("hook accrued ETH (sell fee)", ethFeeAccrued);
        assertGt(ethFeeAccrued, 0, "no ETH fee skimmed on sell");

        // === flush: ETH -> flywheel sink, COAT -> burn sink ===
        uint256 supplyBeforeBurn = coat.totalSupply();
        hook.flush();
        emit log_named_uint("flywheel sink ETH received", ethSink.balance);
        assertEq(ethSink.balance, ethFeeAccrued, "flywheel sink did not receive the ETH fee");
        assertEq(coat.totalSupply(), supplyBeforeBurn - coatFeeAccrued, "COAT fee was not burned");
        assertEq(address(hook).balance, 0, "hook should be drained of ETH after flush");
    }

    receive() external payable {} // to receive ETH output from the SELL swap
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PlaybookEngine} from "../src/PlaybookEngine.sol";

interface IBrokersG { function ownerOf(uint256) external view returns (address); function accountOf(uint256) external view returns (address); }
interface ITBAG { function execute(address,uint256,bytes calldata,uint8) external payable returns (bytes memory); }
interface IBoosterG { function claimFor(uint256) external; function knownTokenCount() external view returns (uint256); function knownTokens(uint256) external view returns (address); }
interface IFloorG {
    function sellBasket(address[] calldata, uint256[] calldata, uint8, uint256, address, uint256) external returns (uint256);
}

/// Where does the ~1M gas actually go? Measures each stage separately so the fix targets
/// the real cost centre instead of the loudest guess.
contract GasProfileTest is Test {
    PlaybookEngine constant ENGINE = PlaybookEngine(0x3b39C832a906E7fE5292F6872c3D3f9eE8340438);
    address constant BROKERS = 0x1122dB21998707F8c2eD8182734356C947fA5e98;
    address constant BOOSTER = 0x7bAf435847A4b45c2e22a7fd13549C3192C95953;
    address constant FLOOR = 0x478F22A32663cF37702d65352A7579A73e61FDc7;
    address constant KEEPER = 0xa492c8fFa033016144B169501D2e428BeDD518CA;
    address constant INTC = 0xc72b96e0E48ecd4DC75E1e45396e26300BC39681;
    address constant SPCX = 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa;
    address constant MU = 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD;
    uint256 constant ID = 527;
    address owner; address tba;

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC", string("https://rpc.mainnet.chain.robinhood.com")));
        owner = IBrokersG(BROKERS).ownerOf(ID);
        tba = IBrokersG(BROKERS).accountOf(ID);
    }

    function test_profile() public {
        address[3] memory s = [INTC, SPCX, MU];

        uint256 g = gasleft();
        IBoosterG(BOOSTER).claimFor(ID);
        emit log_named_uint("A claimFor (the keeper already does this hourly)", g - gasleft());

        for (uint256 i; i < 3; ++i) {
            vm.prank(owner);
            ITBAG(tba).execute(s[i], 0, abi.encodeCall(IERC20.approve, (address(ENGINE), type(uint256).max)), 0);
        }

        // the read loop the engine performs: token list + balance + allowance per stock
        g = gasleft();
        uint256 n = IBoosterG(BOOSTER).knownTokenCount();
        for (uint256 i; i < n; ++i) {
            address t = IBoosterG(BOOSTER).knownTokens(i);
            IERC20(t).balanceOf(tba);
            IERC20(t).allowance(tba, address(ENGINE));
        }
        emit log_named_uint("B discovery reads (7 stocks x 3 calls)", g - gasleft());

        // the swap itself, measured directly against the Floor with this Broker's holdings
        address[] memory tk = new address[](3);
        uint256[] memory am = new uint256[](3);
        uint256 legs;
        for (uint256 i; i < 3; ++i) {
            uint256 bal = IERC20(s[i]).balanceOf(tba);
            if (bal == 0) continue;
            vm.prank(tba);
            IERC20(s[i]).transfer(address(this), bal);
            IERC20(s[i]).approve(FLOOR, bal);
            tk[legs] = s[i];
            am[legs] = bal;
            ++legs;
        }
        assembly { mstore(tk, legs) mstore(am, legs) }
        g = gasleft();
        IFloorG(FLOOR).sellBasket(tk, am, 0, 0, address(this), block.timestamp + 300);
        emit log_named_uint("C sellBasket (the actual market work)", g - gasleft());
        emit log_named_uint("  legs sold", legs);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PlaybookEngine, IBrokersPB, IBoosterPB, IFloorPB} from "../src/PlaybookEngine.sol";

interface IBrokerMintPB {
    function mint(uint256 qty) external payable returns (uint256[] memory tokenIds);
    function activate(uint256 tokenId) external;
    function accountOf(uint256 tokenId) external view returns (address);
}

interface IFloorBuyPB {
    function buyBasketEth(uint256 presetId, address recipient, uint256 deadline) external payable;
}

interface ITBAExecutePB {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory);
}

/// @notice Full testnet dress rehearsal of Playbooks against the REAL staging stack:
///         mint a Broker, burn tCOAT to activate it, install a convert-to-USDG playbook,
///         give the TBA's one-time approval exactly the way the frontend will (a single
///         BrokerAccount.execute per stock), stage salary stock in the TBA, then run the
///         keeper pass and prove USDG lands at the owner's chosen destination.
contract DeployTestnetPlaybooks is Script {
    address constant BROKERS = 0x1F6e75a3adD9C7DEbc8594d4f41FA557Fc33DdaF;
    address constant BOOSTER = 0x39e4B20401dc4cA45c0b14800c86Fc3Df953A245;
    address constant FLOOR = 0x927E23B683AcBbeB7F2FbBFa035aF80acfE0b31a;
    address constant TCOAT = 0xD3f44c7DD32D12C7a6776C23c839DEcA8196cf07;
    address constant TAAPL = 0x44B8DA4948e3Eacb0f2E20a42c694Af49942e5C9;
    address constant TUSDG = 0xca71484e6FA828dc261C7b4e902d3DF47542aDa4;

    function run() external {
        require(block.chainid == 46630, "testnet only");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);

        PlaybookEngine engine = new PlaybookEngine(
            IBrokersPB(BROKERS), IBoosterPB(BOOSTER), IFloorPB(FLOOR), me, me
        );
        console2.log("PlaybookEngine", address(engine));

        // the Broker minted+activated beforehand via cast (mint ids are pseudo-random,
        // which breaks forge's two-phase simulation if minted inside the script)
        uint256 id = vm.envUint("TOKEN_ID");
        address tba = IBrokerMintPB(BROKERS).accountOf(id);
        console2.log("broker", id, "tba", tba);

        // salary stand-in: buy a sliver of the live basket straight into the TBA, as if
        // claimed by earlier rounds (also a fresh exercise of the Floor's ETH entry)
        IFloorBuyPB(FLOOR).buyBasketEth{value: 0.0005 ether}(0, tba, block.timestamp + 600);

        // the one-time approval the frontend will collect per stock (single-CALL execute)
        ITBAExecutePB(tba).execute(
            TAAPL, 0, abi.encodeCall(IERC20.approve, (address(engine), type(uint256).max)), 0
        );

        // install: auto-claim on, convert everything to USDG, deliver to the owner wallet
        engine.setPlaybook(id, true, PlaybookEngine.Mode.TO_USDG, me);

        uint256 usdgBefore = IERC20(TUSDG).balanceOf(me);
        uint256[] memory runIds = new uint256[](1);
        runIds[0] = id;
        uint256[] memory minOuts = new uint256[](1);
        engine.run(runIds, minOuts);
        uint256 got = IERC20(TUSDG).balanceOf(me) - usdgBefore;
        console2.log("USDG delivered to owner", got);
        require(got > 0, "playbook must deliver USDG");
        require(IERC20(TAAPL).balanceOf(tba) == 0, "TBA stock fully converted");

        vm.stopBroadcast();
    }
}

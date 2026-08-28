// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IBrokersPB {
    function ownerOf(uint256 tokenId) external view returns (address);
    function accountOf(uint256 tokenId) external view returns (address);
}

interface IBoosterPB {
    function claimFor(uint256 tokenId) external;
    function knownTokenCount() external view returns (uint256);
    function knownTokens(uint256 i) external view returns (address);
    function isActive(uint256 tokenId) external view returns (bool);
}

interface IFloorPB {
    function sellBasket(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint8 outCur, // 0 USDG, 1 ETH, 2 COAT (BasketRouter.OutCurrency)
        uint256 minOut,
        address recipient,
        uint256 deadline
    ) external returns (uint256 out);
}

/// @title PlaybookEngine
/// @notice Programmable paychecks for Coattail Brokers. The NFT owner installs a playbook
///         on a Broker; the hourly keeper executes it: auto-claim the salary, then sweep
///         the claimed stocks raw or convert them through The Floor into USDG or $COAT.
///         No new fee anywhere in this contract — conversions ride The Floor, whose fee
///         already streams to Broker payroll.
/// @dev    Custody never rests here: pulled stocks are sold and delivered within the same
///         transaction, or transferred straight to the owner's destination. A playbook
///         self-invalidates when the Broker changes hands (setter != current owner).
contract PlaybookEngine is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Mode {
        NONE, // auto-claim only (if enabled)
        SWEEP, // move claimed stocks raw to dest
        TO_USDG, // sell claimed stocks via The Floor, USDG to dest
        TO_COAT // sell claimed stocks via The Floor, $COAT to dest
    }

    struct Playbook {
        bool autoClaim;
        Mode mode;
        address dest; // where sweeps/proceeds land; zero = the Broker's own TBA
        bool paused;
    }

    IBrokersPB public immutable brokers;
    IBoosterPB public immutable booster;
    IFloorPB public floor; // settable: the venue can be upgraded without re-enrollment
    address public keeper;

    mapping(uint256 tokenId => Playbook) public playbookOf;
    mapping(uint256 tokenId => address) public setterOf;
    uint256[] public enrolled;
    mapping(uint256 tokenId => uint256) private enrolledIndexPlusOne;

    event PlaybookSet(uint256 indexed tokenId, address indexed owner, bool autoClaim, Mode mode, address dest);
    event PlaybookCleared(uint256 indexed tokenId);
    event PlaybookPaused(uint256 indexed tokenId, bool paused);
    event Executed(uint256 indexed tokenId, Mode mode, uint256 out);
    event FloorSet(address floor);
    event KeeperSet(address keeper);

    error NotBrokerOwner();
    error NotKeeper();
    error NotEnrolled();
    error ZeroAddress();
    error FloorMissing();

    constructor(IBrokersPB brokers_, IBoosterPB booster_, IFloorPB floor_, address keeper_, address owner_)
        Ownable(owner_)
    {
        if (address(brokers_) == address(0) || address(booster_) == address(0)) revert ZeroAddress();
        brokers = brokers_;
        booster = booster_;
        floor = floor_;
        keeper = keeper_;
    }

    // --- owner-of-the-NFT surface ---

    function setPlaybook(uint256 tokenId, bool autoClaim, Mode mode, address dest) external {
        address holder = brokers.ownerOf(tokenId);
        if (holder != msg.sender) revert NotBrokerOwner();
        playbookOf[tokenId] = Playbook({autoClaim: autoClaim, mode: mode, dest: dest, paused: false});
        setterOf[tokenId] = holder;
        if (enrolledIndexPlusOne[tokenId] == 0) {
            enrolled.push(tokenId);
            enrolledIndexPlusOne[tokenId] = enrolled.length;
        }
        emit PlaybookSet(tokenId, holder, autoClaim, mode, dest);
    }

    function clearPlaybook(uint256 tokenId) external {
        if (brokers.ownerOf(tokenId) != msg.sender) revert NotBrokerOwner();
        _remove(tokenId);
    }

    function setPaused(uint256 tokenId, bool paused) external {
        if (brokers.ownerOf(tokenId) != msg.sender) revert NotBrokerOwner();
        if (enrolledIndexPlusOne[tokenId] == 0) revert NotEnrolled();
        playbookOf[tokenId].paused = paused;
        emit PlaybookPaused(tokenId, paused);
    }

    // --- keeper surface ---

    /// @notice Execute a batch of playbooks. `minOuts[i]` guards the whole conversion of
    ///         `ids[i]` (keeper computes it off-chain; pass 0 for SWEEP/claim-only). A
    ///         playbook whose Broker changed hands since it was set is skipped, never run.
    function run(uint256[] calldata ids, uint256[] calldata minOuts) external nonReentrant {
        if (msg.sender != keeper && msg.sender != owner()) revert NotKeeper();
        for (uint256 i; i < ids.length; ++i) {
            _runOne(ids[i], i < minOuts.length ? minOuts[i] : 0);
        }
    }

    function enrolledCount() external view returns (uint256) {
        return enrolled.length;
    }

    function enrolledAt(uint256 i) external view returns (uint256) {
        return enrolled[i];
    }

    function _runOne(uint256 tokenId, uint256 minOut) internal {
        Playbook memory pb = playbookOf[tokenId];
        if (enrolledIndexPlusOne[tokenId] == 0 || pb.paused) return;
        address holder;
        try brokers.ownerOf(tokenId) returns (address h) {
            holder = h;
        } catch {
            return;
        }
        // the playbook died with the transfer: the new owner must opt in themselves
        if (holder != setterOf[tokenId]) return;

        if (pb.autoClaim && booster.isActive(tokenId)) {
            try booster.claimFor(tokenId) {} catch {}
        }
        if (pb.mode == Mode.NONE) return;

        address tba = brokers.accountOf(tokenId);
        address dest = pb.dest == address(0) ? tba : pb.dest;
        uint256 n = booster.knownTokenCount();
        address[] memory tokens = new address[](n);
        uint256[] memory amounts = new uint256[](n);
        uint256 legs;
        for (uint256 i; i < n; ++i) {
            address stock = booster.knownTokens(i);
            uint256 bal = IERC20(stock).balanceOf(tba);
            if (bal == 0) continue;
            if (IERC20(stock).allowance(tba, address(this)) < bal) continue; // not yet approved: skip, never revert
            if (pb.mode == Mode.SWEEP) {
                IERC20(stock).safeTransferFrom(tba, dest, bal);
                continue;
            }
            IERC20(stock).safeTransferFrom(tba, address(this), bal);
            tokens[legs] = stock;
            amounts[legs] = bal;
            ++legs;
        }
        if (pb.mode == Mode.SWEEP) {
            emit Executed(tokenId, pb.mode, 0);
            return;
        }
        if (legs == 0) return;
        if (address(floor) == address(0)) revert FloorMissing();
        assembly {
            mstore(tokens, legs)
            mstore(amounts, legs)
        }
        for (uint256 i; i < legs; ++i) {
            IERC20(tokens[i]).forceApprove(address(floor), amounts[i]);
        }
        uint256 out = floor.sellBasket(
            tokens, amounts, pb.mode == Mode.TO_USDG ? 0 : 2, minOut, dest, block.timestamp + 300
        );
        emit Executed(tokenId, pb.mode, out);
    }

    function _remove(uint256 tokenId) internal {
        uint256 idxPlus = enrolledIndexPlusOne[tokenId];
        if (idxPlus == 0) revert NotEnrolled();
        uint256 last = enrolled.length - 1;
        if (idxPlus - 1 != last) {
            uint256 moved = enrolled[last];
            enrolled[idxPlus - 1] = moved;
            enrolledIndexPlusOne[moved] = idxPlus;
        }
        enrolled.pop();
        delete enrolledIndexPlusOne[tokenId];
        delete playbookOf[tokenId];
        delete setterOf[tokenId];
        emit PlaybookCleared(tokenId);
    }

    // --- admin (settable levers, hard scope) ---

    function setFloor(IFloorPB floor_) external onlyOwner {
        floor = floor_;
        emit FloorSet(address(floor_));
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }
}

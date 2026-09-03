// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IBrokersGV {
    function accountOf(uint256 tokenId) external view returns (address);
    function MAX_SUPPLY() external view returns (uint256);
}

interface IBoosterGV {
    function isActive(uint256 tokenId) external view returns (bool);
}

/// @title GiftVault
/// @notice Holds donated NFTs and gifts them, one draw at a time, to a random ACTIVE Broker.
///         The gift lands in the winning Broker's own ERC-6551 wallet, so it travels with the
///         NFT and the holder can pull it out from the site whenever they like.
/// @dev    The draw is done on chain: a round is opened for the next queued NFT with a draw
///         block a few blocks ahead, and once that block is mined anyone may settle the round.
///         The winner is derived from that block's hash, so neither the keeper nor the owner
///         chooses who wins; they only choose when a round opens. The cadence is enforced
///         here too (`interval`), so gifts cannot be handed out faster than announced.
///         Fully additive: the core contracts are untouched, the vault holds nothing but the
///         NFTs it was sent, and `rescue` gives the owner an exit for mistaken deposits.
contract GiftVault is Ownable2Step, ReentrancyGuard, IERC721Receiver {
    struct Item {
        address nft;
        uint256 id;
    }

    struct Round {
        address nft;
        uint256 id;
        uint64 drawBlock;
        uint64 openedAt;
    }

    IBrokersGV public immutable brokers;
    IBoosterGV public immutable booster;
    /// @notice Highest Broker id the draw can land on (ids are 1..supply).
    uint256 public immutable supply;

    /// @notice Blocks between opening a round and the block whose hash decides it.
    uint64 public constant DRAW_DELAY = 20;
    /// @notice Attempts to land on an active Broker before the round is re-rolled.
    uint256 public constant MAX_TRIES = 32;

    address public keeper;
    /// @notice Minimum seconds between two gifts (the announced cadence).
    uint64 public interval;
    /// @notice When the last gift was settled (0 before the first).
    uint64 public lastGiftAt;
    uint256 public roundCount;
    /// @notice The round currently waiting for its draw block; `nft == 0` means none.
    Round public open;

    Item[] private queue;
    uint256 private head;
    /// @notice How many queued NFTs are waiting for a draw.
    uint256 public queuedCount;
    mapping(address nft => mapping(uint256 id => bool)) public queued;

    event Deposited(address indexed nft, uint256 indexed id, address indexed from);
    event RoundOpened(uint256 indexed round, address indexed nft, uint256 indexed id, uint256 drawBlock);
    event RoundRescheduled(uint256 indexed round, uint256 drawBlock);
    event RoundCancelled(uint256 indexed round);
    event Gifted(
        uint256 indexed round,
        uint256 indexed brokerId,
        address indexed nft,
        uint256 id,
        address wallet,
        bytes32 seed
    );
    event Rescued(address indexed nft, uint256 indexed id, address to);
    event KeeperSet(address keeper);
    event IntervalSet(uint64 interval);

    error NotKeeper();
    error ZeroAddress();
    error RoundOpen();
    error NoRound();
    error TooSoon();
    error QueueEmpty();
    error DrawBlockNotReached();
    error NotQueued();
    error InRound();
    error DirectTransfer();

    constructor(IBrokersGV brokers_, IBoosterGV booster_, address keeper_, uint64 interval_, address owner_)
        Ownable(owner_)
    {
        if (address(brokers_) == address(0) || address(booster_) == address(0)) revert ZeroAddress();
        brokers = brokers_;
        booster = booster_;
        supply = brokers_.MAX_SUPPLY();
        keeper = keeper_;
        interval = interval_;
        emit KeeperSet(keeper_);
        emit IntervalSet(interval_);
    }

    modifier onlyKeeper() {
        _onlyKeeper();
        _;
    }

    function _onlyKeeper() internal view {
        if (msg.sender != keeper && msg.sender != owner()) revert NotKeeper();
    }

    // --- deposits ---

    /// @notice Any ERC-721 sent with `safeTransferFrom` joins the gift queue (first in, first out).
    function onERC721Received(address, address from, uint256 id, bytes calldata) external returns (bytes4) {
        // Only the NFT contract itself calls this hook during a transfer; a direct call would
        // queue an NFT the vault does not hold.
        if (IERC721(msg.sender).ownerOf(id) != address(this)) revert DirectTransfer();
        queue.push(Item({nft: msg.sender, id: id}));
        queued[msg.sender][id] = true;
        ++queuedCount;
        emit Deposited(msg.sender, id, from);
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Next `n` NFTs waiting for a draw, in draw order.
    function upcoming(uint256 n) external view returns (Item[] memory items) {
        uint256 count = n < queuedCount ? n : queuedCount;
        items = new Item[](count);
        uint256 found;
        for (uint256 i = head; i < queue.length && found < count; ++i) {
            Item memory it = queue[i];
            if (queued[it.nft][it.id]) items[found++] = it;
        }
    }

    /// @notice Earliest timestamp the next round may open.
    function nextDrawAt() external view returns (uint256) {
        return lastGiftAt == 0 ? 0 : uint256(lastGiftAt) + interval;
    }

    // --- rounds ---

    /// @notice Open a round for the next queued NFT. The winner is decided by the hash of a
    ///         block `DRAW_DELAY` blocks ahead, which no one knows yet.
    function openRound() external onlyKeeper {
        if (open.nft != address(0)) revert RoundOpen();
        if (lastGiftAt != 0 && block.timestamp < uint256(lastGiftAt) + interval) revert TooSoon();
        Item memory it = _pop();
        ++roundCount;
        open = Round({
            nft: it.nft,
            id: it.id,
            drawBlock: uint64(block.number + DRAW_DELAY),
            openedAt: uint64(block.timestamp)
        });
        emit RoundOpened(roundCount, it.nft, it.id, block.number + DRAW_DELAY);
    }

    /// @notice Settle the open round: derive the winner from the draw block's hash and send
    ///         the NFT to that Broker's wallet. Anyone may call once the draw block is mined.
    ///         If the hash is no longer available (older than 256 blocks) or the tries all
    ///         land on inactive Brokers, the round is re-rolled to a fresh draw block.
    function settle() external nonReentrant {
        Round memory r = open;
        if (r.nft == address(0)) revert NoRound();
        if (block.number <= r.drawBlock) revert DrawBlockNotReached();
        bytes32 hash = blockhash(r.drawBlock);
        if (hash == bytes32(0)) return _reschedule();
        bytes32 seed = keccak256(abi.encode(hash, roundCount, r.nft, r.id));
        uint256 winner;
        for (uint256 i; i < MAX_TRIES; ++i) {
            uint256 candidate = (uint256(keccak256(abi.encode(seed, i))) % supply) + 1;
            if (booster.isActive(candidate)) {
                winner = candidate;
                break;
            }
        }
        if (winner == 0) return _reschedule();
        address wallet = brokers.accountOf(winner);
        delete open;
        lastGiftAt = uint64(block.timestamp);
        IERC721(r.nft).safeTransferFrom(address(this), wallet, r.id);
        emit Gifted(roundCount, winner, r.nft, r.id, wallet, seed);
    }

    /// @notice Put the open round's NFT back at the end of the queue (owner escape hatch).
    function cancelRound() external onlyOwner {
        Round memory r = open;
        if (r.nft == address(0)) revert NoRound();
        delete open;
        queue.push(Item({nft: r.nft, id: r.id}));
        queued[r.nft][r.id] = true;
        ++queuedCount;
        emit RoundCancelled(roundCount);
    }

    // --- admin ---

    /// @notice Return a queued NFT (a mistaken deposit, a partner's request). Never the one in
    ///         the open round: cancel that round first.
    function rescue(address nft, uint256 id, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (open.nft == nft && open.id == id) revert InRound();
        if (!queued[nft][id]) revert NotQueued();
        queued[nft][id] = false;
        --queuedCount;
        IERC721(nft).safeTransferFrom(address(this), to, id);
        emit Rescued(nft, id, to);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setInterval(uint64 interval_) external onlyOwner {
        interval = interval_;
        emit IntervalSet(interval_);
    }

    // --- internals ---

    function _pop() internal returns (Item memory it) {
        while (head < queue.length) {
            it = queue[head++];
            if (queued[it.nft][it.id]) {
                queued[it.nft][it.id] = false;
                --queuedCount;
                return it;
            }
        }
        revert QueueEmpty();
    }

    function _reschedule() internal {
        open.drawBlock = uint64(block.number + DRAW_DELAY);
        emit RoundRescheduled(roundCount, block.number + DRAW_DELAY);
    }
}

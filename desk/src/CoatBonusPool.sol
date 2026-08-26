// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ICoattailBrokerView} from "./interfaces/ICoattailCore.sol";

/// @title CoatBonusPool
/// @notice Collects COAT (Desk mints today, any future partner/campaign flow tomorrow) and
///         distributes it to Brokers that were ACTIVE at distribution time. Payouts land in
///         each Broker's ERC-6551 wallet, so the bonus follows the NFT exactly like salary.
/// @dev Distribution is merkle-round based: the poster snapshots the active set off-chain
///      (Booster.isActive is public and every Activated/Deactivated is evented, so any round
///      is independently reproducible) and posts one root per round. Pull-based claims keep
///      gas flat regardless of how many Brokers a round covers. The pool can never touch the
///      deployed core: it only reads `accountOf` to route payouts.
contract CoatBonusPool is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable coat;
    ICoattailBrokerView public immutable brokers;

    /// @notice Address allowed to post rounds (keeper). Settable — the 36,750 lesson.
    address public poster;

    struct Round {
        bytes32 root; // merkle root over leaves keccak256(bytes.concat(keccak256(abi.encode(tokenId, amount))))
        uint96 total; // COAT allocated to this round (raw units; fits: total supply < 2^96)
        uint96 claimed; // COAT already claimed out of `total`
    }

    Round[] public rounds;
    /// @dev claim bitmap per round: word index => 256 tokenIds per word (collection is 1..1776).
    mapping(uint256 roundId => mapping(uint256 wordIndex => uint256)) private _claimedBitmap;
    /// @notice COAT promised to posted rounds and not yet claimed. `sweep` can never touch it.
    uint256 public outstanding;

    event PosterSet(address poster);
    event RoundPosted(uint256 indexed roundId, bytes32 root, uint256 total);
    event BonusClaimed(uint256 indexed roundId, uint256 indexed tokenId, address to, uint256 amount);
    event Swept(address indexed token, address to, uint256 amount);

    error NotPoster();
    error ZeroAddress();
    error ZeroTotal();
    error InsufficientUnallocated(uint256 want, uint256 have);
    error UnknownRound();
    error AlreadyClaimed();
    error BadProof();
    error RoundOverclaimed();

    constructor(IERC20 coat_, ICoattailBrokerView brokers_, address poster_, address owner_) Ownable(owner_) {
        if (address(coat_) == address(0) || address(brokers_) == address(0) || poster_ == address(0)) {
            revert ZeroAddress();
        }
        coat = coat_;
        brokers = brokers_;
        poster = poster_;
        emit PosterSet(poster_);
    }

    function setPoster(address poster_) external onlyOwner {
        if (poster_ == address(0)) revert ZeroAddress();
        poster = poster_;
        emit PosterSet(poster_);
    }

    /// @notice COAT held by the pool that no posted round has claim to yet.
    function unallocated() public view returns (uint256) {
        return coat.balanceOf(address(this)) - outstanding;
    }

    function roundCount() external view returns (uint256) {
        return rounds.length;
    }

    function isClaimed(uint256 roundId, uint256 tokenId) public view returns (bool) {
        return _claimedBitmap[roundId][tokenId >> 8] & (1 << (tokenId & 0xff)) != 0;
    }

    /// @notice Allocate `total` COAT to a new round under `root`. The funds must already sit
    ///         in the pool — a root can never promise COAT the contract does not hold.
    function postRound(bytes32 root, uint256 total) external returns (uint256 roundId) {
        if (msg.sender != poster) revert NotPoster();
        if (total == 0 || root == bytes32(0)) revert ZeroTotal();
        uint256 free = unallocated();
        if (total > free) revert InsufficientUnallocated(total, free);
        roundId = rounds.length;
        // COAT's entire raw supply (1e27) fits in uint96 (~7.9e28), and `total` can never exceed
        // the pool's real balance, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        rounds.push(Round({root: root, total: uint96(total), claimed: 0}));
        outstanding += total;
        emit RoundPosted(roundId, root, total);
    }

    /// @notice Claim a Broker's share of a round into that Broker's 6551 wallet. Permissionless
    ///         (Booster.claimFor precedent): the caller can neither choose nor redirect the
    ///         destination, so claiming for someone only does them a favor.
    function claim(uint256 roundId, uint256 tokenId, uint256 amount, bytes32[] calldata proof)
        external
        nonReentrant
    {
        _claim(roundId, tokenId, amount, proof);
    }

    /// @notice Keeper-friendly batch. Arrays are index-aligned; the whole batch targets one round.
    function claimMany(
        uint256 roundId,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external nonReentrant {
        for (uint256 i; i < tokenIds.length; ++i) {
            _claim(roundId, tokenIds[i], amounts[i], proofs[i]);
        }
    }

    function _claim(uint256 roundId, uint256 tokenId, uint256 amount, bytes32[] calldata proof) internal {
        if (roundId >= rounds.length) revert UnknownRound();
        if (isClaimed(roundId, tokenId)) revert AlreadyClaimed();
        Round storage round = rounds[roundId];
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(tokenId, amount))));
        if (!MerkleProof.verifyCalldata(proof, round.root, leaf)) revert BadProof();
        // Defense in depth: even a malformed tree cannot pay out more than the round's escrow.
        if (uint256(round.claimed) + amount > uint256(round.total)) revert RoundOverclaimed();

        _claimedBitmap[roundId][tokenId >> 8] |= 1 << (tokenId & 0xff);
        // Bounded by the overclaim check above: claimed + amount <= total <= uint96 max.
        // forge-lint: disable-next-line(unsafe-typecast)
        round.claimed += uint96(amount);
        outstanding -= amount;

        address to = brokers.accountOf(tokenId); // reverts for nonexistent Brokers
        coat.safeTransfer(to, amount);
        emit BonusClaimed(roundId, tokenId, to, amount);
    }

    /// @notice Recover tokens that are NOT owed to any round: stray airdrops fully, COAT only
    ///         above `outstanding`. Mirrors Booster.sweepToken's conservation rule.
    function sweep(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 amount = token == address(coat) ? bal - outstanding : bal;
        if (amount == 0) return;
        IERC20(token).safeTransfer(to, amount);
        emit Swept(token, to, amount);
    }
}

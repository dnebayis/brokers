// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Currency} from "./v4/V4Types.sol";

interface IV4PositionManagerLocker {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function ownerOf(uint256 tokenId) external view returns (address);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

interface IV4StateViewLocker {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

/// @title PermanentV4LiquidityLocker
/// @notice Irrevocably owns one v4 LP NFT. There is deliberately no principal withdrawal,
///         approval, arbitrary-call, ownership or NFT-transfer function. Anyone may crystallize
///         and forward trading fees to the immutable project treasury.
contract PermanentV4LiquidityLocker is IERC721Receiver {
    IV4PositionManagerLocker public immutable positionManager;
    IV4StateViewLocker public immutable stateView;
    address payable public immutable treasury;
    uint256 public immutable tokenId;
    bytes32 public immutable poolId;
    Currency public immutable currency0;
    Currency public immutable currency1;
    uint128 public immutable lockedLiquidity;
    uint160 public immutable sqrtPriceLowerX96;
    uint160 public immutable sqrtPriceUpperX96;

    uint256 public constant GRADUATION_PRINCIPAL = 4.2 ether;
    uint8 private constant DECREASE_LIQUIDITY = 0x01;
    uint8 private constant TAKE_PAIR = 0x11;

    error InvalidConfiguration();
    error PositionNotLocked();
    error PrincipalChanged();

    event FeesCollected(address indexed caller, address indexed treasury);

    constructor(
        IV4PositionManagerLocker positionManager_,
        IV4StateViewLocker stateView_,
        address payable treasury_,
        uint256 tokenId_,
        bytes32 poolId_,
        Currency currency0_,
        Currency currency1_,
        uint128 liquidity_,
        uint160 sqrtLowerX96_,
        uint160 sqrtUpperX96_
    ) {
        if (
            address(positionManager_) == address(0) || address(stateView_) == address(0)
                || treasury_ == address(0) || liquidity_ == 0 || sqrtLowerX96_ >= sqrtUpperX96_
        ) revert InvalidConfiguration();
        positionManager = positionManager_;
        stateView = stateView_;
        treasury = treasury_;
        tokenId = tokenId_;
        poolId = poolId_;
        currency0 = currency0_;
        currency1 = currency1_;
        lockedLiquidity = liquidity_;
        sqrtPriceLowerX96 = sqrtLowerX96_;
        sqrtPriceUpperX96 = sqrtUpperX96_;
    }

    /// @notice Collects fees with a zero-liquidity decrease, then sends both currencies
    ///         straight from PositionManager to treasury. Principal liquidity is unchanged.
    function collectFees() external {
        if (positionManager.ownerOf(tokenId) != address(this)) revert PositionNotLocked();
        uint128 beforeLiquidity = positionManager.getPositionLiquidity(tokenId);
        if (beforeLiquidity != lockedLiquidity) revert PrincipalChanged();

        bytes memory actions = abi.encodePacked(DECREASE_LIQUIDITY, TAKE_PAIR);
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(currency0, currency1, treasury);
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        if (positionManager.getPositionLiquidity(tokenId) != beforeLiquidity) revert PrincipalChanged();
        emit FeesCollected(msg.sender, treasury);
    }

    /// @notice ETH principal currently paired by this immutable position. Fees and direct
    ///         PoolManager donations are excluded because this derives only from L and spot sqrtP.
    function pairedPrincipal() public view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = stateView.getSlot0(poolId);
        uint160 a = sqrtPriceLowerX96;
        uint160 b = sqrtPriceUpperX96;
        if (sqrtPriceX96 >= b) return 0;
        if (sqrtPriceX96 > a) a = sqrtPriceX96;

        // SqrtPriceMath.getAmount0Delta(a,b,L,false), with full-precision mulDiv.
        uint256 numerator = uint256(lockedLiquidity) << 96;
        return Math.mulDiv(numerator, uint256(b) - a, b) / a;
    }

    function graduated() external view returns (bool) {
        return pairedPrincipal() >= GRADUATION_PRINCIPAL;
    }

    function onERC721Received(address, address, uint256 receivedId, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != address(positionManager) || receivedId != tokenId) revert PositionNotLocked();
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}
}

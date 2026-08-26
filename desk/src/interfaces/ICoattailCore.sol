// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read-only views of the DEPLOYED Coattail core. The Desk system never calls a
///         state-changing function on the core and the core is never modified for the Desk.
interface IBoosterView {
    function isActive(uint256 tokenId) external view returns (bool);
    function activeShares() external view returns (uint256);
}

interface ICoattailBrokerView {
    function ownerOf(uint256 tokenId) external view returns (address);
    function accountOf(uint256 tokenId) external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
}

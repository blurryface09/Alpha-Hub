// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AlphaHub test contract — open mint, no access control, no imports.
/// mint(uint256 quantity) succeeds for any caller, free (value=0).
contract TestMintNFT {
    string public name   = "AlphaHub Test NFT";
    string public symbol = "AHTEST";

    uint256 private _nextId = 1;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function mint(uint256 quantity) external payable {
        require(quantity > 0 && quantity <= 10, "qty 1-10");
        for (uint256 i = 0; i < quantity; i++) {
            uint256 id = _nextId++;
            _owners[id] = msg.sender;
            _balances[msg.sender]++;
            emit Transfer(address(0), msg.sender, id);
        }
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "nonexistent");
        return owner;
    }

    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "zero addr");
        return _balances[owner];
    }

    function totalSupply() external view returns (uint256) {
        return _nextId - 1;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd  // ERC721
            || interfaceId == 0x01ffc9a7; // ERC165
    }
}

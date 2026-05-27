// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * AlphaHubValidationNFT
 *
 * Permanent testing collection for Alpha Hub end-to-end validation.
 * Self-contained ERC-721 — no external imports required.
 *
 * Modes supported:
 *   Free mint    — mintPrice = 0, mintActive = true
 *   Paid mint    — mintPrice > 0, mintActive = true
 *   Delayed start — startTime > block.timestamp, mintActive = true
 *   FCFS          — maxSupply > 0, first-come-first-served until sold out
 *
 * Admin functions (owner only):
 *   setMintPrice(uint256)
 *   setMintActive(bool)
 *   setStartTime(uint256)    — 0 = no restriction
 *   setEndTime(uint256)      — 0 = no restriction
 *   setMaxSupply(uint256)    — 0 = unlimited
 *   setMaxPerWallet(uint256) — 0 = unlimited
 *   withdraw()
 *   transferOwnership(address)
 *
 * Strike-compatible:
 *   mint(uint256 quantity)   — payable, matches AlphaHub prewarm selector 0xa0712d68
 */
contract AlphaHubValidationNFT {

    // ─── ERC-721 state ────────────────────────────────────────────────────────

    string public name;
    string public symbol;

    uint256 private _nextId = 1;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    // ─── Mint config ──────────────────────────────────────────────────────────

    address public owner;
    bool    public mintActive;
    uint256 public mintPrice;       // wei per token
    uint256 public startTime;       // unix timestamp; 0 = no restriction
    uint256 public endTime;         // unix timestamp; 0 = no restriction
    uint256 public maxSupply;       // 0 = unlimited
    uint256 public maxPerWallet;    // 0 = unlimited
    uint256 public maxPerTx = 20;   // hard cap per single mint call

    // ─── Events ───────────────────────────────────────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner_, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner_, address indexed operator, bool approved);
    event MintConfigUpdated(uint256 mintPrice, bool mintActive, uint256 startTime, uint256 endTime, uint256 maxSupply);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Withdrawn(address indexed to, uint256 amount);

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(
        string memory _name,
        string memory _symbol,
        uint256 _mintPrice,
        uint256 _maxSupply,
        uint256 _startTime
    ) {
        name        = _name;
        symbol      = _symbol;
        owner       = msg.sender;
        mintPrice   = _mintPrice;
        maxSupply   = _maxSupply;
        startTime   = _startTime;
        mintActive  = false;  // explicitly activate after deployment
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    // ─── Core mint ────────────────────────────────────────────────────────────

    /**
     * @notice Mint `quantity` tokens to the caller.
     * @dev    Selector: 0xa0712d68 — matches AlphaHub Strike prewarm fast-path.
     */
    function mint(uint256 quantity) external payable {
        require(mintActive,                              "mint not active");
        require(quantity > 0 && quantity <= maxPerTx,   "qty 1-20");
        require(startTime == 0 || block.timestamp >= startTime, "not started");
        require(endTime   == 0 || block.timestamp <= endTime,   "mint ended");
        require(msg.value == mintPrice * quantity,       "wrong ETH");

        if (maxSupply > 0) {
            require(_nextId - 1 + quantity <= maxSupply, "supply exhausted");
        }
        if (maxPerWallet > 0) {
            require(_balances[msg.sender] + quantity <= maxPerWallet, "wallet limit");
        }

        for (uint256 i = 0; i < quantity; i++) {
            uint256 id = _nextId++;
            _owners[id]  = msg.sender;
            _balances[msg.sender]++;
            emit Transfer(address(0), msg.sender, id);
        }
    }

    // ─── ERC-721 view ─────────────────────────────────────────────────────────

    function totalSupply() external view returns (uint256) {
        return _nextId - 1;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _owners[tokenId];
        require(o != address(0), "nonexistent");
        return o;
    }

    function balanceOf(address account) external view returns (uint256) {
        require(account != address(0), "zero addr");
        return _balances[account];
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        require(_owners[tokenId] != address(0), "nonexistent");
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address owner_, address operator) external view returns (bool) {
        return _operatorApprovals[owner_][operator];
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd   // ERC721
            || interfaceId == 0x5b5e139f   // ERC721Metadata
            || interfaceId == 0x01ffc9a7;  // ERC165
    }

    // ─── ERC-721 write ────────────────────────────────────────────────────────

    function approve(address to, uint256 tokenId) external {
        address tokenOwner = _owners[tokenId];
        require(msg.sender == tokenOwner || _operatorApprovals[tokenOwner][msg.sender], "not authorised");
        _tokenApprovals[tokenId] = to;
        emit Approval(tokenOwner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata) external {
        _transfer(from, to, tokenId);
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        require(_owners[tokenId] == from, "wrong owner");
        require(
            msg.sender == from ||
            msg.sender == _tokenApprovals[tokenId] ||
            _operatorApprovals[from][msg.sender],
            "not authorised"
        );
        require(to != address(0), "zero addr");
        delete _tokenApprovals[tokenId];
        _balances[from]--;
        _balances[to]++;
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setMintActive(bool active) external onlyOwner {
        mintActive = active;
        emit MintConfigUpdated(mintPrice, mintActive, startTime, endTime, maxSupply);
    }

    function setMintPrice(uint256 price) external onlyOwner {
        mintPrice = price;
        emit MintConfigUpdated(mintPrice, mintActive, startTime, endTime, maxSupply);
    }

    function setStartTime(uint256 ts) external onlyOwner {
        startTime = ts;
        emit MintConfigUpdated(mintPrice, mintActive, startTime, endTime, maxSupply);
    }

    function setEndTime(uint256 ts) external onlyOwner {
        endTime = ts;
        emit MintConfigUpdated(mintPrice, mintActive, startTime, endTime, maxSupply);
    }

    function setMaxSupply(uint256 supply) external onlyOwner {
        require(supply == 0 || supply >= _nextId - 1, "below current supply");
        maxSupply = supply;
        emit MintConfigUpdated(mintPrice, mintActive, startTime, endTime, maxSupply);
    }

    function setMaxPerWallet(uint256 limit) external onlyOwner {
        maxPerWallet = limit;
    }

    function setMaxPerTx(uint256 limit) external onlyOwner {
        require(limit > 0 && limit <= 100, "1-100");
        maxPerTx = limit;
    }

    function withdraw() external onlyOwner {
        uint256 bal = address(this).balance;
        require(bal > 0, "nothing to withdraw");
        (bool ok, ) = payable(owner).call{value: bal}("");
        require(ok, "transfer failed");
        emit Withdrawn(owner, bal);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero addr");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ─── Convenience read ─────────────────────────────────────────────────────

    /**
     * @notice Return the full mint configuration in one call.
     */
    function mintConfig() external view returns (
        bool   active,
        uint256 price,
        uint256 start,
        uint256 end,
        uint256 supply,
        uint256 minted,
        uint256 perWallet,
        uint256 perTx
    ) {
        return (mintActive, mintPrice, startTime, endTime, maxSupply, _nextId - 1, maxPerWallet, maxPerTx);
    }
}

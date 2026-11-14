// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.28;

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title SELEN Bridge, Robinhood Chain side
/// @notice Tokens locked here are paid out on the SELEN chain as sealed outputs. Tokens leave this contract only
/// when the operator releases them against a transfer made on the SELEN chain, at most once per SELEN reference,
/// within a per-token daily limit. The owner manages settings but has no path to locked funds: it can only sweep
/// what sits above the locked total (rounding dust, tokens sent here by mistake).
contract SelenBridge {
    struct Token {
        bool enabled; //      new locks accepted (releases always work for a known token)
        uint8 asset; //       asset id on the SELEN chain
        uint64 unit; //       token amount equal to one atomic unit on the SELEN chain (1e10 for 18 → 8 decimals)
        uint128 cap; //       most that may sit locked at once
        uint128 locked; //    locked now, owed to holders on the SELEN chain
        uint128 dailyLimit; // most the operator may release per 24 h window
        uint128 windowReleased;
        uint64 windowStart;
    }

    address public owner;
    address public pendingOwner;
    address public operator;
    bool public paused;
    uint256 public lockCount;
    mapping(address => Token) public tokens;
    /// SELEN-side reference (transfer id + output) already paid out on this chain
    mapping(bytes32 => bool) public released;

    uint256 private _entered = 1;

    event Locked(uint256 indexed id, address indexed token, address indexed from, uint256 amount, bytes32 dest);
    event Released(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount);
    event TokenSet(address indexed token, bool enabled, uint8 asset, uint64 unit, uint128 cap, uint128 dailyLimit);
    event OperatorSet(address indexed operator);
    event PausedSet(bool paused);
    event SurplusSwept(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotOperator();
    error IsPaused();
    error Reentrancy();
    error BadToken();
    error MappingFixed();
    error TokenOff();
    error NoDestination();
    error BelowOneUnit();
    error CapReached();
    error AlreadyReleased();
    error BadAmount();
    error MoreThanLocked();
    error DailyLimit();
    error TransferFailed();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor(address operator_) {
        if (operator_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        operator = operator_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit OperatorSet(operator_);
    }

    // ---------------------------------------------------------------- holders

    /// @notice Lock `amount` of `token` to receive it on the SELEN chain. `dest` is sha256 of the receiving SELEN
    /// address, registered with the bridge service. The amount credited is what actually arrived, rounded down to
    /// whole SELEN-chain units; the remainder stays here as surplus.
    function lock(address token, uint256 amount, bytes32 dest) external nonReentrant whenNotPaused returns (uint256 id) {
        Token storage t = tokens[token];
        if (!t.enabled) revert TokenOff();
        if (dest == bytes32(0)) revert NoDestination();
        uint256 before = IERC20Min(token).balanceOf(address(this));
        _call(token, abi.encodeWithSelector(IERC20Min.transferFrom.selector, msg.sender, address(this), amount));
        uint256 got = IERC20Min(token).balanceOf(address(this)) - before;
        got -= got % t.unit;
        if (got == 0) revert BelowOneUnit();
        if (uint256(t.locked) + got > t.cap) revert CapReached();
        t.locked += uint128(got);
        id = ++lockCount;
        emit Locked(id, token, msg.sender, got, dest);
    }

    // ---------------------------------------------------------------- operator

    /// @notice Pay `amount` of `token` to `to` for the SELEN-chain transfer identified by `ref`.
    function release(address token, address to, uint256 amount, bytes32 ref) external onlyOperator nonReentrant whenNotPaused {
        Token storage t = tokens[token];
        if (t.unit == 0) revert BadToken();
        if (to == address(0)) revert ZeroAddress();
        if (released[ref]) revert AlreadyReleased();
        if (amount == 0 || amount % t.unit != 0) revert BadAmount();
        if (amount > t.locked) revert MoreThanLocked();
        if (block.timestamp >= uint256(t.windowStart) + 1 days) {
            t.windowStart = uint64(block.timestamp);
            t.windowReleased = 0;
        }
        if (uint256(t.windowReleased) + amount > t.dailyLimit) revert DailyLimit();
        t.windowReleased += uint128(amount);
        released[ref] = true;
        t.locked -= uint128(amount);
        _call(token, abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount));
        emit Released(ref, token, to, amount);
    }

    // ---------------------------------------------------------------- owner

    /// @notice Add or update a token. Its SELEN asset id and unit are fixed the first time; cap, daily limit and
    /// whether new locks are accepted can change later.
    function setToken(address token, bool enabled, uint8 asset, uint64 unit, uint128 cap, uint128 dailyLimit) external onlyOwner {
        if (token.code.length == 0 || unit == 0) revert BadToken();
        Token storage t = tokens[token];
        if (t.unit != 0 && (t.unit != unit || t.asset != asset)) revert MappingFixed();
        t.enabled = enabled;
        t.asset = asset;
        t.unit = unit;
        t.cap = cap;
        t.dailyLimit = dailyLimit;
        emit TokenSet(token, enabled, asset, unit, cap, dailyLimit);
    }

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Send out what sits above the locked total. Locked funds cannot be swept.
    function sweepSurplus(address token, address to) external onlyOwner nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = IERC20Min(token).balanceOf(address(this)) - tokens[token].locked;
        if (amount > 0) _call(token, abi.encodeWithSelector(IERC20Min.transfer.selector, to, amount));
        emit SurplusSwept(token, to, amount);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---------------------------------------------------------------- views

    function tokenInfo(address token) external view returns (Token memory) {
        return tokens[token];
    }

    // ---------------------------------------------------------------- internal

    /// ERC-20 call that accepts tokens returning nothing or true, and rejects false or a revert.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}

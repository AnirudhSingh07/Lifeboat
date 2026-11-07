// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LifeboatPQ} from "./crypto/LifeboatPQ.sol";
import {IWorldIDGate} from "./interfaces/IWorldIDGate.sol";

/// @title LifeboatVault
/// @notice A quantum-veto vault. The everyday ECDSA "hot key" can only *start* a
///         timelocked withdrawal. A post-quantum (WOTS+/XMSS) key can veto a pending
///         withdrawal, move funds instantly, revoke the hot key, or rotate the PQ root.
///         A quantum attacker who recovers the ECDSA key can start a drain but can
///         never complete one before the PQ key cancels it.
/// @dev Local-first: funds are native ETH; the World ID gate and alt-mempool submission
///      are external adapters so the core logic runs on any EVM (Anvil/devnet).
contract LifeboatVault {
    using LifeboatPQ for bytes32;

    // ----------------------------- action tags ------------------------------
    // Mirrored in packages/pq-signer/src/digest.ts and SPEC §5.
    uint8 internal constant ACTION_REQUEST = 0; // ECDSA hot key
    uint8 internal constant ACTION_VETO = 1; // PQ
    uint8 internal constant ACTION_INSTANT_MOVE = 2; // PQ
    uint8 internal constant ACTION_REVOKE_HOT = 3; // PQ
    uint8 internal constant ACTION_ROTATE_ROOT = 4; // PQ + World ID
    uint8 internal constant ACTION_EXECUTE = 5; // PQ (generic call)

    bytes32 public immutable DOMAIN;

    // ------------------------------- storage ---------------------------------
    address public hotKey; // ECDSA key; address(0) once revoked
    bytes32 public pqRoot; // XMSS Merkle root of the PQ one-time keys
    bytes32 public pqPubSeed; // public seed used by the WOTS+ chaining
    uint64 public timelock; // seconds a withdrawal stays pending
    uint32 public pqEpoch; // bumped on rotation; namespaces used leaves
    uint256 public hotNonce; // replay protection for ECDSA requests
    uint256 public withdrawalCount; // id source
    IWorldIDGate public worldIdGate; // human-recovery factor for rotation

    struct Pending {
        address to;
        uint256 amount;
        uint64 unlockTime; // 0 == does not exist
        bool vetoed;
    }

    mapping(uint256 => Pending) private _pending;
    // (epoch, leafIndex) => used. One-time keys must never be reused.
    mapping(uint256 => bool) private _usedLeaf;

    // ---- risk-based spend policy (set only by the strong key via self-call) ----
    // Sends to an allowlisted destination, or within the rolling daily limit, skip the
    // timelock and execute instantly. Everything else is timelocked + vetoable. This makes
    // the vault a drain-resistant everyday wallet, not just a quantum safe.
    mapping(address => bool) public allowlist;
    uint256 public dailyLimit; // 0 == no instant allowance
    uint256 public windowStart; // start of the current 24h window
    uint256 public spentInWindow; // instant spend used in the current window

    // ---- pluggable guardian (M-of-N ECDSA): hardware wallet = 1-of-1, social = M-of-N ----
    // A second "strong" path alongside the PQ key. Guardians authorize veto/execute with a
    // threshold of ECDSA signatures, so the strong role can be a Ledger, a phone, or friends.
    mapping(address => bool) public isGuardian;
    uint256 public guardianCount;
    uint256 public guardianThreshold; // 0 == guardian path disabled
    uint256 public guardianNonce; // replay protection for guardian quorums

    // ---- inheritance / dead-man's switch ----
    uint256 public lastActivity; // bumped on any owner/hot/strong-key action
    address public beneficiary; // who may claim after prolonged inactivity
    uint256 public inactivityPeriod; // 0 == inheritance disabled
    uint256 public inheritanceUnlock; // 0 == no active claim; else grace deadline

    // ---- emergency freeze (delay-only; safe to automate) ----
    bool public frozen; // while true, no funds can leave the hot path
    address public freezer; // low-power role: may ONLY freeze, never unfreeze or move

    uint256 private _reentry = 1;

    // -------------------------------- events ----------------------------------
    event WithdrawalRequested(
        uint256 indexed id, address indexed to, uint256 amount, uint64 unlockTime
    );
    event WithdrawalExecuted(uint256 indexed id, address indexed to, uint256 amount);
    event InstantWithdrawal(address indexed to, uint256 amount); // hot key, within policy
    event AllowlistSet(address indexed dest, bool allowed);
    event DailyLimitSet(uint256 limit);
    event WithdrawalVetoed(uint256 indexed id, uint32 leafIndex);
    event InstantMove(address indexed to, uint256 amount, uint32 leafIndex);
    event HotKeyRevoked(uint32 leafIndex);
    event PQRootRotated(bytes32 newRoot, bytes32 newPubSeed, uint32 newEpoch, uint32 leafIndex);
    event Executed(address indexed target, uint256 value, uint32 leafIndex);
    event GuardianAdded(address indexed guardian);
    event GuardianRemoved(address indexed guardian);
    event GuardianThresholdSet(uint256 threshold);
    event GuardianVetoed(uint256 indexed id);
    event GuardianExecuted(address indexed target, uint256 value);
    event HotKeySet(address indexed newHotKey);
    event InheritanceConfigured(address indexed beneficiary, uint256 inactivityPeriod);
    event InheritanceClaimStarted(uint256 unlockTime);
    event InheritanceClaimed(address indexed beneficiary, uint256 amount);
    event InheritanceCancelled();
    event Heartbeat(uint256 at);
    event FreezeSet(bool frozen, address indexed by);
    event FreezerSet(address indexed freezer);
    event Deposited(address indexed from, uint256 amount);

    // -------------------------------- errors ----------------------------------
    error HotKeyRevokedError();
    error BadECDSASignature();
    error ZeroAmount();
    error NotPending();
    error AlreadyVetoed();
    error TimelockNotElapsed();
    error LeafAlreadyUsed();
    error BadPQSignature();
    error TransferFailed();
    error ExecFailed(bytes returndata);
    error Reentrancy();
    error NotSelf();
    error GuardianPathDisabled();
    error BadGuardianQuorum();
    error InheritanceDisabled();
    error NotBeneficiary();
    error StillActive();
    error ClaimNotStarted();
    error ClaimAlreadyPending();
    error GraceNotElapsed();
    error VaultFrozen();
    error NotFreezer();

    modifier nonReentrant() {
        if (_reentry != 1) revert Reentrancy();
        _reentry = 2;
        _;
        _reentry = 1;
    }

    /// @dev Only the vault calling itself — i.e. reachable only through a strong-key path
    ///      (pqExecute or guardianExecute). The hot key can never change the policy.
    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    constructor(
        address _hotKey,
        bytes32 _pqRoot,
        bytes32 _pqPubSeed,
        uint64 _timelock,
        IWorldIDGate _worldIdGate
    ) {
        hotKey = _hotKey;
        pqRoot = _pqRoot;
        pqPubSeed = _pqPubSeed;
        timelock = _timelock;
        worldIdGate = _worldIdGate;
        lastActivity = block.timestamp;
        DOMAIN = keccak256(abi.encodePacked("LIFEBOAT_VAULT_V1", block.chainid, address(this)));
    }

    function _bumpActivity() internal {
        lastActivity = block.timestamp;
        // any owner/strong-key activity is a heartbeat: it cancels a pending inheritance claim
        if (inheritanceUnlock != 0) {
            inheritanceUnlock = 0;
            emit InheritanceCancelled();
        }
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    // ===================================================================
    //  Hot-key (ECDSA) path — can ONLY start a timelocked withdrawal
    // ===================================================================

    /// @notice Start a withdrawal with the ECDSA hot key. If the destination is allowlisted
    ///         or the amount fits the rolling daily limit, it executes INSTANTLY (returns
    ///         id 0); otherwise it enters a timelocked, vetoable pending state. Either way
    ///         the policy that permits instant sends is set only by the strong key, so a
    ///         quantum attacker (or a drainer) is capped to the allowance the owner chose.
    function requestWithdrawal(address to, uint256 amount, bytes calldata ecdsaSig)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (hotKey == address(0)) revert HotKeyRevokedError();
        if (amount == 0) revert ZeroAmount();

        // Authorize either by a direct call from the hot key (real wallet, e.g. MetaMask)
        // or by a relayed ECDSA signature (attacker demo / meta-tx). The sig path uses a
        // raw digest, so the hot key can relay without a browser wallet's EIP-191 prefix.
        if (msg.sender != hotKey) {
            bytes32 digest = _requestDigest(to, amount, hotNonce);
            if (_recover(digest, ecdsaSig) != hotKey) revert BadECDSASignature();
        }
        unchecked {
            hotNonce++;
        }
        _bumpActivity();

        if (!frozen && _consumeInstantAllowance(to, amount)) {
            emit InstantWithdrawal(to, amount);
            _send(to, amount);
            return 0;
        }

        id = ++withdrawalCount;
        uint64 unlockTime = uint64(block.timestamp) + timelock;
        _pending[id] = Pending({to: to, amount: amount, unlockTime: unlockTime, vetoed: false});
        emit WithdrawalRequested(id, to, amount, unlockTime);
    }

    /// @dev Returns true (and books the spend) if `to`/`amount` qualify for an instant send.
    function _consumeInstantAllowance(address to, uint256 amount) internal returns (bool) {
        if (allowlist[to]) return true;
        if (dailyLimit == 0) return false;
        uint256 ws = windowStart;
        uint256 spent = spentInWindow;
        if (block.timestamp >= ws + 1 days) {
            ws = block.timestamp;
            spent = 0;
        }
        if (spent + amount > dailyLimit) return false;
        windowStart = ws;
        spentInWindow = spent + amount;
        return true;
    }

    // ---- policy management: strong-key only (via pqExecute / guardianExecute → self) ----

    function setAllowed(address dest, bool allowed) external onlySelf {
        allowlist[dest] = allowed;
        emit AllowlistSet(dest, allowed);
    }

    function setDailyLimit(uint256 limit) external onlySelf {
        dailyLimit = limit;
        emit DailyLimitSet(limit);
    }

    /// @notice Complete a withdrawal after its timelock. Callable by anyone (no key
    ///         needed) — the timelock, not the caller, is the gate.
    function executeWithdrawal(uint256 id) external nonReentrant {
        if (frozen) revert VaultFrozen();
        Pending storage p = _pending[id];
        if (p.unlockTime == 0) revert NotPending();
        if (p.vetoed) revert AlreadyVetoed();
        if (block.timestamp < p.unlockTime) revert TimelockNotElapsed();

        address to = p.to;
        uint256 amount = p.amount;
        delete _pending[id];
        emit WithdrawalExecuted(id, to, amount);
        _send(to, amount);
    }

    // ===================================================================
    //  Post-quantum path — veto / instant move / revoke / rotate
    // ===================================================================

    /// @notice Cancel a pending withdrawal with a PQ signature.
    function veto(uint256 id, LifeboatPQ.PQSig calldata s) external {
        bytes32 paramsHash = keccak256(abi.encode(id));
        _consumePQ(ACTION_VETO, paramsHash, s);

        Pending storage p = _pending[id];
        if (p.unlockTime == 0) revert NotPending();
        if (p.vetoed) revert AlreadyVetoed();
        p.vetoed = true;
        emit WithdrawalVetoed(id, s.leafIndex);
    }

    /// @notice Move funds immediately with a PQ signature (no timelock).
    function instantMove(address to, uint256 amount, LifeboatPQ.PQSig calldata s)
        external
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        bytes32 paramsHash = keccak256(abi.encode(to, amount));
        _consumePQ(ACTION_INSTANT_MOVE, paramsHash, s);
        emit InstantMove(to, amount, s.leafIndex);
        _send(to, amount);
    }

    /// @notice "Cut the cord": permanently disable the ECDSA hot key with a PQ signature.
    function revokeHotKey(LifeboatPQ.PQSig calldata s) external {
        _consumePQ(ACTION_REVOKE_HOT, bytes32(0), s);
        hotKey = address(0);
        emit HotKeyRevoked(s.leafIndex);
    }

    /// @notice Rotate to a fresh PQ tree. Gated by a PQ signature AND a World ID human
    ///         check (never World ID alone). Bumps the epoch so new leaves start unused.
    function rotatePQRoot(
        bytes32 newRoot,
        bytes32 newPubSeed,
        LifeboatPQ.PQSig calldata s,
        bytes calldata worldIdProof
    ) external {
        bytes32 paramsHash = keccak256(abi.encode(newRoot, newPubSeed));
        _consumePQ(ACTION_ROTATE_ROOT, paramsHash, s);

        // Human-recovery factor. Reverts on an invalid/expired proof (failure path).
        worldIdGate.check(address(this), paramsHash, worldIdProof);

        pqRoot = newRoot;
        pqPubSeed = newPubSeed;
        unchecked {
            pqEpoch++;
        }
        emit PQRootRotated(newRoot, newPubSeed, pqEpoch, s.leafIndex);
    }

    /// @notice Make an arbitrary call from the vault, authorized by a PQ signature.
    ///         This makes the vault a post-quantum-controlled smart account — e.g. it can
    ///         hold and exercise ENSv2 roles (set the resolver, transfer the name) so a
    ///         quantum attacker with the ECDSA key can never repoint your name.
    function pqExecute(address target, uint256 value, bytes calldata data, LifeboatPQ.PQSig calldata s)
        external
        nonReentrant
        returns (bytes memory)
    {
        bytes32 paramsHash = keccak256(abi.encode(target, value, keccak256(data)));
        _consumePQ(ACTION_EXECUTE, paramsHash, s);
        emit Executed(target, value, s.leafIndex);
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert ExecFailed(ret);
        return ret;
    }

    // ===================================================================
    //  Inheritance / dead-man's switch
    // ===================================================================

    /// @notice Keep the account "alive" so no inheritance claim can mature. Callable by the
    ///         hot key; any strong-key action is also a heartbeat.
    function heartbeat() external {
        if (msg.sender != hotKey) revert BadECDSASignature();
        _bumpActivity();
        emit Heartbeat(block.timestamp);
    }

    /// @notice Beneficiary opens a claim once the account has been inactive for the full
    ///         period. A grace timelock follows, during which any owner activity cancels it.
    function startInheritanceClaim() external {
        if (beneficiary == address(0) || inactivityPeriod == 0) revert InheritanceDisabled();
        if (msg.sender != beneficiary) revert NotBeneficiary();
        if (block.timestamp < lastActivity + inactivityPeriod) revert StillActive();
        if (inheritanceUnlock != 0) revert ClaimAlreadyPending();
        inheritanceUnlock = block.timestamp + timelock;
        emit InheritanceClaimStarted(inheritanceUnlock);
    }

    /// @notice After the grace timelock (and still inactive), the beneficiary sweeps the vault.
    function claimInheritance() external nonReentrant {
        if (msg.sender != beneficiary) revert NotBeneficiary();
        if (inheritanceUnlock == 0) revert ClaimNotStarted();
        if (block.timestamp < inheritanceUnlock) revert GraceNotElapsed();
        if (block.timestamp < lastActivity + inactivityPeriod) revert StillActive();
        inheritanceUnlock = 0;
        uint256 amount = address(this).balance;
        emit InheritanceClaimed(beneficiary, amount);
        _send(beneficiary, amount);
    }

    function setBeneficiary(address who) external onlySelf {
        beneficiary = who;
        emit InheritanceConfigured(who, inactivityPeriod);
    }

    function setInactivityPeriod(uint256 period) external onlySelf {
        inactivityPeriod = period;
        emit InheritanceConfigured(beneficiary, period);
    }

    // ===================================================================
    //  Guardian (M-of-N ECDSA) path — a pluggable "strong" authority
    // ===================================================================

    /// @notice Cancel a pending withdrawal with a threshold of guardian signatures.
    function guardianVeto(uint256 id, bytes[] calldata sigs) external {
        _verifyGuardianQuorum(_guardianDigest(ACTION_VETO, keccak256(abi.encode(id))), sigs);
        Pending storage p = _pending[id];
        if (p.unlockTime == 0) revert NotPending();
        if (p.vetoed) revert AlreadyVetoed();
        p.vetoed = true;
        emit GuardianVetoed(id);
    }

    /// @notice Arbitrary call authorized by a guardian quorum. Covers moving funds
    ///         (target=recipient, data=""), changing policy, setting the hot key, etc.
    function guardianExecute(address target, uint256 value, bytes calldata data, bytes[] calldata sigs)
        external
        nonReentrant
        returns (bytes memory)
    {
        bytes32 paramsHash = keccak256(abi.encode(target, value, keccak256(data)));
        _verifyGuardianQuorum(_guardianDigest(ACTION_EXECUTE, paramsHash), sigs);
        emit GuardianExecuted(target, value);
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert ExecFailed(ret);
        return ret;
    }

    // ---- management setters: strong-key only (reached via pqExecute / guardianExecute) ----

    function addGuardian(address g) external onlySelf {
        if (!isGuardian[g]) {
            isGuardian[g] = true;
            guardianCount++;
            emit GuardianAdded(g);
        }
    }

    function removeGuardian(address g) external onlySelf {
        if (isGuardian[g]) {
            isGuardian[g] = false;
            guardianCount--;
            emit GuardianRemoved(g);
        }
    }

    function setGuardianThreshold(uint256 t) external onlySelf {
        guardianThreshold = t;
        emit GuardianThresholdSet(t);
    }

    /// @notice Set or clear the ECDSA hot key (revoke = set to address(0)).
    function setHotKey(address newHotKey) external onlySelf {
        hotKey = newHotKey;
        emit HotKeySet(newHotKey);
    }

    // ---- emergency freeze: anyone with the freezer role (or a strong key) can PAUSE
    //      all hot-path outflow; it can never move funds, so it is safe to automate. ----

    function freeze() external {
        if (msg.sender != freezer && msg.sender != address(this)) revert NotFreezer();
        frozen = true;
        emit FreezeSet(true, msg.sender);
    }

    /// @notice Lift the freeze. Strong-key only (via pqExecute / guardianExecute).
    function unfreeze() external onlySelf {
        frozen = false;
        emit FreezeSet(false, msg.sender);
    }

    /// @notice Designate the low-power freezer address (e.g. an always-on watcher bot).
    function setFreezer(address who) external onlySelf {
        freezer = who;
        emit FreezerSet(who);
    }

    // ===================================================================
    //  Views
    // ===================================================================

    function pending(uint256 id)
        external
        view
        returns (address to, uint256 amount, uint64 unlockTime, bool vetoed)
    {
        Pending storage p = _pending[id];
        return (p.to, p.amount, p.unlockTime, p.vetoed);
    }

    function isLeafUsed(uint32 epoch, uint32 leafIndex) public view returns (bool) {
        return _usedLeaf[_leafKey(epoch, leafIndex)];
    }

    /// @notice Digest the hot key must ECDSA-sign to request a withdrawal.
    function requestDigest(address to, uint256 amount, uint256 nonce)
        external
        view
        returns (bytes32)
    {
        return _requestDigest(to, amount, nonce);
    }

    /// @notice Digest a PQ action must be signed over (SPEC §5). Lets the signer/frontend
    ///         reproduce exactly what the vault will check.
    function pqDigest(uint8 actionType, bytes32 paramsHash, uint32 leafIndex)
        external
        view
        returns (bytes32)
    {
        return _pqDigest(actionType, paramsHash, leafIndex);
    }

    /// @notice Digest a guardian quorum must sign (uses the current guardianNonce).
    function guardianDigest(uint8 actionType, bytes32 paramsHash)
        external
        view
        returns (bytes32)
    {
        return _guardianDigest(actionType, paramsHash);
    }

    // ===================================================================
    //  Internal
    // ===================================================================

    /// @dev Verify + consume a one-time PQ signature for `actionType`.
    function _consumePQ(uint8 actionType, bytes32 paramsHash, LifeboatPQ.PQSig calldata s)
        internal
    {
        uint256 key = _leafKey(pqEpoch, s.leafIndex);
        if (_usedLeaf[key]) revert LeafAlreadyUsed();

        bytes32 digest = _pqDigest(actionType, paramsHash, s.leafIndex);
        if (!digest.verify(pqRoot, pqPubSeed, s)) revert BadPQSignature();

        _usedLeaf[key] = true;
        _bumpActivity();
    }

    function _pqDigest(uint8 actionType, bytes32 paramsHash, uint32 leafIndex)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(DOMAIN, block.chainid, address(this), actionType, paramsHash, leafIndex)
        );
    }

    function _requestDigest(address to, uint256 amount, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 paramsHash = keccak256(abi.encode(to, amount));
        return keccak256(
            abi.encode(DOMAIN, block.chainid, address(this), ACTION_REQUEST, paramsHash, nonce)
        );
    }

    function _guardianDigest(uint8 actionType, bytes32 paramsHash)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                "LIFEBOAT_GUARDIAN", DOMAIN, block.chainid, address(this), actionType, paramsHash, guardianNonce
            )
        );
    }

    /// @dev Require >= threshold signatures from distinct guardians (strictly increasing
    ///      recovered addresses enforce distinctness), then bump the guardian nonce.
    function _verifyGuardianQuorum(bytes32 digest, bytes[] calldata sigs) internal {
        uint256 t = guardianThreshold;
        if (t == 0) revert GuardianPathDisabled();
        if (sigs.length < t) revert BadGuardianQuorum();
        address last = address(0);
        for (uint256 i = 0; i < sigs.length; i++) {
            address g = _recover(digest, sigs[i]);
            if (g <= last || !isGuardian[g]) revert BadGuardianQuorum();
            last = g;
        }
        unchecked {
            guardianNonce++;
        }
        _bumpActivity();
    }

    function _leafKey(uint32 epoch, uint32 leafIndex) internal pure returns (uint256) {
        return (uint256(epoch) << 32) | uint256(leafIndex);
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadECDSASignature();
        bytes32 r;
        bytes32 vs;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            vs := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, vs);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}

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

    uint256 private _reentry = 1;

    // -------------------------------- events ----------------------------------
    event WithdrawalRequested(
        uint256 indexed id, address indexed to, uint256 amount, uint64 unlockTime
    );
    event WithdrawalExecuted(uint256 indexed id, address indexed to, uint256 amount);
    event WithdrawalVetoed(uint256 indexed id, uint32 leafIndex);
    event InstantMove(address indexed to, uint256 amount, uint32 leafIndex);
    event HotKeyRevoked(uint32 leafIndex);
    event PQRootRotated(bytes32 newRoot, bytes32 newPubSeed, uint32 newEpoch, uint32 leafIndex);
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
    error Reentrancy();

    modifier nonReentrant() {
        if (_reentry != 1) revert Reentrancy();
        _reentry = 2;
        _;
        _reentry = 1;
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
        DOMAIN = keccak256(abi.encodePacked("LIFEBOAT_VAULT_V1", block.chainid, address(this)));
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    // ===================================================================
    //  Hot-key (ECDSA) path — can ONLY start a timelocked withdrawal
    // ===================================================================

    /// @notice Start a timelocked withdrawal. Authorized by an ECDSA signature from the
    ///         hot key, so whoever holds that key (including a quantum attacker) can call
    ///         it — but it only ever enters the pending state.
    function requestWithdrawal(address to, uint256 amount, bytes calldata ecdsaSig)
        external
        returns (uint256 id)
    {
        if (hotKey == address(0)) revert HotKeyRevokedError();
        if (amount == 0) revert ZeroAmount();

        bytes32 digest = _requestDigest(to, amount, hotNonce);
        if (_recover(digest, ecdsaSig) != hotKey) revert BadECDSASignature();
        unchecked {
            hotNonce++;
        }

        id = ++withdrawalCount;
        uint64 unlockTime = uint64(block.timestamp) + timelock;
        _pending[id] = Pending({to: to, amount: amount, unlockTime: unlockTime, vetoed: false});
        emit WithdrawalRequested(id, to, amount, unlockTime);
    }

    /// @notice Complete a withdrawal after its timelock. Callable by anyone (no key
    ///         needed) — the timelock, not the caller, is the gate.
    function executeWithdrawal(uint256 id) external nonReentrant {
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

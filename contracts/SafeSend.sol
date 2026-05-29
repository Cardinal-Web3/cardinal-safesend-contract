// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

contract SafeSend is Initializable, PausableUpgradeable, AccessControlUpgradeable, UUPSUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    uint256 public constant BPS_DENOMINATOR = 10_000;

    enum SafeSendStatus {
        None,
        Pending,
        Cancelled,
        Released
    }

    struct SafeSendTransfer {
        address sender;
        address recipient;
        address token;
        uint256 amount;
        uint256 feeAmount;
        uint256 releaseTime;
        SafeSendStatus status;
    }

    error InvalidAddress();
    error InvalidAmount();
    error InvalidReleaseTime();
    error TransferNotFound();
    error TransferNotPending();
    error UnauthorizedSender();
    error CancellationWindowClosed();
    error ReleaseTimeNotReached();
    error InvalidFeeBps();

    event SafeSendCreated(
        uint256 indexed transferId,
        address indexed sender,
        address indexed recipient,
        address token,
        uint256 amount,
        uint256 feeAmount,
        uint256 releaseTime
    );
    event SafeSendCancelled(uint256 indexed transferId, address indexed sender);
    event SafeSendReleased(
        uint256 indexed transferId,
        address indexed recipient,
        uint256 recipientAmount,
        uint256 feeAmount
    );
    event FeeConfigUpdated(address indexed feeRecipient, uint256 feeBps);
    event OwnershipTransferred(address indexed previousAdmin, address indexed newAdmin);

    mapping(uint256 => SafeSendTransfer) private _transfers;
    uint256 public _nextTransferId;
    address public _feeRecipient;
    uint256 public _feeBps;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address feeRecipient_, uint256 feeBps_)
        public
        initializer
    {
        __Pausable_init();
        __AccessControl_init();

        _checkIsValidAddress(admin);

        _setFeeConfig(feeRecipient_, feeBps_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FEE_MANAGER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
    }

    /// @notice Creates a protected ERC20 transfer with a delayed release time.
    /// @dev `amount` is the total amount locked. The platform fee is deducted on release.
    function createSafeSend(
        address recipient,
        address token,
        uint256 amount,
        uint256 releaseTime
    ) external nonReentrant returns (uint256 transferId) {
        _checkIsValidAddress(recipient);
        _checkIsValidAddress(token);
        require(amount != 0, InvalidAmount());
        require(releaseTime > block.timestamp, InvalidReleaseTime());

        transferId = _nextTransferId++;
        uint256 feeAmount = previewFee(amount);

        _transfers[transferId] = SafeSendTransfer({
            sender: msg.sender,
            recipient: recipient,
            token: token,
            amount: amount,
            feeAmount: feeAmount,
            releaseTime: releaseTime,
            status: SafeSendStatus.Pending
        });

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit SafeSendCreated(
            transferId,
            msg.sender,
            recipient,
            token,
            amount,
            feeAmount,
            releaseTime
        );
    }

    /// @notice Cancels a pending transfer before the release time and refunds the sender.
    function cancelSafeSend(uint256 transferId) external nonReentrant {
        SafeSendTransfer storage transfer = _getPendingTransfer(transferId);

        require(transfer.sender == msg.sender, UnauthorizedSender());
        require(block.timestamp < transfer.releaseTime, CancellationWindowClosed());

        transfer.status = SafeSendStatus.Cancelled;
        IERC20(transfer.token).safeTransfer(transfer.sender, transfer.amount);

        emit SafeSendCancelled(transferId, transfer.sender);
    }

    /// @notice Releases a pending transfer after the delay window has expired.
    /// @dev Anyone may call this after expiry so settlement can be automated off-chain.
    function releaseSafeSend(uint256 transferId) external nonReentrant {
        SafeSendTransfer storage transfer = _getPendingTransfer(transferId);

        require(block.timestamp >= transfer.releaseTime, ReleaseTimeNotReached());

        transfer.status = SafeSendStatus.Released;

        uint256 recipientAmount = transfer.amount - transfer.feeAmount;
        IERC20 token = IERC20(transfer.token);

        if (transfer.feeAmount > 0) {
            token.safeTransfer(_feeRecipient, transfer.feeAmount);
        }

        token.safeTransfer(transfer.recipient, recipientAmount);

        emit SafeSendReleased(
            transferId,
            transfer.recipient,
            recipientAmount,
            transfer.feeAmount
        );
    }

    function transferOwnership(address newAdmin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldAdmin = msg.sender;
        _checkIsValidAddress(newAdmin);
        
        grantRole(DEFAULT_ADMIN_ROLE, newAdmin);
        grantRole(FEE_MANAGER_ROLE, newAdmin);
        grantRole(PAUSER_ROLE, newAdmin);
        grantRole(UPGRADER_ROLE, newAdmin);
        
        renounceRole(DEFAULT_ADMIN_ROLE, oldAdmin);
        renounceRole(FEE_MANAGER_ROLE, oldAdmin);
        renounceRole(PAUSER_ROLE, oldAdmin);
        renounceRole(UPGRADER_ROLE, oldAdmin);

        emit OwnershipTransferred(oldAdmin, newAdmin);
    }

    /// @notice Returns the stored transfer data for a Safe Send.
    function getSafeSend(uint256 transferId)
        external
        view
        returns (SafeSendTransfer memory)
    {
        return _getTransfer(transferId);
    }

    /// @notice Updates the platform fee configuration.
    function setFeeConfig(
        address feeRecipient_,
        uint256 feeBps_
    ) external onlyRole(FEE_MANAGER_ROLE) {
        _setFeeConfig(feeRecipient_, feeBps_);
    }

    /// @notice Returns the fee that would be charged for a transfer amount.
    function previewFee(uint256 amount) public view returns (uint256) {
        return (amount * _feeBps) / BPS_DENOMINATOR;
    }

    function _setFeeConfig(address feeRecipient_, uint256 feeBps_) internal {
        _checkIsValidAddress(feeRecipient_);
        require(feeBps_ < BPS_DENOMINATOR, InvalidFeeBps());

        _feeRecipient = feeRecipient_;
        _feeBps = feeBps_;

        emit FeeConfigUpdated(feeRecipient_, feeBps_);
    }

    function _getPendingTransfer(
        uint256 transferId
    ) internal view returns (SafeSendTransfer storage transfer) {
        transfer = _getTransfer(transferId);
        require(transfer.status == SafeSendStatus.Pending, TransferNotPending());
    }

    function _getTransfer(
        uint256 transferId
    ) private view returns (SafeSendTransfer storage transfer) {
        transfer = _transfers[transferId];
        _checkTransferExists(transfer);
    }

    function _checkIsValidAddress(address addr) private pure {
        require(addr != address(0), InvalidAddress());
    }

    function _checkTransferExists(
        SafeSendTransfer storage transfer
    ) private view {
        require(transfer.sender != address(0), TransferNotFound());
    }

    function pause() public onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() public onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(UPGRADER_ROLE)
    {}
}

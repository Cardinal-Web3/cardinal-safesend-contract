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

    error InvalidRecipient();
    error InvalidToken();
    error InvalidAmount();
    error InvalidReleaseTime();
    error TransferNotFound();
    error TransferNotPending();
    error UnauthorizedSender();
    error CancellationWindowClosed();
    error ReleaseTimeNotReached();
    error InvalidFeeRecipient();
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

    mapping(uint256 => SafeSendTransfer) private transfers;
    uint256 public nextTransferId;
    address public feeRecipient;
    uint256 public feeBps;

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

        if (admin == address(0)) {
            revert InvalidRecipient();
        }

        _setFeeConfig(feeRecipient_, feeBps_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FEE_MANAGER_ROLE, admin);
    }

    /// @notice Creates a protected ERC20 transfer with a delayed release time.
    /// @dev `amount` is the total amount locked. The platform fee is deducted on release.
    function createSafeSend(
        address recipient,
        address token,
        uint256 amount,
        uint256 releaseTime
    ) external nonReentrant returns (uint256 transferId) {
        if (recipient == address(0)) {
            revert InvalidRecipient();
        }
        if (token == address(0)) {
            revert InvalidToken();
        }
        if (amount == 0) {
            revert InvalidAmount();
        }
        if (releaseTime <= block.timestamp) {
            revert InvalidReleaseTime();
        }

        transferId = nextTransferId++;
        uint256 feeAmount = previewFee(amount);

        transfers[transferId] = SafeSendTransfer({
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

        if (transfer.sender != msg.sender) {
            revert UnauthorizedSender();
        }
        if (block.timestamp >= transfer.releaseTime) {
            revert CancellationWindowClosed();
        }

        transfer.status = SafeSendStatus.Cancelled;
        IERC20(transfer.token).safeTransfer(transfer.sender, transfer.amount);

        emit SafeSendCancelled(transferId, transfer.sender);
    }

    /// @notice Releases a pending transfer after the delay window has expired.
    /// @dev Anyone may call this after expiry so settlement can be automated off-chain.
    function releaseSafeSend(uint256 transferId) external nonReentrant {
        SafeSendTransfer storage transfer = _getPendingTransfer(transferId);

        if (block.timestamp < transfer.releaseTime) {
            revert ReleaseTimeNotReached();
        }

        transfer.status = SafeSendStatus.Released;

        uint256 recipientAmount = transfer.amount - transfer.feeAmount;
        IERC20 token = IERC20(transfer.token);

        if (transfer.feeAmount > 0) {
            token.safeTransfer(feeRecipient, transfer.feeAmount);
        }

        token.safeTransfer(transfer.recipient, recipientAmount);

        emit SafeSendReleased(
            transferId,
            transfer.recipient,
            recipientAmount,
            transfer.feeAmount
        );
    }

    /// @notice Returns the stored transfer data for a Safe Send.
    function getSafeSend(uint256 transferId)
        external
        view
        returns (SafeSendTransfer memory)
    {
        SafeSendTransfer memory transfer = transfers[transferId];
        if (transfer.sender == address(0)) {
            revert TransferNotFound();
        }

        return transfer;
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
        return (amount * feeBps) / BPS_DENOMINATOR;
    }

    function _setFeeConfig(address feeRecipient_, uint256 feeBps_) internal {
        if (feeRecipient_ == address(0)) {
            revert InvalidFeeRecipient();
        }
        if (feeBps_ >= BPS_DENOMINATOR) {
            revert InvalidFeeBps();
        }

        feeRecipient = feeRecipient_;
        feeBps = feeBps_;

        emit FeeConfigUpdated(feeRecipient_, feeBps_);
    }

    function _getPendingTransfer(
        uint256 transferId
    ) internal view returns (SafeSendTransfer storage transfer) {
        transfer = transfers[transferId];
        if (transfer.sender == address(0)) {
            revert TransferNotFound();
        }
        if (transfer.status != SafeSendStatus.Pending) {
            revert TransferNotPending();
        }
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

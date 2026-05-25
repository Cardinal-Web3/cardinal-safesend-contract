import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("SafeSend", function () {
  const NULL_ADDRESS = "0x0000000000000000000000000000000000000000";
  const FEE_BPS = 250n;
  const AMOUNT = 1000n;
  const FEE_AMOUNT = 25n;
  const RECIPIENT_AMOUNT = AMOUNT - FEE_AMOUNT;
  const RELEASE_DELAY = 3600n;

  let safeSend: any;
  let mockToken: any;
  let owner: any, feeRecipient: any, sender: any, recipient: any, otherSigner: any, pauser: any;

  async function getReleaseTime() {
    const latestBlock = await ethers.provider.getBlock("latest");
    return BigInt(latestBlock!.timestamp) + RELEASE_DELAY;
  }

  async function deploySafeSend(adminAddress: string, feeRecipientAddress: string, feeBps: bigint) {
    const SafeSend = await ethers.getContractFactory("SafeSend");
    const safeSendImplementation = await SafeSend.deploy();

    const initData = SafeSend.interface.encodeFunctionData("initialize", [
      adminAddress,
      feeRecipientAddress,
      feeBps
    ]);

    const TestERC1967Proxy = await ethers.getContractFactory("TestERC1967Proxy");
    const proxy = await TestERC1967Proxy.deploy(
      await safeSendImplementation.getAddress(),
      initData
    );

    return SafeSend.attach(await proxy.getAddress());
  }

  beforeEach(async function () {
    [owner, feeRecipient, sender, recipient, otherSigner, pauser] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy("Mock USDT", "USDT", 6);

    safeSend = await deploySafeSend(owner.address, feeRecipient.address, FEE_BPS);

    await mockToken.mint(sender.address, AMOUNT * 10n);
    await mockToken.connect(sender).approve(await safeSend.getAddress(), AMOUNT * 10n);
  });

  describe("Initialization", function () {
    it("Should initialize correctly", async function () {
      expect(await safeSend._feeRecipient()).to.equal(feeRecipient.address);
      expect(await safeSend._feeBps()).to.equal(FEE_BPS);
      expect(await safeSend._nextTransferId()).to.equal(0n);
      expect(await safeSend.hasRole(await safeSend.DEFAULT_ADMIN_ROLE(), owner.address)).to.equal(true);
      expect(await safeSend.hasRole(await safeSend.FEE_MANAGER_ROLE(), owner.address)).to.equal(true);
    });

    it("Should revert if any address is zero", async function () {
      await expect(
        deploySafeSend(NULL_ADDRESS, feeRecipient.address, FEE_BPS)
      ).to.be.revertedWithCustomError(safeSend, "InvalidAddress");

      await expect(
        deploySafeSend(owner.address, NULL_ADDRESS, FEE_BPS)
      ).to.be.revertedWithCustomError(safeSend, "InvalidAddress");
    });

    it("Should revert if fee bps is invalid", async function () {
      await expect(
        deploySafeSend(owner.address, feeRecipient.address, 10000n)
      ).to.be.revertedWithCustomError(safeSend, "InvalidFeeBps");
    });
  });

  describe("Create Safe Send", function () {
    it("Should revert if recipient is zero address", async function () {
      const releaseTime = await getReleaseTime();

      await expect(
        safeSend.connect(sender).createSafeSend(NULL_ADDRESS, await mockToken.getAddress(), AMOUNT, releaseTime)
      ).to.be.revertedWithCustomError(safeSend, "InvalidAddress");
    });

    it("Should revert if token is zero address", async function () {
      const releaseTime = await getReleaseTime();

      await expect(
        safeSend.connect(sender).createSafeSend(recipient.address, NULL_ADDRESS, AMOUNT, releaseTime)
      ).to.be.revertedWithCustomError(safeSend, "InvalidAddress");
    });

    it("Should revert if amount is zero", async function () {
      const releaseTime = await getReleaseTime();

      await expect(
        safeSend.connect(sender).createSafeSend(recipient.address, await mockToken.getAddress(), 0, releaseTime)
      ).to.be.revertedWithCustomError(safeSend, "InvalidAmount");
    });

    it("Should revert if release time is not in the future", async function () {
      const latestBlock = await ethers.provider.getBlock("latest");

      await expect(
        safeSend.connect(sender).createSafeSend(
          recipient.address,
          await mockToken.getAddress(),
          AMOUNT,
          latestBlock!.timestamp
        )
      ).to.be.revertedWithCustomError(safeSend, "InvalidReleaseTime");
    });

    it("Should create safe send correctly", async function () {
      const releaseTime = await getReleaseTime();

      await expect(
        safeSend.connect(sender).createSafeSend(recipient.address, await mockToken.getAddress(), AMOUNT, releaseTime)
      ).to.emit(safeSend, "SafeSendCreated")
        .withArgs(0n, sender.address, recipient.address, await mockToken.getAddress(), AMOUNT, FEE_AMOUNT, releaseTime);

      const safeSendTransfer = await safeSend.getSafeSend(0);
      expect(safeSendTransfer.sender).to.equal(sender.address);
      expect(safeSendTransfer.recipient).to.equal(recipient.address);
      expect(safeSendTransfer.token).to.equal(await mockToken.getAddress());
      expect(safeSendTransfer.amount).to.equal(AMOUNT);
      expect(safeSendTransfer.feeAmount).to.equal(FEE_AMOUNT);
      expect(safeSendTransfer.releaseTime).to.equal(releaseTime);
      expect(safeSendTransfer.status).to.equal(1n);
      expect(await safeSend._nextTransferId()).to.equal(1n);
      expect(await mockToken.balanceOf(await safeSend.getAddress())).to.equal(AMOUNT);
    });
  });

  describe("Cancel Safe Send", function () {
    beforeEach(async function () {
      const releaseTime = await getReleaseTime();
      await safeSend.connect(sender).createSafeSend(recipient.address, await mockToken.getAddress(), AMOUNT, releaseTime);
    });

    it("Should revert if transfer does not exist", async function () {
      await expect(
        safeSend.connect(sender).cancelSafeSend(999)
      ).to.be.revertedWithCustomError(safeSend, "TransferNotFound");
    });

    it("Should revert if caller is not the sender", async function () {
      await expect(
        safeSend.connect(otherSigner).cancelSafeSend(0)
      ).to.be.revertedWithCustomError(safeSend, "UnauthorizedSender");
    });

    it("Should revert if cancellation window is closed", async function () {
      await ethers.provider.send("evm_increaseTime", [Number(RELEASE_DELAY + 1n)]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        safeSend.connect(sender).cancelSafeSend(0)
      ).to.be.revertedWithCustomError(safeSend, "CancellationWindowClosed");
    });

    it("Should allow sender to cancel safe send", async function () {
      const senderBalanceBefore = await mockToken.balanceOf(sender.address);

      await expect(
        safeSend.connect(sender).cancelSafeSend(0)
      ).to.emit(safeSend, "SafeSendCancelled")
        .withArgs(0n, sender.address);

      const safeSendTransfer = await safeSend.getSafeSend(0);
      expect(safeSendTransfer.status).to.equal(2n);
      expect(await mockToken.balanceOf(sender.address)).to.equal(senderBalanceBefore + AMOUNT);
      expect(await mockToken.balanceOf(await safeSend.getAddress())).to.equal(0n);
    });
  });

  describe("Release Safe Send", function () {
    beforeEach(async function () {
      const releaseTime = await getReleaseTime();
      await safeSend.connect(sender).createSafeSend(recipient.address, await mockToken.getAddress(), AMOUNT, releaseTime);
    });

    it("Should revert if transfer does not exist", async function () {
      await expect(
        safeSend.connect(otherSigner).releaseSafeSend(999)
      ).to.be.revertedWithCustomError(safeSend, "TransferNotFound");
    });

    it("Should revert if release time has not been reached", async function () {
      await expect(
        safeSend.connect(otherSigner).releaseSafeSend(0)
      ).to.be.revertedWithCustomError(safeSend, "ReleaseTimeNotReached");
    });

    it("Should allow anyone to release safe send after release time", async function () {
      await ethers.provider.send("evm_increaseTime", [Number(RELEASE_DELAY + 1n)]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        safeSend.connect(otherSigner).releaseSafeSend(0)
      ).to.emit(safeSend, "SafeSendReleased")
        .withArgs(0n, recipient.address, RECIPIENT_AMOUNT, FEE_AMOUNT);

      const safeSendTransfer = await safeSend.getSafeSend(0);
      expect(safeSendTransfer.status).to.equal(3n);
      expect(await mockToken.balanceOf(recipient.address)).to.equal(RECIPIENT_AMOUNT);
      expect(await mockToken.balanceOf(feeRecipient.address)).to.equal(FEE_AMOUNT);
      expect(await mockToken.balanceOf(await safeSend.getAddress())).to.equal(0n);
    });

    it("Should revert if transfer is not pending", async function () {
      await safeSend.connect(sender).cancelSafeSend(0);

      await expect(
        safeSend.connect(otherSigner).releaseSafeSend(0)
      ).to.be.revertedWithCustomError(safeSend, "TransferNotPending");
    });
  });

  describe("Safe Send Mapping", function () {
    it("Should return safe send transfer details", async function () {
      const releaseTime = await getReleaseTime();
      await safeSend.connect(sender).createSafeSend(recipient.address, await mockToken.getAddress(), AMOUNT, releaseTime);

      const safeSendTransfer = await safeSend.getSafeSend(0);

      expect(safeSendTransfer.sender).to.equal(sender.address);
      expect(safeSendTransfer.recipient).to.equal(recipient.address);
      expect(safeSendTransfer.amount).to.equal(AMOUNT);
    });

    it("Should revert if transfer does not exist", async function () {
      await expect(
        safeSend.getSafeSend(0)
      ).to.be.revertedWithCustomError(safeSend, "TransferNotFound");
    });
  });

  describe("Fee Management", function () {
    it("Should calculate fee correctly", async function () {
      expect(await safeSend.previewFee(AMOUNT)).to.equal(FEE_AMOUNT);
    });

    it("Should revert if non-fee-manager tries to update fee config", async function () {
      await expect(
        safeSend.connect(otherSigner).setFeeConfig(otherSigner.address, 100)
      ).to.be.revertedWithCustomError(safeSend, "AccessControlUnauthorizedAccount");
    });

    it("Should revert if fee recipient address is zero", async function () {
      await expect(
        safeSend.setFeeConfig(NULL_ADDRESS, 100)
      ).to.be.revertedWithCustomError(safeSend, "InvalidAddress");
    });

    it("Should revert if fee bps is invalid", async function () {
      await expect(
        safeSend.setFeeConfig(otherSigner.address, 10000)
      ).to.be.revertedWithCustomError(safeSend, "InvalidFeeBps");
    });

    it("Should allow fee manager to update fee config", async function () {
      await expect(
        safeSend.setFeeConfig(otherSigner.address, 100)
      ).to.emit(safeSend, "FeeConfigUpdated")
        .withArgs(otherSigner.address, 100);

      expect(await safeSend._feeRecipient()).to.equal(otherSigner.address);
      expect(await safeSend._feeBps()).to.equal(100n);
      expect(await safeSend.previewFee(AMOUNT)).to.equal(10n);
    });
  });

  describe("Pause / Unpause", function () {
    it("Should revert if non-pauser tries to pause or unpause", async function () {
      await expect(
        safeSend.connect(otherSigner).pause()
      ).to.be.revertedWithCustomError(safeSend, "AccessControlUnauthorizedAccount");

      await expect(
        safeSend.connect(otherSigner).unpause()
      ).to.be.revertedWithCustomError(safeSend, "AccessControlUnauthorizedAccount");
    });

    it("Should allow pauser to pause and unpause the contract", async function () {
      await safeSend.grantRole(await safeSend.PAUSER_ROLE(), pauser.address);

      await safeSend.connect(pauser).pause();
      expect(await safeSend.paused()).to.equal(true);

      await safeSend.connect(pauser).unpause();
      expect(await safeSend.paused()).to.equal(false);
    });
  });

  describe("SafeSend UUPS Upgradeability", function () {
    it("Should revert if non-upgrader tries to upgrade", async function () {
      const SafeSend = await ethers.getContractFactory("SafeSend");
      const newImplementation = await SafeSend.deploy();

      await expect(
        safeSend.connect(otherSigner).upgradeToAndCall(await newImplementation.getAddress(), "0x")
      ).to.be.revertedWithCustomError(safeSend, "AccessControlUnauthorizedAccount");
    });

    it("Should allow upgrader to upgrade", async function () {
      const SafeSend = await ethers.getContractFactory("SafeSend");
      const newImplementation = await SafeSend.deploy();

      await safeSend.grantRole(await safeSend.UPGRADER_ROLE(), owner.address);

      await expect(
        safeSend.upgradeToAndCall(await newImplementation.getAddress(), "0x")
      ).to.emit(safeSend, "Upgraded")
        .withArgs(await newImplementation.getAddress());
    });
  });
});

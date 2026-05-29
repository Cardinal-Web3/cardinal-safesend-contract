import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { requiredEnv } from "../../utils/utils.js";
import { log } from "node:console";

const admin = requiredEnv("SAFESEND_ADMIN");
const feeRecipient = requiredEnv("SAFESEND_FEE_RECIPIENT");
const feeBps = BigInt(requiredEnv("SAFESEND_FEE_BPS"));

if (feeBps >= 10_000n) {
  throw new Error("SAFESEND_FEE_BPS must be less than 10000");
}

export default buildModule("SafeSendModule", (m) => {
  const implementation = m.contract("SafeSend", [], {
    id: "SafeSendImplementation",
  });
  const initializeData = m.encodeFunctionCall(implementation, "initialize", [
    admin,
    feeRecipient,
    feeBps,
  ]);

  const proxy = m.contract("ERC1967Proxy", [
    implementation,
    initializeData,
  ], {
    id: "SafeSendERC1967Proxy",
  });

  const safeSend = m.contractAt("SafeSend", proxy, {
    id: "SafeSendProxy",
  });

  return { implementation, proxy, safeSend };
});
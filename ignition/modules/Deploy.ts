import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { requiredEnv } from "../../utils/utils.js";

export default buildModule("DeployModule", (m) => {
  const feeBps = BigInt(requiredEnv("SAFESEND_FEE_BPS"));
  const deployer = m.getAccount(0);

  if (feeBps >= 10_000n) {
    throw new Error("SAFESEND_FEE_BPS must be less than 10000");
  }

  const implementation = m.contract("SafeSend", [], {
    id: "Implementation",
  });
  const initializeData = m.encodeFunctionCall(implementation, "initialize", [
    deployer,
    deployer,
    feeBps,
  ]);

  const erc1967proxy = m.contract("ERC1967Proxy", [
    implementation,
    initializeData,
  ], {
    id: "ERC1967Proxy",
    after: [implementation],
  });

  const proxy = m.contractAt("SafeSend", erc1967proxy, {
    id: "Proxy",
  });

  return { implementation, erc1967proxy, proxy };
});
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import SafeSendModule from "./Deploy.js";

export default buildModule("UpgradeModule", (m) => {
  const upgrader = m.getAccount(0);
  const { proxy, erc1967proxy, implementation } = m.useModule(SafeSendModule);

  const safeSendUpdatedImplementation = m.contract("SafeSend", [], {
    id: "UpdatedImplementation",
  });

  m.call(
    proxy,
    "upgradeToAndCall",
    [safeSendUpdatedImplementation, "0x"],
    {
      from: upgrader,
      id: "upgradeToAndCall",
      after: [safeSendUpdatedImplementation],
    }
  );

  return { implementation, proxy, erc1967proxy };
});

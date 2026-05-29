import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";
import { requiredEnv } from "./utils/utils.js";
import dotenv from "dotenv";
dotenv.config();

const PRIVATE_KEY = requiredEnv("PRIVATE_KEY");
const RPC_URL = requiredEnv("RPC_URL");
const ETHERSCAN_API_KEY = requiredEnv("ETHERSCAN_API_KEY");

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    npmFilesToBuild: [
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol",
    ],
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    sepolia: {
      type: "http",
      chainType: "l1",
      url: RPC_URL,
      accounts: [PRIVATE_KEY],
    },
    arbSepolia: {
      type: "http",
      chainType: "l1",
      url: RPC_URL,
      accounts: [PRIVATE_KEY],
    },
  },
  verify: {
    etherscan: {
      apiKey: ETHERSCAN_API_KEY,
    },
    sourcify: {
      enabled: true,
    },
    blockscout: {
      enabled: true,
    }
  },
});

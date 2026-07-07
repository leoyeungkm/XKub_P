import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";
import * as path from "path";

// Load .env from this project's root
dotenv.config({ path: path.resolve(__dirname, ".env") });

const KUB_PRIVATE_KEY =
  process.env.KUB_PRIVATE_KEY ||
  process.env.HYPERLIQUID_PRIVATE_KEY ||
  "0x0000000000000000000000000000000000000000000000000000000000000001";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    kubTestnet: {
      url: "https://rpc-testnet.bitkubchain.io",
      chainId: 25925,
      accounts: [KUB_PRIVATE_KEY],
      gasPrice: 100_000_000_000, // 100 gwei — comfortably above the ~50 min so keeper txs never stall
    },
    kubLayer2Testnet: {
      url: "https://kublayer2.testnet.kubchain.io",
      chainId: 259251,
      accounts: [KUB_PRIVATE_KEY],
    },
    kubMainnet: {
      url: "https://rpc.bitkubchain.io",
      chainId: 96,
      accounts: [KUB_PRIVATE_KEY],
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  paths: {
    sources:   "./src",
    tests:     "./test",
    cache:     "./cache",
    artifacts: "./artifacts",
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  etherscan: {
    apiKey: {
      kubTestnet: "no-api-key-needed",
      kubMainnet: "no-api-key-needed",
    },
    customChains: [
      {
        network: "kubTestnet",
        chainId: 25925,
        urls: {
          apiURL:     "https://testnet.kubscan.com/api",
          browserURL: "https://testnet.kubscan.com",
        },
      },
      {
        network: "kubMainnet",
        chainId: 96,
        urls: {
          apiURL:     "https://www.kubscan.com/api",
          browserURL: "https://www.kubscan.com",
        },
      },
    ],
  },
  sourcify: {
    enabled: false,
  },
};

export default config;

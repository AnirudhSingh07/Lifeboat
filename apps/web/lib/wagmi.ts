import { createConfig, http } from "wagmi";
import { anvil, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { LIVE_RPC, LOCAL_RPC } from "./config";

/** Real-wallet config: MetaMask (injected) on Sepolia or a local Anvil. */
export const wagmiConfig = createConfig({
  chains: [sepolia, anvil],
  connectors: [injected()],
  transports: {
    [sepolia.id]: http(LIVE_RPC),
    [anvil.id]: http(LOCAL_RPC),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

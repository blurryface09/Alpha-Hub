import { createConfig, http, injected, createStorage } from 'wagmi'
import { mainnet, base, baseSepolia, bsc } from 'wagmi/chains'
import { walletConnect } from 'wagmi/connectors'

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '546875fa81ade5e1df39a1cd93e6c5e7'
const chains = import.meta.env.DEV ? [mainnet, base, baseSepolia, bsc] : [mainnet, base, bsc]
const transports = {
  [mainnet.id]: http(),
  [base.id]: http(),
  [bsc.id]: http(),
}

if (import.meta.env.DEV) {
  transports[baseSepolia.id] = http()
}

export const wagmiConfig = createConfig({
  chains,
  connectors: [
    injected(),
    walletConnect({ projectId }),
  ],
  transports,
  // Version the storage key so stale WalletConnect sessions (pre-v2) are dropped
  // rather than causing "getChainId is not a function" errors on reconnect
  storage: createStorage({ storage: window?.localStorage, key: 'wagmi.v2' }),
})

export const SUPPORTED_CHAINS = {
  eth: mainnet,
  base: base,
  bnb: bsc,
}

if (import.meta.env.DEV) {
  SUPPORTED_CHAINS.baseSepolia = baseSepolia
}

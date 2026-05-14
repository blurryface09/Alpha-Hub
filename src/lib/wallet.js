import { createConfig, http, injected } from 'wagmi'
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
    walletConnect({ projectId }),
    injected(),
  ],
  transports,
})

export const SUPPORTED_CHAINS = {
  eth: mainnet,
  base: base,
  bnb: bsc,
}

if (import.meta.env.DEV) {
  SUPPORTED_CHAINS.baseSepolia = baseSepolia
}

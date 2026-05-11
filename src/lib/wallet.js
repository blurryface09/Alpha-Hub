import { createConfig, http, injected } from 'wagmi'
import { mainnet, base, baseSepolia, bsc } from 'wagmi/chains'
import { walletConnect, metaMask } from 'wagmi/connectors'

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '546875fa81ade5e1df39a1cd93e6c5e7'

export const wagmiConfig = createConfig({
  chains: [mainnet, base, baseSepolia, bsc],
  connectors: [
    walletConnect({ projectId }),
    metaMask(),
    injected(),
  ],
  transports: {
    [mainnet.id]: http(),
    [base.id]: http(),
    [baseSepolia.id]: http(),
    [bsc.id]: http(),
  },
})

export const SUPPORTED_CHAINS = {
  eth: mainnet,
  base: base,
  baseSepolia: baseSepolia,
  bnb: bsc,
}

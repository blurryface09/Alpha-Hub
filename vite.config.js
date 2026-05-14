import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  resolve: {
    dedupe: [
      'react',
      'react-dom',
      'wagmi',
      '@wagmi/core',
      'viem',
      '@tanstack/react-query',
    ],
    alias: {
      '@': '/src',
    },
  },
  build: {
    sourcemap: false,
    cssCodeSplit: true,
    minify: 'esbuild',
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined

          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-router-dom/')) {
            return 'vendor-react'
          }

          if (
            id.includes('/wagmi/') ||
            id.includes('/@wagmi/') ||
            id.includes('/viem/') ||
            id.includes('/ethers/') ||
            id.includes('/@walletconnect/') ||
            id.includes('/@coinbase/') ||
            id.includes('/@base-org/') ||
            id.includes('/@metamask/') ||
            id.includes('/@reown/') ||
            id.includes('/ox/')
          ) {
            return 'vendor-web3'
          }

          if (id.includes('/@supabase/')) return 'vendor-supabase'
          if (id.includes('/framer-motion/')) return 'vendor-motion'
          if (id.includes('/recharts/')) return 'vendor-charts'
          if (id.includes('/lucide-react/')) return 'vendor-icons'

          return undefined
        },
      },
    },
  },
  optimizeDeps: {
    exclude: [
      '@walletconnect/ethereum-provider',
      '@coinbase/wallet-sdk',
      '@base-org/account',
      '@metamask/sdk',
      '@reown/appkit',
    ],
  },
})

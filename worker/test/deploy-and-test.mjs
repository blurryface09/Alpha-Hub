/**
 * Compile, deploy TestMintNFT to Sepolia, then run the full live test.
 * Run: node worker/test/deploy-and-test.mjs
 *
 * Polls for wallet balance first — safe to start before funding is confirmed.
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { prepareMintTransaction } from '../../api/_lib/mint-engine.js'

const PRIVATE_KEY = process.env.DEPLOY_PRIVATE_KEY || '0x60eaa4066e49c578d7c376bcefac360995f0d42ba6ba4b40a7e82f86656e5701'
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
const FALLBACK_RPC = 'https://sepolia.gateway.tenderly.co'

const account = privateKeyToAccount(PRIVATE_KEY)

const sepoliaChain = {
  id: 11155111, name: 'Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [SEPOLIA_RPC] } },
  testnet: true,
}

const publicClient = createPublicClient({ chain: sepoliaChain, transport: http(SEPOLIA_RPC, { timeout: 20000 }) })
const fallbackClient = createPublicClient({
  chain: { ...sepoliaChain, rpcUrls: { default: { http: [FALLBACK_RPC] } } },
  transport: http(FALLBACK_RPC, { timeout: 20000 }),
})
const walletClient = createWalletClient({ account, chain: sepoliaChain, transport: http(SEPOLIA_RPC, { timeout: 40000 }) })

// ─── Step 1: Wait for balance ─────────────────────────────────────────────────

console.log('\n=== AlphaHub Sepolia Deploy + Test ===\n')
console.log(`Deployer: ${account.address}`)
console.log(`RPC:      ${SEPOLIA_RPC}\n`)
console.log('Polling for balance (every 15s, up to 10 min)...\n')

let balance = 0n
for (let i = 0; i < 40; i++) {
  balance = await publicClient.getBalance({ address: account.address }).catch(() => 0n)
  if (balance > 0n) {
    console.log(`✓ Balance: ${(Number(balance) / 1e18).toFixed(6)} ETH`)
    break
  }
  process.stdout.write(`  [${i + 1}/40] 0 ETH — waiting 15s...\r`)
  await new Promise(r => setTimeout(r, 15000))
}

if (balance === 0n) {
  console.error('\n✗ Still 0 after 10 min. Fund and retry.')
  process.exit(1)
}

// ─── Step 2: Compile ──────────────────────────────────────────────────────────

console.log('\n--- Compile ---\n')

const solFile = new URL('./contracts/TestMintNFT.sol', import.meta.url).pathname
const outDir  = new URL('./contracts/out', import.meta.url).pathname
mkdirSync(outDir, { recursive: true })

execSync(`npx --yes solc --optimize --abi --bin -o ${outDir} ${solFile}`, { stdio: 'inherit' })

// npx solc prefixes output files with a sanitized path
import { readdirSync } from 'fs'
const outFiles = readdirSync(outDir)
const binFile = outFiles.find(f => f.endsWith('TestMintNFT.bin'))
const abiFile = outFiles.find(f => f.endsWith('TestMintNFT.abi'))
if (!binFile || !abiFile) throw new Error(`Compiled output not found. Files: ${outFiles.join(', ')}`)
const bytecode = '0x' + readFileSync(`${outDir}/${binFile}`, 'utf8').trim()
const abi      = JSON.parse(readFileSync(`${outDir}/${abiFile}`, 'utf8'))
console.log(`✓ Bytecode: ${bytecode.length / 2} bytes`)

// ─── Step 3: Deploy ───────────────────────────────────────────────────────────

console.log('\n--- Deploy ---\n')

const gasPrice = await publicClient.getGasPrice()
console.log(`Gas price: ${Number(gasPrice) / 1e9} gwei`)

const deployHash = await walletClient.deployContract({ abi, bytecode, gasPrice: gasPrice * 120n / 100n })
console.log(`TX:        ${deployHash}`)
console.log('Waiting for receipt...')

const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash, timeout: 120000 })
const contractAddress = receipt.contractAddress

if (!contractAddress) { console.error('✗ No contract address in receipt'); process.exit(1) }

console.log(`\n★ Deployed: ${contractAddress}`)
console.log(`  Block:    ${receipt.blockNumber}  Gas: ${receipt.gasUsed}`)
console.log(`  Etherscan: https://sepolia.etherscan.io/address/${contractAddress}`)

// Save for reuse
writeFileSync(
  new URL('./contracts/deployed.json', import.meta.url).pathname,
  JSON.stringify({ contractAddress, chain: 'sepolia', deployedAt: new Date().toISOString() }, null, 2),
)

// ─── Step 4: prepareMintTransaction ──────────────────────────────────────────

console.log('\n--- prepareMintTransaction ---\n')

let pass = 0, fail = 0
async function check(label, fn) {
  try { await fn(); console.log(`  ✓  ${label}`); pass++ }
  catch (e) { console.error(`  ✗  ${label}\n     ${e.message.slice(0, 120)}`); fail++ }
}

let prepared = null

await check('prepareMintTransaction returns a result', async () => {
  prepared = await prepareMintTransaction(
    { chain: 'sepolia', contractAddress, walletAddress: account.address, mintPrice: '0', quantity: 1 },
    fallbackClient,
  )
  if (!prepared) throw new Error('null result')
})

if (prepared) {
  await check('functionName === "mint"', () => {
    if (prepared.functionName !== 'mint') throw new Error(`got "${prepared.functionName}"`)
  })
  await check('chainId === 11155111', () => {
    if (prepared.chainId !== 11155111) throw new Error(`got ${prepared.chainId}`)
  })
  await check('gas is non-zero string', () => {
    if (!prepared.gas || prepared.gas === '0') throw new Error(`got "${prepared.gas}"`)
    BigInt(prepared.gas)
  })
  await check('data starts with mint(uint256) selector 0xa0712d68', () => {
    if (!prepared.data?.startsWith('0xa0712d68')) throw new Error(`got ${prepared.data?.slice(0, 10)}`)
  })
  await check('value === "0" (free mint)', () => {
    if (prepared.value !== '0') throw new Error(`got "${prepared.value}"`)
  })
  await check('to matches deployed contract', () => {
    if (prepared.to?.toLowerCase() !== contractAddress.toLowerCase()) throw new Error(`to=${prepared.to}`)
  })

  console.log(`\n  functionName: ${prepared.functionName}`)
  console.log(`  gas:          ${prepared.gas}`)
  console.log(`  chainId:      ${prepared.chainId}`)
  console.log(`  source:       ${prepared.source}`)
  console.log(`  data:         ${prepared.data?.slice(0, 20)}…`)
}

// ─── Step 5: Submit real mint TX ─────────────────────────────────────────────

console.log('\n--- Submit mint transaction ---\n')

await check('mint(1) confirmed on Sepolia', async () => {
  if (!prepared) throw new Error('no prepared tx')

  const mintHash = await walletClient.sendTransaction({
    to: contractAddress,
    data: prepared.data,
    value: BigInt(prepared.value || '0'),
    gas: BigInt(prepared.gas),
  })
  console.log(`  TX: ${mintHash}`)

  const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash, timeout: 90000 })
  if (mintReceipt.status !== 'success') throw new Error(`status: ${mintReceipt.status}`)
  console.log(`  Confirmed in block ${mintReceipt.blockNumber}  gas used: ${mintReceipt.gasUsed}`)

  const supply = await publicClient.readContract({
    address: contractAddress,
    abi: [{ name: 'totalSupply', type: 'function', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
  })
  console.log(`  totalSupply after mint: ${supply}`)
  if (supply < 1n) throw new Error('supply still 0')
})

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(52)}`)
console.log(`Contract: ${contractAddress}`)
console.log(`Network:  Sepolia (11155111)`)
console.log(`Result:   ${pass}/${pass + fail} checks passed`)
console.log(`\nRe-run anytime:`)
console.log(`  CONTRACT_ADDRESS=${contractAddress} node worker/test/sepolia-live.test.js`)
console.log('='.repeat(52) + '\n')

if (fail > 0) process.exitCode = 1

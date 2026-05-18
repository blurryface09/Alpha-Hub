import assert from 'node:assert/strict'
import { extractOpenSeaSchedule } from '../src/server/calendar/adapters/opensea.js'

const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
const later = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
const past = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
const pastEnd = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
const liveStart = new Date(Date.now() - 60 * 60 * 1000).toISOString()
const liveEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString()

function stage(result, name) {
  return result.stages.find(item => item.stage_name === name)
}

{
  const result = extractOpenSeaSchedule({
    saleConfig: {
      phases: [
        { stageName: 'Allowlist', startsAt: future, endsAt: later, pricePerToken: { amount: '0.05', symbol: 'ETH' }, maxPerWallet: 2 },
        { stageName: 'Public', startsAt: later, mintPrice: '0.08 ETH', walletLimit: 5 },
      ],
    },
  }, { url: 'https://opensea.io/collection/example', slug: 'example' })
  assert.equal(result.stages.length, 2)
  assert.equal(stage(result, 'Allowlist').price_label, '0.05 ETH')
  assert.equal(stage(result, 'Allowlist').wallet_limit, '2')
  assert.equal(stage(result, 'Public').price_label, '0.08 ETH')
  assert.equal(result.status, 'upcoming')
}

{
  const html = `
    <html><body>
      <h2>Mint Schedule</h2>
      <p>Presale Price 0.04 ETH Starts: May 20, 2026 at 5:00 PM GMT+1 Ends: May 21, 2026 at 5:00 PM GMT+1 Limit per wallet: 3</p>
    </body></html>
  `
  const result = extractOpenSeaSchedule({}, { html, url: 'https://opensea.io/collection/html-fixture' })
  assert.ok(result.stages.length >= 1)
  assert.equal(result.stages[0].price_label, '0.04 ETH')
  assert.equal(result.stages[0].wallet_limit, '3')
  assert.equal(result.stages[0].start_time, '2026-05-20T16:00:00.000Z')
  assert.equal(result.stages[0].end_time, '2026-05-21T16:00:00.000Z')
}

{
  const result = extractOpenSeaSchedule({}, { html: '<main>MINTING IN 0 DAYS 7 HOURS</main>' })
  assert.equal(result.status, 'upcoming')
  assert.notEqual(result.status, 'live_now')
  assert.match(result.price_note || result.reason, /countdown|price/i)
}

{
  const result = extractOpenSeaSchedule({ stages: [{ name: 'Public', startTime: liveStart, endTime: liveEnd, price: 'Free mint' }] })
  assert.equal(result.status, 'live_now')
  assert.equal(result.price_label, 'Free mint')
}

{
  const result = extractOpenSeaSchedule({ stages: [{ name: 'Public', startTime: past, endTime: pastEnd, price: '0 MATIC' }] })
  assert.equal(result.status, 'ended')
  assert.equal(result.price_label, 'Free mint')
}

{
  const result = extractOpenSeaSchedule({ stages: [{ name: 'Public', startTime: future }] })
  assert.equal(result.price_label, 'Price TBA')
  assert.ok(result.missing_fields.includes('mint_price'))
}

{
  const result = extractOpenSeaSchedule({
    stats: { floor_price: '0.8 ETH', total_volume: '200 ETH' },
    stages: [{ name: 'Public', startTime: future }],
  })
  assert.equal(result.price_label, 'Price TBA')
  assert.ok(result.rejected_price_candidates.some(item => item.reason === 'secondary_or_non_mint_price'))
}

{
  const sol = extractOpenSeaSchedule({ phases: [{ name: 'Public', startsAt: future, price: '1.5 SOL' }] })
  const matic = extractOpenSeaSchedule({ phases: [{ name: 'Public', startsAt: future, price: '12 MATIC' }] })
  assert.equal(sol.price_label, '1.5 SOL')
  assert.equal(matic.price_label, '12 MATIC')
}

console.log('OpenSea schedule extraction fixtures passed')

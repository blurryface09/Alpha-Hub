/**
 * Mint Capture Mode proxy.
 * Fetches an external mint page, strips X-Frame-Options / CSP frame-ancestors,
 * and injects the AH capture script so wallet transactions can be intercepted
 * before the user signs them (tx is not modified — user still signs normally).
 *
 * Auth: Bearer token passed as ?token= query param (iframe can't send headers).
 */

import { getBearerToken, createAnonClient } from '../_lib/auth.js'

// Inlined capture script — must run before any page scripts load
const CAPTURE_SCRIPT = `<script>
;(function(){
  if(window.__AH_CAPTURE_ACTIVE)return
  window.__AH_CAPTURE_ACTIVE=true
  var P=(function(){try{return window.parent!==window?window.parent:null}catch(e){return null}})()
  function badge(){
    var s=document.createElement('style')
    s.textContent='#__ahb{position:fixed;top:10px;right:10px;z-index:2147483647;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;font:700 11px/1 monospace;padding:5px 12px;border-radius:99px;box-shadow:0 2px 16px rgba(0,0,0,.45);pointer-events:none;letter-spacing:.04em}#__ahn{position:fixed;top:44px;right:10px;z-index:2147483647;background:#10b981;color:#fff;font:600 11px/1 monospace;padding:6px 13px;border-radius:8px;box-shadow:0 2px 14px rgba(0,0,0,.4);pointer-events:none;transition:opacity .3s}'
    var b=document.createElement('div')
    b.id='__ahb';b.textContent='⚡ CAPTURE MODE'
    var attach=function(){document.body.appendChild(s);document.body.appendChild(b)}
    if(document.body)attach();else document.addEventListener('DOMContentLoaded',attach)
  }
  function notify(){
    var el=document.getElementById('__ahn')
    if(el){el.style.opacity='1';return}
    el=document.createElement('div');el.id='__ahn';el.textContent='✓ Transaction captured'
    document.body&&document.body.appendChild(el)
    setTimeout(function(){el.style.opacity='0'},2200)
    setTimeout(function(){el.remove()},2700)
  }
  function patch(eth){
    if(!eth||eth.__ahp)return eth
    var orig=eth.request.bind(eth)
    eth.request=async function(a){
      var m=a&&a.method||''
      if(m==='eth_sendTransaction'||m==='wallet_sendTransaction'){
        var tx=(a.params||[])[0]
        if(tx&&P){try{P.postMessage({__type:'AH_CAPTURE_TX',tx:tx},'*')}catch(e){}}
        notify()
      }
      return orig(a)
    }
    eth.__ahp=true;return eth
  }
  badge()
  if(window.ethereum)patch(window.ethereum)
  try{
    var d=Object.getOwnPropertyDescriptor(window,'ethereum')
    if(!d||d.configurable!==false){
      var _e=window.ethereum
      Object.defineProperty(window,'ethereum',{get:function(){return _e},set:function(v){_e=patch(v)},configurable:true})
    }
  }catch(e){}
  window.addEventListener('ethereum#initialized',function(){if(window.ethereum)patch(window.ethereum)},{once:true})
  window.addEventListener('eip6963:announceProvider',function(e){if(e.detail&&e.detail.provider)patch(e.detail.provider)})
  try{window.dispatchEvent(new Event('eip6963:requestProvider'))}catch(e){}
})()
</script>`

const BLOCKED_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
])

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end('Method Not Allowed')

  // Auth: token in query param (iframe loads via GET, can't send Authorization header)
  const token = req.query.token || getBearerToken(req)
  if (!token) return res.status(401).json({ error: 'Authentication required' })

  const supabase = createAnonClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) return res.status(401).json({ error: 'Invalid or expired session' })

  const rawUrl = req.query.url
  if (!rawUrl) return res.status(400).end('Missing url parameter')

  let parsed
  try { parsed = new URL(rawUrl) } catch { return res.status(400).end('Invalid URL') }

  if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).end('Only HTTP/S allowed')
  if (BLOCKED_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith('.internal')) {
    return res.status(400).end('URL not allowed')
  }

  let fetchRes
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12000)
    fetchRes = await fetch(rawUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    })
    clearTimeout(timeout)
  } catch (err) {
    console.error('[capture-proxy] fetch_error', { url: rawUrl.slice(0, 80), err: err.message })
    return res.status(502).json({ error: 'Could not reach mint page', detail: err.message })
  }

  const ct = fetchRes.headers.get('content-type') || ''
  if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
    return res.status(415).json({ error: 'Mint page did not return HTML', contentType: ct })
  }

  let html
  try { html = await fetchRes.text() } catch (err) {
    return res.status(502).json({ error: 'Failed to read page body', detail: err.message })
  }

  // Inject capture script + base href at the top of <head>
  const origin = parsed.origin
  const baseTag = html.includes('<base ') ? '' : `<base href="${origin}/">`
  const injection = CAPTURE_SCRIPT + baseTag

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, (m) => `${m}${injection}`)
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html([^>]*)>/i, (m) => `${m}<head>${injection}</head>`)
  } else {
    html = injection + html
  }

  // Our response headers — strip original security restrictions, allow our iframe
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Content-Security-Policy', "default-src * blob: data: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).send(html)
}

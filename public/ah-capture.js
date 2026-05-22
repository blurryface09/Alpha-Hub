;(function () {
  if (window.__AH_CAPTURE_ACTIVE) return
  window.__AH_CAPTURE_ACTIVE = true

  const __AH_PARENT = (function () {
    try { return window.parent !== window ? window.parent : null } catch { return null }
  })()

  function showBadge() {
    const style = document.createElement('style')
    style.textContent = `
      #__ah-badge { position:fixed;top:10px;right:10px;z-index:2147483647;
        background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;
        font:700 11px/1 "SF Mono",monospace;padding:5px 12px;border-radius:99px;
        box-shadow:0 2px 16px rgba(0,0,0,.45);letter-spacing:.04em;pointer-events:none }
      #__ah-notify { position:fixed;top:44px;right:10px;z-index:2147483647;
        background:#10b981;color:#fff;font:600 11px/1 "SF Mono",monospace;
        padding:6px 13px;border-radius:8px;box-shadow:0 2px 14px rgba(0,0,0,.4);
        pointer-events:none;transition:opacity .3s ease }
    `
    const badge = document.createElement('div')
    badge.id = '__ah-badge'
    badge.textContent = '⚡ CAPTURE MODE'
    const attach = () => { document.body?.appendChild(style); document.body?.appendChild(badge) }
    if (document.body) attach()
    else document.addEventListener('DOMContentLoaded', attach)
  }

  function notifyCaptured() {
    let el = document.getElementById('__ah-notify')
    if (el) { el.style.opacity = '1'; return }
    el = document.createElement('div')
    el.id = '__ah-notify'
    el.textContent = '✓ Transaction captured'
    document.body?.appendChild(el)
    setTimeout(() => { el.style.opacity = '0' }, 2200)
    setTimeout(() => el.remove(), 2700)
  }

  function patch(eth) {
    if (!eth || eth.__ah_patched) return eth
    const orig = eth.request.bind(eth)
    eth.request = async function (args) {
      const method = args?.method || ''
      if (method === 'eth_sendTransaction' || method === 'wallet_sendTransaction') {
        const tx = (args.params || [])[0]
        if (tx && __AH_PARENT) {
          try { __AH_PARENT.postMessage({ __type: 'AH_CAPTURE_TX', tx }, '*') } catch {}
          notifyCaptured()
        }
      }
      return orig(args)
    }
    eth.__ah_patched = true
    return eth
  }

  showBadge()

  if (window.ethereum) patch(window.ethereum)

  try {
    const desc = Object.getOwnPropertyDescriptor(window, 'ethereum')
    if (!desc || desc.configurable !== false) {
      let _eth = window.ethereum
      Object.defineProperty(window, 'ethereum', {
        get: () => _eth,
        set: v => { _eth = patch(v) },
        configurable: true,
      })
    }
  } catch {}

  window.addEventListener('ethereum#initialized', () => { if (window.ethereum) patch(window.ethereum) }, { once: true })
  window.addEventListener('eip6963:announceProvider', e => { if (e.detail?.provider) patch(e.detail.provider) })
  try { window.dispatchEvent(new Event('eip6963:requestProvider')) } catch {}
})()

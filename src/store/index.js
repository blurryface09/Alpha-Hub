import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { supabase } from '../lib/supabase'

let resumeListenerAttached = false
let lastResumeRefreshAt = 0
const RESUME_REFRESH_MS = 4 * 60 * 1000

// --- Auth Store --------------------------------------------------
export const useAuthStore = create((set, get) => ({
  user: null,
  profile: null,
  loading: true,
  signingIn: false,
  _authSubscription: null,

  init: async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.user) {
        set({ user: session.user })
        await get().fetchProfile(session.user.id)
      }
      set({ loading: false })

      const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          if (session?.user) {
            set({ user: session.user })
            await get().fetchProfile(session.user.id)
          }
        } else if (event === 'SIGNED_OUT') {
          set({ user: null, profile: null })
        }
      })

      get()._authSubscription?.unsubscribe()
      set({ _authSubscription: subscription })

      if (!resumeListenerAttached) {
        resumeListenerAttached = true
        const recover = async () => {
          if (document.visibilityState !== 'visible') return
          if (Date.now() - lastResumeRefreshAt < RESUME_REFRESH_MS) return
          lastResumeRefreshAt = Date.now()
          try {
            await supabase.auth.refreshSession()
          } catch {}
          const { data: { session } } = await supabase.auth.getSession()
          if (session?.user) {
            set({ user: session.user })
            get().fetchProfile(session.user.id).catch(() => {})
          }
          window.dispatchEvent(new CustomEvent('alphahub:resume'))
        }
        document.addEventListener('visibilitychange', recover)
      }
    } catch (err) {
      console.error('Auth init error:', err)
      set({ loading: false })
    }
  },

  signInWithWallet: async (address, signMessageAsync, chainId = 1) => {
    if (get().signingIn) return { success: false, error: 'Already signing in' }

    try {
      set({ signingIn: true })

      const domain = window.location.host
      const url = new URL(window.location.href)
      url.hash = ''
      const uri = url.href
      const issuedAt = new Date().toISOString()
      const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 16)

      const message = [
        domain + ' wants you to sign in with your Ethereum account:',
        address,
        '',
        'Sign in to Alpha Hub',
        '',
        'URI: ' + uri,
        'Version: 1',
        'Chain ID: ' + chainId,
        'Nonce: ' + nonce,
        'Issued At: ' + issuedAt,
      ].join('\n')

      const signature = await signMessageAsync({ message })

      const { data, error } = await supabase.auth.signInWithWeb3({
        chain: 'ethereum',
        message,
        signature,
      })

      if (error) throw error

      if (data?.user) {
        set({ user: data.user, signingIn: false })
        const profilePayload = {
          id: data.user.id,
          username: 'user_' + data.user.id.slice(0, 6),
          wallet_address: address.toLowerCase(),
        }
        const { error: profileError } = await supabase
          .from('profiles')
          .update(profilePayload)
          .eq('id', data.user.id)
        if (profileError) {
          // Optional profile metadata must never block wallet sign-in.
          await supabase.from('profiles').insert(profilePayload).then(async ({ error }) => {
            if (error?.code === '42703') {
              await supabase.from('profiles').insert({
                id: data.user.id,
                username: profilePayload.username,
              }).catch(() => null)
            }
          }).catch(() => null)
        }
        await get().fetchProfile(data.user.id)
        return { success: true }
      }

      throw new Error('Sign in failed — no user returned')
    } catch (err) {
      console.error('signInWithWallet error:', err)
      set({ signingIn: false })
      return { success: false, error: err.message }
    }
  },

  fetchProfile: async (userId) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single()
      if (error && error.code === 'PGRST116') {
        const { data: newProfile } = await supabase
          .from('profiles')
          .insert({ id: userId, username: 'user_' + userId.slice(0, 6) })
          .select()
          .single()
        if (newProfile) set({ profile: newProfile })
      } else if (data) {
        set({ profile: data })
      }
    } catch (err) {
      console.error('fetchProfile error:', err)
    }
  },

  signOut: async () => {
    await supabase.auth.signOut()
    set({ user: null, profile: null })
  },
}))

// --- Notifications Store -----------------------------------------
export const useNotificationStore = create((set) => ({
  notifications: [],
  unreadCount: 0,

  fetch: async (userId) => {
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (data) {
      set({ notifications: data, unreadCount: data.filter(n => !n.read).length })
    }
  },

  markRead: async (id) => {
    set(s => ({
      notifications: s.notifications.map(n => n.id === id ? { ...n, read: true } : n),
      unreadCount: Math.max(0, s.unreadCount - 1),
    }))
    const { error } = await supabase.from('notifications').update({ read: true }).eq('id', id)
    if (error) console.error('markRead failed:', error.message)
  },

  markAllRead: async (userId) => {
    set(s => ({ notifications: s.notifications.map(n => ({ ...n, read: true })), unreadCount: 0 }))
    const { error } = await supabase.from('notifications').update({ read: true }).eq('user_id', userId)
    if (error) console.error('markAllRead failed:', error.message)
  },

  subscribe: (userId) => {
    const channel = supabase
      .channel('notifications')
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'notifications',
        filter: 'user_id=eq.' + userId,
      }, (payload) => {
        set(s => ({
          notifications: [payload.new, ...s.notifications],
          unreadCount: s.unreadCount + 1,
        }))
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  },
}))

// --- Whale Activity Store -----------------------------------------
export const useWhaleStore = create((set) => ({
  activity: [],
  loading: false,

  fetch: async (userId) => {
    set({ loading: true })
    let query = supabase
      .from('whale_activity')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(100)
    if (userId) query = query.eq('user_id', userId)
    const { data } = await query
    set({ activity: data || [], loading: false })
  },

  subscribe: (userId) => {
    const channel = supabase
      .channel('whale_activity')
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'whale_activity',
        ...(userId ? { filter: 'user_id=eq.' + userId } : {}),
      }, (payload) => {
        set(s => ({ activity: [payload.new, ...s.activity].slice(0, 100) }))
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  },
}))

// --- Monitor Store (project + wallet watchlist) ------------------
export const useMonitorStore = create((set, get) => ({
  watchedProjects: new Set(),
  loading: false,

  fetchWatched: async (userId) => {
    if (!userId) return
    set({ loading: true })
    const { data } = await supabase
      .from('wl_project_watchers')
      .select('project_id')
      .eq('user_id', userId)
    set({
      watchedProjects: new Set((data || []).map(w => w.project_id)),
      loading: false,
    })
  },

  follow: async (userId, projectId) => {
    set(s => ({ watchedProjects: new Set([...s.watchedProjects, projectId]) }))
    const { error } = await supabase
      .from('wl_project_watchers')
      .upsert({ user_id: userId, project_id: projectId }, { onConflict: 'project_id,user_id', ignoreDuplicates: true })
    if (error) {
      set(s => {
        const next = new Set(s.watchedProjects)
        next.delete(projectId)
        return { watchedProjects: next }
      })
      return { error }
    }
    return { error: null }
  },

  unfollow: async (userId, projectId) => {
    set(s => {
      const next = new Set(s.watchedProjects)
      next.delete(projectId)
      return { watchedProjects: next }
    })
    const { error } = await supabase
      .from('wl_project_watchers')
      .delete()
      .eq('user_id', userId)
      .eq('project_id', projectId)
    if (error) {
      set(s => ({ watchedProjects: new Set([...s.watchedProjects, projectId]) }))
      return { error }
    }
    return { error: null }
  },

  isWatching: (projectId) => get().watchedProjects.has(projectId),
}))

// --- Wallet Intel Store ------------------------------------------
export const useWalletIntelStore = create((set, get) => ({
  watchedWallets: [],   // [{id, wallet_address, label, chain}]
  profiles: {},         // { 'address:chain': profile }
  loading: false,

  fetchWatched: async (userId) => {
    if (!userId) return
    set({ loading: true })
    const { data } = await supabase
      .from('whale_watchlist')
      .select('id, wallet_address, label, chain')
      .eq('user_id', userId)
      .eq('is_active', true)
    set({ watchedWallets: data || [], loading: false })
  },

  followWallet: async (userId, address, label, chain = 'eth') => {
    const existing = get().watchedWallets.find(
      w => w.wallet_address.toLowerCase() === address.toLowerCase() && w.chain === chain
    )
    if (existing) return { error: null }

    const tempId = `temp-${Date.now()}`
    set(s => ({ watchedWallets: [...s.watchedWallets, { id: tempId, wallet_address: address, label, chain }] }))
    const { data, error } = await supabase
      .from('whale_watchlist')
      .insert({ user_id: userId, wallet_address: address, label: label || 'Unlabeled', chain, is_active: true })
      .select('id, wallet_address, label, chain')
      .single()

    if (error) {
      set(s => ({ watchedWallets: s.watchedWallets.filter(w => w.id !== tempId) }))
      return { error }
    }
    set(s => ({ watchedWallets: s.watchedWallets.map(w => w.id === tempId ? data : w) }))
    return { error: null }
  },

  unfollowWallet: async (userId, walletId) => {
    set(s => ({ watchedWallets: s.watchedWallets.filter(w => w.id !== walletId) }))
    const { error } = await supabase
      .from('whale_watchlist')
      .delete()
      .eq('id', walletId)
      .eq('user_id', userId)
    if (error) {
      await get().fetchWatched(userId)
      return { error }
    }
    return { error: null }
  },

  isFollowing: (address, chain = 'eth') => {
    return get().watchedWallets.some(
      w => w.wallet_address.toLowerCase() === address.toLowerCase() && w.chain === chain
    )
  },

  getWatchEntry: (address, chain = 'eth') => {
    return get().watchedWallets.find(
      w => w.wallet_address.toLowerCase() === address.toLowerCase() && w.chain === chain
    ) || null
  },

  fetchProfile: async (address, chain = 'eth') => {
    const key = `${address.toLowerCase()}:${chain}`
    if (get().profiles[key]) return get().profiles[key]
    const { data, error } = await supabase
      .from('wallet_profiles')
      .select('*')
      .eq('address', address.toLowerCase())
      .eq('chain', chain)
      .maybeSingle()
    if (error) return null  // table may not exist yet; caller handles fallback
    if (data) {
      set(s => ({ profiles: { ...s.profiles, [key]: data } }))
      return data
    }
    return null
  },
}))

// --- Wallet Follow Store (localStorage, no DB needed) ------------
// Completely separate from whale_watchlist — toggling never affects row display.
export const useWalletFollowStore = create(
  persist(
    (set, get) => ({
      followedKeys: [],  // array of "address:chain" strings

      isFollowing: (address, chain = 'eth') =>
        get().followedKeys.includes(`${(address || '').toLowerCase()}:${chain}`),

      toggle: (address, chain = 'eth') => {
        const key = `${(address || '').toLowerCase()}:${chain}`
        set(s => ({
          followedKeys: s.followedKeys.includes(key)
            ? s.followedKeys.filter(k => k !== key)
            : [...s.followedKeys, key],
        }))
      },
    }),
    { name: 'alphahub-wallet-follows' }
  )
)

// --- Settings Store (persisted) ----------------------------------
export const useSettingsStore = create(
  persist(
    (set) => ({
      etherscanKey: '',
      groqKey: '',
      alchemyKey: '',
      walletConnectId: '',
      theme: 'dark',
      setKeys: (keys) => set(keys),
    }),
    { name: 'alphahub-settings' }
  )
)

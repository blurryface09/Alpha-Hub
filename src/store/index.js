import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { supabase } from '../lib/supabase'

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
      const origin = window.location.origin
      const issuedAt = new Date().toISOString()
      const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 16)

      const message = [
        domain + ' wants you to sign in with your Ethereum account:',
        address,
        '',
        'Sign in to Alpha Hub',
        '',
        'URI: ' + origin,
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
          .upsert({ id: userId, username: 'user_' + userId.slice(0, 6) })
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

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { supabase } from '../lib/supabase'

// --- Auth Store --------------------------------------------------
export const useAuthStore = create((set, get) => ({
  user: null,
  profile: null,
  loading: true,
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

  signInWithWallet: async (address) => {
    try {
      set({ loading: true })
      const email = address.toLowerCase() + '@alphahub.wallet'
      const password = 'AH_' + address.toLowerCase() + '_2024'

      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      if (!signInError && signInData.user) {
        set({ user: signInData.user })
        await get().fetchProfile(signInData.user.id)
        set({ loading: false })
        return { success: true }
      }

      // No account yet - create one
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      })

      if (signUpError) throw signUpError

      if (signUpData.user) {
        set({ user: signUpData.user })
        await get().fetchProfile(signUpData.user.id)
        set({ loading: false })
        return { success: true }
      }

      throw new Error('Sign up failed')
    } catch (err) {
      console.error('signInWithWallet error:', err)
      set({ loading: false })
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
export const useNotificationStore = create((set, get) => ({
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

  fetch: async () => {
    set({ loading: true })
    const { data } = await supabase
      .from('whale_activity')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(100)
    set({ activity: data || [], loading: false })
  },

  subscribe: () => {
    const channel = supabase
      .channel('whale_activity')
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'whale_activity',
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

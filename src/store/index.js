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
      // Get session first
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.user) {
        set({ user: session.user })
        await get().fetchProfile(session.user.id)
      }
      set({ loading: false })

      // Set up listener ONCE with proper cleanup stored
      const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          if (session?.user) {
            set({ user: session.user })
            // Only fetch profile if we don't have it yet
            if (!get().profile) {
              await get().fetchProfile(session.user.id)
            }
          }
        } else if (event === 'SIGNED_OUT') {
          set({ user: null, profile: null })
        }
      })

      // Store unsubscribe function to prevent duplicate listeners
      get()._authSubscription?.unsubscribe()
      set({ _authSubscription: subscription })
    } catch (err) {
      console.error('Auth init error:', err)
      set({ loading: false })
    }
  },

  fetchProfile: async (userId) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single()
      if (error && error.code !== 'PGRST116') {
        console.error('fetchProfile error:', error)
        // Create profile if missing
        const { data: newProfile } = await supabase
          .from('profiles')
          .upsert({ id: userId, username: 'user_' + userId.slice(0,6) })
          .select()
          .single()
        if (newProfile) set({ profile: newProfile })
      } else if (data) {
        set({ profile: data })
      }
    } catch (err) {
      console.error('fetchProfile catch:', err)
    }
  },

  // Get fresh session - call before any DB operation
  getValidSession: async () => {
    const { data: { session }, error } = await supabase.auth.getSession()
    if (error || !session) {
      // Try refresh
      const { data: { session: refreshed } } = await supabase.auth.refreshSession()
      return refreshed
    }
    return session
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
    await supabase.from('notifications').update({ read: true }).eq('id', id)
    set(s => ({
      notifications: s.notifications.map(n => n.id === id ? { ...n, read: true } : n),
      unreadCount: Math.max(0, s.unreadCount - 1),
    }))
  },

  markAllRead: async (userId) => {
    await supabase.from('notifications').update({ read: true }).eq('user_id', userId)
    set(s => ({ notifications: s.notifications.map(n => ({ ...n, read: true })), unreadCount: 0 }))
  },

  subscribe: (userId) => {
    const channel = supabase
      .channel('notifications')
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'notifications',
        filter: `user_id=eq.${userId}`,
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

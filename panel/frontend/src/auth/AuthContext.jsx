import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

import {
  api,
  apiFetch,
  clearTokens,
  getRefreshToken,
  setOnLogout,
  storeTokens,
} from '../api/client'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setOnLogout(() => setUser(null))
    return () => setOnLogout(null)
  }, [])

  // Restore the session on reload: the access token is gone, the refresh is not.
  useEffect(() => {
    let cancelled = false

    async function restore() {
      if (!getRefreshToken()) {
        setLoading(false)
        return
      }
      try {
        const me = await api.get('/auth/me')
        if (!cancelled) setUser(me)
      } catch {
        clearTokens()
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void restore()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (username, password) => {
    const tokens = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    storeTokens(tokens)
    setUser(await api.get('/auth/me'))
  }, [])

  const logout = useCallback(async () => {
    const refresh = getRefreshToken()
    if (refresh) {
      try {
        await api.post('/auth/logout', { refresh_token: refresh })
      } catch {
        // Server-side revoke failed; drop the local session anyway.
      }
    }
    clearTokens()
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({ user, loading, login, logout }),
    [user, loading, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

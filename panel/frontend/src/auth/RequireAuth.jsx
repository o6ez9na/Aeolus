import { Navigate, useLocation } from 'react-router-dom'

import { useAuth } from './AuthContext'

const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 }

export function RequireAuth({ children, minimumRole = 'viewer' }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) return <div className="auth-splash">Loading…</div>
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />
  if (ROLE_RANK[user.role] < ROLE_RANK[minimumRole]) {
    return <Navigate to="/" replace />
  }
  return children
}

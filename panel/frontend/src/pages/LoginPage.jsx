import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import { useTheme } from '../theme/ThemeContext'

export function LoginPage() {
  const { user, login } = useAuth()
  const { theme, toggle } = useTheme()
  const navigate = useNavigate()
  const location = useLocation()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  if (user) return <Navigate to="/nodes" replace />

  async function handleSubmit(event) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(username, password)
      navigate(location.state?.from?.pathname ?? '/nodes', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="term-head" style={{ marginBottom: 4 }}>
          <span className="term-title">aeolus</span>
          <span className="dim">control</span>
          <span className="spacer" />
          <button
            className="btn ghost"
            type="button"
            onClick={toggle}
            aria-label={`Тема: ${theme === 'dark' ? 'тёмная' : 'светлая'}`}
          >
            {theme === 'dark' ? '◐' : '◑'}
          </button>
        </div>

        <label className="field">
          логин
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>
        <label className="field">
          пароль
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}

        <button className="btn" type="submit" disabled={submitting}>
          {submitting ? 'вход…' : 'войти'}
        </button>
      </form>
    </main>
  )
}

import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import { Icon } from '../components/Icon'
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

  if (user) return <Navigate to="/map" replace />

  async function handleSubmit(event) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(username, password)
      navigate(location.state?.from?.pathname ?? '/map', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      <form className="panel login-card" onSubmit={handleSubmit}>
        <div className="panel-head" style={{ alignItems: 'center' }}>
          <span className="brand">
            <span className="rail-logo" style={{ margin: 0 }}>
              <Icon name="logo" size={22} stroke={1.9} />
            </span>
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <b>Aeolus</b>
              <span className="hint">панель OpenVPN-меша</span>
            </span>
          </span>
          <button
            className="icon-btn"
            type="button"
            onClick={toggle}
            aria-label={`Тема: ${theme === 'dark' ? 'тёмная' : 'светлая'}, переключить`}
          >
            <Icon name="theme" />
          </button>
        </div>

        <label className="field">
          Логин
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoFocus
            required
          />
        </label>
        <label className="field">
          Пароль
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && (
          <p role="alert" className="form-error" style={{ margin: 0 }}>
            {error}
          </p>
        )}

        <button className="btn primary" type="submit" disabled={submitting}>
          {submitting ? 'Вхожу…' : 'Войти'}
        </button>
      </form>
    </main>
  )
}

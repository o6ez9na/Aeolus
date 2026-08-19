import { NavLink, Outlet, useLocation } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import { formatAgo, formatBytes } from '../lib/format'
import { useResource } from '../lib/useResource'
import { useTheme } from '../theme/ThemeContext'

const ROLE_LABELS = {
  admin: 'админ',
  operator: 'оператор',
  viewer: 'наблюдатель',
}

const TABS = [
  { to: '/nodes', label: 'узлы' },
  { to: '/clients', label: 'клиенты' },
  { to: '/pki', label: 'pki' },
  { to: '/ccd', label: 'ccd' },
  { to: '/traffic', label: 'трафик' },
  { to: '/audit', label: 'аудит' },
]

function StatStrip({ summary, updatedAt }) {
  if (!summary) return <div className="stats muted">загрузка…</div>

  return (
    <div className="stats fade-in" key={updatedAt}>
      <span className="muted">
        онлайн <span className="hl">{summary.nodes_online}/{summary.nodes_total}</span>
      </span>
      <span className="sep">·</span>
      <span className="muted">
        сессий <span className="hl">{summary.sessions}</span>
      </span>
      <span className="sep">·</span>
      <span className="muted">
        клиентов{' '}
        <span className="hl">
          {summary.clients_active}/{summary.clients_total}
        </span>
      </span>
      <span className="sep">·</span>
      <span className="muted">
        rx <span className="hl">{formatBytes(summary.rx_bytes)}</span>
      </span>
      <span className="muted">
        tx <span className="hl">{formatBytes(summary.tx_bytes)}</span>
      </span>
      <span className="sep">·</span>
      <span className="muted">
        fail{' '}
        <span style={{ color: summary.failed_nodes ? 'var(--err)' : 'var(--text)' }}>
          {summary.failed_nodes}
        </span>
      </span>
    </div>
  )
}

export function AppShell() {
  const { user, logout } = useAuth()
  const { theme, toggle } = useTheme()
  const location = useLocation()

  // Summary is shared chrome, so it lives here and refreshes on its own.
  const { data: summary, updatedAt, reload } = useResource('/nodes/summary', {
    pollMs: 15000,
  })

  return (
    <div className="shell">
      <div className="term">
        <div className="term-head">
          <span className="term-title">aeolus</span>
          <span className="dim">control</span>
          <span className="spacer" />
          {/* Role is shown as a translated chip, so "admin/admin" never reads twice. */}
          <span className="user-chip">
            <span className="muted">{user?.username}</span>
            <span className="role">{ROLE_LABELS[user?.role] ?? user?.role}</span>
          </span>
          <button
            className="btn ghost"
            onClick={toggle}
            title="Переключить тему"
            aria-label={`Тема: ${theme === 'dark' ? 'тёмная' : 'светлая'}`}
          >
            {theme === 'dark' ? '◐ тёмная' : '◑ светлая'}
          </button>
          <button className="btn ghost" onClick={() => void logout()}>
            выход
          </button>
        </div>

        <nav className="tabs">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) => (isActive ? 'tab active' : 'tab')}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>

        <StatStrip summary={summary} updatedAt={updatedAt} />

        {/* Remounting on pathname replays the enter animation on every route change. */}
        <div className="term-body view" key={location.pathname}>
          <Outlet context={{ reloadSummary: reload }} />
        </div>

        <div className="term-foot">
          <span className="dim">openvpn · gRPC+mTLS</span>
          <span className="spacer" />
          <span className="dim">
            обновлено {updatedAt ? formatAgo(new Date(updatedAt).toISOString()) : '—'}
          </span>
        </div>
      </div>
    </div>
  )
}

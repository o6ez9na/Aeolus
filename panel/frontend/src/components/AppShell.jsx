import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import { formatAgo } from '../lib/format'
import { MeshProvider, useMesh } from '../lib/mesh'
import { clientState, nodeState } from '../lib/model'
import { useMeshAlerts } from '../lib/useMeshAlerts'
import { useTheme } from '../theme/ThemeContext'
import { CommandPalette } from './CommandPalette'
import { Icon } from './Icon'

const ROLE_LABELS = {
  admin: 'админ',
  operator: 'оператор',
  viewer: 'наблюдатель',
}

const NAV = [
  { to: '/map', label: 'Карта', icon: 'map' },
  { to: '/clients', label: 'Клиенты', icon: 'users' },
  { to: '/nodes', label: 'Узлы', icon: 'server', badge: 'pending' },
  { to: '/ccd', label: 'Доступ', icon: 'sliders' },
  { to: '/pki', label: 'PKI', icon: 'key' },
  { to: '/traffic', label: 'Трафик', icon: 'activity' },
  { to: '/audit', label: 'Аудит', icon: 'list' },
]

function Stats() {
  const { nodes, clients, updatedAt } = useMesh()
  if (!nodes || !clients) return <div className="stats dim">загрузка…</div>

  const members = nodes.filter((n) => n.approval === 'approved' && n.is_enabled)
  const up = members.filter((n) => nodeState(n) === 'up').length
  const sessions = clients.filter((c) => c.session).length
  const active = clients.filter((c) => c.status === 'active').length
  const down = members.length - up

  return (
    <div className="stats" title={updatedAt ? `обновлено ${formatAgo(new Date(updatedAt).toISOString())}` : ''}>
      <span className="chip lg">
        <span className={down ? 'dot err' : 'dot live'} />
        узлы <b>{up}/{members.length}</b>
      </span>
      <span className="chip lg">
        сессии <b>{sessions}</b>
      </span>
      <span className="chip lg">
        клиенты <b>{active}/{clients.length}</b>
      </span>
    </div>
  )
}

function Rail({ onSearch }) {
  const { user, logout } = useAuth()
  const { theme, toggle } = useTheme()
  const { nodes } = useMesh()
  const pending = (nodes ?? []).filter((n) => n.approval === 'pending').length

  return (
    <nav className="rail" aria-label="Разделы">
      <NavLink to="/map" className="rail-logo" aria-label="Aeolus — карта">
        <Icon name="logo" size={27} stroke={1.9} />
      </NavLink>
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) => (isActive ? 'navi active' : 'navi')}
        >
          <Icon name={item.icon} size={20} stroke={1.6} />
          {item.label}
          {item.badge === 'pending' && pending > 0 && (
            <span className="navi-badge" aria-label={`заявок: ${pending}`}>
              {pending}
            </span>
          )}
        </NavLink>
      ))}
      <button className="navi rail-search" type="button" onClick={onSearch}>
        <Icon name="search" size={20} stroke={1.6} />
        Поиск
      </button>
      <div className="rail-spacer" />
      <button
        className="navi"
        type="button"
        onClick={toggle}
        aria-label={`Тема: ${theme === 'dark' ? 'тёмная' : 'светлая'}, переключить`}
      >
        <Icon name="theme" size={20} stroke={1.6} />
        Тема
      </button>
      <button
        className="navi"
        type="button"
        onClick={() => void logout()}
        title={`${user?.username} · ${ROLE_LABELS[user?.role] ?? user?.role}`}
      >
        <span className="avatar" aria-hidden="true">
          {(user?.username ?? '?').slice(0, 1).toUpperCase()}
        </span>
        Выйти
      </button>
    </nav>
  )
}

function Shell() {
  const location = useLocation()
  const [palette, setPalette] = useState(false)
  const { clients, nodes } = useMesh()
  // Trouble arrives as notices at the bottom, never as a banner that pushes
  // the page down: the map already shows it in red.
  useMeshAlerts()

  useEffect(() => {
    function onKey(event) {
      const typing = event.target.matches?.('input, select, textarea, [contenteditable]')
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPalette((open) => !open)
      } else if (event.key === '/' && !typing) {
        event.preventDefault()
        setPalette(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const noAccess = (clients ?? []).filter((c) => clientState(c) === 'noaccess').length
  const pending = (nodes ?? []).filter((n) => n.approval === 'pending').length

  return (
    <div className="shell">
      <Rail onSearch={() => setPalette(true)} />
      <main className="main">
        <div className="topbar">
          <button className="search-trigger" type="button" onClick={() => setPalette(true)}>
            <Icon name="search" size={16} />
            <span>Клиент, узел, адрес или команда</span>
            <span className="kbd">Ctrl K</span>
          </button>
          <Stats />
          <span className="spacer" />
          {pending > 0 && (
            <NavLink to="/nodes" className="chip lg warn" style={{ textDecoration: 'none' }}>
              <Icon name="warn" size={14} />
              заявок: {pending}
            </NavLink>
          )}
          {noAccess > 0 && (
            <NavLink to="/clients?filter=noaccess" className="chip lg" style={{ textDecoration: 'none' }}>
              без доступа: {noAccess}
            </NavLink>
          )}
        </div>
        {/* Remounting on pathname replays the enter animation on every route change. */}
        <div className="view stack-lg" key={location.pathname}>
          <Outlet />
        </div>
      </main>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  )
}

export function AppShell() {
  return (
    <MeshProvider>
      <Shell />
    </MeshProvider>
  )
}

/** Title row shared by every page. */
export function PageHead({ title, sub, actions, crumbs }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {crumbs}
      <div className="page-head">
        <div className="titles">
          <h1>{title}</h1>
          {sub && <span className="sub">{sub}</span>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  )
}

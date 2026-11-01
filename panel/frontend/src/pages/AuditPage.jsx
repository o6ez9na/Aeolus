import { useEffect, useMemo, useState } from 'react'

import { useAuth } from '../auth/AuthContext'
import { PageHead } from '../components/AppShell'
import { formatStamp } from '../lib/format'
import { useResource } from '../lib/useResource'

const PAGE_SIZE = 50

/** Russian labels for the actions the backend writes. */
const ACTION_LABEL = {
  'auth.login': 'вход',
  'auth.login_failed': 'неудачный вход',
  'auth.logout': 'выход',
  'auth.refresh_rejected': 'refresh отклонён',
  'auth.password_changed': 'смена пароля',
  'user.create': 'создан пользователь',
  'user.delete': 'удалён пользователь',
  'user.disable': 'отключён пользователь',
  'node.create': 'создан узел',
  'node.update': 'изменён узел',
  'node.delete': 'удалён узел',
  'node.approve': 'узел принят',
  'node.reject': 'узел отклонён',
  'node.enrollment_token': 'выдан токен узла',
  'client.create': 'создан клиент',
  'client.update': 'изменён клиент',
  'client.delete': 'удалён клиент',
  'client.delete_refused': 'удаление отклонено',
  'client.config_download': 'скачан профиль',
  'ccd.update': 'изменён ccd',
  'ccd.exit': 'изменён выход',
  'pki.init_ca': 'создан CA',
  'pki.issue_client_cert': 'выпущен клиентский сертификат',
  'pki.revoke_client_cert': 'отозван сертификат',
  'pki.issue_server_cert': 'выпущен серверный сертификат',
  'agent.enroll': 'агент зарегистрирован',
  'agent.enroll_rejected': 'регистрация агента отклонена',
  'ui.groups': 'изменены группы',
  'group.create': 'создана группа',
  'group.update': 'переименована группа',
  'group.grants': 'изменены доступы группы',
  'group.delete': 'удалена группа',
}

// Events that mean something went wrong or something disappeared. They carry
// the reason the log exists, so they are marked instead of blending in.
const LOUD = new Set([
  'auth.login_failed',
  'auth.refresh_rejected',
  'client.delete',
  'client.delete_refused',
  'node.delete',
  'node.reject',
  'group.delete',
  'user.delete',
  'pki.revoke_client_cert',
  'agent.enroll_rejected',
])

const FAMILIES = [
  ['', 'Все'],
  ['auth', 'Вход'],
  ['client', 'Клиенты'],
  ['node', 'Узлы'],
  ['ccd', 'Доступ'],
  ['group', 'Группы'],
  ['pki', 'Сертификаты'],
  ['user', 'Пользователи'],
  ['agent', 'Агенты'],
]

function Detail({ event }) {
  if (!event.detail || Object.keys(event.detail).length === 0) return <span className="dim">—</span>
  const text = Object.entries(event.detail)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.length : typeof value === 'object' && value !== null ? '…' : value}`)
    .join(' · ')
  return (
    <span className="hint mono" title={JSON.stringify(event.detail, null, 2)}>
      {text}
    </span>
  )
}

export function AuditPage() {
  const { user } = useAuth()
  const [family, setFamily] = useState('')
  const [actor, setActor] = useState('')
  const [actorQuery, setActorQuery] = useState('')
  const [offset, setOffset] = useState(0)

  // Typing a login should not fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      setActorQuery(actor.trim())
      setOffset(0)
    }, 300)
    return () => clearTimeout(id)
  }, [actor])

  const path = useMemo(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (family) params.set('action', family)
    if (actorQuery) params.set('actor', actorQuery)
    return `/audit?${params.toString()}`
  }, [family, actorQuery, offset])

  const isAdmin = user?.role === 'admin'
  const log = useResource(isAdmin ? path : null, { pollMs: 30000 })

  if (!isAdmin) {
    return (
      <>
        <PageHead title="Аудит" />
        <div className="panel empty-state">
          <h3>Журнал доступен только админу</h3>
          <span>В нём видно, кто и с какого адреса что делал.</span>
        </div>
      </>
    )
  }

  const items = log.data?.items ?? []
  const total = log.data?.total ?? 0
  const from = total === 0 ? 0 : offset + 1
  const to = offset + items.length

  return (
    <>
      <PageHead title="Аудит" />
      <section className="panel" style={{ overflow: 'hidden' }}>
        <div className="toolbar">
          {FAMILIES.map(([value, label]) => (
            <button
              key={value || 'all'}
              type="button"
              className={`seg${family === value ? ' on' : ''}`}
              aria-pressed={family === value}
              onClick={() => {
                setFamily(value)
                setOffset(0)
              }}
            >
              {label}
            </button>
          ))}
          <span className="spacer" />
          <input
            className="input"
            style={{ width: 180, height: 32 }}
            placeholder="Кто (логин)"
            aria-label="Фильтр по логину"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
          />
          <span className="hint">{total === 0 ? 'записей нет' : `${from}–${to} из ${total}`}</span>
          <button
            className="btn sm"
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Новее
          </button>
          <button className="btn sm" type="button" disabled={to >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
            Старее
          </button>
        </div>
        {log.error && <div className="notice err">{log.error}</div>}
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th>Когда</th>
                <th>Кто</th>
                <th>Действие</th>
                <th>Объект</th>
                <th>Детали</th>
                <th>Адрес</th>
              </tr>
            </thead>
            <tbody>
              {!log.error && items.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">{log.loading ? 'загрузка журнала…' : 'Под фильтр ничего не попало'}</div>
                  </td>
                </tr>
              )}
              {items.map((event) => (
                <tr key={event.id}>
                  <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>
                    {formatStamp(event.created_at)}
                  </td>
                  <td>
                    <span className="mono" style={{ fontWeight: 600 }}>
                      {event.actor_username ?? 'система'}
                    </span>
                    {event.actor_role && <div className="hint">{event.actor_role}</div>}
                  </td>
                  <td className={LOUD.has(event.action) ? 'err-text' : ''} title={event.action}>
                    {ACTION_LABEL[event.action] ?? event.action}
                  </td>
                  <td>
                    <span className="mono">{event.target_label ?? '—'}</span>
                    {event.target_type && <div className="hint">{event.target_type}</div>}
                  </td>
                  <td style={{ maxWidth: 280 }}>
                    <Detail event={event} />
                  </td>
                  <td className="mono dim">{event.actor_ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

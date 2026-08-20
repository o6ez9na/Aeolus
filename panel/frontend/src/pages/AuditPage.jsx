import { useEffect, useMemo, useState } from 'react'

import { useAuth } from '../auth/AuthContext'
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
  'node.enrollment_token': 'выдан токен узла',
  'client.create': 'создан клиент',
  'client.update': 'изменён клиент',
  'client.delete': 'удалён клиент',
  'client.delete_refused': 'удаление отклонено',
  'client.config_download': 'скачан профиль',
  'pki.init_ca': 'создан CA',
  'pki.issue_client_cert': 'выпущен клиентский сертификат',
  'pki.revoke_client_cert': 'отозван сертификат',
  'pki.issue_server_cert': 'выпущен серверный сертификат',
  'agent.enroll': 'агент зарегистрирован',
  'agent.enroll_rejected': 'регистрация агента отклонена',
}

// Events that mean something went wrong or something disappeared. They carry
// the reason the log exists, so they are marked instead of blending in.
const LOUD = new Set([
  'auth.login_failed',
  'auth.refresh_rejected',
  'client.delete',
  'client.delete_refused',
  'node.delete',
  'user.delete',
  'pki.revoke_client_cert',
  'agent.enroll_rejected',
])

const FAMILIES = [
  ['', 'все действия'],
  ['auth', 'вход и сессии'],
  ['client', 'клиенты'],
  ['node', 'узлы'],
  ['pki', 'сертификаты'],
  ['user', 'пользователи'],
  ['agent', 'агенты'],
]

function formatStamp(iso) {
  const date = new Date(iso)
  return `${date.toLocaleDateString('ru-RU')} ${date.toLocaleTimeString('ru-RU')}`
}

function Detail({ event }) {
  if (!event.detail || Object.keys(event.detail).length === 0) return <span className="sub">—</span>
  const text = Object.entries(event.detail)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.length : value}`)
    .join(' · ')
  return (
    <span className="sub" title={JSON.stringify(event.detail, null, 2)}>
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
      <div className="empty">
        <div className="name">журнал доступен только админу</div>
        <p className="sub" style={{ margin: '8px 0 0' }}>
          В нём видно, кто и с какого адреса что делал, поэтому читать его может
          только администратор.
        </p>
      </div>
    )
  }

  // The filters stay mounted while a request is in flight: re-rendering them
  // would take the focus out of the input mid-typing.
  const items = log.data?.items ?? []
  const total = log.data?.total ?? 0
  const from = total === 0 ? 0 : offset + 1
  const to = offset + items.length

  return (
    <>
      <div className="audit-filters">
        <select
          value={family}
          aria-label="фильтр по разделу"
          onChange={(event) => {
            setFamily(event.target.value)
            setOffset(0)
          }}
        >
          {FAMILIES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        <input
          placeholder="кто (логин)"
          aria-label="фильтр по логину"
          value={actor}
          onChange={(event) => setActor(event.target.value)}
        />

        <span className="sub">
          {total === 0 ? 'записей нет' : `${from}–${to} из ${total}`}
        </span>

        <span className="audit-pager">
          <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            новее
          </button>
          <button className="btn" disabled={to >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
            старее
          </button>
        </span>
      </div>

      <div className="row audit head">
        <span className="dim">когда</span>
        <span className="dim">кто</span>
        <span className="dim">действие</span>
        <span className="dim">объект</span>
        <span className="dim">детали</span>
        <span className="dim">адрес</span>
      </div>

      {log.error && <div className="empty form-error">{log.error}</div>}

      {!log.error && items.length === 0 && (
        <div className="empty">
          {log.loading ? 'загрузка журнала…' : 'под фильтр ничего не попало.'}
        </div>
      )}

      {items.map((event) => (
        <div className="row audit" key={event.id}>
          <span className="muted">{formatStamp(event.created_at)}</span>
          <span>
            <span className="name">{event.actor_username ?? 'система'}</span>
            {event.actor_role && <div className="sub">{event.actor_role}</div>}
          </span>
          <span className={LOUD.has(event.action) ? 'sub err' : 'muted'} title={event.action}>
            {ACTION_LABEL[event.action] ?? event.action}
          </span>
          <span>
            <span className="name">{event.target_label ?? '—'}</span>
            {event.target_type && <div className="sub">{event.target_type}</div>}
          </span>
          <Detail event={event} />
          <span className="sub">{event.actor_ip ?? '—'}</span>
        </div>
      ))}
    </>
  )
}

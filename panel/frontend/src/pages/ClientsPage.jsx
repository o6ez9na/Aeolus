import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { authorizedDownload } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { PageHead } from '../components/AppShell'
import {
  ClientInspector,
  expiryFrom,
  generatePassword,
  holdCredentials,
  importHandout,
} from '../components/ClientInspector'
import { GroupEditor } from '../components/GroupEditor'
import { Icon } from '../components/Icon'
import { Drawer } from '../components/Overlay'
import { useToast } from '../components/Toast'
import { api } from '../api/client'
import { daysUntil, formatAgo, formatBytes, formatDate, formatSince } from '../lib/format'
import { groupSummary, membersOf } from '../lib/groups'
import { useMesh } from '../lib/mesh'
import {
  CLIENT_STATE_LABEL,
  canEdit,
  clientState,
  dotClass,
  exitGrant,
  nodeState,
  sessionBytes,
} from '../lib/model'

const FILTERS = [
  ['all', 'Все', () => true],
  ['online', 'В сети', (c) => clientState(c) === 'online'],
  ['noaccess', 'Без доступа', (c) => clientState(c) === 'noaccess'],
  ['exit', 'С выходом', (c) => Boolean(exitGrant(c))],
  ['off', 'Отключены', (c) => ['disabled', 'revoked', 'expired'].includes(clientState(c))],
  [
    'expiring',
    'Истекают',
    (c) => {
      const days = daysUntil(c.expires_at)
      return days !== null && days >= 0 && days <= 14
    },
  ],
]

function AccessChips({ client }) {
  if (client.access.length === 0) return <span className="chip warn">нет доступа</span>
  return (
    <div className="row-wrap" style={{ gap: 5, maxWidth: 300 }}>
      {client.access
        .slice()
        .sort((a, b) => Number(b.is_exit) - Number(a.is_exit))
        .map((grant) => (
          <span
            key={grant.grant_id}
            className={`chip mono${grant.is_exit ? ' exit' : ''}`}
            title={grant.group_id ? 'выдано группой' : 'личный доступ'}
            style={grant.group_id ? { borderStyle: 'dashed' } : undefined}
          >
            {grant.is_exit ? `⇱ ${grant.node_name}` : grant.node_name}
            {grant.networks ? `: ${grant.networks.join(', ')}` : ''}
          </span>
        ))}
    </div>
  )
}

function NewClient({ onClose, onCreated, initialGroup }) {
  const mesh = useMesh()
  const toast = useToast()
  const nodes = (mesh.nodes ?? [])
    .filter((n) => n.approval === 'approved')
    .sort((a, b) => Number(b.is_hub) - Number(a.is_hub) || a.name.localeCompare(b.name))
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [groupId, setGroupId] = useState(initialGroup ?? '')
  const [nodeIds, setNodeIds] = useState([])
  const [exit, setExit] = useState(null)
  const [term, setTerm] = useState('never')
  const [issue, setIssue] = useState(true)
  const [password, setPassword] = useState(generatePassword)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const group = (mesh.groups ?? []).find((g) => g.id === groupId) ?? null
  const fromGroup = new Set(group ? group.grants.map((g) => g.node_id) : [])
  const groupExit = group?.grants.find((g) => g.is_exit) ?? null

  const toggle = (id) => {
    setNodeIds((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))
    if (exit === id) setExit(null)
  }

  async function submit(download) {
    setBusy(true)
    setError(null)
    try {
      let client = await api.post('/clients', {
        common_name: name.trim(),
        label: label.trim() || null,
        node_ids: nodeIds.filter((id) => !fromGroup.has(id)),
        group_id: group?.id ?? null,
        expires_at: term === 'never' ? null : expiryFrom(term),
        import_password: password,
      })
      holdCredentials(client.id, { username: client.common_name, password })
      if (exit && !groupExit) {
        const grant = client.access.find((g) => g.node_id === exit)
        if (grant) await api.post(`/ccd/${grant.grant_id}/exit`, { is_exit: true })
      }
      if (issue) client = await api.post(`/pki/clients/${client.id}/certificate`)
      if (issue && download) {
        await authorizedDownload(`/clients/${client.id}/config`, `${client.common_name}.ovpn`)
      }
      toast.info(`${client.common_name} создан${issue ? ', сертификат выпущен' : ''}`)
      await mesh.reload()
      onCreated(client)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать клиента')
    } finally {
      setBusy(false)
    }
  }

  const valid = /^[a-zA-Z0-9_.-]+$/.test(name.trim()) && password.length >= 8

  return (
    <Drawer title="Новый клиент" onClose={onClose}>
      <form
        className="stack-lg"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid) void submit(true)
        }}
      >
        <div className="stack">
          <span className="lbl">1 · Кто это</span>
          <label className="field">
            Имя профиля (латиница, цифры, - _ .)
            <input
              className="input mono"
              autoFocus
              required
              pattern="[a-zA-Z0-9_.\-]+"
              placeholder="anna-phone"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            Подпись для себя
            <input
              className="input"
              placeholder="Телефон Ани"
              maxLength={128}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="lbl">2 · Группа</span>
          <select
            className="select"
            aria-label="Группа"
            value={groupId}
            onChange={(event) => {
              setGroupId(event.target.value)
              setExit(null)
            }}
          >
            <option value="">Без группы</option>
            {(mesh.groups ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          {group && <span className="hint mono">{groupSummary(group)}</span>}
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <span className="lbl">{group ? 'Личные доступы сверху группы' : '3 · Куда пускать'}</span>
          <div className="bleed">
            {nodes.map((node) => {
              const inherited = fromGroup.has(node.id)
              return (
                <label key={node.id} className="check-row" style={inherited ? { opacity: 0.6 } : undefined}>
                  <input
                    type="checkbox"
                    checked={inherited || nodeIds.includes(node.id)}
                    disabled={inherited}
                    onChange={() => toggle(node.id)}
                  />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                    <span className="mono" style={{ fontSize: 13 }}>
                      {node.name}
                    </span>
                    <span className="hint mono">
                      {inherited ? 'даёт группа' : node.is_hub ? 'сама панель' : node.subnets.join(', ')}
                    </span>
                  </span>
                  {nodeState(node) !== 'up' && <span className="err-text" style={{ fontSize: 11 }}>недоступен</span>}
                </label>
              )
            })}
          </div>
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <span className="lbl">Выход в интернет</span>
          {groupExit ? (
            <div className="callout">
              Выход задаёт группа: через <span className="mono">{groupExit.node_name}</span>
            </div>
          ) : (
            <div className="bleed" style={{ gap: 4 }}>
              {[null, ...new Set([...fromGroup, ...nodeIds])].map((id) => {
                const node = nodes.find((n) => n.id === id)
                return (
                  <button
                    key={id ?? 'none'}
                    type="button"
                    className={`opt${exit === id ? ' on' : ''}`}
                    aria-pressed={exit === id}
                    onClick={() => setExit(id)}
                  >
                    <span className="radio" />
                    <span style={{ fontSize: 13, fontWeight: 500 }}>
                      {node ? (
                        <>
                          Через <span className="mono">{node.name}</span>
                        </>
                      ) : (
                        'Не выпускать, только сети'
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="lbl">Срок</span>
          <div className="seg-group fill">
            {[
              ['30', '30 дней'],
              ['90', '90 дней'],
              ['365', 'Год'],
              ['never', 'Бессрочно'],
            ].map(([value, text]) => (
              <button
                key={value}
                type="button"
                className={`seg${term === value ? ' on' : ''}`}
                aria-pressed={term === value}
                onClick={() => setTerm(value)}
              >
                {text}
              </button>
            ))}
          </div>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <span className="lbl">Вход в OpenVPN Connect</span>
          <pre className="code wrap" style={{ fontSize: 12.5 }}>
            {importHandout(name.trim() || '—', password)}
          </pre>
          <div className="row-wrap">
            <input
              className="input mono"
              style={{ flex: 1, minWidth: 160 }}
              aria-label="Пароль для OpenVPN Connect"
              minLength={8}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              className="btn sm"
              type="button"
              onClick={() => setPassword(generatePassword())}
            >
              Другой
            </button>
            <button
              className="btn sm"
              type="button"
              onClick={() => void navigator.clipboard?.writeText(importHandout(name.trim(), password))}
            >
              <Icon name="copy" size={14} />
              Скопировать
            </button>
          </div>
          <span className="hint">
            {password.length < 8
              ? 'Пароль короче 8 символов.'
              : 'После создания панель хранит лишь хеш: скопируй сейчас или со страницы клиента.'}
          </span>
        </div>

        <div className="bleed">
          <button type="button" className="trow" aria-pressed={issue} onClick={() => setIssue((v) => !v)}>
            <span className={issue ? 'sw on' : 'sw'} />
            <span className="t-main">
              <span className="t-title">Сразу выпустить сертификат</span>
              <span className="t-sub">без него профиль не скачать</span>
            </span>
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="stack" style={{ gap: 8 }}>
          <button className="btn primary" type="submit" disabled={busy || !valid || !issue}>
            {busy ? 'Создаю…' : 'Создать и скачать .ovpn'}
          </button>
          <button className="btn" type="button" disabled={busy || !valid} onClick={() => void submit(false)}>
            Только создать
          </button>
        </div>
      </form>
    </Drawer>
  )
}

function BulkBar({ selected, onClear }) {
  const mesh = useMesh()
  const nodes = (mesh.nodes ?? []).filter((n) => n.approval === 'approved')
  const names = selected.map((c) => c.common_name).join(', ')

  const pick = (handler) => (event) => {
    const value = event.target.value
    event.target.value = ''
    if (value) void handler(value).catch(() => {})
  }

  return (
    <div className="bulkbar">
      <span style={{ fontWeight: 500, marginRight: 6 }}>
        Выбрано {selected.length}: <span className="mono">{names}</span>
      </span>
      <select
        className="select"
        style={{ width: 'auto', height: 32 }}
        aria-label="Выдать доступ к узлу"
        defaultValue=""
        onChange={pick((id) =>
          mesh.bulk(
            selected.filter((c) => !c.node_ids.includes(id)),
            (c, { patchClient }) => patchClient(c, { node_ids: [...c.node_ids, id] }),
            `Доступ к ${mesh.nodeName(id)} выдан`,
          ),
        )}
      >
        <option value="">Выдать доступ…</option>
        {nodes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.name}
          </option>
        ))}
      </select>
      <select
        className="select"
        style={{ width: 'auto', height: 32 }}
        aria-label="В группу"
        defaultValue=""
        onChange={pick((id) =>
          mesh.bulk(
            selected,
            (c, { patchClient }) => patchClient(c, { group_id: id === 'none' ? null : id }),
            id === 'none'
              ? 'Выведены из групп, доступы групп сняты'
              : `Теперь в группе «${mesh.groups.find((g) => g.id === id)?.name}»`,
          ),
        )}
      >
        <option value="">В группу…</option>
        <option value="none">без группы</option>
        {(mesh.groups ?? []).map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
      <select
        className="select"
        style={{ width: 'auto', height: 32 }}
        aria-label="Сменить выход"
        defaultValue=""
        onChange={pick((id) =>
          mesh.bulk(
            selected,
            (c, { setExitRaw }) => setExitRaw(c, id === 'none' ? null : id),
            id === 'none' ? 'Выход в интернет снят' : `Выход теперь через ${mesh.nodeName(id)}`,
          ),
        )}
      >
        <option value="">Сменить выход…</option>
        <option value="none">не выпускать</option>
        {nodes.map((n) => (
          <option key={n.id} value={n.id}>
            через {n.name}
          </option>
        ))}
      </select>
      <select
        className="select"
        style={{ width: 'auto', height: 32 }}
        aria-label="Продлить"
        defaultValue=""
        onChange={pick((term) =>
          mesh.bulk(
            selected,
            (c, { patchClient }) => patchClient(c, { expires_at: expiryFrom(term, c.expires_at) }),
            'Сроки обновлены',
          ),
        )}
      >
        <option value="">Продлить…</option>
        <option value="30">+30 дней</option>
        <option value="90">+90 дней</option>
        <option value="365">+год</option>
        <option value="never">бессрочно</option>
      </select>
      <button
        className="btn sm"
        type="button"
        onClick={() =>
          void mesh
            .bulk(
              selected.filter((c) => c.status === 'active'),
              (c, { patchClient }) => patchClient(c, { status: 'disabled' }),
              'Отключены',
            )
            .catch(() => {})
        }
      >
        Отключить
      </button>
      <button
        className="btn sm"
        type="button"
        onClick={() =>
          void mesh
            .bulk(
              selected.filter((c) => c.status === 'disabled'),
              (c, { patchClient }) => patchClient(c, { status: 'active' }),
              'Включены',
            )
            .catch(() => {})
        }
      >
        Включить
      </button>
      <span className="spacer" />
      <button className="btn sm ghost" type="button" onClick={onClear}>
        Снять выбор
      </button>
    </div>
  )
}

export function ClientsPage() {
  const { user } = useAuth()
  const mesh = useMesh()
  const editable = canEdit(user)
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [nodeFilter, setNodeFilter] = useState('')
  const [newGroup, setNewGroup] = useState(null)
  const [checked, setChecked] = useState([])

  const filter = params.get('filter') ?? 'all'
  const openId = params.get('open')
  const groupFilter = params.get('group') ?? ''
  const openGroup = params.get('editgroup')
  const creating = params.get('new') === '1'

  const setParam = (key, value) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (value) p.set(key, value)
        else p.delete(key)
        return p
      },
      { replace: key !== 'open' },
    )

  const clients = useMemo(() => mesh.clients ?? [], [mesh.clients])
  const rows = useMemo(() => {
    const test = FILTERS.find(([key]) => key === filter)?.[2] ?? (() => true)
    const q = query.trim().toLowerCase()
    return clients.filter(
      (c) =>
        test(c) &&
        (!nodeFilter || c.node_ids.includes(nodeFilter)) &&
        (!groupFilter || (groupFilter === 'none' ? !c.group_id : c.group_id === groupFilter)) &&
        (!q ||
          `${c.common_name} ${c.label ?? ''} ${c.tunnel_address ?? ''} ${c.session?.real_address ?? ''}`
            .toLowerCase()
            .includes(q)),
    )
  }, [clients, filter, query, nodeFilter, groupFilter])

  const maxBytes = Math.max(1, ...clients.map((c) => sessionBytes(c).rx + sessionBytes(c).tx))
  const selected = clients.filter((c) => checked.includes(c.id))
  const open = clients.find((c) => c.id === openId)

  if (mesh.loading) {
    return (
      <>
        <PageHead title="Клиенты" />
        <div className="panel empty-state">загрузка клиентов…</div>
      </>
    )
  }

  const online = clients.filter((c) => c.session).length

  return (
    <>
      <PageHead
        title="Клиенты"
        sub={`${clients.length} профилей · ${online} в сети`}
        actions={
          editable && (
            <button className="btn primary" type="button" onClick={() => setParam('new', '1')}>
              <Icon name="plus" size={15} stroke={2} />
              Новый клиент
            </button>
          )
        }
      />

      <section className="panel panel-pad stack" aria-label="Группы">
        <div className="panel-head">
          <h2>Группы</h2>
          <span className="hint">роль: доступы задаются у группы, участники получают их сами</span>
        </div>
        <div className="group-strip">
          {(mesh.groups ?? []).map((group) => {
            const members = membersOf(group, clients)
            return (
              <button
                key={group.id}
                type="button"
                className={`group-card${groupFilter === group.id ? ' on' : ''}`}
                onClick={() => setParam('editgroup', group.id)}
              >
                <span className="row-wrap" style={{ gap: 8, flexWrap: 'nowrap' }}>
                  <Icon name="group" size={15} />
                  <b>{group.name}</b>
                  <span className="hint" style={{ marginLeft: 'auto' }}>
                    {members.length} · в сети {members.filter((c) => c.session).length}
                  </span>
                </span>
                <span className="hint mono" style={{ textAlign: 'left' }}>
                  {groupSummary(group)}
                </span>
              </button>
            )
          })}
          {editable &&
            (newGroup === null ? (
              <button type="button" className="group-card add" onClick={() => setNewGroup('')}>
                <Icon name="plus" size={16} />
                Новая группа
              </button>
            ) : (
              <form
                className="group-card"
                onSubmit={(event) => {
                  event.preventDefault()
                  const name = newGroup.trim()
                  if (!name) return
                  void mesh
                    .createGroup({ name, grants: [] })
                    .then((group) => {
                      setNewGroup(null)
                      setParam('editgroup', group.id)
                    })
                    .catch(() => {})
                }}
              >
                <input
                  className="input"
                  autoFocus
                  placeholder="adm, local, гости…"
                  aria-label="Название новой группы"
                  maxLength={64}
                  value={newGroup}
                  onChange={(event) => setNewGroup(event.target.value)}
                  onKeyDown={(event) => event.key === 'Escape' && setNewGroup(null)}
                />
                <span className="row-wrap">
                  <button className="btn sm primary" type="submit">
                    Создать
                  </button>
                  <button className="btn sm ghost" type="button" onClick={() => setNewGroup(null)}>
                    Отмена
                  </button>
                </span>
              </form>
            ))}
          {!editable && (mesh.groups ?? []).length === 0 && <span className="hint">Групп пока нет</span>}
        </div>
      </section>

      <section className="panel" aria-label="Список клиентов" style={{ overflow: 'hidden' }}>
        <div className="toolbar">
          {FILTERS.map(([key, label, test]) => (
            <button
              key={key}
              type="button"
              className={`seg${filter === key ? ' on' : ''}`}
              aria-pressed={filter === key}
              onClick={() => setParam('filter', key === 'all' ? null : key)}
            >
              {key === 'online' && <span className="dot live" />}
              {key === 'noaccess' && <span className="dot warn" />}
              {label} <b>{clients.filter(test).length}</b>
            </button>
          ))}
          <span className="spacer" />
          <input
            className="input"
            style={{ width: 220, height: 32 }}
            type="search"
            placeholder="Имя, подпись, адрес"
            aria-label="Поиск клиентов"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            className="select"
            style={{ width: 'auto', height: 32 }}
            aria-label="Фильтр по группе"
            value={groupFilter}
            onChange={(event) => setParam('group', event.target.value || null)}
          >
            <option value="">Группа: любая</option>
            <option value="none">без группы</option>
            {(mesh.groups ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <select
            className="select"
            style={{ width: 'auto', height: 32 }}
            aria-label="Фильтр по узлу"
            value={nodeFilter}
            onChange={(event) => setNodeFilter(event.target.value)}
          >
            <option value="">Узел: любой</option>
            {(mesh.nodes ?? [])
              .filter((n) => n.approval === 'approved')
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
          </select>
        </div>

        {editable && selected.length > 0 && <BulkBar selected={selected} onClear={() => setChecked([])} />}

        <div className="table-wrap">
          <table className="table wide">
            <thead>
              <tr>
                {editable && (
                  <th style={{ width: 28 }}>
                    <input
                      type="checkbox"
                      aria-label="Выбрать всех"
                      checked={rows.length > 0 && rows.every((r) => checked.includes(r.id))}
                      onChange={(event) =>
                        setChecked(event.target.checked ? rows.map((r) => r.id) : [])
                      }
                      style={{ accentColor: 'var(--accent)' }}
                    />
                  </th>
                )}
                <th>Клиент</th>
                <th>Группа</th>
                <th>Доступ и выход</th>
                <th className="hide-m">Адрес</th>
                <th>Сессия</th>
                <th className="hide-m">Трафик сессии</th>
                <th className="hide-m">Срок</th>
                <th>
                  <span className="sr-only">Профиль</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <div className="empty-state">
                      {clients.length === 0 ? (
                        <>
                          <h3>Клиентов пока нет</h3>
                          {editable && <span>Нажми «Новый клиент» — это займёт полминуты.</span>}
                        </>
                      ) : (
                        'Под фильтр никто не попал'
                      )}
                    </div>
                  </td>
                </tr>
              )}
              {rows.map((client) => {
                const state = clientState(client)
                const bytes = sessionBytes(client)
                const days = daysUntil(client.expires_at)
                return (
                  <tr
                    key={client.id}
                    className={`clickable${checked.includes(client.id) ? ' sel' : ''}`}
                    onClick={() => setParam('open', client.id)}
                  >
                    {editable && (
                      <td onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Выбрать ${client.common_name}`}
                          checked={checked.includes(client.id)}
                          onChange={(event) =>
                            setChecked((list) =>
                              event.target.checked ? [...list, client.id] : list.filter((id) => id !== client.id),
                            )
                          }
                          style={{ accentColor: 'var(--accent)' }}
                        />
                      </td>
                    )}
                    <td>
                      <div className="name-cell">
                        <span className={`${dotClass(state)}${state === 'online' ? ' pulse' : ''}`} />
                        <span className="names" style={{ opacity: state === 'disabled' || state === 'revoked' ? 0.6 : 1 }}>
                          <button
                            type="button"
                            className="n"
                            style={{ all: 'unset', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontWeight: 600, whiteSpace: 'nowrap' }}
                            onClick={(event) => {
                              event.stopPropagation()
                              setParam('open', client.id)
                            }}
                          >
                            {client.common_name}
                          </button>
                          <span className="l">
                            {[client.label, state !== 'online' && state !== 'offline' ? CLIENT_STATE_LABEL[state] : null]
                              .filter(Boolean)
                              .join(' · ') || ' '}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td>
                      {client.group_name ? (
                        <span className="chip">
                          <Icon name="group" size={12} />
                          {client.group_name}
                        </span>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td>
                      <AccessChips client={client} />
                    </td>
                    <td className="mono muted hide-m">{client.session?.virtual_address || client.tunnel_address || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }} className={client.session ? 'ok-text' : 'dim'}>
                      {client.session
                        ? `${client.session.proto} · ${formatSince(client.session.connected_since)}`
                        : client.last_seen_at
                          ? `был ${formatAgo(client.last_seen_at)}`
                          : 'не подключался'}
                    </td>
                    <td className="hide-m">
                      <div className="row-wrap" style={{ gap: 10, flexWrap: 'nowrap' }}>
                        <span className="bar">
                          <span style={{ width: `${Math.round(((bytes.rx + bytes.tx) / maxBytes) * 100)}%` }} />
                        </span>
                        <span className="mono muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                          {client.session ? formatBytes(bytes.rx + bytes.tx) : '—'}
                        </span>
                      </div>
                    </td>
                    <td className={`hide-m ${days !== null && days <= 14 ? 'warn-text' : 'muted'}`} style={{ whiteSpace: 'nowrap' }}>
                      {client.expires_at ? formatDate(client.expires_at) : 'бессрочно'}
                    </td>
                    <td className="actions-cell" onClick={(event) => event.stopPropagation()}>
                      {client.cert_serial && client.status !== 'revoked' ? (
                        <button
                          className="icon-btn"
                          type="button"
                          aria-label={`Скачать ${client.common_name}.ovpn`}
                          title="Скачать .ovpn"
                          onClick={() => mesh.downloadConfig(client)}
                        >
                          <Icon name="download" size={16} />
                        </button>
                      ) : editable && client.status !== 'revoked' ? (
                        <button className="btn sm" type="button" onClick={() => void mesh.issueCert(client).catch(() => {})}>
                          Выпустить
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="toolbar" style={{ borderBottom: 0, borderTop: '1px solid var(--line)' }}>
          <span className="hint">
            Трафик — счётчики текущей сессии на хабе, после переподключения они начинаются заново.
          </span>
        </div>
      </section>

      {open && (
        <Drawer title="Клиент" onClose={() => setParam('open', null)}>
          <ClientInspector key={open.id} client={open} />
        </Drawer>
      )}
      {openGroup && (mesh.groups ?? []).find((g) => g.id === openGroup) && (
        <Drawer title="Группа" onClose={() => setParam('editgroup', null)} width={440}>
          <GroupEditor
            key={openGroup}
            group={mesh.groups.find((g) => g.id === openGroup)}
            onSelectClient={(client) =>
              setParams(
                (prev) => {
                  const p = new URLSearchParams(prev)
                  p.delete('editgroup')
                  p.set('open', client.id)
                  return p
                },
                { replace: true },
              )
            }
            onDeleted={() => setParam('editgroup', null)}
          />
        </Drawer>
      )}
      {creating && editable && (
        <NewClient
          initialGroup={groupFilter && groupFilter !== 'none' ? groupFilter : ''}
          onClose={() => setParam('new', null)}
          onCreated={(client) =>
            setParams(
              (prev) => {
                const p = new URLSearchParams(prev)
                p.delete('new')
                p.set('open', client.id)
                return p
              },
              { replace: true },
            )
          }
        />
      )}
    </>
  )
}

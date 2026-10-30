import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { apiText } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { daysUntil, formatAgo, formatBytes, formatDate, formatSince } from '../lib/format'
import { useMesh } from '../lib/mesh'
import {
  CLIENT_STATE_LABEL,
  canEdit,
  clientNetworks,
  clientState,
  dotClass,
  exitGrant,
  nodeState,
  sessionBytes,
} from '../lib/model'
import { scopeText } from '../lib/groups'
import { ConfirmButton } from './ConfirmButton'
import { Icon } from './Icon'
import { ScopeEditor } from './ScopeEditor'

const EXPIRY_CHOICES = [
  ['', 'Срок'],
  ['30', '+30 дней'],
  ['90', '+90 дней'],
  ['365', '+год'],
  ['never', 'бессрочно'],
]

export function expiryFrom(choice, base) {
  if (choice === 'never') return null
  const start = base && new Date(base).getTime() > Date.now() ? new Date(base) : new Date()
  start.setDate(start.getDate() + Number(choice))
  return start.toISOString()
}

function CcdPreview({ client }) {
  const [text, setText] = useState(null)
  const [error, setError] = useState(null)
  const signature = JSON.stringify(client.access)
  useEffect(() => {
    let live = true
    apiText(`/clients/${client.id}/ccd`)
      .then((t) => live && setText(t))
      .catch((err) => live && setError(err.message))
    return () => {
      live = false
    }
  }, [client.id, signature])
  if (error) return <div className="form-error">{error}</div>
  if (text === null) return <div className="hint">загрузка…</div>
  return (
    <pre className="code wrap" style={{ fontSize: 11.5 }}>
      {text.trim()}
    </pre>
  )
}

/**
 * Setting a client up from OpenVPN Connect itself: the person types the
 * panel's address, their name and a password, and the app fetches the profile.
 */
function ProfileImport({ client, editable }) {
  const mesh = useMesh()
  const [busy, setBusy] = useState(false)
  // Only ever held right after issuing: the panel keeps a hash, not the password.
  const [issued, setIssued] = useState(null)
  const host = window.location.host

  async function act(fn) {
    setBusy(true)
    try {
      await fn()
    } catch {
      // reported by the mesh
    } finally {
      setBusy(false)
    }
  }

  const issue = () => act(async () => setIssued(await mesh.issueImportPassword(client)))
  const handout = issued && `Адрес: ${host}\nЛогин: ${issued.username}\nПароль: ${issued.password}`

  return (
    <div className="stack" style={{ gap: 8 }}>
      <span className="lbl">Вход в OpenVPN Connect</span>
      {issued ? (
        <>
          <pre className="code wrap" style={{ fontSize: 12.5 }}>
            {handout}
          </pre>
          <div className="row-wrap">
            <button
              className="btn sm"
              type="button"
              onClick={() => void navigator.clipboard?.writeText(handout)}
            >
              <Icon name="copy" size={14} />
              Скопировать
            </button>
            <button className="btn sm ghost" type="button" onClick={() => setIssued(null)}>
              Готово
            </button>
          </div>
          <span className="hint warn-text">Пароль виден только сейчас: панель хранит лишь его хеш.</span>
        </>
      ) : client.import_enabled ? (
        <span className="hint">
          Включён: логин <span className="mono">{client.common_name}</span>, адрес{' '}
          <span className="mono">{host}</span>.
        </span>
      ) : (
        <span className="hint">
          В приложении: импорт профиля → URL → {host}, логин и пароль. Профиль подтянется сам, с
          ключом внутри, поэтому пароль даёт тот же доступ, что и файл.
        </span>
      )}
      {editable && !issued && (
        <div className="row-wrap">
          <button className="btn sm" type="button" disabled={busy} onClick={() => void issue()}>
            {client.import_enabled ? 'Новый пароль' : 'Выдать пароль'}
          </button>
          {client.import_enabled && (
            <button
              className="btn sm ghost"
              type="button"
              disabled={busy}
              onClick={() => void act(() => mesh.disableImport(client))}
            >
              Выключить
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Everything about one client in one column: where it may go, where its
 * internet leaves, its profile. The same component sits beside the map and in
 * the client table's drawer, so both places behave the same way.
 */
export function ClientInspector({ client }) {
  const { user } = useAuth()
  const mesh = useMesh()
  const editable = canEdit(user)
  const [busy, setBusy] = useState(false)
  const [ccdOpen, setCcdOpen] = useState(false)
  const [editingLabel, setEditingLabel] = useState(false)
  const [label, setLabel] = useState(client.label ?? '')

  const [scopeFor, setScopeFor] = useState(null)
  const state = clientState(client)
  const exit = exitGrant(client)
  const group = (mesh.groups ?? []).find((g) => g.id === client.group_id) ?? null
  const groupExit = group?.grants.find((g) => g.is_exit) ?? null
  const nodes = (mesh.nodes ?? [])
    .filter((n) => n.approval === 'approved')
    .sort((a, b) => Number(b.is_hub) - Number(a.is_hub) || a.name.localeCompare(b.name))
  const bytes = sessionBytes(client)
  const nets = clientNetworks(client)
  const certDays = daysUntil(client.cert_not_after)

  async function act(fn) {
    setBusy(true)
    try {
      await fn()
    } catch {
      // The mesh actions already reported the error.
    } finally {
      setBusy(false)
    }
  }

  const status =
    state === 'online'
      ? `в сети ${formatSince(client.session.connected_since)}`
      : state === 'offline'
        ? `не в сети, был ${formatAgo(client.last_seen_at)}`
        : CLIENT_STATE_LABEL[state]

  return (
    <section className="stack-lg" aria-label={`Клиент ${client.common_name}`}>
      <div className="stack" style={{ gap: 6 }}>
        <div className="row-wrap" style={{ gap: 9 }}>
          <span className={`${dotClass(state)}${state === 'online' ? ' pulse' : ''}`} />
          <h2 className="mono" style={{ fontSize: 18, fontWeight: 600, overflowWrap: 'anywhere' }}>
            {client.common_name}
          </h2>
        </div>
        {editingLabel ? (
          <form
            className="row-wrap"
            onSubmit={(event) => {
              event.preventDefault()
              setEditingLabel(false)
              void act(() =>
                mesh.updateClient(client, { label: label.trim() || null }, 'Подпись сохранена'),
              )
            }}
          >
            <input
              className="input"
              style={{ flex: 1, minWidth: 160 }}
              autoFocus
              value={label}
              maxLength={128}
              placeholder="Телефон Ани"
              aria-label="Подпись клиента"
              onChange={(event) => setLabel(event.target.value)}
            />
            <button className="btn sm" type="submit">
              Сохранить
            </button>
          </form>
        ) : (
          <div className="row-wrap" style={{ gap: 6 }}>
            <span className={state === 'noaccess' ? 'warn-text' : 'muted'} style={{ fontSize: 13 }}>
              {client.label ? `${client.label} · ` : ''}
              {status}
            </span>
            {editable && (
              <button
                className="icon-btn"
                type="button"
                style={{ width: 28, height: 28 }}
                aria-label="Изменить подпись"
                onClick={() => setEditingLabel(true)}
              >
                <Icon name="edit" size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="stack" style={{ gap: 6 }}>
        <span className="lbl">Группа</span>
        <select
          className="select"
          aria-label="Группа клиента"
          value={client.group_id ?? ''}
          disabled={!editable || busy}
          onChange={(event) => {
            const next = (mesh.groups ?? []).find((g) => g.id === event.target.value) ?? null
            void act(() => mesh.setClientGroup(client, next))
          }}
        >
          <option value="">Без группы — только личные доступы</option>
          {(mesh.groups ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        {group && (
          <span className="hint">
            Получает всё, что даёт «{group.name}». Сверху можно выдать личные доступы.
          </span>
        )}
      </div>

      <div className="meta-grid">
        <div>
          <div className="lbl">Адрес</div>
          <div className="v mono">{client.session?.virtual_address || client.tunnel_address || '—'}</div>
        </div>
        <div>
          <div className="lbl">Вход</div>
          <div className="v mono">
            {client.session ? `${client.session.proto} · ${client.session.real_address.split(':')[0]}` : '—'}
          </div>
        </div>
        <div>
          <div className="lbl">Сессия</div>
          <div className="v mono">
            {client.session ? `↓${formatBytes(bytes.rx)} ↑${formatBytes(bytes.tx)}` : '—'}
          </div>
        </div>
        <div>
          <div className="lbl">Срок</div>
          <div className="v row-wrap" style={{ gap: 6 }}>
            <span>{client.expires_at ? `до ${formatDate(client.expires_at)}` : 'бессрочно'}</span>
            {editable && (
              <select
                className="select"
                style={{ height: 28, width: 'auto', padding: '0 6px', fontSize: 12 }}
                aria-label="Изменить срок"
                value=""
                onChange={(event) => {
                  const choice = event.target.value
                  if (!choice) return
                  void act(() =>
                    mesh.updateClient(
                      client,
                      { expires_at: expiryFrom(choice, client.expires_at) },
                      'Срок обновлён',
                    ),
                  )
                }}
              >
                {EXPIRY_CHOICES.map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      <div className="stack" style={{ gap: 6 }}>
        <div className="panel-head">
          <span className="lbl">Доступ к узлам</span>
          <span className="hint">
            {client.access.length} из {nodes.length}
          </span>
        </div>
        <div className="bleed">
          {nodes.map((node) => {
            const grant = client.access.find((g) => g.node_id === node.id)
            const on = Boolean(grant)
            const fromGroup = Boolean(grant?.group_id)
            const locked = !editable || busy || fromGroup
            const down = nodeState(node) !== 'up'
            return (
              <div key={node.id} className="stack" style={{ gap: 0 }}>
                <div className="row-wrap" style={{ flexWrap: 'nowrap', gap: 0 }}>
                  <button
                    type="button"
                    className="trow"
                    aria-pressed={on}
                    aria-disabled={locked}
                    title={fromGroup ? `Выдано группой «${group?.name}»: меняется в группе` : undefined}
                    onClick={() => {
                      if (locked) return
                      void act(() => (on ? mesh.revoke(client, node.id) : mesh.grant(client, node.id)))
                    }}
                  >
                    <span className={on ? 'sw on' : 'sw'} style={fromGroup ? { opacity: 0.6 } : undefined} />
                    <span className="t-main">
                      <span className="t-title mono">{node.name}</span>
                      <span className={`t-sub${node.is_hub ? '' : ' mono'}${grant?.networks ? ' exit-text' : ''}`}>
                        {node.is_hub ? 'сама панель' : scopeText(grant?.networks ?? null, node.subnets) || 'сетей не объявил'}
                      </span>
                    </span>
                    {fromGroup && <span className="chip" style={{ height: 22 }}>группа</span>}
                    {down && <span className="err-text" style={{ fontSize: 11 }}>недоступен</span>}
                  </button>
                  {editable && on && !fromGroup && !node.is_hub && node.subnets.length > 0 && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      aria-expanded={scopeFor === node.id}
                      onClick={() => setScopeFor(scopeFor === node.id ? null : node.id)}
                    >
                      {grant.networks ? 'Изменить' : 'Сузить'}
                    </button>
                  )}
                </div>
                {scopeFor === node.id && grant && (
                  <div style={{ padding: '4px 10px 12px' }}>
                    <ScopeEditor
                      node={node}
                      networks={grant.networks}
                      busy={busy}
                      onCancel={() => setScopeFor(null)}
                      onSave={(networks) =>
                        void act(async () => {
                          await mesh.setGrantScope(grant, networks, `${client.common_name} → ${node.name}`)
                          setScopeFor(null)
                        })
                      }
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="stack" style={{ gap: 6 }}>
        <span className="lbl">Выход в интернет</span>
        {groupExit && (
          <div className="callout">
            Выход задаёт группа «{group.name}»: весь трафик через{' '}
            <span className="mono">{groupExit.node_name}</span>.
          </div>
        )}
        <div className="bleed" style={{ gap: 4, opacity: groupExit ? 0.55 : 1 }}>
          <button
            type="button"
            className={`opt${exit ? '' : ' on'}`}
            aria-pressed={!exit}
            disabled={!editable || busy || Boolean(groupExit)}
            onClick={() => void act(() => mesh.setExit(client, null))}
          >
            <span className="radio" />
            <span className="t-main" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>Не выпускать</span>
              <span className="hint">только разрешённые сети</span>
            </span>
          </button>
          {client.access.map((grant) => (
            <button
              key={grant.grant_id}
              type="button"
              className={`opt${grant.is_exit ? ' on' : ''}`}
              aria-pressed={grant.is_exit}
              disabled={!editable || busy || Boolean(groupExit)}
              onClick={() => void act(() => mesh.setExit(client, grant.node_id))}
            >
              <span className="radio" />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>
                  Через <span className="mono">{grant.node_name}</span>
                </span>
                <span className="hint">
                  {grant.node_is_hub ? 'IP панели' : 'IP узла, его сети тоже видны'}
                </span>
              </span>
            </button>
          ))}
        </div>
        <span className="hint">
          {nets.length > 0 && (
            <>
              {exit ? 'Видит ' : 'Видит только '}
              <span className="mono">{nets.join(', ')}</span>
            </>
          )}
          {exit
            ? `${nets.length ? ' и ' : 'Видит '}интернет через ${exit.node_name}`
            : nets.length
              ? ''
              : 'Пока никуда не попадает: выдай доступ к узлу'}
        </span>
      </div>

      <div className="panel" style={{ overflow: 'hidden', borderRadius: 12 }}>
        <button
          type="button"
          className="trow"
          style={{ borderRadius: 0, padding: '8px 14px' }}
          aria-expanded={ccdOpen}
          onClick={() => setCcdOpen((open) => !open)}
        >
          <span className="t-main">
            <span className="t-title">Тонкая настройка (ccd)</span>
            <span className="t-sub">что получает клиент при подключении</span>
          </span>
          <Icon name="chevron" size={14} style={{ transform: ccdOpen ? 'rotate(180deg)' : 'none' }} />
        </button>
        {ccdOpen && (
          <div className="stack" style={{ padding: '0 14px 14px' }}>
            <CcdPreview client={client} />
            <Link className="btn sm" to={`/ccd?client=${client.id}`} style={{ alignSelf: 'flex-start' }}>
              Маршруты, iroute и push
            </Link>
          </div>
        )}
      </div>

      <div className="stack" style={{ gap: 8 }}>
        {client.cert_serial && client.status !== 'revoked' ? (
          <>
            <button className="btn primary" type="button" onClick={() => mesh.downloadConfig(client)}>
              <Icon name="download" size={15} stroke={2} />
              Скачать {client.common_name}.ovpn
            </button>
            <span className="hint">
              Профиль один и ведёт на панель: доступ и выход меняются без перевыпуска.
              {certDays !== null && ` Сертификат действует до ${formatDate(client.cert_not_after)}.`}
            </span>
            <ProfileImport key={client.id} client={client} editable={editable} />
          </>
        ) : client.status === 'revoked' ? (
          <div className="callout err">Сертификат отозван: профиль больше не подключится.</div>
        ) : (
          <>
            <div className="callout warn">Сертификата ещё нет, поэтому нет и профиля.</div>
            {editable && (
              <button
                className="btn primary"
                type="button"
                disabled={busy}
                onClick={() => void act(() => mesh.issueCert(client))}
              >
                Выпустить сертификат
              </button>
            )}
          </>
        )}

        {editable && client.status !== 'revoked' && (
          <div className="row-wrap">
            <button
              className="btn sm"
              type="button"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() =>
                void act(() =>
                  mesh.setClientStatus(client, client.status === 'active' ? 'disabled' : 'active'),
                )
              }
            >
              {client.status === 'active' ? 'Отключить' : 'Включить'}
            </button>
            {client.cert_serial && (
              <ConfirmButton
                className="btn sm"
                label="Отозвать сертификат"
                armedLabel="Точно отозвать?"
                title={`Отозвать сертификат ${client.common_name}`}
                onConfirm={() => void act(() => mesh.revokeCert(client))}
              />
            )}
          </div>
        )}
        {editable && (
          <ConfirmButton
            className="btn sm danger"
            label="Удалить клиента"
            armedLabel="Удалить и отозвать сертификат?"
            title={`Удалить ${client.common_name}`}
            onConfirm={() => void act(() => mesh.deleteClient(client))}
          />
        )}
      </div>
    </section>
  )
}

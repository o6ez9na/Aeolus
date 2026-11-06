import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { api, apiText } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { PageHead } from '../components/AppShell'
import {
  ClientAccessList,
  ClientExitOptions,
  ClientLabel,
  EXPIRY_CHOICES,
  ProfileImport,
  clientStatusText,
  expiryFrom,
} from '../components/ClientInspector'
import { ConfirmButton } from '../components/ConfirmButton'
import { Icon } from '../components/Icon'
import { formatBytes, formatDate } from '../lib/format'
import { useMesh } from '../lib/mesh'
import { canEdit, clientState, dotClass, sessionBytes } from '../lib/model'
import { useResource } from '../lib/useResource'

function networkOf(client) {
  return {
    host: client.tunnel_host === null ? '' : String(client.tunnel_host),
    dnsOwn: (client.dns_servers ?? []).length > 0,
    dns: client.dns_servers ?? [],
    routes: client.push_routes ?? [],
    behind: client.iroutes ?? [],
    options: client.push_options ?? [],
  }
}

/** What the API takes for these settings. Own resolvers left empty mean the hub's. */
function payloadOf(network) {
  return {
    ...(network.host === '' ? {} : { tunnel_host: Number(network.host) }),
    dns_servers: network.dnsOwn ? network.dns : [],
    push_routes: network.routes,
    iroutes: network.behind,
    push_options: network.options,
  }
}

function hostPrefix(address) {
  return address ? address.slice(0, address.lastIndexOf('.') + 1) : ''
}

/** The saved file against the draft: what would appear, and what would go. */
function fileRows(saved, draft) {
  const lines = (text) => (text ?? '').trimEnd().split('\n')
  if (draft === null) return lines(saved).map((text) => ({ text, kind: '' }))
  const before = lines(saved)
  const after = lines(draft)
  return [
    ...after.map((text) => ({ text, kind: before.includes(text) ? '' : 'line-new' })),
    ...before.filter((text) => !after.includes(text)).map((text) => ({ text, kind: 'line-gone' })),
  ]
}

function ListField({ id, label, values, placeholder, suggestions, editable, onChange }) {
  const [text, setText] = useState('')

  function add() {
    const value = text.trim()
    if (!value) return
    if (!values.includes(value)) onChange([...values, value])
    setText('')
  }

  return (
    <div className="stack" style={{ gap: 7 }}>
      <label className="lbl" htmlFor={id}>
        {label}
      </label>
      {values.length > 0 && (
        <div className="row-wrap" style={{ gap: 6 }}>
          {values.map((value) => (
            <span key={value} className="chip mono">
              {value}
              {editable && (
                <button
                  className="chip-x"
                  type="button"
                  aria-label={`Убрать ${value}`}
                  onClick={() => onChange(values.filter((v) => v !== value))}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {editable && (
        <div className="add-row">
          <input
            id={id}
            className="input mono"
            list={suggestions ? `${id}-list` : undefined}
            placeholder={placeholder}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              add()
            }}
          />
          <button className="btn" type="button" disabled={!text.trim()} onClick={add}>
            Добавить
          </button>
          {suggestions && (
            <datalist id={`${id}-list`}>
              {suggestions.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          )}
        </div>
      )}
      {!editable && values.length === 0 && <span className="dim">нет</span>}
    </div>
  )
}

function ClientFacts({ client, editable }) {
  const mesh = useMesh()
  const state = clientState(client)
  const bytes = sessionBytes(client)

  // The mesh actions report their own errors.
  const change = (fn) => fn().catch(() => {})

  return (
    <dl className="facts">
      <div>
        <dt className="lbl">Группа</dt>
        <dd>
          {editable ? (
            <select
              className="select compact"
              aria-label="Группа клиента"
              value={client.group_id ?? ''}
              onChange={(event) => {
                const next = (mesh.groups ?? []).find((g) => g.id === event.target.value) ?? null
                void change(() => mesh.setClientGroup(client, next))
              }}
            >
              <option value="">без группы</option>
              {(mesh.groups ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="mono">{client.group_name ?? 'без группы'}</span>
          )}
        </dd>
      </div>
      <div>
        <dt className="lbl">Статус</dt>
        <dd>
          <span className={`${dotClass(state)}${state === 'online' ? ' pulse' : ''}`} />
          {clientStatusText(client)}
        </dd>
      </div>
      <div>
        <dt className="lbl">Срок</dt>
        <dd>
          {client.expires_at ? `до ${formatDate(client.expires_at)}` : 'бессрочно'}
          {editable && (
            <select
              className="select compact"
              aria-label="Изменить срок"
              value=""
              onChange={(event) => {
                const choice = event.target.value
                if (!choice) return
                void change(() =>
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
        </dd>
      </div>
      {client.session && (
        <>
          <div>
            <dt className="lbl">Вход</dt>
            <dd className="mono">
              {client.session.proto}, {client.session.real_address.split(':')[0]}
            </dd>
          </div>
          <div>
            <dt className="lbl">Сессия</dt>
            <dd className="mono">
              ↓{formatBytes(bytes.rx)} ↑{formatBytes(bytes.tx)}
            </dd>
          </div>
        </>
      )}
    </dl>
  )
}

function ClientView({ client }) {
  const { user } = useAuth()
  const mesh = useMesh()
  const navigate = useNavigate()
  const editable = canEdit(user)
  const limits = useResource('/ccd/limits')

  const saved = useMemo(() => networkOf(client), [client])
  const savedBody = JSON.stringify(payloadOf(saved))
  // Null until something is edited, so a poll of the mesh shows through.
  const [draft, setDraft] = useState(null)
  const network = draft ?? saved
  const body = JSON.stringify(payloadOf(network))
  const dirty = body !== savedBody
  const set = (patch) => setDraft({ ...network, ...patch })

  const low = limits.data?.static_host_min
  const high = limits.data?.static_host_max
  const hostNumber = Number(network.host)
  const hostError =
    saved.host !== '' &&
    limits.data &&
    (!/^\d+$/.test(network.host) || hostNumber < low || hostNumber > high)
      ? `Номер адреса: от ${low} до ${high}`
      : null

  const [proto, setProto] = useState('udp')
  const [savedFile, setSavedFile] = useState(null)
  const [draftFile, setDraftFile] = useState(null)
  const [fileError, setFileError] = useState(null)
  const [busy, setBusy] = useState(false)
  const issued = Boolean(client.cert_serial) && client.status !== 'revoked'

  // The file also follows access and exits, changed elsewhere on this page.
  const fileInputs = JSON.stringify([client.access, client.status, client.cert_serial, savedBody])
  useEffect(() => {
    let live = true
    apiText(`/clients/${client.id}/ccd?proto=${proto}`)
      .then((text) => live && setSavedFile(text))
      .catch((err) => live && setFileError(err.message))
    return () => {
      live = false
    }
  }, [client.id, proto, fileInputs])

  useEffect(() => {
    if (!dirty || hostError) {
      setDraftFile(null)
      setFileError(hostError)
      return undefined
    }
    let live = true
    const timer = setTimeout(() => {
      api
        .post(`/clients/${client.id}/ccd/preview`, { proto, ...JSON.parse(body) })
        .then((preview) => {
          if (!live) return
          setDraftFile(preview.text)
          setFileError(null)
        })
        .catch((err) => live && setFileError(err.message))
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [client.id, proto, body, dirty, hostError])

  async function save() {
    setBusy(true)
    try {
      await mesh.updateClient(
        client,
        JSON.parse(body),
        `${client.common_name}: сохранено, применится при следующем подключении`,
      )
      setDraft(null)
    } catch {
      // The mesh already reported it; the draft stays so nothing is lost.
    } finally {
      setBusy(false)
    }
  }

  const hub = (mesh.nodes ?? []).find((n) => n.is_hub)
  const hubDns = hub?.client_dns?.length ? hub.client_dns : (hub?.client_dns_default ?? [])
  const rows = fileRows(savedFile, draftFile)

  return (
    <>
      <PageHead
        crumbs={
          <nav className="crumbs" aria-label="Путь">
            <Link to="/clients">Клиенты</Link>
            <span>/</span>
            <span className="mono" style={{ color: 'var(--text)' }}>
              {client.common_name}
            </span>
          </nav>
        }
        title={<span className="mono">{client.common_name}</span>}
        actions={
          <>
            {issued ? (
              <button className="btn" type="button" onClick={() => mesh.downloadConfig(client)}>
                <Icon name="download" size={15} stroke={2} />
                Скачать {client.common_name}.ovpn
              </button>
            ) : (
              editable &&
              client.status !== 'revoked' && (
                <button
                  className="btn"
                  type="button"
                  onClick={() => mesh.issueCert(client).catch(() => {})}
                >
                  Выпустить сертификат
                </button>
              )
            )}
            {editable && client.status !== 'revoked' && (
              <button
                className="btn ghost"
                type="button"
                onClick={() =>
                  mesh
                    .setClientStatus(client, client.status === 'active' ? 'disabled' : 'active')
                    .catch(() => {})
                }
              >
                {client.status === 'active' ? 'Отключить' : 'Включить'}
              </button>
            )}
          </>
        }
      />
      <ClientLabel client={client} />
      <ClientFacts client={client} editable={editable} />

      <div className="client-grid">
        <section className="panel panel-pad stack-lg" aria-label="Доступ и выход">
          <h2 style={{ fontSize: 15 }}>Куда ходит</h2>
          <ClientAccessList client={client} />
          <div className="stack" style={{ gap: 6 }}>
            <span className="lbl">Выход в интернет</span>
            <ClientExitOptions client={client} />
          </div>
        </section>

        <section className="panel panel-pad stack-lg" aria-label="Сеть клиента">
          <h2 style={{ fontSize: 15 }}>Сеть клиента</h2>

          <div className="stack" style={{ gap: 7 }}>
            <label className="lbl" htmlFor="client-host">
              Адрес в VPN
            </label>
            {saved.host === '' ? (
              <span className="dim">ещё не выдан</span>
            ) : (
              <>
                <div className="row-wrap" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <span className="mono muted">{hostPrefix(client.tunnel_address)}</span>
                  <input
                    id="client-host"
                    className="input mono"
                    style={{ width: 72 }}
                    inputMode="numeric"
                    disabled={!editable}
                    value={network.host}
                    onChange={(event) => set({ host: event.target.value.trim() })}
                  />
                </div>
                <span className="hint">
                  При входе по TCP:{' '}
                  <span className="mono">
                    {hostPrefix(client.tunnel_address_tcp)}
                    {network.host}
                  </span>
                </span>
              </>
            )}
          </div>

          <div className="stack" style={{ gap: 7 }}>
            <span className="lbl">DNS</span>
            <div className="seg-group" role="group" aria-label="DNS клиента" style={{ width: 'fit-content' }}>
              <button
                className={`seg${network.dnsOwn ? '' : ' on'}`}
                type="button"
                aria-pressed={!network.dnsOwn}
                disabled={!editable}
                onClick={() => set({ dnsOwn: false })}
              >
                Как у хаба <span className="mono">{hubDns.join(', ')}</span>
              </button>
              <button
                className={`seg${network.dnsOwn ? ' on' : ''}`}
                type="button"
                aria-pressed={network.dnsOwn}
                disabled={!editable}
                onClick={() => set({ dnsOwn: true })}
              >
                Свои серверы
              </button>
            </div>
            {network.dnsOwn && (
              <ListField
                id="client-dns"
                label="Серверы"
                values={network.dns}
                placeholder="1.1.1.1"
                editable={editable}
                onChange={(dns) => set({ dns })}
              />
            )}
          </div>

          <ListField
            id="client-routes"
            label="Дополнительные сети"
            values={network.routes}
            placeholder="10.40.0.0/24"
            editable={editable}
            onChange={(routes) => set({ routes })}
          />
          <ListField
            id="client-behind"
            label="Сети за клиентом"
            values={network.behind}
            placeholder="10.30.1.0/24"
            editable={editable}
            onChange={(behind) => set({ behind })}
          />
          <ListField
            id="client-options"
            label="Другие опции OpenVPN"
            values={network.options}
            placeholder="route-metric 50"
            suggestions={limits.data?.allowed_push_options}
            editable={editable}
            onChange={(options) => set({ options })}
          />
        </section>

        <div className="stack">
          <section className="panel panel-pad stack-lg" aria-label="Что получит клиент">
            <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ fontSize: 15 }}>Что получит клиент</h2>
              <div className="seg-group" role="group" aria-label="Вход" style={{ width: 'fit-content' }}>
                {['udp', 'tcp'].map((value) => (
                  <button
                    key={value}
                    className={`seg${proto === value ? ' on' : ''}`}
                    type="button"
                    aria-pressed={proto === value}
                    onClick={() => setProto(value)}
                  >
                    {value.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <pre className="code wrap" style={{ fontSize: 12 }}>
              {savedFile === null
                ? 'загрузка…'
                : rows.map((row, index) => (
                    <span key={`${index}-${row.text}`} className={row.kind}>
                      {row.text}
                      {'\n'}
                    </span>
                  ))}
            </pre>
            {fileError && <div className="form-error">{fileError}</div>}
            {editable && (
              <div className="row-wrap">
                <button
                  className="btn primary"
                  type="button"
                  disabled={!dirty || busy || Boolean(fileError)}
                  onClick={() => void save()}
                >
                  {busy ? 'Сохраняю…' : 'Сохранить'}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={!dirty || busy}
                  onClick={() => setDraft(null)}
                >
                  Отменить
                </button>
              </div>
            )}
          </section>

          <section className="panel panel-pad stack-lg" aria-label="Профиль">
            <h2 style={{ fontSize: 15 }}>Профиль</h2>
            {client.status === 'revoked' && (
              <div className="callout err">Сертификат отозван: профиль больше не подключится.</div>
            )}
            {issued && <ProfileImport key={client.id} client={client} editable={editable} />}
            {editable && (
              <div className="row-wrap">
                {issued && (
                  <ConfirmButton
                    className="btn sm"
                    label="Отозвать сертификат"
                    armedLabel="Точно отозвать?"
                    title={`Отозвать сертификат ${client.common_name}`}
                    onConfirm={() => mesh.revokeCert(client).catch(() => {})}
                  />
                )}
                <ConfirmButton
                  className="btn sm danger"
                  label="Удалить клиента"
                  armedLabel="Удалить и отозвать сертификат?"
                  title={`Удалить ${client.common_name}`}
                  onConfirm={() =>
                    mesh
                      .deleteClient(client)
                      .then(() => navigate('/clients'))
                      .catch(() => {})
                  }
                />
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  )
}

export function ClientPage() {
  const { clientId } = useParams()
  const mesh = useMesh()
  const client = (mesh.clients ?? []).find((c) => c.id === clientId)

  if (client) return <ClientView key={client.id} client={client} />
  return (
    <>
      <PageHead title="Клиент" />
      <div className="panel empty-state">
        {mesh.loading ? (
          'загрузка клиента…'
        ) : (
          <>
            Такого клиента нет.
            <Link className="btn sm" to="/clients">
              Все клиенты
            </Link>
          </>
        )}
      </div>
    </>
  )
}

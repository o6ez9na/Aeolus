import { ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import { PageHead } from '../components/AppShell'
import { ConfirmButton } from '../components/ConfirmButton'
import { SiteLinks } from '../components/SiteLinks'
import { Icon } from '../components/Icon'
import { nodeTypes } from '../components/map/MapNodes'
import { daysUntil, formatAgo, formatBytes, formatDate, formatSince, formatStamp } from '../lib/format'
import { useMesh } from '../lib/mesh'
import {
  NODE_STATE_LABEL,
  canEdit,
  clientState,
  dotClass,
  nodeState,
  sessionBytes,
  transportLabel,
} from '../lib/model'
import { useResource } from '../lib/useResource'
import { useTheme } from '../theme/ThemeContext'

const CHECK_ICON = { ok: 'check', fail: 'close', warn: 'warn', unknown: 'more' }

function Checks({ diag }) {
  if (diag.loading) return <span className="hint">проверяю…</span>
  if (diag.error) return <span className="form-error">{diag.error}</span>
  const checks = diag.data?.checks ?? []
  const good = checks.filter((c) => c.status === 'ok').length
  const bad = checks.some((c) => c.status === 'fail')
  return (
    <>
      <div className="panel-head" style={{ marginBottom: 8 }}>
        <h2>Проверки</h2>
        <span className={bad ? 'err-text' : 'ok-text'} style={{ fontSize: 12 }}>
          {good} из {checks.length}
        </span>
      </div>
      {checks.map((check) => (
        <div
          key={check.key}
          className={`check${check.status === 'fail' ? ' bad' : check.status === 'warn' ? ' so-so' : ''}`}
        >
          <span className={`check-ico ${check.status}`}>
            <Icon name={CHECK_ICON[check.status]} size={12} stroke={2.6} />
          </span>
          <span className="c-main">
            <span className="c-title">{check.title}</span>
            {check.detail && <span className="c-detail">{check.detail}</span>}
          </span>
        </div>
      ))}
    </>
  )
}

function Files({ diag }) {
  const files = diag.data?.files ?? []
  const [tab, setTab] = useState(0)
  if (files.length === 0) return null
  const current = files[Math.min(tab, files.length - 1)]
  return (
    <section className="panel" aria-label="Конфигурация" style={{ overflow: 'hidden' }}>
      <div className="panel-head panel-pad" style={{ paddingBottom: 0 }}>
        <h2>Что лежит на узле и на хабе</h2>
        <span className="hint">только чтение</span>
      </div>
      <div className="tabs" role="tablist" style={{ padding: '8px 14px 0' }}>
        {files.map((file, i) => (
          <button
            key={file.name}
            type="button"
            role="tab"
            aria-selected={i === tab}
            className={`tab${i === tab ? ' on' : ''}`}
            onClick={() => setTab(i)}
          >
            {file.name}
          </button>
        ))}
      </div>
      <div className="stack panel-pad">
        <pre className="code">{current.content}</pre>
        <div className="row-wrap">
          <button
            className="btn sm"
            type="button"
            onClick={() => void navigator.clipboard?.writeText(current.content)}
          >
            <Icon name="copy" size={14} />
            Скопировать
          </button>
        </div>
      </div>
    </section>
  )
}

/** The node's own corner of the map: who comes in, where they go out. */
function MiniMap({ node, clients, hub }) {
  const { theme } = useTheme()
  const graph = useMemo(() => {
    const shown = clients.slice(0, 6)
    const nodes = []
    const edges = []
    const style = (stroke, width) => ({ stroke, strokeWidth: width })
    shown.forEach((client, i) => {
      const state = clientState(client)
      nodes.push({
        id: `c${client.id}`,
        type: 'client',
        position: { x: 0, y: i * 68 },
        data: {
          client,
          state,
          sub: {
            text: client.session ? `${client.session.proto} · ${formatSince(client.session.connected_since)}` : 'не в сети',
            tone: '',
          },
          connectable: false,
        },
      })
      edges.push({
        id: `s${client.id}`,
        source: `c${client.id}`,
        target: 'hub',
        targetHandle: 'in',
        style: style(client.session ? 'var(--live)' : 'var(--line-strong)', client.session ? 2 : 1.5),
        className: client.session ? 'flow' : 'dashed',
      })
    })
    const mid = Math.max(0, ((shown.length - 1) * 68) / 2)
    nodes.push({
      id: 'hub',
      type: 'hub',
      position: { x: 290, y: mid - 40 },
      data: { hub, state: hub ? nodeState(hub) : 'up', sessions: clients.filter((c) => c.session).length },
    })
    const exits = clients.filter((c) => c.access.some((g) => g.node_id === node.id && g.is_exit))
    if (!node.is_hub) {
      const state = nodeState(node)
      nodes.push({
        id: 'node',
        type: 'vpnnode',
        position: { x: 540, y: mid - 8 },
        data: { node, state, sub: { text: transportLabel(node), tone: state === 'down' ? 'err' : '' }, sel: true },
      })
      edges.push({
        id: 't',
        source: 'hub',
        sourceHandle: 'out',
        target: 'node',
        targetHandle: 'in',
        style: style(state === 'up' ? 'var(--transit)' : 'var(--err)', 2.5),
        className: state === 'up' ? '' : 'dashed-wide',
      })
    }
    const from = node.is_hub ? 'hub' : 'node'
    const x = node.is_hub ? 540 : 800
    if (node.subnets.length) {
      nodes.push({ id: 'lan', type: 'lan', position: { x, y: mid - 56 }, data: { subnets: node.subnets } })
      edges.push({ id: 'l', source: from, sourceHandle: node.is_hub ? 'out' : 'out', target: 'lan', style: style('var(--line-strong)', 1.5) })
    }
    if (exits.length) {
      nodes.push({ id: 'inet', type: 'inet', position: { x, y: mid + 40 }, data: { count: exits.length } })
      edges.push({
        id: 'x',
        source: from,
        sourceHandle: node.is_hub ? 'exit' : 'out',
        target: 'inet',
        style: style('var(--exit)', 2),
        className: exits.some((c) => c.session) ? 'flow' : 'dashed',
      })
    }
    return { nodes, edges, more: clients.length - shown.length }
  }, [node, clients, hub])

  return (
    <section className="panel" aria-label="Связи узла" style={{ overflow: 'hidden' }}>
      <div className="panel-head panel-pad" style={{ paddingBottom: 8 }}>
        <h2>Связи узла</h2>
        <Link to={`/map?sel=node:${node.id}`} style={{ fontSize: 13 }}>
          Открыть на общей карте
        </Link>
      </div>
      <div style={{ height: Math.max(220, Math.min(6, clients.length) * 68 + 60) }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            colorMode={theme}
            fitView
            fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
          />
        </ReactFlowProvider>
      </div>
      {graph.more > 0 && (
        <div className="hint" style={{ padding: '0 20px 14px' }}>
          и ещё {graph.more} — все в таблице ниже
        </div>
      )}
    </section>
  )
}

/** Resolvers the hub hands every client along with the tunnel. */
function ClientDns({ node, editable }) {
  const mesh = useMesh()
  const saved = node.client_dns.join(', ')
  const [draft, setDraft] = useState(saved)
  const [busy, setBusy] = useState(false)
  const servers = draft.split(/[\s,;]+/).filter(Boolean)
  const fallback = node.client_dns_default.join(', ')

  const save = async () => {
    setBusy(true)
    try {
      const updated = await mesh.updateNode(
        node,
        { client_dns: servers },
        `DNS для клиентов: ${servers.join(', ') || fallback}. OpenVPN перезапустится, клиенты переподключатся`,
      )
      setDraft(updated.client_dns.join(', '))
    } catch {
      // reported by the mesh
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel panel-pad stack" aria-label="DNS для клиентов">
      <h2 style={{ fontSize: 15 }}>DNS для клиентов</h2>
      <form
        className="row-wrap"
        style={{ flexWrap: 'nowrap' }}
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <input
          className="input mono"
          style={{ height: 34 }}
          placeholder={fallback}
          aria-label="Адреса DNS-серверов"
          value={draft}
          disabled={!editable}
          onChange={(event) => setDraft(event.target.value)}
        />
        {editable && (
          <button className="btn sm primary" type="submit" disabled={busy || servers.join(', ') === saved}>
            Сохранить
          </button>
        )}
      </form>
    </section>
  )
}

/** The hub's side of site links: which of its networks the linked sites reach. */
function HubLan({ node, editable }) {
  const mesh = useMesh()
  const saved = node.site_subnets.join(', ')
  const [draft, setDraft] = useState(saved)
  const [busy, setBusy] = useState(false)
  const networks = draft.split(/[\s,;]+/).filter(Boolean)

  const save = async () => {
    setBusy(true)
    try {
      const updated = await mesh.updateNode(
        node,
        { site_subnets: networks },
        networks.length
          ? `Сеть панели для транзита сетей: ${networks.join(', ')}`
          : 'Сеть панели для транзита сетей убрана',
      )
      setDraft(updated.site_subnets.join(', '))
    } catch {
      // reported by the mesh
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel panel-pad stack" aria-label="Сеть панели для транзита сетей">
      <h2 style={{ fontSize: 15 }}>Сеть панели для транзита сетей</h2>
      <form
        className="row-wrap"
        style={{ flexWrap: 'nowrap' }}
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <input
          className="input mono"
          style={{ height: 34 }}
          placeholder="192.168.1.0/24"
          aria-label="Сети за панелью"
          value={draft}
          disabled={!editable}
          onChange={(event) => setDraft(event.target.value)}
        />
        {editable && (
          <button className="btn sm primary" type="submit" disabled={busy || networks.join(', ') === saved}>
            Сохранить
          </button>
        )}
      </form>
    </section>
  )
}

function Events({ nodeId }) {
  const log = useResource(`/audit?target_id=${nodeId}&limit=8`, { pollMs: 30000 })
  const items = log.data?.items ?? []
  return (
    <section className="panel panel-pad stack" aria-label="События">
      <div className="panel-head">
        <h2>События</h2>
        <Link to="/audit" style={{ fontSize: 13 }}>
          Весь аудит
        </Link>
      </div>
      {items.length === 0 ? (
        <span className="hint">{log.loading ? 'загрузка…' : 'Пока ничего не записано'}</span>
      ) : (
        <div className="events">
          {items.map((event) => (
            <div key={event.id} style={{ display: 'contents' }}>
              <span className="mono dim" title={formatStamp(event.created_at)}>
                {formatDate(event.created_at)}
              </span>
              <span>
                <span className="mono">{event.actor_username ?? 'система'}</span>{' '}
                <span className="muted">{event.action}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export function NodePage() {
  const { nodeId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const mesh = useMesh()
  const editable = canEdit(user)
  const diag = useResource(`/nodes/${nodeId}/diagnostics`, { pollMs: 15000 })

  if (mesh.loading) {
    return (
      <>
        <PageHead title="Узел" />
        <div className="panel empty-state">загрузка…</div>
      </>
    )
  }

  const node = mesh.nodes.find((n) => n.id === nodeId)
  if (!node) {
    return (
      <>
        <PageHead title="Узел не найден" />
        <div className="panel empty-state">
          <span>Его удалили или ссылка устарела.</span>
          <Link className="btn" to="/nodes">
            К списку узлов
          </Link>
        </div>
      </>
    )
  }

  const state = nodeState(node)
  const hub = mesh.nodes.find((n) => n.is_hub)
  const granted = mesh.clients.filter((c) => c.node_ids.includes(node.id))
  const live = granted.filter((c) => c.session)
  const exits = granted.filter((c) => c.access.some((g) => g.node_id === node.id && g.is_exit))
  const certDays = daysUntil(node.server_cert_not_after)
  const capacity = node.bandwidth_capacity_mbps || 1

  return (
    <>
      <PageHead
        crumbs={
          <nav className="crumbs" aria-label="Путь">
            <Link to="/nodes">Узлы</Link>
            <span>/</span>
            <span className="mono" style={{ color: 'var(--text)' }}>
              {node.name}
            </span>
          </nav>
        }
        title={
          <span className="row-wrap" style={{ gap: 10 }}>
            <span className={dotClass(state)} style={{ width: 10, height: 10 }} />
            <span className="mono">{node.name}</span>
            <span className={`chip${state === 'up' ? ' live' : state === 'down' ? ' err' : ' warn'}`}>
              {NODE_STATE_LABEL[state]}
            </span>
            <span className="chip mono">{transportLabel(node)}</span>
            {exits.length > 0 && <span className="chip exit">выход для {exits.length}</span>}
          </span>
        }
        sub={
          <span className="mono">
            {[
              node.is_hub ? 'сама панель' : null,
              node.hostname,
              node.announce_ip || node.address,
              node.transit_host ? `транзитный хост .${node.transit_host}` : null,
              node.agent_version ? `anemoi ${node.agent_version}` : null,
              node.approved_at ? `принят ${formatDate(node.approved_at)}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        }
        actions={
          editable &&
          !node.is_hub && (
            <button
              className="btn"
              type="button"
              onClick={() =>
                void mesh
                  .updateNode(
                    node,
                    { is_enabled: !node.is_enabled },
                    node.is_enabled ? `${node.name} выключен` : `${node.name} включён`,
                  )
                  .catch(() => {})
              }
            >
              {node.is_enabled ? 'Выключить' : 'Включить'}
            </button>
          )
        }
      />

      <div className="tiles">
        <div className="panel tile">
          <span className="lbl">Сессии через узел</span>
          <span className="value">{live.length}</span>
          <span className="hint">{live.map((c) => c.common_name).join(', ') || 'никого'}</span>
        </div>
        <div className="panel tile">
          <span className="lbl">Канал</span>
          <span className="value">
            {node.bandwidth_mbps} <small>/ {capacity} Мбит/с</small>
          </span>
          <span className="bar wide">
            <span style={{ width: `${Math.min(100, (node.bandwidth_mbps / capacity) * 100)}%` }} />
          </span>
        </div>
        <div className="panel tile">
          <span className="lbl">Трафик агента</span>
          <span className="value mono" style={{ fontSize: 19 }}>
            ↓{formatBytes(node.rx_bytes)} ↑{formatBytes(node.tx_bytes)}
          </span>
          <span className="hint">с последнего запуска OpenVPN</span>
        </div>
        <div className="panel tile">
          <span className="lbl">Агент</span>
          <span className="value" style={{ fontSize: 19 }}>
            {formatAgo(node.last_seen_at)}
          </span>
          <span className={state === 'down' ? 'hint err-text' : 'hint'}>
            {node.status_message || (state === 'up' ? 'отчёты приходят' : NODE_STATE_LABEL[state])}
          </span>
        </div>
        <div className="panel tile">
          <span className="lbl">Конфиг</span>
          <span className="value mono" style={{ fontSize: 19 }}>
            {node.config_revision ? node.config_revision.slice(0, 8) : '—'}
          </span>
          <span className={certDays !== null && certDays <= 30 ? 'hint warn-text' : 'hint'}>
            сертификат {certDays === null ? 'не выпущен' : `до ${formatDate(node.server_cert_not_after)}`}
          </span>
        </div>
      </div>

      <div className="cols">
        <div className="col-main">
          <MiniMap node={node} clients={node.is_hub ? mesh.clients.filter((c) => c.session) : granted} hub={hub} />

          <section className="panel" aria-label="Клиенты с доступом" style={{ overflow: 'hidden' }}>
            <div className="panel-head panel-pad" style={{ paddingBottom: 8 }}>
              <h2>Клиенты с доступом</h2>
              <Link className="btn sm" to={`/map?sel=node:${node.id}`}>
                Выдать на карте
              </Link>
            </div>
            <div className="table-wrap">
              <table className="table" style={{ minWidth: 620 }}>
                <thead>
                  <tr>
                    <th>Клиент</th>
                    <th>Что даёт узел</th>
                    <th>Сессия</th>
                    <th>Трафик сессии</th>
                    <th>
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {granted.length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        <div className="empty-state">Этот узел пока никому не выдан</div>
                      </td>
                    </tr>
                  )}
                  {granted.map((client) => {
                    const grant = client.access.find((g) => g.node_id === node.id)
                    const cs = clientState(client)
                    const bytes = sessionBytes(client)
                    return (
                      <tr key={client.id}>
                        <td>
                          <div className="name-cell">
                            <span className={dotClass(cs)} />
                            <Link
                              className="mono"
                              to={`/clients?open=${client.id}`}
                              style={{ color: 'var(--text)', fontWeight: 600, textDecoration: 'none' }}
                            >
                              {client.common_name}
                            </Link>
                          </div>
                        </td>
                        <td>
                          <div className="row-wrap" style={{ gap: 5 }}>
                            {node.subnets.map((net) => (
                              <span key={net} className="chip mono">
                                {net}
                              </span>
                            ))}
                            {grant?.is_exit && <span className="chip exit">⇱ весь трафик</span>}
                            {!node.subnets.length && !grant?.is_exit && <span className="dim">ничего — нет сетей и выхода</span>}
                          </div>
                        </td>
                        <td className={client.session ? 'ok-text' : 'dim'}>
                          {client.session ? `${client.session.proto} · ${formatSince(client.session.connected_since)}` : 'не в сети'}
                        </td>
                        <td className="mono muted">
                          {client.session ? `↓${formatBytes(bytes.rx)} ↑${formatBytes(bytes.tx)}` : '—'}
                        </td>
                        <td className="actions-cell">
                          {editable && (
                            <button
                              className="btn sm ghost"
                              type="button"
                              onClick={() => void mesh.revoke(client, node.id).catch(() => {})}
                            >
                              Забрать
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <Files diag={diag} />
        </div>

        <div className="col-side">
          <section className="panel panel-pad" aria-label="Проверки">
            <Checks diag={diag} />
          </section>

          <section className="panel panel-pad stack" aria-label="Сети за узлом">
            <h2 style={{ fontSize: 15 }}>Сети за узлом</h2>
            <div className="row-wrap" style={{ gap: 6 }}>
              {node.subnets.length ? (
                node.subnets.map((net) => (
                  <span key={net} className="chip lg mono">
                    {net}
                  </span>
                ))
              ) : (
                <span className="hint">{node.is_hub ? 'Нет' : 'Не объявлены'}</span>
              )}
            </div>
          </section>

          {node.is_hub && <ClientDns node={node} editable={editable} />}

          {node.is_hub && <HubLan node={node} editable={editable} />}

          {!node.is_hub && node.approval === 'approved' && <SiteLinks node={node} editable={editable} />}

          {!node.is_hub && (
            <section className="panel panel-pad stack" aria-label="Транзит">
              <h2 style={{ fontSize: 15 }}>Как узел достаёт до панели</h2>
              <div className="seg-group fill">
                {[
                  [true, 'HTTPS · 443'],
                  [false, `Напрямую · ${node.transit_transport && !node.transit_obfuscated ? node.transit_transport : '1195'}`],
                ].map(([value, label]) => (
                  <button
                    key={String(value)}
                    type="button"
                    className={`seg${node.transit_obfuscated === value ? ' on' : ''}`}
                    aria-pressed={node.transit_obfuscated === value}
                    disabled={!editable}
                    onClick={() =>
                      node.transit_obfuscated !== value &&
                      void mesh
                        .updateNode(
                          node,
                          { transit_obfuscated: value },
                          `${node.name}: транзит ${value ? 'через HTTPS' : 'напрямую'}, узел переподключится`,
                        )
                        .catch(() => {})
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </section>
          )}

          {user?.role === 'admin' && <Events nodeId={node.id} />}

          {editable && (
            <section className="panel panel-pad stack" aria-label="Опасные действия" style={{ borderColor: 'var(--err-soft)' }}>
              <h2 style={{ fontSize: 15 }}>Опасные действия</h2>
              <ConfirmButton
                className="btn"
                label="Перевыпустить серверный сертификат"
                armedLabel="Перевыпустить?"
                title={`Перевыпустить сертификат ${node.name}`}
                onConfirm={() => void mesh.reissueServerCert(node).catch(() => {})}
              />
              {!node.is_hub && (
                <>
                  <ConfirmButton
                    className="btn danger"
                    label="Удалить узел"
                    armedLabel="Точно удалить?"
                    title={`Удалить ${node.name}`}
                    onConfirm={() =>
                      void mesh
                        .deleteNode(node)
                        .then(() => navigate('/nodes'))
                        .catch(() => {})
                    }
                  />
                  <span className="hint">
                    {granted.length
                      ? `Клиенты потеряют доступ к ${node.subnets.join(', ') || 'узлу'}${exits.length ? `, а ${exits.map((c) => c.common_name).join(', ')} останутся без выхода` : ''}.`
                      : 'Клиентов у узла нет.'}
                  </span>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  )
}

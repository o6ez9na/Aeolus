import { useState } from 'react'
import { Link } from 'react-router-dom'

import { useAuth } from '../../auth/AuthContext'
import { formatAgo } from '../../lib/format'
import { useMesh } from '../../lib/mesh'
import {
  NODE_STATE_LABEL,
  canEdit,
  clientState,
  clientUsable,
  dotClass,
  exitGrant,
  nodeState,
  transportLabel,
} from '../../lib/model'
import { useResource } from '../../lib/useResource'

function cidr(value) {
  const [net, mask] = value.split('/')
  if (!mask?.includes('.')) return value
  const bits = mask.split('.').reduce((sum, octet) => sum + Number(octet).toString(2).replace(/0/g, '').length, 0)
  return `${net}/${bits}`
}

function Head({ dot, name, sub, subClass = 'muted', mono = true }) {
  return (
    <div className="stack" style={{ gap: 5 }}>
      <div className="row-wrap" style={{ gap: 9 }}>
        {dot && <span className={dot} />}
        <h2 className={mono ? 'mono' : ''} style={{ fontSize: 18, fontWeight: 600 }}>
          {name}
        </h2>
      </div>
      {sub && (
        <span className={subClass} style={{ fontSize: 13 }}>
          {sub}
        </span>
      )}
    </div>
  )
}

function Meta({ items }) {
  return (
    <div className="meta-grid">
      {items.map(([label, value, mono]) => (
        <div key={label}>
          <div className="lbl">{label}</div>
          <div className={`v${mono ? ' mono' : ''}`}>{value}</div>
        </div>
      ))}
    </div>
  )
}

function ClientChips({ clients, nodeId, onSelect }) {
  if (clients.length === 0) return <span className="hint">Пока никому не выдан</span>
  return (
    <div className="row-wrap" style={{ gap: 6 }}>
      {clients.map((client) => {
        const grant = client.access.find((g) => g.node_id === nodeId)
        return (
          <button
            key={client.id}
            type="button"
            className="chip mono"
            style={{ height: 30 }}
            onClick={() => onSelect({ type: 'client', id: client.id })}
          >
            <span className={dotClass(clientState(client))} />
            {client.common_name}
            {grant?.is_exit && <span className="exit-text">⇱ выход</span>}
          </button>
        )
      })}
    </div>
  )
}

export function NodeInspector({ node, onSelect }) {
  const { user } = useAuth()
  const mesh = useMesh()
  const editable = canEdit(user)
  const state = nodeState(node)
  const granted = (mesh.clients ?? []).filter((c) => c.node_ids.includes(node.id))
  const live = granted.filter((c) => c.session).length

  return (
    <section className="stack-lg">
      <Head
        dot={dotClass(state)}
        name={node.name}
        sub={state === 'up' ? `Онлайн · агент ${formatAgo(node.last_seen_at)}` : NODE_STATE_LABEL[state]}
        subClass={state === 'down' ? 'err-text' : 'muted'}
      />
      {state === 'down' && (
        <div className="callout err">
          Хаб не держит туннель с узлом
          {node.last_seen_at ? `, агент последний раз отвечал ${formatAgo(node.last_seen_at)}` : ''}.
          Клиенты узла не попадут в {node.subnets.join(', ') || 'его сеть'}.
          {node.status_message && <div className="mono" style={{ marginTop: 6 }}>{node.status_message}</div>}
        </div>
      )}
      <Meta
        items={[
          ['Сеть за узлом', node.subnets.join(', ') || '—', true],
          ['Транзит', transportLabel(node), true],
          ['Хост', node.hostname || node.address || '—', true],
          ['Сессий через узел', String(live)],
        ]}
      />
      {editable && (
        <div className="bleed">
          <button
            type="button"
            className="trow"
            aria-pressed={node.transit_obfuscated}
            onClick={() =>
              void mesh
                .updateNode(
                  node,
                  { transit_obfuscated: !node.transit_obfuscated },
                  `${node.name}: транзит ${node.transit_obfuscated ? 'напрямую' : 'внутри HTTPS на 443'}, узел переподключится`,
                )
                .catch(() => {})
            }
          >
            <span className={node.transit_obfuscated ? 'sw on' : 'sw'} />
            <span className="t-main">
              <span className="t-title">Прятать транзит в HTTPS</span>
              <span className="t-sub">WebSocket на 443 — для сетей, где режут VPN</span>
            </span>
          </button>
        </div>
      )}
      <div className="stack" style={{ gap: 8 }}>
        <span className="lbl">Клиенты с доступом</span>
        <ClientChips clients={granted} nodeId={node.id} onSelect={onSelect} />
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <Link className="btn primary" to={`/nodes/${node.id}`}>
          Открыть страницу узла
        </Link>
        {editable && (
          <button
            className="btn sm"
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
            {node.is_enabled ? 'Выключить узел' : 'Включить узел'}
          </button>
        )}
      </div>
    </section>
  )
}

export function HubInspector({ hub, onSelect }) {
  const mesh = useMesh()
  const limits = useResource('/ccd/limits')
  const clients = mesh.clients ?? []
  const sessions = clients.filter((c) => c.session).length
  const exits = hub ? clients.filter((c) => exitGrant(c)?.node_id === hub.id) : []

  if (!hub) {
    return (
      <section className="stack">
        <Head name="panel" sub="Панель ещё не зарегистрировала себя как узел" />
      </section>
    )
  }
  return (
    <section className="stack-lg">
      <Head
        dot={dotClass(nodeState(hub))}
        name={hub.name}
        sub="Сама панель: хаб, через который идут все клиенты"
      />
      <Meta
        items={[
          ['Домен', hub.address, true],
          [
            'Входы',
            `${hub.openvpn_proto}/${hub.openvpn_port}${hub.tcp_port ? `, tcp/${hub.tcp_port}` : ''}`,
            true,
          ],
          ['Пулы', limits.data ? `${cidr(limits.data.subnet)}, ${cidr(limits.data.subnet_tcp)}` : '…', true],
          ['Сессии сейчас', String(sessions)],
        ]}
      />
      <div className="stack" style={{ gap: 8 }}>
        <span className="lbl">Выходят в интернет через панель</span>
        <ClientChips clients={exits} nodeId={hub.id} onSelect={onSelect} />
      </div>
      <span className="hint">Панель тоже узел: клиенту можно выдать выход прямо через неё.</span>
      <Link className="btn" to={`/nodes/${hub.id}`}>
        Проверки и конфиги хаба
      </Link>
    </section>
  )
}

export function PendingInspector({ node }) {
  const { user } = useAuth()
  const mesh = useMesh()
  const [busy, setBusy] = useState(false)

  async function decide(fn) {
    setBusy(true)
    try {
      await fn(node)
    } catch {
      // reported by the mesh
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="stack-lg">
      <Head dot="dot warn" name={node.name} sub="Просится в сеть" subClass="warn-text" />
      <Meta
        items={[
          ['Хост', node.hostname || '—', true],
          ['Сеть за узлом', node.subnets.join(', ') || 'не объявлена', true],
          ['Пришёл с', node.announce_ip || '—', true],
          ['Агент', node.agent_version ? `anemoi ${node.agent_version}` : '—', true],
        ]}
      />
      <div className="stack" style={{ gap: 8 }}>
        <span className="lbl">Отпечаток ключа</span>
        <code className="code wrap" style={{ fontSize: 12 }}>
          {node.key_fingerprint}
        </code>
        <span className="hint">
          Сверь с тем, что агент напечатал на самой ноде. Пока не примешь, узел не получит
          ни сертификата, ни адреса.
        </span>
      </div>
      {canEdit(user) && (
        <div className="row-wrap">
          <button
            className="btn primary"
            type="button"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={() => void decide(mesh.approveNode)}
          >
            Совпадает, принять
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => void decide(mesh.rejectNode)}>
            Отклонить
          </button>
        </div>
      )}
    </section>
  )
}

export function InternetInspector({ onSelect }) {
  const mesh = useMesh()
  const rows = (mesh.clients ?? [])
    .map((client) => ({ client, exit: exitGrant(client) }))
    .filter((row) => row.exit && clientUsable(row.client))
  return (
    <section className="stack-lg">
      <Head name="Интернет" mono={false} sub="Кто через какой узел выходит наружу" />
      <div className="stack" style={{ gap: 6 }}>
        {rows.length === 0 && <span className="hint">Через VPN наружу никто не выходит.</span>}
        {rows.map(({ client, exit }) => (
          <button
            key={client.id}
            type="button"
            className="trow"
            style={{ border: '1px solid var(--line)' }}
            onClick={() => onSelect({ type: 'client', id: client.id })}
          >
            <span className={dotClass(clientState(client))} />
            <span className="mono" style={{ flex: 1, fontWeight: 500 }}>
              {client.common_name}
            </span>
            <span className="exit-text">⇱</span>
            <span className="mono muted">{exit.node_name}</span>
          </button>
        ))}
      </div>
      <span className="hint">
        У клиента один выход. Протяни клиента к «Интернету» на карте или смени выход в его карточке.
      </span>
    </section>
  )
}

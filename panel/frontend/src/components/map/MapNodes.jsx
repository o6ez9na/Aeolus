import { Handle, Position } from '@xyflow/react'
import { memo } from 'react'

import { dotClass } from '../../lib/model'
import { Icon } from '../Icon'

function cls(base, d, extra = '') {
  return [
    'mcard',
    base,
    d.sel && 'sel',
    d.dim && 'dim',
    d.faded && 'faded',
    d.candidate && 'target',
    extra,
  ]
    .filter(Boolean)
    .join(' ')
}

// Hidden anchors: lines need a point to attach to, people do not need to see it.
function Anchor({ type, position, id }) {
  return (
    <Handle
      type={type}
      position={position}
      id={id}
      isConnectable={false}
      className="m-handle quiet"
    />
  )
}

function Grab({ connectable, label }) {
  return (
    <Handle
      type="source"
      position={Position.Right}
      id="grant"
      isConnectable={connectable}
      className={`m-handle source${connectable ? '' : ' quiet'}`}
      title={label}
      aria-label={label}
    />
  )
}

export const ClientCard = memo(function ClientCard({ data: d }) {
  const { client, state, sub } = d
  return (
    <div className={cls('m-client', d)} style={d.member ? { width: 184 } : undefined}>
      <span className="t">
        <span className={`${dotClass(state)}${state === 'online' ? ' pulse' : ''}`} />
        {client.common_name}
      </span>
      <span className={`s ${sub.tone}`}>{client.label && state !== 'online' ? `${client.label} · ${sub.text}` : sub.text}</span>
      {d.member ? (
        <Anchor type="source" position={Position.Right} id="grant" />
      ) : (
        <Grab connectable={d.connectable !== false} label={`Протяни к узлу: выдать доступ ${client.common_name}`} />
      )}
    </div>
  )
})

export const GroupCard = memo(function GroupCard({ data: d }) {
  return (
    <div className={cls('m-group', d, d.drop ? 'drop' : '')}>
      <span className="g-head">
        <Icon name="group" size={15} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {d.group.name}
        </span>
        <span className="count">
          {d.online}/{d.count} в сети
        </span>
      </span>
      <span className="g-sub">{d.summary}</span>
      {d.count === 0 && <span className="hint" style={{ marginTop: 10 }}>перетащи сюда клиентов</span>}
      <Handle
        type="source"
        position={Position.Right}
        id="grant"
        isConnectable={d.connectable !== false}
        className="m-handle source"
        style={{ top: 22 }}
        title="Протяни к узлу: выдать доступ всей группе"
        aria-label={`Выдать доступ группе ${d.group.name}`}
      />
    </div>
  )
})

export const HubCard = memo(function HubCard({ data: d }) {
  const name = d.hub?.name ?? 'panel'
  return (
    <div className={cls('m-hub', d, d.state === 'down' ? 'err' : '')}>
      <Anchor type="target" position={Position.Left} id="in" />
      <span className="t" style={{ fontSize: 15 }}>
        <span className="logo">
          <Icon name="logo" size={18} stroke={1.9} />
        </span>
        {name}
      </span>
      <span className="s mono" style={{ fontSize: 11 }}>
        {d.hub?.address ?? 'панель'}
      </span>
      {d.hub && (
        <span className="s mono" style={{ fontSize: 11 }}>
          {d.hub.openvpn_proto}/{d.hub.openvpn_port}
          {d.hub.tcp_port ? ` · tcp/${d.hub.tcp_port}` : ''}
        </span>
      )}
      <span className={`s ${d.state === 'down' ? 'err' : 'live'}`}>
        {d.state === 'down' ? 'OpenVPN не отвечает' : `сессий: ${d.sessions}`}
      </span>
      {d.candidate && <span className="m-badge">+ доступ</span>}
      <Anchor type="source" position={Position.Right} id="out" />
      <Anchor type="source" position={Position.Bottom} id="exit" />
    </div>
  )
})

export const NodeCard = memo(function NodeCard({ data: d }) {
  const { node, state, sub } = d
  const extra =
    state === 'pending'
      ? 'dashed warn'
      : state === 'reconnecting'
        ? 'warn'
        : state === 'down'
          ? 'err'
          : state === 'off'
            ? 'faded'
            : ''
  return (
    <div className={cls('m-node', d, extra)}>
      <Anchor type="target" position={Position.Left} id="in" />
      <span className="t">
        <span className={dotClass(state)} />
        {node.name}
      </span>
      <span className={`s ${sub.tone}`}>{sub.text}</span>
      {d.candidate && <span className="m-badge">+ доступ</span>}
      <Anchor type="source" position={Position.Right} id="out" />
    </div>
  )
})

export const LanCard = memo(function LanCard({ data: d }) {
  return (
    <div className={cls('m-lan', d, d.pending ? 'dashed' : '')}>
      <Anchor type="target" position={Position.Left} />
      {d.subnets.map((net) => (
        <span key={net}>{net}</span>
      ))}
    </div>
  )
})

export const InetCard = memo(function InetCard({ data: d }) {
  return (
    <div className={cls('m-inet', d)}>
      <Anchor type="target" position={Position.Left} />
      <span className="t" style={{ fontFamily: 'var(--font-sans)', fontSize: 14 }}>
        <Icon name="globe" size={15} style={{ color: 'var(--exit)' }} />
        Интернет
      </span>
      <span className="s">{d.candidate ? 'отпусти: выбрать выход' : `выходов: ${d.count}`}</span>
    </div>
  )
})

export const nodeTypes = {
  client: ClientCard,
  mgroup: GroupCard,
  hub: HubCard,
  vpnnode: NodeCard,
  lan: LanCard,
  inet: InetCard,
}

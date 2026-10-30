/**
 * Words and states the whole panel agrees on, derived from what the API sends.
 * Kept in one place so the map, the tables and the inspector never disagree
 * about whether something is "online".
 */

export function clientState(client) {
  if (client.status === 'revoked') return 'revoked'
  if (client.status === 'disabled') return 'disabled'
  if (
    client.status === 'expired' ||
    (client.expires_at && new Date(client.expires_at).getTime() < Date.now())
  ) {
    return 'expired'
  }
  if (client.session) return 'online'
  if (client.access.length === 0) return 'noaccess'
  return 'offline'
}

/** Whether a client can be routed anywhere at all right now. */
export function clientUsable(client) {
  const state = clientState(client)
  return state === 'online' || state === 'offline'
}

export const CLIENT_STATE_LABEL = {
  online: 'в сети',
  offline: 'не в сети',
  noaccess: 'нет доступа',
  disabled: 'отключён',
  revoked: 'сертификат отозван',
  expired: 'срок истёк',
}

export function nodeState(node) {
  if (node.approval === 'pending') return 'pending'
  if (node.approval === 'rejected') return 'rejected'
  if (!node.is_enabled) return 'off'
  if (node.is_hub) return node.status === 'error' || node.status === 'offline' ? 'down' : 'up'
  // A node is judged by its tunnel: an agent can answer while clients cannot
  // reach anything behind it.
  if (!node.transit_connected) return 'down'
  if (node.status === 'error') return 'down'
  return 'up'
}

export const NODE_STATE_LABEL = {
  up: 'онлайн',
  down: 'нет туннеля',
  pending: 'ждёт подтверждения',
  rejected: 'отклонён',
  off: 'выключен',
}

export function dotClass(state) {
  if (state === 'online' || state === 'up') return 'dot live'
  if (state === 'pending' || state === 'noaccess' || state === 'expired') return 'dot warn'
  if (state === 'down' || state === 'revoked') return 'dot err'
  if (state === 'disabled' || state === 'off' || state === 'rejected') return 'dot off'
  return 'dot'
}

export function transportLabel(node) {
  if (node.is_hub) return `${node.openvpn_proto}/${node.openvpn_port}`
  return node.transit_obfuscated ? 'wss:443' : node.transit_transport.replace('/', ':')
}

export function exitGrant(client) {
  return client.access.find((grant) => grant.is_exit) ?? null
}

/** What the client can reach behind nodes: each grant's scope, or the node's LAN. */
export function clientNetworks(client) {
  return [...new Set(client.access.flatMap((grant) => grant.networks ?? grant.node_subnets))]
}

/** Live session usage, the only per-client counter the hub keeps. */
export function sessionBytes(client) {
  if (!client.session) return { rx: 0, tx: 0 }
  // The hub's "received" is what the client uploaded.
  return { rx: client.session.tx_bytes, tx: client.session.rx_bytes }
}

export function canEdit(user) {
  return user?.role === 'admin' || user?.role === 'operator'
}

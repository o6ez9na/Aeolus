// Network transit between sites (site links): the panel's LAN or another
// node's network reaching a node's LAN over the transit tunnel.

// The first anemoi that forwards between its LAN and linked sites.
export const LINKS_SINCE = [0, 3, 0]

export function versionAtLeast(raw, want = LINKS_SINCE) {
  const have = String(raw ?? '')
    .split('.')
    .map((part) => parseInt(part, 10))
  for (let i = 0; i < want.length; i += 1) {
    const value = Number.isNaN(have[i]) || have[i] === undefined ? 0 : have[i]
    if (value !== want[i]) return value > want[i]
  }
  return true
}

/** The link between two nodes, whichever way round it is stored. */
export const linkOf = (links, a, b) =>
  a && b
    ? links.find(
        (link) =>
          (link.node_a_id === a.id && link.node_b_id === b.id) ||
          (link.node_a_id === b.id && link.node_b_id === a.id),
      )
    : undefined

/** Why a link between `node` and `peer` cannot be switched on, or null. */
export function linkBlocker(node, peer) {
  if (!peer) return 'нет второй стороны'
  if (node.approval !== 'approved' || peer.approval !== 'approved') return 'узел ещё не принят'
  if (!node.subnets.length) return `${node.name} не объявил ни одной сети`
  if (!peer.site_networks.length) {
    return peer.is_hub
      ? 'у панели не задана её сеть — укажи её на странице панели'
      : `${peer.name} не объявил ни одной сети`
  }
  return null
}

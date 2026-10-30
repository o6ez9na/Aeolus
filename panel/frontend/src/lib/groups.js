/**
 * A group's access is edited as a whole list and sent back in one PUT, so the
 * helpers here only ever build the next list from the current one.
 */

const asInput = (grant) => ({
  node_id: grant.node_id,
  is_exit: Boolean(grant.is_exit),
  networks: grant.networks ?? null,
})

export function grantsWith(group, nodeId, patch = {}) {
  const list = group.grants.map(asInput)
  const found = list.find((g) => g.node_id === nodeId)
  if (found) Object.assign(found, patch)
  else list.push({ node_id: nodeId, is_exit: false, networks: null, ...patch })
  return list
}

export function grantsWithout(group, nodeId) {
  return group.grants.filter((g) => g.node_id !== nodeId).map(asInput)
}

/** Make `nodeId` the group's exit (adding the node if needed), or none. */
export function grantsWithExit(group, nodeId) {
  const list = group.grants.map((g) => ({ ...asInput(g), is_exit: g.node_id === nodeId }))
  if (nodeId && !list.some((g) => g.node_id === nodeId)) {
    list.push({ node_id: nodeId, is_exit: true, networks: null })
  }
  return list
}

export function scopeText(networks, subnets) {
  if (!networks) return subnets.length ? subnets.join(', ') : 'выход и сама панель'
  return networks.join(', ')
}

/** "panel ⇱ · home-openvpn · office-lab: 10.18.18.5/32" */
export function groupSummary(group) {
  if (group.grants.length === 0) return 'доступов пока нет'
  return group.grants
    .map((g) => `${g.node_name}${g.is_exit ? ' ⇱' : ''}${g.networks ? `: ${g.networks.join(', ')}` : ''}`)
    .join(' · ')
}

export function membersOf(group, clients) {
  return (clients ?? []).filter((c) => c.group_id === group.id)
}

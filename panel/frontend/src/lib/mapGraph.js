/**
 * The network map, built from data alone.
 *
 * Columns follow the path a packet takes: clients on the left dial the panel
 * (the hub), the panel carries them through a transit tunnel to a node, and
 * the node lets them into its LAN or out to the internet. Grants are not drawn
 * as lines of their own by default: selecting a client lights up the path its
 * grants open, which is what an operator usually wants to know.
 *
 * Saved positions override the computed ones card by card, so a map someone
 * arranged by hand keeps its shape while new cards still land somewhere sane.
 */
import { clientState, clientUsable, nodeState, transportLabel } from './model'
import { formatSince } from './format'
import { groupSummary } from './groups'
import { linkOf } from './links'

export const CLIENT_W = 184
export const CLIENT_H = 56
export const GROUP_W = CLIENT_W + 32
const GROUP_HEAD = 62
const MEMBER_STEP = 66
const COL = { client: 0, hub: 330, node: 590, inet: 870 }
const NODE_W = 196
// Space a side-to-side line between two nodes needs to leave and arrive straight.
const LINK_ROOM = 40

/** A node card grows by a line per network; the gap leaves room for a link's chip. */
const nodeStep = (node) => 103 + Math.max(1, node.subnets.length) * 21

export const cid = (id) => `client:${id}`
export const gid = (id) => `group:${id}`
export const nid = (id) => `node:${id}`
export const HUB = 'hub'
export const INET = 'inet'

export function groupHeight(count) {
  return GROUP_HEAD + Math.max(1, count) * MEMBER_STEP + 4
}

export function memberPosition(index) {
  return { x: 16, y: GROUP_HEAD + index * MEMBER_STEP }
}

/** Clients and nodes as the map shows them, with groups resolved. */
export function prepare({ nodes, clients, groups: serverGroups }) {
  const hub = nodes.find((n) => n.is_hub) ?? null
  const shown = nodes
    .filter((n) => !n.is_hub && n.approval !== 'rejected')
    .sort(
      (a, b) =>
        Number(a.approval === 'pending') - Number(b.approval === 'pending') ||
        a.name.localeCompare(b.name),
    )
  const byId = Object.fromEntries(clients.map((c) => [c.id, c]))
  const groups = (serverGroups ?? []).map((g) => ({
    ...g,
    members: clients
      .filter((c) => c.group_id === g.id)
      .sort((a, b) => a.common_name.localeCompare(b.common_name))
      .map((c) => c.id),
  }))
  const groupOf = {}
  for (const c of clients) if (c.group_id) groupOf[c.id] = c.group_id
  const loose = clients
    .filter((c) => !groupOf[c.id])
    .sort((a, b) => a.common_name.localeCompare(b.common_name))
  return { hub, shown, byId, groups, groupOf, loose }
}

/** Where every card goes when nobody has moved it. */
export function autoPositions(prep) {
  const pos = {}
  let y = 40
  for (const client of prep.loose) {
    pos[cid(client.id)] = { x: COL.client, y }
    y += 74
  }
  if (prep.groups.length) y += 16
  for (const group of prep.groups) {
    pos[gid(group.id)] = { x: COL.client - 16, y }
    y += groupHeight(group.members.length) + 24
  }
  const columnMid = Math.max(140, y / 2)
  pos[HUB] = { x: COL.hub, y: Math.max(40, columnMid - 66) }

  const span = prep.shown.reduce((sum, node) => sum + nodeStep(node), 0)
  let ny = Math.max(40, columnMid - span / 2 + 16)
  for (const node of prep.shown) {
    pos[nid(node.id)] = { x: COL.node, y: ny }
    ny += nodeStep(node)
  }
  pos[INET] = { x: COL.inet, y: Math.max(ny + 16, columnMid + 110) }
  return pos
}

function edgeStyle(stroke, width, opacity) {
  return { stroke, strokeWidth: width, opacity }
}

/**
 * Which sides a line between two nodes uses, going by how the cards stand: side
 * to side when there is room between them, otherwise from the bottom of the upper
 * card to the top of the lower one. Always leaving by the right and arriving on the
 * left would make the line double back whenever the target stands further left.
 */
function linkRoute(a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) >= NODE_W + LINK_ROOM) {
    return { swap: dx < 0, sourceHandle: 'out', targetHandle: 'in' }
  }
  return { swap: dy < 0, sourceHandle: 'bottom', targetHandle: 'top' }
}

/**
 * Which cards and lines the current selection touches. `null` means nothing
 * is singled out and everything is drawn at full strength.
 */
function focus(sel, prep, clients, links) {
  if (!sel || sel.type === 'hub') return null
  const edges = new Set()
  const cards = new Set([HUB])
  if (sel.type === 'transit') {
    edges.add(`t:${sel.id}`)
    cards.add(nid(sel.id))
    return { edges, cards }
  }
  if (sel.type === 'link') {
    const link = links.find((l) => l.id === sel.id)
    if (!link) return null
    edges.add(`k:${link.id}`)
    for (const id of [link.node_a_id, link.node_b_id]) cards.add(nid(id))
    return { edges, cards }
  }
  const holder = (client) => (prep.groupOf[client.id] ? gid(prep.groupOf[client.id]) : cid(client.id))

  const addClient = (client) => {
    cards.add(cid(client.id))
    cards.add(holder(client))
    edges.add(`s:${holder(client)}`)
    for (const grant of client.access) {
      if (grant.node_is_hub) continue
      edges.add(`t:${grant.node_id}`)
      cards.add(nid(grant.node_id))
    }
    const exit = client.access.find((g) => g.is_exit)
    if (exit) {
      edges.add(exit.node_is_hub ? 'x:hub' : `x:${exit.node_id}`)
      cards.add(INET)
    }
  }

  if (sel.type === 'client') {
    const client = prep.byId[sel.id]
    if (!client) return null
    addClient(client)
  } else if (sel.type === 'group') {
    const group = prep.groups.find((g) => g.id === sel.id)
    if (!group) return null
    cards.add(gid(group.id))
    edges.add(`s:${gid(group.id)}`)
    for (const grant of group.grants) {
      if (grant.node_is_hub) continue
      edges.add(`t:${grant.node_id}`)
      cards.add(nid(grant.node_id))
    }
    if (group.grants.some((g) => g.is_exit)) cards.add(INET)
    group.members.forEach((m) => addClient(prep.byId[m]))
  } else if (sel.type === 'node') {
    edges.add(`t:${sel.id}`)
    cards.add(nid(sel.id))
    for (const client of clients) {
      const grant = client.access.find((g) => g.node_id === sel.id)
      if (!grant) continue
      cards.add(cid(client.id))
      cards.add(holder(client))
      edges.add(`s:${holder(client)}`)
      if (grant.is_exit) {
        edges.add(`x:${sel.id}`)
        cards.add(INET)
      }
    }
  } else if (sel.type === 'inet') {
    cards.add(INET)
    for (const client of clients) {
      const exit = client.access.find((g) => g.is_exit)
      if (!exit) continue
      cards.add(cid(client.id))
      cards.add(holder(client))
      edges.add(`s:${holder(client)}`)
      if (exit.node_is_hub) edges.add('x:hub')
      else {
        edges.add(`x:${exit.node_id}`)
        edges.add(`t:${exit.node_id}`)
        cards.add(nid(exit.node_id))
      }
    }
  }
  return { edges, cards }
}

function clientSub(client, state) {
  if (state === 'online') {
    return {
      text: `${client.session.virtual_address || client.tunnel_address || ''} · ${client.session.proto} · ${formatSince(client.session.connected_since)}`,
      tone: '',
    }
  }
  if (state === 'noaccess') return { text: 'нет доступа ни к чему', tone: 'warn' }
  if (state === 'disabled') return { text: 'отключён', tone: '' }
  if (state === 'revoked') return { text: 'сертификат отозван', tone: 'err' }
  if (state === 'expired') return { text: 'срок истёк', tone: 'warn' }
  if (!client.cert_serial) return { text: 'нет сертификата', tone: 'warn' }
  return { text: client.last_seen_at ? 'не в сети' : 'не подключался', tone: '' }
}

export function buildGraph({
  prep,
  clients,
  layout,
  sel,
  layers,
  connectingFrom,
  dropGroup,
  links = [],
  onOpenEdge,
}) {
  const saved = layout?.positions ?? {}
  const auto = autoPositions(prep)
  const at = (id) => saved[id] ?? auto[id]
  const f = focus(sel, prep, clients, links)
  const op = (id) => (f ? (f.cards.has(id) ? 1 : 0.32) : 1)
  const eop = (id) => (f ? (f.edges.has(id) ? 1 : 0.1) : 1)
  const isSel = (type, id) => sel?.type === type && (id === undefined || sel.id === id)

  const connectingClient = connectingFrom?.startsWith('client:')
    ? prep.byId[connectingFrom.slice(7)]
    : null
  const connectingGroup = connectingFrom?.startsWith('group:')
    ? prep.groups.find((g) => g.id === connectingFrom.slice(6))
    : null
  const alreadyGranted = (nodeId) => {
    if (connectingClient) return connectingClient.node_ids.includes(nodeId)
    if (connectingGroup) return connectingGroup.grants.some((g) => g.node_id === nodeId)
    return true
  }
  const connecting = Boolean(connectingClient || connectingGroup)

  const rfNodes = []
  const rfEdges = []
  const edge = (id, source, target, style, { cls = '', sourceHandle, targetHandle, animated, type, data } = {}) =>
    rfEdges.push({
      id,
      source,
      target,
      sourceHandle,
      targetHandle,
      style,
      className: cls,
      animated: animated ?? false,
      focusable: false,
      selectable: false,
      ...(type ? { type } : {}),
      ...(data ? { data } : {}),
    })

  // Groups first: React Flow wants a parent before its children.
  for (const group of prep.groups) {
    const members = group.members.map((m) => prep.byId[m])
    const online = members.filter((c) => clientState(c) === 'online').length
    const id = gid(group.id)
    rfNodes.push({
      id,
      type: 'mgroup',
      position: at(id),
      style: { width: GROUP_W, height: groupHeight(members.length) },
      data: {
        group,
        online,
        summary: groupSummary(group),
        count: members.length,
        sel: isSel('group', group.id),
        dim: op(id) < 1,
        drop: dropGroup === group.id,
        connectable: !connecting,
      },
    })
    members.forEach((client, index) => {
      const state = clientState(client)
      rfNodes.push({
        id: cid(client.id),
        type: 'client',
        parentId: id,
        position: memberPosition(index),
        data: {
          client,
          state,
          sub: clientSub(client, state),
          member: true,
          sel: isSel('client', client.id),
          dim: op(cid(client.id)) < 1 && op(id) < 1,
        },
      })
    })
    const usable = members.filter((c) => clientUsable(c) && c.access.length)
    if (layers.sessions && usable.length) {
      const live = usable.some((c) => c.session)
      edge(`s:${id}`, id, HUB, edgeStyle(live ? 'var(--live)' : 'var(--line-strong)', live ? 2 : 1.5, eop(`s:${id}`)), {
        cls: live ? 'flow' : 'dashed',
        targetHandle: 'in',
      })
    }
  }

  for (const client of prep.loose) {
    const state = clientState(client)
    const id = cid(client.id)
    rfNodes.push({
      id,
      type: 'client',
      position: at(id),
      data: {
        client,
        state,
        sub: clientSub(client, state),
        sel: isSel('client', client.id) || connectingFrom === id,
        dim: connecting ? connectingFrom !== id : op(id) < 1,
        faded: state === 'disabled' || state === 'revoked',
        connectable: state !== 'revoked',
      },
    })
    if (layers.sessions && clientUsable(client) && client.access.length) {
      const live = Boolean(client.session)
      edge(`s:${id}`, id, HUB, edgeStyle(live ? 'var(--live)' : 'var(--line-strong)', live ? 2 : 1.5, eop(`s:${id}`)), {
        cls: live ? 'flow' : 'dashed',
        targetHandle: 'in',
      })
    }
  }

  const hub = prep.hub
  const hubState = hub ? nodeState(hub) : 'up'
  const liveSessions = clients.filter((c) => c.session).length
  rfNodes.push({
    id: HUB,
    type: 'hub',
    position: at(HUB),
    data: {
      hub,
      state: hubState,
      sessions: liveSessions,
      sel: isSel('hub'),
      candidate: connecting && hub && !alreadyGranted(hub.id),
      dim: connecting && !(hub && !alreadyGranted(hub.id)),
    },
  })

  const exitsByNode = {}
  for (const client of clients) {
    if (!clientUsable(client)) continue
    const exit = client.access.find((g) => g.is_exit)
    if (!exit) continue
    const key = exit.node_is_hub ? 'hub' : exit.node_id
    ;(exitsByNode[key] ??= []).push(client)
  }

  prep.shown.forEach((node, index) => {
    const state = nodeState(node)
    const id = nid(node.id)
    const pending = state === 'pending'
    const granted = clients.filter(
      (c) => c.session && c.access.some((g) => g.node_id === node.id),
    ).length
    const candidate = connecting && !pending && state !== 'off' && !alreadyGranted(node.id)
    rfNodes.push({
      id,
      type: 'vpnnode',
      position: at(id),
      data: {
        node,
        state,
        sub:
          state === 'up'
            ? { text: `${transportLabel(node)} · сессий ${granted}`, tone: '' }
            : state === 'reconnecting'
              ? { text: `переподключается · ${transportLabel(node)}`, tone: 'warn' }
              : state === 'down'
              ? { text: `нет туннеля · ${transportLabel(node)}`, tone: 'err' }
              : state === 'pending'
                ? { text: 'заявка · сверить ключ', tone: 'warn' }
                : { text: 'выключен', tone: '' },
        sel: isSel('node', node.id) || isSel('pending', node.id),
        candidate,
        dim: connecting ? !candidate : op(id) < 1,
      },
    })

    if (layers.transit) {
      const color =
        state === 'up'
          ? 'var(--transit)'
          : state === 'reconnecting'
            ? 'var(--warn)'
            : state === 'down'
              ? 'var(--err)'
              : 'var(--line-strong)'
      // Network transit with the panel: the same tunnel, drawn as a bridge
      // while it carries the LANs. Reconnecting, the bridge stays and only
      // pauses; a bridge over a tunnel that is really down takes the alarm
      // colours and says so on its chip.
      const bridged = Boolean(linkOf(links, node, prep.hub))
      const alive = state === 'up' || state === 'reconnecting'
      const selected = isSel('transit', node.id)
      edge(`t:${node.id}`, HUB, id, edgeStyle(color, state === 'up' ? 2.5 : 2, eop(`t:${node.id}`)), {
        cls: `transit-edge${selected ? ' sel' : ''} ${state === 'up' ? '' : state === 'down' ? 'dashed-wide' : 'dotted'}`,
        sourceHandle: 'out',
        targetHandle: 'in',
        type: pending ? undefined : 'transit',
        data: pending
          ? undefined
          : {
              bridged: bridged && alive,
              paused: state === 'reconnecting',
              selected,
              chip:
                bridged && !alive
                  ? '⇄ нет туннеля'
                  : !bridged && state === 'reconnecting'
                    ? 'переподключается…'
                    : selected
                      ? 'транзит'
                      : null,
              chipTone: bridged && !alive ? 'err' : state === 'reconnecting' ? 'warn' : '',
              onOpen: () => onOpenEdge?.({ type: 'transit', id: node.id }),
            },
      })
    }

    const exiting = exitsByNode[node.id]
    if (layers.exits && exiting) {
      const live = exiting.some((c) => c.session)
      edge(`x:${node.id}`, id, INET, edgeStyle('var(--exit)', 2, eop(`x:${node.id}`)), {
        cls: live ? 'flow' : 'dashed',
        sourceHandle: 'out',
      })
    }
    void index
  })

  // Network transit between two nodes: through the hub, both ways.
  if (layers.transit) {
    const shownIds = new Set(prep.shown.map((n) => n.id))
    for (const link of links) {
      if (!shownIds.has(link.node_a_id) || !shownIds.has(link.node_b_id)) continue
      const a = prep.shown.find((n) => n.id === link.node_a_id)
      const b = prep.shown.find((n) => n.id === link.node_b_id)
      const states = [nodeState(a), nodeState(b)]
      const alive = states.every((s) => s === 'up' || s === 'reconnecting')
      const selected = isSel('link', link.id)
      const route = linkRoute(at(nid(a.id)), at(nid(b.id)))
      const [from, to] = route.swap ? [b, a] : [a, b]
      edge(`k:${link.id}`, nid(from.id), nid(to.id), edgeStyle('var(--err)', 1.75, eop(`k:${link.id}`)), {
        cls: `transit-edge${selected ? ' sel' : ''}${alive ? '' : ' dashed-wide'}`,
        sourceHandle: route.sourceHandle,
        targetHandle: route.targetHandle,
        type: 'transit',
        data: {
          bridged: alive,
          paused: states.includes('reconnecting'),
          both: true,
          selected,
          chip: alive ? null : '⇄ нет туннеля',
          chipTone: 'err',
          onOpen: () => onOpenEdge?.({ type: 'link', id: link.id }),
        },
      })
    }
  }

  if (layers.exits && exitsByNode.hub) {
    const live = exitsByNode.hub.some((c) => c.session)
    edge('x:hub', HUB, INET, edgeStyle('var(--exit)', 2, eop('x:hub')), {
      cls: live ? 'flow' : 'dashed',
      sourceHandle: 'exit',
    })
  }

  // Optional: the grants themselves, the way 6ers3rk draws them.
  if (layers.access) {
    const drawn = new Set()
    for (const group of prep.groups) {
      for (const grant of group.grants) {
        const to = grant.node_is_hub ? HUB : nid(grant.node_id)
        const from = gid(group.id)
        edge(`a:${from}~${to}`, from, to, edgeStyle('var(--accent)', 1.5, f ? (f.cards.has(from) ? 0.9 : 0.08) : 0.6), {
          cls: 'dotted',
          targetHandle: 'in',
        })
      }
    }
    for (const client of clients) {
      if (!clientUsable(client)) continue
      const from = cid(client.id)
      for (const grant of client.access) {
        if (grant.group_id) continue
        const to = grant.node_is_hub ? HUB : nid(grant.node_id)
        const key = `a:${from}~${to}`
        if (drawn.has(key)) continue
        drawn.add(key)
        edge(key, from, to, edgeStyle('var(--accent)', 1.25, f ? (f.cards.has(from) ? 0.9 : 0.08) : 0.55), {
          cls: 'dotted',
          targetHandle: 'in',
        })
      }
    }
  }

  const exitCount = Object.values(exitsByNode).reduce((sum, list) => sum + list.length, 0)
  rfNodes.push({
    id: INET,
    type: 'inet',
    position: at(INET),
    data: {
      count: exitCount,
      sel: isSel('inet'),
      candidate: connecting,
      dim: connecting ? false : op(INET) < 1,
    },
  })

  return { rfNodes, rfEdges, auto }
}

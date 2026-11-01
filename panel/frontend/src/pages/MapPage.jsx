import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import { PageHead } from '../components/AppShell'
import { ClientInspector } from '../components/ClientInspector'
import { ConfirmButton } from '../components/ConfirmButton'
import { GroupEditor } from '../components/GroupEditor'
import { Icon } from '../components/Icon'
import { edgeTypes } from '../components/map/MapEdges'
import {
  HubInspector,
  InternetInspector,
  LinkInspector,
  NodeInspector,
  PendingInspector,
  TransitInspector,
} from '../components/map/MapInspectors'
import { nodeTypes } from '../components/map/MapNodes'
import { Modal } from '../components/Overlay'
import { useToast } from '../components/Toast'
import { grantsWith, grantsWithExit } from '../lib/groups'
import { CLIENT_H, CLIENT_W, buildGraph, prepare } from '../lib/mapGraph'
import { useMesh } from '../lib/mesh'
import { canEdit, exitGrant, nodeState } from '../lib/model'
import { useTheme } from '../theme/ThemeContext'

const LAYERS_KEY = 'aeolus.map.layers'
const DEFAULT_LAYERS = { sessions: true, transit: true, lan: true, exits: true, access: false }

const LAYER_DEFS = [
  ['sessions', 'Сессии', 'var(--live)'],
  ['transit', 'Транзит', 'var(--transit)'],
  ['lan', 'Сети', 'var(--line-strong)'],
  ['exits', 'Выходы', 'var(--exit)'],
  ['access', 'Доступы', 'var(--accent)'],
]

function loadLayers() {
  try {
    return { ...DEFAULT_LAYERS, ...JSON.parse(localStorage.getItem(LAYERS_KEY) ?? '{}') }
  } catch {
    return DEFAULT_LAYERS
  }
}

function parseSel(raw) {
  if (!raw) return null
  if (raw === 'hub' || raw === 'inet') return { type: raw }
  const at = raw.indexOf(':')
  if (at < 0) return null
  return { type: raw.slice(0, at), id: raw.slice(at + 1) }
}

const selKey = (sel) => (sel ? (sel.id ? `${sel.type}:${sel.id}` : sel.type) : null)

/** Keep what React Flow measured and anything mid-drag when the data refreshes. */
function merge(previous, next) {
  const old = Object.fromEntries(previous.map((n) => [n.id, n]))
  return next.map((n) => {
    const prev = old[n.id]
    if (!prev) return n
    return {
      ...n,
      measured: prev.measured,
      position: prev.dragging ? prev.position : n.position,
      dragging: prev.dragging,
    }
  })
}

function MapView() {
  const mesh = useMesh()
  const { nodes, clients, layout, setLayout } = mesh
  const { user } = useAuth()
  const { theme } = useTheme()
  const toast = useToast()
  const rf = useReactFlow()
  const editable = canEdit(user)

  const [params, setParams] = useSearchParams()
  const sel = parseSel(params.get('sel'))
  const setSel = useCallback(
    (next) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev)
          const key = selKey(next)
          if (key) p.set('sel', key)
          else p.delete('sel')
          return p
        },
        { replace: true },
      ),
    [setParams],
  )

  const [layers, setLayers] = useState(loadLayers)
  const [connectingFrom, setConnectingFrom] = useState(null)
  const [dropGroup, setDropGroup] = useState(null)
  const [exitFor, setExitFor] = useState(null)

  useEffect(() => {
    try {
      localStorage.setItem(LAYERS_KEY, JSON.stringify(layers))
    } catch {
      // a per-browser convenience only
    }
  }, [layers])

  const prep = useMemo(() => prepare({ nodes, clients, groups: mesh.groups }), [nodes, clients, mesh.groups])
  const links = mesh.links
  const graph = useMemo(
    () =>
      buildGraph({ prep, clients, layout, sel, layers, connectingFrom, dropGroup, links, onOpenEdge: setSel }),
    // sel is rebuilt from the URL on every render; its key is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prep, clients, layout, selKey(sel), layers, connectingFrom, dropGroup, links, setSel],
  )

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(graph.rfNodes)
  useEffect(() => {
    setRfNodes((prev) => merge(prev, graph.rfNodes))
  }, [graph.rfNodes, setRfNodes])

  const groups = prep.groups

  const savePositions = useCallback(
    (patch) => {
      const positions = patch({ ...(layout?.positions ?? {}) })
      setLayout({ positions }, { persist: editable })
    },
    [layout, setLayout, editable],
  )

  // ---------- groups ----------

  const joinGroup = useCallback(
    (client, group) => {
      savePositions((positions) => {
        delete positions[`client:${client.id}`]
        return positions
      })
      void mesh.setClientGroup(client, group).catch(() => {})
    },
    [mesh, savePositions],
  )

  const leaveGroup = useCallback(
    (client, position) => {
      savePositions((positions) => ({ ...positions, [`client:${client.id}`]: position }))
      void mesh.setClientGroup(client, null).catch(() => {})
    },
    [mesh, savePositions],
  )

  const createGroup = useCallback(async () => {
    // Below everything in the client column, where nothing else is drawn.
    const column = rf.getNodes().filter((n) => !n.parentId && (n.type === 'client' || n.type === 'mgroup'))
    const left = column.length ? Math.min(...column.map((n) => n.position.x)) : 0
    const bottom = column.length
      ? Math.max(...column.map((n) => n.position.y + (n.measured?.height ?? CLIENT_H)))
      : 0
    const taken = new Set(groups.map((g) => g.name))
    let n = groups.length + 1
    while (taken.has(`Группа ${n}`)) n += 1
    try {
      const group = await mesh.createGroup({ name: `Группа ${n}`, grants: [] })
      const id = `group:${group.id}`
      savePositions((positions) => ({ ...positions, [id]: { x: Math.round(left - 16), y: Math.round(bottom + 32) } }))
      setSel({ type: 'group', id: group.id })
      setTimeout(() => rf.fitView({ nodes: [{ id }], maxZoom: 1, duration: 300, padding: 0.6 }), 120)
    } catch {
      // reported by the mesh
    }
  }, [groups, mesh, rf, savePositions, setSel])

  const giveGroup = useCallback(
    (group, node) => {
      if (group.grants.some((g) => g.node_id === node.id)) {
        toast.info(`«${group.name}» уже даёт ${node.name}`)
        return
      }
      void mesh
        .setGroupGrants(
          group,
          grantsWith(group, node.id),
          `«${group.name}» → ${node.name}: выдано всем участникам`,
        )
        .catch(() => {})
    },
    [mesh, toast],
  )

  // ---------- drag ----------

  /** The group frame under a card's centre, by absolute coordinates. */
  const groupAt = useCallback(
    (node) => {
      const own = rf.getInternalNode(node.id)
      const at = own?.internals.positionAbsolute ?? node.position
      const cx = at.x + (own?.measured?.width ?? CLIENT_W) / 2
      const cy = at.y + (own?.measured?.height ?? CLIENT_H) / 2
      for (const frame of rf.getNodes().filter((n) => n.type === 'mgroup')) {
        const inner = rf.getInternalNode(frame.id)
        const p = inner?.internals.positionAbsolute ?? frame.position
        const w = inner?.measured?.width ?? frame.style?.width ?? 0
        const h = inner?.measured?.height ?? frame.style?.height ?? 0
        if (cx >= p.x && cx <= p.x + w && cy >= p.y && cy <= p.y + h) {
          return { group: groups.find((g) => `group:${g.id}` === frame.id), at }
        }
      }
      return { group: null, at }
    },
    [rf, groups],
  )

  const onNodeDrag = useCallback(
    (_, node) => {
      if (node.type !== 'client') return
      const { group } = groupAt(node)
      const current = node.data.client.group_id
      setDropGroup(group && group.id !== current ? group.id : null)
    },
    [groupAt],
  )

  const onNodeDragStop = useCallback(
    (_, node) => {
      setDropGroup(null)
      if (!editable) return

      if (node.type === 'client') {
        const client = node.data.client
        const { group, at } = groupAt(node)
        const current = client.group_id
        if (group && group.id !== current) {
          joinGroup(client, group)
        } else if (!group && current) {
          leaveGroup(client, { x: Math.round(at.x), y: Math.round(at.y) })
        } else if (!group) {
          savePositions((positions) => ({
            ...positions,
            [node.id]: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
          }))
        } else {
          // Dropped back into its own group: snap to its seat.
          setRfNodes((prev) => merge(prev.map((n) => ({ ...n, dragging: false })), graph.rfNodes))
        }
        return
      }

      savePositions((positions) => ({
        ...positions,
        [node.id]: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      }))
    },
    [editable, groupAt, joinGroup, leaveGroup, savePositions, setRfNodes, graph.rfNodes],
  )

  // ---------- connect ----------

  const dropOn = useCallback(
    (from, target) => {
      const client = from.startsWith('client:') ? prep.byId[from.slice(7)] : null
      const group = from.startsWith('group:') ? groups.find((g) => g.id === from.slice(6)) : null
      if (!client && !group) return

      if (target === 'inet') {
        setExitFor({ client, group })
        return
      }
      if (target.startsWith('group:') && client) {
        const into = groups.find((g) => `group:${g.id}` === target)
        if (into && into.id !== client.group_id) joinGroup(client, into)
        return
      }
      let node = null
      if (target === 'hub') node = prep.hub
      else if (target.startsWith('node:') || target.startsWith('lan:')) {
        const id = target.slice(target.indexOf(':') + 1)
        node = nodes.find((n) => n.id === id)
      }
      if (!node) return
      const state = nodeState(node)
      if (state === 'pending') {
        toast.info(`${node.name} ещё не принят: сначала сверь отпечаток`)
        return
      }
      if (state === 'off') {
        toast.info(`${node.name} выключен`)
        return
      }
      if (client) void mesh.grant(client, node.id).catch(() => {})
      else giveGroup(group, node)
      setSel(client ? { type: 'client', id: client.id } : { type: 'group', id: group.id })
    },
    [prep, groups, nodes, mesh, toast, joinGroup, giveGroup, setSel],
  )

  const onConnectStart = useCallback((_, { nodeId }) => setConnectingFrom(nodeId), [])
  const onConnectEnd = useCallback(
    (event, state) => {
      const from = state?.fromNode?.id ?? connectingFrom
      setConnectingFrom(null)
      let target = state?.toNode?.id
      if (!target) {
        const point = event.changedTouches?.[0] ?? event
        const el = document.elementFromPoint(point.clientX, point.clientY)?.closest('.react-flow__node')
        target = el?.dataset.id
      }
      if (from && target && target !== from) dropOn(from, target)
    },
    [connectingFrom, dropOn],
  )

  const onNodeClick = useCallback(
    (_, node) => {
      const at = node.id.indexOf(':')
      const [type, id] = at < 0 ? [node.id, undefined] : [node.id.slice(0, at), node.id.slice(at + 1)]
      if (type === 'node' || type === 'lan') {
        const target = nodes.find((n) => n.id === id)
        setSel({ type: target?.approval === 'pending' ? 'pending' : 'node', id })
      } else {
        setSel(id ? { type, id } : { type })
      }
    },
    [nodes, setSel],
  )

  // A transit line opens its inspector: switching network transit on is one
  // click there rather than a trip to the node's page.
  const onEdgeClick = useCallback(
    (_, edge) => {
      if (edge.id.startsWith('t:')) setSel({ type: 'transit', id: edge.id.slice(2) })
      else if (edge.id.startsWith('k:')) setSel({ type: 'link', id: edge.id.slice(2) })
    },
    [setSel],
  )

  const relayout = useCallback(() => {
    savePositions(() => ({}))
    setTimeout(() => rf.fitView({ padding: 0.12, duration: 300 }), 80)
  }, [savePositions, rf])

  // ---------- inspector ----------

  let inspector = null
  const selectedNode = sel?.id ? nodes.find((n) => n.id === sel.id) : null
  const selectedGroup = sel?.type === 'group' ? groups.find((g) => g.id === sel.id) : null
  if (sel?.type === 'client' && prep.byId[sel.id]) {
    inspector = <ClientInspector key={sel.id} client={prep.byId[sel.id]} />
  } else if (sel?.type === 'node' && selectedNode) {
    inspector = selectedNode.is_hub ? (
      <HubInspector hub={selectedNode} onSelect={setSel} />
    ) : (
      <NodeInspector node={selectedNode} onSelect={setSel} />
    )
  } else if (sel?.type === 'pending' && selectedNode) {
    inspector = <PendingInspector node={selectedNode} />
  } else if (selectedGroup) {
    inspector = (
      <GroupEditor
        key={selectedGroup.id}
        group={mesh.groups.find((g) => g.id === selectedGroup.id)}
        onSelectClient={(client) => setSel({ type: 'client', id: client.id })}
        onDeleted={() => setSel(null)}
      />
    )
  } else if (sel?.type === 'transit' && selectedNode && prep.hub) {
    inspector = <TransitInspector key={selectedNode.id} node={selectedNode} hub={prep.hub} onSelect={setSel} />
  } else if (sel?.type === 'link' && links.some((l) => l.id === sel.id)) {
    inspector = <LinkInspector key={sel.id} link={links.find((l) => l.id === sel.id)} onSelect={setSel} />
  } else if (sel?.type === 'inet') {
    inspector = <InternetInspector onSelect={setSel} />
  } else {
    inspector = <HubInspector hub={prep.hub} onSelect={setSel} />
  }

  return (
    <>
      <PageHead title="Карта сети" />


      <div className="map-wrap">
        <section className="panel map-panel" aria-label="Карта соединений">
          <div className="toolbar">
            <span className="lbl" style={{ marginRight: 4 }}>
              Слои
            </span>
            {LAYER_DEFS.map(([key, label, color]) => (
              <button
                key={key}
                type="button"
                className={`layer${layers[key] ? ' on' : ''}`}
                aria-pressed={layers[key]}
                onClick={() => setLayers((l) => ({ ...l, [key]: !l[key] }))}
              >
                <i style={{ background: color, height: key === 'transit' ? 3 : 2 }} />
                {label}
              </button>
            ))}
            <span className="spacer" />
            {editable && (
              <>
                <button className="btn sm" type="button" onClick={() => void createGroup()}>
                  <Icon name="group" size={14} />
                  Группа
                </button>
                <ConfirmButton
                  className="btn sm ghost"
                  label="Разложить заново"
                  armedLabel="Сбросить ручную раскладку?"
                  title="Разложить карту автоматически"
                  onConfirm={relayout}
                />
              </>
            )}
          </div>
          <div className="map-canvas">
            <ReactFlow
              nodes={rfNodes}
              edges={graph.rfEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onPaneClick={() => setSel(null)}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onConnectStart={onConnectStart}
              onConnectEnd={onConnectEnd}
              nodesDraggable={editable}
              nodesConnectable={editable}
              elementsSelectable={false}
              deleteKeyCode={null}
              colorMode={theme}
              fitView
              fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }}
              minZoom={0.25}
              maxZoom={1.8}
              connectionRadius={36}
              connectionLineStyle={{ stroke: 'var(--accent)', strokeWidth: 2 }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
              <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>
          </div>
          {!editable && (
            <div className="toolbar" style={{ borderBottom: 0, borderTop: '1px solid var(--line)' }}>
              <span className="hint">Режим просмотра: менять доступы может оператор или админ.</span>
            </div>
          )}
        </section>

        <aside className="panel panel-pad map-side" aria-label="Свойства выбранного">
          {inspector}
        </aside>
      </div>

      {exitFor && (
        <ExitChooser
          nodes={nodes}
          title={exitFor.client ? exitFor.client.common_name : `группу «${exitFor.group.name}»`}
          current={
            exitFor.client
              ? (exitGrant(exitFor.client)?.node_id ?? null)
              : (exitFor.group.grants.find((g) => g.is_exit)?.node_id ?? null)
          }
          onClose={() => setExitFor(null)}
          onPick={(node) => {
            const { client, group } = exitFor
            setExitFor(null)
            if (client) {
              void mesh.setExit(client, node?.id ?? null).catch(() => {})
              setSel({ type: 'client', id: client.id })
            } else {
              void mesh
                .setGroupGrants(
                  group,
                  grantsWithExit(group, node?.id ?? null),
                  node ? `«${group.name}» выходит в интернет через ${node.name}` : `«${group.name}»: выход не задан`,
                )
                .catch(() => {})
              setSel({ type: 'group', id: group.id })
            }
          }}
        />
      )}
    </>
  )
}

function ExitChooser({ nodes, title, current, onClose, onPick }) {
  const choices = nodes
    .filter((n) => n.approval === 'approved' && n.is_enabled)
    .sort((a, b) => Number(b.is_hub) - Number(a.is_hub) || a.name.localeCompare(b.name))
  return (
    <Modal title="Выход в интернет" onClose={onClose}>
      <div className="stack">
        <div className="panel-head">
          <h2 style={{ fontSize: 17 }}>Куда выпускать {title}</h2>
          <button className="icon-btn" type="button" aria-label="Закрыть" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="bleed" style={{ gap: 4 }}>
          {[null, ...choices].map((node) => (
            <button
              key={node?.id ?? 'none'}
              type="button"
              className={`opt${(node?.id ?? null) === current ? ' on' : ''}`}
              onClick={() => onPick(node)}
            >
              <span className="radio" />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }} className={node ? 'mono' : ''}>
                  {node ? `через ${node.name}` : 'Не выпускать'}
                </span>
                <span className="hint">
                  {node
                    ? node.is_hub
                      ? 'IP панели'
                      : `IP узла${nodeState(node) === 'down' ? ' · сейчас недоступен' : ''}`
                    : 'только разрешённые сети'}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

export function MapPage() {
  const mesh = useMesh()
  if (mesh.loading || !mesh.layout) {
    return (
      <>
        <PageHead title="Карта сети" />
        <div className="panel empty-state">загрузка карты…</div>
      </>
    )
  }
  return (
    <ReactFlowProvider>
      <MapView />
    </ReactFlowProvider>
  )
}

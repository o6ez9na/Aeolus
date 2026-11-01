import { useState } from 'react'

import { linkBlocker, linkOf, versionAtLeast } from '../lib/links'
import { useMesh } from '../lib/mesh'

/**
 * Network transit of an ordinary node: its LAN and the panel's, or another
 * node's, reaching each other over the transit, with no VPN client on any
 * device. The node page shows every peer; the map's transit inspector has its
 * own button for the panel and lists only the other nodes here.
 */
export function SiteLinks({ node, editable, withHub = true, title = 'Транзит сетей', bare = false }) {
  const mesh = useMesh()
  const [busy, setBusy] = useState(null)
  const hub = mesh.nodes.find((n) => n.is_hub)
  const peers = [
    withHub ? hub : null,
    ...mesh.nodes.filter((n) => !n.is_hub && n.id !== node.id && n.approval === 'approved'),
  ].filter(Boolean)
  const linked = peers.filter((peer) => linkOf(mesh.links, node, peer))
  const oldAgent = !versionAtLeast(node.agent_version)

  const toggle = (peer) => {
    const link = linkOf(mesh.links, node, peer)
    setBusy(peer.id)
    void (link ? mesh.unlinkNodes(link) : mesh.linkNodes(node, peer))
      .catch(() => {})
      .finally(() => setBusy(null))
  }

  const rows = (
    <div className="bleed">
      {peers.map((peer) => {
        const on = Boolean(linkOf(mesh.links, node, peer))
        const nets = peer.site_networks
        const blocked = !on && linkBlocker(node, peer)
        const disabled = !editable || busy !== null || Boolean(blocked)
        return (
          <button
            key={peer.id}
            type="button"
            className="trow"
            aria-pressed={on}
            aria-disabled={disabled}
            title={blocked || undefined}
            onClick={() => !disabled && toggle(peer)}
          >
            <span className={on ? 'sw on' : 'sw'} />
            <span className="t-main">
              <span className={`t-title${peer.is_hub ? '' : ' mono'}`}>
                {peer.is_hub ? 'Сеть панели' : peer.name}
              </span>
              <span className={`t-sub${nets.length ? ' mono' : ''}`}>
                {nets.length
                  ? `${nets.join(', ')} · ${peer.is_hub ? 'отсюда туда, через NAT панели' : 'в обе стороны'}`
                  : blocked || '—'}
              </span>
            </span>
            {busy === peer.id && <span className="hint">…</span>}
          </button>
        )
      })}
      {peers.length === 0 && <span className="hint">Других принятых узлов пока нет.</span>}
    </div>
  )

  const notes = (
    <>
      {oldAgent && linked.length > 0 && (
        <span className="hint warn-text">
          Агент {node.agent_version || '?'} не умеет транзит сетей: переустанови узел командой со
          страницы узлов, нужен anemoi 0.3.0 или новее.
        </span>
      )}
    </>
  )

  if (bare) {
    return (
      <>
        {rows}
        {notes}
      </>
    )
  }

  return (
    <section className="panel panel-pad stack" aria-label={title}>
      <h2 style={{ fontSize: 15 }}>{title}</h2>
      {rows}
      {!node.subnets.length && <span className="hint">Узел не объявил ни одной сети: связывать нечего.</span>}
      {notes}
    </section>
  )
}

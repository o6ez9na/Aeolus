import { Link } from 'react-router-dom'

import { PageHead } from '../components/AppShell'
import { formatBytes, formatSince } from '../lib/format'
import { useMesh } from '../lib/mesh'
import { dotClass, nodeState, sessionBytes } from '../lib/model'

/**
 * What the panel can count today: live session counters on the hub and the
 * agents' own counters. They restart with OpenVPN, so this is "right now", not
 * history — the page says so instead of drawing a chart it cannot back.
 */
export function TrafficPage() {
  const mesh = useMesh()
  if (mesh.loading) {
    return (
      <>
        <PageHead title="Трафик" />
        <div className="panel empty-state">загрузка…</div>
      </>
    )
  }

  const sessions = mesh.clients
    .filter((c) => c.session)
    .map((c) => ({ client: c, ...sessionBytes(c) }))
    .sort((a, b) => b.rx + b.tx - (a.rx + a.tx))
  const down = sessions.reduce((sum, s) => sum + s.rx, 0)
  const up = sessions.reduce((sum, s) => sum + s.tx, 0)
  const nodes = mesh.nodes.filter((n) => n.approval === 'approved')
  const busiest = Math.max(1, ...sessions.map((s) => s.rx + s.tx))
  const nodeMax = Math.max(1, ...nodes.map((n) => n.rx_bytes + n.tx_bytes))

  return (
    <>
      <PageHead
        title="Трафик"
        sub="Счётчики живых сессий и агентов. Истории пока нет: после переподключения счёт начинается заново."
      />
      <div className="tiles">
        <div className="panel tile">
          <span className="lbl">Сессий сейчас</span>
          <span className="value">{sessions.length}</span>
        </div>
        <div className="panel tile">
          <span className="lbl">Клиенты скачали</span>
          <span className="value mono" style={{ fontSize: 20 }}>
            ↓{formatBytes(down)}
          </span>
        </div>
        <div className="panel tile">
          <span className="lbl">Клиенты отдали</span>
          <span className="value mono" style={{ fontSize: 20 }}>
            ↑{formatBytes(up)}
          </span>
        </div>
      </div>

      <div className="cols">
        <section className="panel col-main" style={{ overflow: 'hidden', gap: 0 }} aria-label="Сессии клиентов">
          <div className="panel-head panel-pad" style={{ paddingBottom: 8 }}>
            <h2>Живые сессии</h2>
          </div>
          <div className="table-wrap">
            <table className="table" style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  <th>Клиент</th>
                  <th>Вход</th>
                  <th>Длится</th>
                  <th>Объём</th>
                  <th className="num">↓ / ↑</th>
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <div className="empty-state">Сейчас никто не подключён</div>
                    </td>
                  </tr>
                )}
                {sessions.map(({ client, rx, tx }) => (
                  <tr key={client.id}>
                    <td>
                      <Link className="mono" to={`/clients?open=${client.id}`} style={{ color: 'var(--text)', fontWeight: 600, textDecoration: 'none' }}>
                        {client.common_name}
                      </Link>
                    </td>
                    <td className="mono muted">{client.session.proto}</td>
                    <td className="muted">{formatSince(client.session.connected_since)}</td>
                    <td>
                      <span className="bar" style={{ width: 120 }}>
                        <span style={{ width: `${Math.round(((rx + tx) / busiest) * 100)}%` }} />
                      </span>
                    </td>
                    <td className="num mono muted">
                      {formatBytes(rx)} / {formatBytes(tx)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel panel-pad col-side stack" aria-label="Узлы">
          <h2 style={{ fontSize: 15 }}>Узлы</h2>
          {nodes.map((node) => (
            <div key={node.id} className="stack" style={{ gap: 6 }}>
              <div className="panel-head">
                <span className="row-wrap" style={{ gap: 8 }}>
                  <span className={dotClass(nodeState(node))} />
                  <Link className="mono" to={`/nodes/${node.id}`} style={{ color: 'var(--text)', textDecoration: 'none', fontWeight: 600 }}>
                    {node.name}
                  </Link>
                </span>
                <span className="mono hint">
                  ↓{formatBytes(node.rx_bytes)} ↑{formatBytes(node.tx_bytes)}
                </span>
              </div>
              <span className="bar wide">
                <span style={{ width: `${Math.round(((node.rx_bytes + node.tx_bytes) / nodeMax) * 100)}%` }} />
              </span>
              <span className="hint">
                {node.bandwidth_mbps} из {node.bandwidth_capacity_mbps} Мбит/с
              </span>
            </div>
          ))}
        </section>
      </div>
    </>
  )
}

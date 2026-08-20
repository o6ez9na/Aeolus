/**
 * Which nodes a client may use, and where its traffic leaves.
 *
 * These are the two questions the panel exists to answer, so they are one row
 * of switches on the client itself rather than a separate section an operator
 * has to know to visit.
 */
export function AccessPicker({ client, nodes, busy, onToggleNode, onSetExit }) {
  if (nodes.length === 0) {
    return (
      <div className="sub">
        узлов ещё нет — заявку от нового узла видно в разделе «узлы»
      </div>
    )
  }

  const grantByNode = Object.fromEntries(client.access.map((g) => [g.node_id, g]))
  const exitGrant = client.access.find((g) => g.is_exit)

  return (
    <div className="access">
      <div className="access-head">
        <span className="dim">доступ к узлам</span>
        <span className="sub">
          {exitGrant
            ? `весь трафик уходит через ${exitGrant.node_name}`
            : 'выход в интернет не выдан — клиент видит только разрешённые сети'}
        </span>
      </div>

      <div className="access-chips">
        {nodes.map((node) => {
          const grant = grantByNode[node.id]
          const granted = Boolean(grant)
          const working = busy === node.id

          return (
            <span
              key={node.id}
              className={`achip${granted ? ' on' : ''}${working ? ' busy' : ''}`}
            >
              <button
                type="button"
                className="achip-main"
                aria-pressed={granted}
                disabled={working}
                onClick={() => onToggleNode(node, granted)}
                title={
                  granted
                    ? `Забрать у ${client.common_name} доступ к ${node.name}`
                    : `Дать ${client.common_name} доступ к ${node.name}`
                }
              >
                {node.is_hub ? `${node.name} · сама панель` : node.name}
                {node.subnets.length > 0 && (
                  <span className="achip-sub">{node.subnets.join(', ')}</span>
                )}
              </button>

              {granted && (
                <button
                  type="button"
                  className={`achip-exit${grant.is_exit ? ' on' : ''}`}
                  aria-pressed={grant.is_exit}
                  disabled={working}
                  onClick={() => onSetExit(grant, !grant.is_exit)}
                  title={
                    grant.is_exit
                      ? `Перестать выпускать весь трафик через ${node.name}`
                      : `Выпускать весь трафик ${client.common_name} через ${node.name}`
                  }
                >
                  {grant.is_exit ? '⇱ выход' : 'выход'}
                </button>
              )}
            </span>
          )
        })}
      </div>
    </div>
  )
}

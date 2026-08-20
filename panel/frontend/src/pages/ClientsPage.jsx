import { useCallback, useState } from 'react'
import { useOutletContext } from 'react-router-dom'

import { api, authorizedDownload } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { ConfirmButton } from '../components/ConfirmButton'
import { NodePicker } from '../components/NodePicker'
import { formatAgo, formatBytes } from '../lib/format'
import { useResource } from '../lib/useResource'

const STATUS_DOT = {
  active: 'online',
  disabled: 'disabled',
  expired: 'unknown',
  revoked: 'error',
}

function AccessSummary({ client, nodesById }) {
  if (client.node_ids.length === 0) {
    return <div className="sub warn">нет доступа к узлам</div>
  }
  const names = client.node_ids.map((id) => nodesById[id]?.name ?? '—')
  return <div className="sub">{names.join(' · ')}</div>
}

function ClientRow({ client, nodesById, canEdit, expanded, onExpand, onToggle, onDelete }) {
  return (
    <div className="row clients">
      <span className={`dot ${STATUS_DOT[client.status] ?? 'unknown'}`} />
      <span>
        <span className={`name ${client.status === 'active' ? '' : 'faded'}`}>
          {client.common_name}
        </span>
        {client.label && <div className="sub">{client.label}</div>}
      </span>
      <span>
        <AccessSummary client={client} nodesById={nodesById} />
      </span>
      <span className="muted">{client.status}</span>
      <span className="muted">{formatBytes(client.traffic_used_bytes)}</span>
      <span className="muted">
        {client.expires_at
          ? new Date(client.expires_at).toLocaleDateString('ru-RU')
          : 'бессрочно'}
      </span>
      <span className="muted">{formatAgo(client.last_seen_at)}</span>
      <span className="right actions">
        {canEdit && (
          <>
            <button className="btn" onClick={() => onExpand(expanded ? null : client.id)}>
              {expanded ? 'скрыть' : 'доступ'}
            </button>
            <button className="btn" onClick={() => onToggle(client)}>
              {client.status === 'active' ? 'выкл' : 'вкл'}
            </button>
            <ConfirmButton
              title={`Удалить клиента ${client.common_name} и отозвать его сертификат`}
              onConfirm={() => onDelete(client)}
            />
          </>
        )}
      </span>
    </div>
  )
}

export function ClientsPage() {
  const { user } = useAuth()
  const { reloadSummary } = useOutletContext()
  const clients = useResource('/clients', { pollMs: 20000 })
  const nodes = useResource('/nodes')

  const [commonName, setCommonName] = useState('')
  const [nodeIds, setNodeIds] = useState([])
  const [formOpen, setFormOpen] = useState(false)
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [expandedId, setExpandedId] = useState(null)
  const [draftAccess, setDraftAccess] = useState([])
  const [actionError, setActionError] = useState(null)

  const canEdit = user?.role === 'admin' || user?.role === 'operator'
  const nodeList = nodes.data ?? []

  const refreshAll = useCallback(async () => {
    await Promise.all([clients.reload({ quiet: true }), reloadSummary({ quiet: true })])
  }, [clients, reloadSummary])

  async function handleCreate(event) {
    event.preventDefault()
    setBusy(true)
    setFormError(null)
    try {
      await api.post('/clients', { common_name: commonName, node_ids: nodeIds })
      setCommonName('')
      setNodeIds([])
      setFormOpen(false)
      await refreshAll()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Не удалось создать клиента')
    } finally {
      setBusy(false)
    }
  }

  function handleExpand(clientId) {
    setExpandedId(clientId)
    const client = (clients.data ?? []).find((c) => c.id === clientId)
    setDraftAccess(client ? client.node_ids : [])
  }

  async function saveAccess(client) {
    setBusy(true)
    try {
      await api.patch(`/clients/${client.id}`, { node_ids: draftAccess })
      setExpandedId(null)
      await refreshAll()
    } finally {
      setBusy(false)
    }
  }

  async function handleToggle(client) {
    await api.patch(`/clients/${client.id}`, {
      status: client.status === 'active' ? 'disabled' : 'active',
    })
    await refreshAll()
  }

  async function handleDelete(client) {
    setActionError(null)
    try {
      // The backend revokes the certificate first and refuses to delete if it
      // cannot, so a failure here means the client is still there on purpose.
      await api.delete(`/clients/${client.id}`)
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : `Не удалось удалить ${client.common_name}`,
      )
    }
    await refreshAll()
  }

  if (clients.loading) return <div className="empty">загрузка клиентов…</div>
  if (clients.error) return <div className="empty form-error">{clients.error}</div>

  const nodesById = Object.fromEntries(nodeList.map((node) => [node.id, node]))

  return (
    <>
      <div className="row clients head">
        <span />
        <span className="dim">клиент</span>
        <span className="dim">выход через</span>
        <span className="dim">статус</span>
        <span className="dim">трафик</span>
        <span className="dim">истекает</span>
        <span className="dim">был</span>
        <span />
      </div>

      {actionError && <div className="empty form-error">{actionError}</div>}

      {clients.data.length === 0 && (
        <div className="empty">
          клиентов нет.{' '}
          {canEdit ? 'создай первого ниже.' : 'создание доступно оператору и админу.'}
        </div>
      )}

      {clients.data.map((client) => (
        <div key={client.id}>
          <ClientRow
            client={client}
            nodesById={nodesById}
            canEdit={canEdit}
            expanded={expandedId === client.id}
            onExpand={handleExpand}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
          {expandedId === client.id && (
            <div className="inline-form fade-in">
              <div className="field" style={{ flex: 1 }}>
                через какие узлы выпускать {client.common_name}
                <NodePicker nodes={nodeList} value={draftAccess} onChange={setDraftAccess} />
              </div>
              <button className="btn" disabled={busy} onClick={() => saveAccess(client)}>
                {busy ? 'сохраняю…' : 'сохранить'}
              </button>
              <button className="btn ghost" onClick={() => setExpandedId(null)}>
                отмена
              </button>
              {client.cert_serial && client.status !== 'revoked' && (
                <div className="field" style={{ flexBasis: '100%' }}>
                  конфигурация клиента
                  <div className="picker">
                    {client.node_ids.map((nodeId) => (
                      <button
                        key={nodeId}
                        type="button"
                        className="btn"
                        onClick={() =>
                          authorizedDownload(
                            `/clients/${client.id}/config/${nodeId}`,
                            `${client.common_name}-${nodesById[nodeId]?.name ?? 'node'}.ovpn`,
                          )
                        }
                      >
                        скачать .ovpn · {nodesById[nodeId]?.name ?? '—'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {!client.cert_serial && (
                <span className="sub warn">
                  сертификата нет — выпусти его в разделе pki, тогда появится .ovpn
                </span>
              )}
            </div>
          )}
        </div>
      ))}

      {canEdit && !formOpen && (
        <div className="term-foot">
          <button className="btn" onClick={() => setFormOpen(true)}>
            добавить клиента
          </button>
          <span className="dim">сертификат выпускается позже, в разделе pki</span>
        </div>
      )}

      {formOpen && (
        <form className="inline-form fade-in" onSubmit={handleCreate}>
          <label className="field">
            common name
            <input
              value={commonName}
              onChange={(e) => setCommonName(e.target.value)}
              placeholder="user-042"
              pattern="[a-zA-Z0-9_.\-]+"
              autoFocus
              required
            />
          </label>
          <div className="field" style={{ flex: 1 }}>
            доступ к узлам
            <NodePicker nodes={nodeList} value={nodeIds} onChange={setNodeIds} />
          </div>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'создаю…' : 'создать'}
          </button>
          <button className="btn ghost" type="button" onClick={() => setFormOpen(false)}>
            отмена
          </button>
          {formError && <span className="form-error">{formError}</span>}
        </form>
      )}
    </>
  )
}

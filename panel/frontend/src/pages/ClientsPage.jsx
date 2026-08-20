import { useCallback, useState } from 'react'
import { useOutletContext } from 'react-router-dom'

import { api, authorizedDownload } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { ConfirmButton } from '../components/ConfirmButton'
import { AccessPicker } from '../components/AccessPicker'
import { NodePicker } from '../components/NodePicker'
import { formatAgo, formatBytes } from '../lib/format'
import { useResource } from '../lib/useResource'

const STATUS_DOT = {
  active: 'online',
  disabled: 'disabled',
  expired: 'unknown',
  revoked: 'error',
}

function AccessSummary({ client }) {
  if (client.access.length === 0) {
    return <div className="sub warn">нет доступа к узлам</div>
  }
  const exit = client.access.find((g) => g.is_exit)
  return (
    <div className="sub">
      {client.access.map((g) => g.node_name).join(' · ')}
      {exit && <div className="hl">весь трафик → {exit.node_name}</div>}
    </div>
  )
}

function ClientRow({ client, canEdit, expanded, onExpand, onToggle, onDelete }) {
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
        <AccessSummary client={client} />
      </span>
      <span className="muted">{client.tunnel_address ?? '—'}</span>
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
  const [actionError, setActionError] = useState(null)
  const [accessError, setAccessError] = useState(null)
  const [busyNode, setBusyNode] = useState(null)

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
    setAccessError(null)
  }

  async function handleToggleNode(client, node, granted) {
    setBusyNode(node.id)
    setAccessError(null)
    try {
      const next = granted
        ? client.node_ids.filter((id) => id !== node.id)
        : [...client.node_ids, node.id]
      await api.patch(`/clients/${client.id}`, { node_ids: next })
      await refreshAll()
    } catch (err) {
      setAccessError(err instanceof Error ? err.message : 'Не удалось изменить доступ')
    } finally {
      setBusyNode(null)
    }
  }

  async function handleSetExit(grant, isExit) {
    setBusyNode(grant.node_id)
    setAccessError(null)
    try {
      await api.post(`/ccd/${grant.grant_id}/exit`, { is_exit: isExit })
      await refreshAll()
    } catch (err) {
      setAccessError(err instanceof Error ? err.message : 'Не удалось переключить выход')
    } finally {
      setBusyNode(null)
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

  return (
    <>
      <div className="row clients head">
        <span />
        <span className="dim">клиент</span>
        <span className="dim">доступ</span>
        <span className="dim">адрес</span>
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
            canEdit={canEdit}
            expanded={expandedId === client.id}
            onExpand={handleExpand}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
          {expandedId === client.id && (
            <div className="inline-form fade-in">
              <AccessPicker
                client={client}
                nodes={nodeList}
                busy={busyNode}
                onToggleNode={(node, granted) => handleToggleNode(client, node, granted)}
                onSetExit={handleSetExit}
              />

              <div className="field" style={{ flexBasis: '100%' }}>
                профиль
                {client.cert_serial && client.status !== 'revoked' ? (
                  <div className="picker">
                    <button
                      className="btn"
                      onClick={() =>
                        authorizedDownload(
                          `/clients/${client.id}/config`,
                          `${client.common_name}.ovpn`,
                        )
                      }
                    >
                      скачать .ovpn
                    </button>
                    <span className="sub">
                      один на клиента, ведёт на панель — менять узел выхода можно
                      без перевыпуска
                    </span>
                  </div>
                ) : (
                  <span className="sub warn">
                    сертификата нет — выпусти его в разделе pki, тогда появится .ovpn
                  </span>
                )}
              </div>

              {accessError && <span className="form-error">{accessError}</span>}
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'

import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { ConfirmButton } from '../components/ConfirmButton'
import { daysUntil, formatAgo, meter, pluralRu } from '../lib/format'
import { useResource } from '../lib/useResource'

const EMPTY_FORM = { name: '', address: '', openvpn_port: '1194', openvpn_proto: 'udp', role: 'slave' }

function NodeSubline({ node }) {
  if (!node.is_enabled) return <div className="sub">выключен вручную</div>
  if (node.status_message) return <div className="sub err">{node.status_message}</div>

  // The agent reporting in says nothing about the tunnel clients actually
  // travel through, and a node whose transit is down routes nobody.
  if (!node.transit_connected) {
    return (
      <div className="sub err">
        туннель до панели не установлен
        {!node.transit_obfuscated && ' — попробуй ws'}
      </div>
    )
  }

  const days = daysUntil(node.server_cert_not_after)
  if (days !== null && days <= 14) {
    return (
      <div className="sub warn">
        cert · {days} {pluralRu(days, 'день', 'дня', 'дней')}
      </div>
    )
  }
  return <div className="sub">{node.status === 'unknown' ? 'агент не подключался' : ''}</div>
}

/** A node that announced itself and is waiting for someone to accept it. */
function PendingRow({ node, canEdit, busy, onApprove, onReject }) {
  return (
    <div className="pending-card">
      <div className="pending-head">
        <span className="name">{node.name}</span>
        <span className="sub">
          {node.hostname || 'без имени хоста'} · {node.announce_ip || 'адрес неизвестен'}
          {node.agent_version && ` · anemoi ${node.agent_version}`}
        </span>
      </div>

      <div className="field">
        отпечаток ключа — сверь с тем, что агент напечатал на самой ноде
        <code className="fingerprint">{node.key_fingerprint}</code>
      </div>

      <div className="field">
        сети за узлом
        <span className="muted">
          {node.subnets.length ? node.subnets.join(', ') : 'не объявлены'}
        </span>
      </div>

      {canEdit && (
        <div className="pending-actions">
          <button className="btn" disabled={busy} onClick={() => onApprove(node)}>
            принять
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => onReject(node)}>
            отклонить
          </button>
        </div>
      )}
    </div>
  )
}

function NodeRow({ node, canEdit, onToggle, onDelete, onObfuscate }) {
  const bar = meter(node.bandwidth_mbps, node.bandwidth_capacity_mbps)

  return (
    <div className="row">
      <span
        className={`dot ${
          !node.is_enabled
            ? 'disabled'
            : node.transit_connected
              ? node.status
              : 'error'
        }`}
      />
      <span>
        <span className={`name ${node.status === 'online' ? '' : 'faded'}`}>{node.name}</span>
        <NodeSubline node={node} />
      </span>
      <span className="muted">{node.address}</span>
      <span className="muted">
        {node.openvpn_proto}/{node.openvpn_port}
      </span>
      {node.role === 'master' ? (
        <span className="chip">master</span>
      ) : (
        <span className="dim">slave</span>
      )}
      <span className="muted">{node.status === 'online' ? node.sessions : '—'}</span>
      <span className="right">
        <span className="bar-fill">{bar.filled}</span>
        <span className="bar-empty">{bar.empty}</span>
        <div className="sub">{node.bandwidth_mbps} мбит/с</div>
      </span>
      <span className="muted">{formatAgo(node.last_seen_at)}</span>
      <span className="right actions">
        {canEdit && (
          <>
            {!node.is_hub && (
              <button
                className={`btn${node.transit_obfuscated ? '' : ' ghost'}`}
                onClick={() => onObfuscate(node)}
                title={
                  node.transit_obfuscated
                    ? 'Вернуть прямой транзит'
                    : 'Вести транзит внутри WebSocket на 443 — для сетей, где режут VPN'
                }
              >
                {node.transit_obfuscated ? 'ws вкл' : 'ws'}
              </button>
            )}
            <button className="btn" onClick={() => onToggle(node)}>
              {node.is_enabled ? 'выкл' : 'вкл'}
            </button>
            <ConfirmButton title={`Удалить узел ${node.name}`} onConfirm={() => onDelete(node)} />
          </>
        )}
      </span>
    </div>
  )
}

export function NodesPage() {
  const { user } = useAuth()
  const { reloadSummary } = useOutletContext()
  const { data: nodes, error, loading, reload } = useResource('/nodes', { pollMs: 15000 })

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef(null)

  const canEdit = user?.role === 'admin' || user?.role === 'operator'

  const refreshAll = useCallback(async () => {
    await Promise.all([reload({ quiet: true }), reloadSummary({ quiet: true })])
  }, [reload, reloadSummary])

  // Hotkeys from the reference footer: r reloads, n opens the create form.
  useEffect(() => {
    function onKey(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.target.matches('input, select, textarea')) return
      if (event.key === 'r') void refreshAll()
      if (event.key === 'n' && canEdit) setFormOpen((open) => !open)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [refreshAll, canEdit])

  useEffect(() => {
    if (formOpen) nameRef.current?.focus()
  }, [formOpen])

  async function handleCreate(event) {
    event.preventDefault()
    setBusy(true)
    setFormError(null)
    try {
      await api.post('/nodes', {
        ...form,
        openvpn_port: Number(form.openvpn_port),
      })
      setForm(EMPTY_FORM)
      setFormOpen(false)
      await refreshAll()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Не удалось создать узел')
    } finally {
      setBusy(false)
    }
  }

  async function handleToggle(node) {
    await api.patch(`/nodes/${node.id}`, { is_enabled: !node.is_enabled })
    await refreshAll()
  }

  async function handleObfuscate(node) {
    await api.patch(`/nodes/${node.id}`, {
      transit_obfuscated: !node.transit_obfuscated,
    })
    await refreshAll()
  }

  async function handleDelete(node) {
    await api.delete(`/nodes/${node.id}`)
    await refreshAll()
  }

  async function decide(node, verdict) {
    setBusy(true)
    setFormError(null)
    try {
      await api.post(`/nodes/${node.id}/${verdict}`)
      await refreshAll()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Не удалось применить решение')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="empty">загрузка узлов…</div>
  if (error) return <div className="empty form-error">{error}</div>

  const pending = nodes.filter((node) => node.approval === 'pending')
  const members = nodes.filter((node) => node.approval !== 'pending')

  return (
    <>
      {pending.length > 0 && (
        <div className="pending-block">
          <div className="sub" style={{ marginBottom: 10 }}>
            заявки на подключение — узел ничего не получает, пока его не принять
          </div>
          {pending.map((node) => (
            <PendingRow
              key={node.id}
              node={node}
              canEdit={canEdit}
              busy={busy}
              onApprove={(n) => decide(n, 'approve')}
              onReject={(n) => decide(n, 'reject')}
            />
          ))}
        </div>
      )}

      <div className="row head">
        <span />
        <span className="dim">узел</span>
        <span className="dim">адрес</span>
        <span className="dim">транспорт</span>
        <span className="dim">роль</span>
        <span className="dim">сес</span>
        <span className="dim right">канал</span>
        <span className="dim">ответ</span>
        <span />
      </div>

      {members.length === 0 && (
        <div className="empty">
          узлов нет. {canEdit ? 'нажми n или «добавить узел».' : 'обратись к оператору.'}
        </div>
      )}

      {members.map((node) => (
        <NodeRow
          key={node.id}
          node={node}
          canEdit={canEdit}
          onToggle={handleToggle}
          onDelete={handleDelete}
          onObfuscate={handleObfuscate}
        />
      ))}

      {canEdit && !formOpen && (
        <div className="term-foot">
          <button className="btn" onClick={() => setFormOpen(true)}>
            добавить узел
          </button>
          <span className="dim">n новый · r обновить</span>
        </div>
      )}

      {formOpen && (
        <form className="inline-form fade-in" onSubmit={handleCreate}>
          <label className="field">
            имя
            <input
              ref={nameRef}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="frankfurt-01"
              pattern="[a-z0-9][a-z0-9_.\-]*"
              required
            />
          </label>
          <label className="field">
            адрес
            <input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="10.8.0.1"
              required
            />
          </label>
          <label className="field">
            порт
            <input
              type="number"
              min="1"
              max="65535"
              style={{ width: 80 }}
              value={form.openvpn_port}
              onChange={(e) => setForm({ ...form, openvpn_port: e.target.value })}
              required
            />
          </label>
          <label className="field">
            протокол
            <select
              value={form.openvpn_proto}
              onChange={(e) => setForm({ ...form, openvpn_proto: e.target.value })}
            >
              <option value="udp">udp</option>
              <option value="tcp">tcp</option>
            </select>
          </label>
          <label className="field">
            роль
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              <option value="slave">slave</option>
              <option value="master">master</option>
            </select>
          </label>
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

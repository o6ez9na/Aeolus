import { useState } from 'react'

import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { useResource } from '../lib/useResource'

/** A textarea holding one entry per line, which is how routes read best. */
function LineList({ label, hint, value, onChange }) {
  return (
    <label className="field" style={{ flex: 1, minWidth: 220 }}>
      {label}
      <textarea
        rows={3}
        value={value}
        placeholder={hint}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function toLines(list) {
  return (list ?? []).join('\n')
}

function fromLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function Editor({ entry, limits, onSave, onCancel, busy, error }) {
  const [staticHost, setStaticHost] = useState(
    entry.static_host === null ? '' : String(entry.static_host),
  )
  const [routes, setRoutes] = useState(toLines(entry.push_routes))
  const [iroutes, setIroutes] = useState(toLines(entry.iroutes))
  const [options, setOptions] = useState(toLines(entry.push_options))

  function submit(event) {
    event.preventDefault()
    onSave({
      static_host: staticHost.trim() === '' ? null : Number(staticHost),
      push_routes: fromLines(routes),
      iroutes: fromLines(iroutes),
      push_options: fromLines(options),
    })
  }

  return (
    <form className="inline-form fade-in" onSubmit={submit}>
      <label className="field">
        фиксированный адрес
        <input
          type="number"
          min={limits.static_host_min}
          max={limits.static_host_max}
          value={staticHost}
          placeholder="пусто — из пула"
          onChange={(event) => setStaticHost(event.target.value)}
        />
        <span className="sub">
          номер хоста {limits.static_host_min}–{limits.static_host_max}; выше — пул,
          который OpenVPN раздаёт сам
        </span>
      </label>

      <LineList
        label="маршруты клиенту"
        hint="192.168.5.0/24"
        value={routes}
        onChange={setRoutes}
      />
      <LineList
        label="сети за клиентом (iroute)"
        hint="10.20.0.0/16"
        value={iroutes}
        onChange={setIroutes}
      />
      <LineList
        label="push-опции"
        hint="dhcp-option DNS 10.8.0.1"
        value={options}
        onChange={setOptions}
      />

      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'сохраняю…' : 'сохранить'}
      </button>
      <button className="btn ghost" type="button" onClick={onCancel}>
        отмена
      </button>

      <span className="sub" style={{ flexBasis: '100%' }}>
        разрешённые push-опции: {limits.allowed_push_options.join(', ')}
      </span>

      {error && <span className="form-error">{error}</span>}

      <pre className="ccd-preview">{entry.preview}</pre>
    </form>
  )
}

export function CcdPage() {
  const { user } = useAuth()
  const entries = useResource('/ccd', { pollMs: 30000 })
  const limits = useResource('/ccd/limits')

  const [openId, setOpenId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const canEdit = user?.role === 'admin' || user?.role === 'operator'

  async function save(entry, payload) {
    setBusy(true)
    setError(null)
    try {
      await api.patch(`/ccd/${entry.id}`, payload)
      setOpenId(null)
      await entries.reload({ quiet: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setBusy(false)
    }
  }

  if (entries.loading || limits.loading) return <div className="empty">загрузка ccd…</div>
  if (entries.error) return <div className="empty form-error">{entries.error}</div>

  const list = entries.data ?? []

  return (
    <>
      <p className="sub" style={{ margin: '0 0 16px' }}>
        Файл ccd читается узлом в момент подключения клиента: он закрепляет адрес,
        добавляет персональные маршруты и push-опции. Клиент без доступа к узлу
        получает <span className="hl">disable</span> — сертификат нашего CA сам по
        себе узел не открывает.
      </p>

      <div className="row ccd head">
        <span className="dim">клиент</span>
        <span className="dim">узел</span>
        <span className="dim">адрес в туннеле</span>
        <span className="dim">маршруты</span>
        <span className="dim">push</span>
        <span />
      </div>

      {list.length === 0 && (
        <div className="empty">
          доступов нет: сначала выдай клиенту узел в разделе клиенты.
        </div>
      )}

      {list.map((entry) => (
        <div key={entry.id}>
          <div className="row ccd">
            <span>
              <span className={`name ${entry.client_status === 'active' ? '' : 'faded'}`}>
                {entry.client_name}
              </span>
              {entry.client_status !== 'active' && (
                <div className="sub warn">{entry.client_status} — узел его не пустит</div>
              )}
            </span>
            <span className="muted">{entry.node_name}</span>
            <span className="muted">
              {entry.static_address ? (
                <>
                  {entry.static_address}
                  <div className="sub">tcp: {entry.static_address_tcp}</div>
                </>
              ) : (
                <span className="sub">из пула</span>
              )}
            </span>
            <span className="muted">
              {entry.push_routes.length + entry.iroutes.length || <span className="sub">—</span>}
            </span>
            <span className="muted">
              {entry.push_options.length || <span className="sub">—</span>}
            </span>
            <span className="right actions">
              {canEdit && (
                <button
                  className="btn"
                  onClick={() => {
                    setError(null)
                    setOpenId(openId === entry.id ? null : entry.id)
                  }}
                >
                  {openId === entry.id ? 'скрыть' : 'настроить'}
                </button>
              )}
            </span>
          </div>

          {openId === entry.id && (
            <Editor
              entry={entry}
              limits={limits.data}
              busy={busy}
              error={error}
              onSave={(payload) => save(entry, payload)}
              onCancel={() => setOpenId(null)}
            />
          )}
        </div>
      ))}
    </>
  )
}

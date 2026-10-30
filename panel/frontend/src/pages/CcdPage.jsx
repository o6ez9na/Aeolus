import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { PageHead } from '../components/AppShell'
import { Drawer } from '../components/Overlay'
import { useToast } from '../components/Toast'
import { useMesh } from '../lib/mesh'
import { canEdit } from '../lib/model'
import { useResource } from '../lib/useResource'

function toLines(list) {
  return (list ?? []).join('\n')
}

function fromLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function Editor({ entry, limits, editable, onSaved, onClose }) {
  const toast = useToast()
  const [staticHost, setStaticHost] = useState(entry.static_host === null ? '' : String(entry.static_host))
  const [routes, setRoutes] = useState(toLines(entry.push_routes))
  const [iroutes, setIroutes] = useState(toLines(entry.iroutes))
  const [options, setOptions] = useState(toLines(entry.push_options))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.patch(`/ccd/${entry.id}`, {
        static_host: staticHost.trim() === '' ? null : Number(staticHost),
        push_routes: fromLines(routes),
        iroutes: fromLines(iroutes),
        push_options: fromLines(options),
      })
      toast.info(`${entry.client_name}@${entry.node_name}: ccd сохранён`)
      await onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer title={`${entry.client_name} → ${entry.node_name}`} onClose={onClose} width={480}>
      <form className="stack-lg" onSubmit={submit}>
        <label className="field">
          Фиксированный адрес (номер хоста {limits.static_host_min}–{limits.static_host_max})
          <input
            className="input mono"
            type="number"
            min={limits.static_host_min}
            max={limits.static_host_max}
            placeholder="пусто — адрес клиента по умолчанию"
            value={staticHost}
            disabled={!editable}
            onChange={(event) => setStaticHost(event.target.value)}
          />
          <span className="hint">Выше этого диапазона — пул, который OpenVPN раздаёт сам.</span>
        </label>
        <label className="field">
          Маршруты клиенту
          <textarea
            className="textarea"
            rows={3}
            placeholder="192.168.5.0/24"
            value={routes}
            disabled={!editable}
            onChange={(event) => setRoutes(event.target.value)}
          />
        </label>
        <label className="field">
          Сети за клиентом (iroute)
          <textarea
            className="textarea"
            rows={3}
            placeholder="10.30.0.0/24"
            value={iroutes}
            disabled={!editable}
            onChange={(event) => setIroutes(event.target.value)}
          />
        </label>
        <label className="field">
          push-опции
          <textarea
            className="textarea"
            rows={3}
            placeholder="dhcp-option DNS 10.8.0.1"
            value={options}
            disabled={!editable}
            onChange={(event) => setOptions(event.target.value)}
          />
          <span className="hint">Разрешены: {limits.allowed_push_options.join(', ')}</span>
        </label>
        <div className="stack" style={{ gap: 6 }}>
          <span className="lbl">Сейчас в файле</span>
          <pre className="code wrap">{entry.preview}</pre>
        </div>
        {error && <div className="form-error">{error}</div>}
        {editable && (
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
        )}
      </form>
    </Drawer>
  )
}

export function CcdPage() {
  const { user } = useAuth()
  const mesh = useMesh()
  const entries = useResource('/ccd', { pollMs: 30000 })
  const limits = useResource('/ccd/limits')
  const [params, setParams] = useSearchParams()
  const editable = canEdit(user)
  const clientFilter = params.get('client')
  const openId = params.get('open')

  const all = entries.data ?? []
  const list = clientFilter ? all.filter((e) => e.client_id === clientFilter) : all
  const open = all.find((e) => e.id === openId)
  const filteredName = clientFilter && mesh.clients?.find((c) => c.id === clientFilter)?.common_name

  const set = (key, value) =>
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      if (value) p.set(key, value)
      else p.delete(key)
      return p
    })

  return (
    <>
      <PageHead
        title="Доступ (ccd)"
        sub="Что клиент получает при подключении: закреплённый адрес, маршруты и push-опции. Клиент без доступа получает disable."
        actions={
          filteredName && (
            <button className="btn sm" type="button" onClick={() => set('client', null)}>
              Только {filteredName} · показать всех
            </button>
          )
        }
      />
      <section className="panel" style={{ overflow: 'hidden' }}>
        {entries.error && <div className="notice err">{entries.error}</div>}
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Клиент</th>
                <th>Узел</th>
                <th>Адрес</th>
                <th>Маршруты</th>
                <th>push</th>
                <th>Выход</th>
              </tr>
            </thead>
            <tbody>
              {!entries.loading && list.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">Доступов нет: сначала выдай клиенту узел на карте или в карточке клиента.</div>
                  </td>
                </tr>
              )}
              {list.map((entry) => (
                <tr key={entry.id} className="clickable" onClick={() => set('open', entry.id)}>
                  <td>
                    <div className="name-cell">
                      <span className={entry.client_status === 'active' ? 'dot live' : 'dot off'} />
                      <span className="names">
                        <span className="n">{entry.client_name}</span>
                        {entry.client_status !== 'active' && (
                          <span className="l warn-text">{entry.client_status} — узел его не пустит</span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className="mono">{entry.node_name}</td>
                  <td className="mono muted">{entry.static_address ?? entry.tunnel_address ?? 'из пула'}</td>
                  <td className="muted">{entry.push_routes.length + entry.iroutes.length || '—'}</td>
                  <td className="muted">{entry.push_options.length || '—'}</td>
                  <td>{entry.is_exit ? <span className="chip exit">⇱ выход</span> : <span className="dim">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {open && limits.data && (
        <Editor
          key={open.id}
          entry={open}
          limits={limits.data}
          editable={editable}
          onSaved={() => Promise.all([entries.reload({ quiet: true }), mesh.reload()])}
          onClose={() => set('open', null)}
        />
      )}
    </>
  )
}

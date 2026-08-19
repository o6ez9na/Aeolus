import { useCallback, useState } from 'react'

import { api, authorizedDownload } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { ConfirmButton } from '../components/ConfirmButton'
import { daysUntil, pluralRu } from '../lib/format'
import { useResource } from '../lib/useResource'

function CertLife({ notAfter }) {
  if (!notAfter) return <span className="sub warn">нет сертификата</span>
  const days = daysUntil(notAfter)
  const cls = days <= 14 ? 'sub err' : days <= 60 ? 'sub warn' : 'sub'
  return (
    <span className={cls}>
      {days} {pluralRu(days, 'день', 'дня', 'дней')}
    </span>
  )
}

function CaCard({ status, canInit, onInit, busy, error }) {
  if (!status.initialised) {
    return (
      <div className="empty">
        <div className="name">удостоверяющий центр не создан</div>
        <p className="sub" style={{ margin: '8px 0 16px' }}>
          Без CA нельзя выпустить ни серверный, ни клиентский сертификат. Ключ CA
          хранится в базе в зашифрованном виде и никуда не выгружается.
        </p>
        {canInit ? (
          <button className="btn" onClick={onInit} disabled={busy}>
            {busy ? 'создаю…' : 'создать CA'}
          </button>
        ) : (
          <span className="sub">создание CA доступно только админу</span>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
    )
  }

  return (
    <div className="ca-card">
      <div className="ca-facts">
        <span className="muted">
          CA <span className="hl">{status.common_name}</span>
        </span>
        <span className="sep">·</span>
        <span className="muted">
          истекает <CertLife notAfter={status.not_after} />
        </span>
        <span className="sep">·</span>
        <span className="muted">
          выпущено <span className="hl">{status.issued_certificates}</span>
        </span>
        <span className="sep">·</span>
        <span className="muted">
          отозвано{' '}
          <span style={{ color: status.revoked_clients ? 'var(--err)' : 'var(--text)' }}>
            {status.revoked_clients}
          </span>
        </span>
        <span className="sep">·</span>
        <span className="muted">
          crl <span className="hl">#{status.crl_number}</span>
        </span>
      </div>
      <div className="ca-actions">
        <button className="btn" onClick={() => authorizedDownload('/pki/ca.crt', 'ca.crt')}>
          скачать ca.crt
        </button>
        <button className="btn" onClick={() => authorizedDownload('/pki/crl.pem', 'crl.pem')}>
          скачать crl
        </button>
      </div>
    </div>
  )
}

export function PkiPage() {
  const { user } = useAuth()
  const ca = useResource('/pki')
  const nodes = useResource('/nodes')
  const clients = useResource('/clients')

  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const canEdit = user?.role === 'admin' || user?.role === 'operator'

  const refreshAll = useCallback(async () => {
    await Promise.all([
      ca.reload({ quiet: true }),
      nodes.reload({ quiet: true }),
      clients.reload({ quiet: true }),
    ])
  }, [ca, nodes, clients])

  async function run(key, action) {
    setBusy(key)
    setError(null)
    try {
      await action()
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Операция не удалась')
    } finally {
      setBusy(null)
    }
  }

  if (ca.loading) return <div className="empty">загрузка pki…</div>
  if (ca.error) return <div className="empty form-error">{ca.error}</div>

  const initialised = ca.data.initialised

  return (
    <>
      <CaCard
        status={ca.data}
        canInit={user?.role === 'admin'}
        busy={busy === 'init'}
        error={error}
        onInit={() =>
          run('init', () => api.post('/pki/init', { common_name: 'Aeolus CA' }))
        }
      />

      {initialised && (
        <>
          {error && <div className="form-error">{error}</div>}

          <div className="section-title dim">серверные сертификаты узлов</div>
          <div className="row pki head">
            <span />
            <span className="dim">узел</span>
            <span className="dim">serial</span>
            <span className="dim">осталось</span>
            <span />
          </div>
          {(nodes.data ?? []).map((node) => (
            <div className="row pki" key={node.id}>
              <span className={`dot ${node.server_cert_serial ? 'online' : 'unknown'}`} />
              <span>
                <span className="name">{node.name}</span>
                <div className="sub">{node.address}</div>
              </span>
              <span className="muted">{node.server_cert_serial ?? '—'}</span>
              <span>
                <CertLife notAfter={node.server_cert_not_after} />
              </span>
              <span className="right actions">
                {canEdit && (
                  <button
                    className="btn"
                    disabled={busy === node.id}
                    onClick={() =>
                      run(node.id, () =>
                        api.post(`/pki/nodes/${node.id}/certificate`),
                      )
                    }
                  >
                    {node.server_cert_serial ? 'перевыпустить' : 'выпустить'}
                  </button>
                )}
              </span>
            </div>
          ))}

          <div className="section-title dim">клиентские сертификаты</div>
          <div className="row pki head">
            <span />
            <span className="dim">клиент</span>
            <span className="dim">serial</span>
            <span className="dim">осталось</span>
            <span />
          </div>
          {(clients.data ?? []).length === 0 && (
            <div className="empty">клиентов ещё нет</div>
          )}
          {(clients.data ?? []).map((client) => (
            <div className="row pki" key={client.id}>
              <span
                className={`dot ${
                  client.status === 'revoked'
                    ? 'error'
                    : client.cert_serial
                      ? 'online'
                      : 'unknown'
                }`}
              />
              <span>
                <span className="name">{client.common_name}</span>
                <div className="sub">
                  {client.status === 'revoked' ? 'сертификат отозван' : client.status}
                </div>
              </span>
              <span className="muted">{client.cert_serial ?? '—'}</span>
              <span>
                {client.status === 'revoked' ? (
                  <span className="sub err">отозван</span>
                ) : (
                  <CertLife notAfter={client.cert_not_after} />
                )}
              </span>
              <span className="right actions">
                {canEdit && client.status !== 'revoked' && (
                  <>
                    <button
                      className="btn"
                      disabled={busy === client.id}
                      onClick={() =>
                        run(client.id, () =>
                          api.post(`/pki/clients/${client.id}/certificate`),
                        )
                      }
                    >
                      {client.cert_serial ? 'перевыпустить' : 'выпустить'}
                    </button>
                    {client.cert_serial && (
                      <ConfirmButton
                        label="отозвать"
                        armedLabel="точно отозвать?"
                        title={`Отозвать сертификат ${client.common_name}`}
                        onConfirm={() =>
                          run(client.id, () =>
                            api.post(`/pki/clients/${client.id}/revoke`),
                          )
                        }
                      />
                    )}
                  </>
                )}
              </span>
            </div>
          ))}

          <div className="term-foot">
            <span className="dim">
              отзыв вступает в силу на узле только после того, как туда попадёт новый
              CRL — рассылкой займётся агент anemoi
            </span>
          </div>
        </>
      )}
    </>
  )
}

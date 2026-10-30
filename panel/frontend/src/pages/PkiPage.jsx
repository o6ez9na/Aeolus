import { useCallback, useState } from 'react'

import { api, authorizedDownload } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { PageHead } from '../components/AppShell'
import { ConfirmButton } from '../components/ConfirmButton'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'
import { daysUntil, formatDate } from '../lib/format'
import { useMesh } from '../lib/mesh'
import { canEdit } from '../lib/model'
import { useResource } from '../lib/useResource'

function Life({ notAfter, revoked }) {
  if (revoked) return <span className="err-text">отозван</span>
  if (!notAfter) return <span className="warn-text">нет сертификата</span>
  const days = daysUntil(notAfter)
  const cls = days <= 14 ? 'err-text' : days <= 60 ? 'warn-text' : 'muted'
  return (
    <span className={cls}>
      {days} дн · до {formatDate(notAfter)}
    </span>
  )
}

export function PkiPage() {
  const { user } = useAuth()
  const mesh = useMesh()
  const toast = useToast()
  const ca = useResource('/pki')
  const editable = canEdit(user)
  const [busy, setBusy] = useState(null)

  const run = useCallback(
    async (key, action, message) => {
      setBusy(key)
      try {
        await action()
        toast.info(message)
        await Promise.all([ca.reload({ quiet: true }), mesh.reload()])
      } catch (err) {
        toast.error(err)
      } finally {
        setBusy(null)
      }
    },
    [ca, mesh, toast],
  )

  if (ca.loading || mesh.loading) {
    return (
      <>
        <PageHead title="PKI" />
        <div className="panel empty-state">загрузка…</div>
      </>
    )
  }
  if (ca.error) return <div className="notice err">{ca.error}</div>

  const status = ca.data
  if (!status.initialised) {
    return (
      <>
        <PageHead title="PKI" />
        <div className="panel empty-state">
          <h3>Удостоверяющий центр не создан</h3>
          <span>Без CA нельзя выпустить ни серверный, ни клиентский сертификат. Ключ CA хранится в базе зашифрованным.</span>
          {user?.role === 'admin' ? (
            <button
              className="btn primary"
              type="button"
              disabled={busy === 'init'}
              onClick={() => run('init', () => api.post('/pki/init', { common_name: 'Aeolus CA' }), 'CA создан')}
            >
              Создать CA
            </button>
          ) : (
            <span className="hint">Создать CA может только админ</span>
          )}
        </div>
      </>
    )
  }

  const nodes = mesh.nodes.filter((n) => n.approval === 'approved')
  const clients = mesh.clients

  return (
    <>
      <PageHead
        title="PKI"
        sub="Панель — собственный удостоверяющий центр. Отзыв доходит до узла с новым CRL сразу."
        actions={
          <>
            <button className="btn" type="button" onClick={() => authorizedDownload('/pki/ca.crt', 'ca.crt').catch(toast.error)}>
              <Icon name="download" size={15} />
              ca.crt
            </button>
            <button className="btn" type="button" onClick={() => authorizedDownload('/pki/crl.pem', 'crl.pem').catch(toast.error)}>
              <Icon name="download" size={15} />
              crl.pem
            </button>
          </>
        }
      />

      <div className="tiles">
        <div className="panel tile">
          <span className="lbl">CA</span>
          <span className="value mono" style={{ fontSize: 18 }}>
            {status.common_name}
          </span>
          <span className="hint">
            <Life notAfter={status.not_after} />
          </span>
        </div>
        <div className="panel tile">
          <span className="lbl">Выпущено</span>
          <span className="value">{status.issued_certificates}</span>
          <span className="hint">
            клиентов {status.clients_with_cert} · узлов {status.nodes_with_cert}
          </span>
        </div>
        <div className="panel tile">
          <span className="lbl">Отозвано</span>
          <span className={`value${status.revoked_clients ? ' err-text' : ''}`}>{status.revoked_clients}</span>
          <span className="hint">CRL №{status.crl_number}</span>
        </div>
      </div>

      <section className="panel" style={{ overflow: 'hidden' }} aria-label="Серверные сертификаты">
        <div className="panel-head panel-pad" style={{ paddingBottom: 8 }}>
          <h2>Серверные сертификаты узлов</h2>
        </div>
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 600 }}>
            <thead>
              <tr>
                <th>Узел</th>
                <th>Serial</th>
                <th>Срок</th>
                <th>
                  <span className="sr-only">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.id}>
                  <td>
                    <div className="name-cell">
                      <span className={node.server_cert_serial ? 'dot live' : 'dot warn'} />
                      <span className="names">
                        <span className="n">{node.name}</span>
                        <span className="l">{node.is_hub ? 'сама панель' : node.hostname || node.address}</span>
                      </span>
                    </div>
                  </td>
                  <td className="mono muted">{node.server_cert_serial ?? '—'}</td>
                  <td>
                    <Life notAfter={node.server_cert_not_after} />
                  </td>
                  <td className="actions-cell">
                    {editable && (
                      <button
                        className="btn sm"
                        type="button"
                        disabled={busy === node.id}
                        onClick={() =>
                          run(node.id, () => api.post(`/pki/nodes/${node.id}/certificate`), `Сертификат ${node.name} выпущен`)
                        }
                      >
                        {node.server_cert_serial ? 'Перевыпустить' : 'Выпустить'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" style={{ overflow: 'hidden' }} aria-label="Клиентские сертификаты">
        <div className="panel-head panel-pad" style={{ paddingBottom: 8 }}>
          <h2>Клиентские сертификаты</h2>
          <span className="hint">новый клиент получает сертификат сразу в мастере создания</span>
        </div>
        <div className="table-wrap">
          <table className="table" style={{ minWidth: 600 }}>
            <thead>
              <tr>
                <th>Клиент</th>
                <th>Serial</th>
                <th>Срок</th>
                <th>
                  <span className="sr-only">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {clients.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <div className="empty-state">Клиентов ещё нет</div>
                  </td>
                </tr>
              )}
              {clients.map((client) => {
                const revoked = client.status === 'revoked'
                return (
                  <tr key={client.id}>
                    <td>
                      <div className="name-cell">
                        <span className={revoked ? 'dot err' : client.cert_serial ? 'dot live' : 'dot warn'} />
                        <span className="names">
                          <span className="n">{client.common_name}</span>
                          {client.label && <span className="l">{client.label}</span>}
                        </span>
                      </div>
                    </td>
                    <td className="mono muted">{client.cert_serial ?? '—'}</td>
                    <td>
                      <Life notAfter={client.cert_not_after} revoked={revoked} />
                    </td>
                    <td className="actions-cell">
                      {editable && !revoked && (
                        <span className="row-wrap" style={{ justifyContent: 'flex-end', gap: 6 }}>
                          <button
                            className="btn sm"
                            type="button"
                            disabled={busy === client.id}
                            onClick={() =>
                              run(
                                client.id,
                                () => api.post(`/pki/clients/${client.id}/certificate`),
                                `Сертификат ${client.common_name} выпущен`,
                              )
                            }
                          >
                            {client.cert_serial ? 'Перевыпустить' : 'Выпустить'}
                          </button>
                          {client.cert_serial && (
                            <ConfirmButton
                              className="btn sm danger"
                              label="Отозвать"
                              armedLabel="Точно отозвать?"
                              title={`Отозвать сертификат ${client.common_name}`}
                              onConfirm={() =>
                                run(
                                  client.id,
                                  () => api.post(`/pki/clients/${client.id}/revoke`),
                                  `Сертификат ${client.common_name} отозван`,
                                )
                              }
                            />
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

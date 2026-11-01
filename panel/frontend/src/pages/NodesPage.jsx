import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import { PageHead } from '../components/AppShell'
import { Icon } from '../components/Icon'
import { Drawer } from '../components/Overlay'
import { useToast } from '../components/Toast'
import { daysUntil, formatAgo } from '../lib/format'
import { useMesh } from '../lib/mesh'
import { NODE_STATE_LABEL, canEdit, dotClass, nodeState, transportLabel } from '../lib/model'

function PendingCard({ node, editable }) {
  const mesh = useMesh()
  const [busy, setBusy] = useState(false)
  const decide = async (fn) => {
    setBusy(true)
    try {
      await fn(node)
    } catch {
      // reported by the mesh
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="panel panel-pad stack" style={{ borderColor: 'var(--warn)' }}>
      <div className="panel-head">
        <div className="row-wrap" style={{ gap: 9 }}>
          <span className="dot warn" />
          <h2 className="mono">{node.name}</h2>
          <span className="hint mono">
            {[node.hostname, node.announce_ip, node.agent_version && `anemoi ${node.agent_version}`]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <span className="chip warn">просится в сеть</span>
      </div>
      <div className="meta-grid">
        <div>
          <div className="lbl">Сети за узлом</div>
          <div className="v mono">{node.subnets.join(', ') || 'не объявлены'}</div>
        </div>
        <div>
          <div className="lbl">Пришёл</div>
          <div className="v">{formatAgo(node.created_at)}</div>
        </div>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="lbl">Отпечаток ключа — сверь с тем, что агент напечатал на самой ноде</span>
        <code className="code wrap" style={{ fontSize: 12 }}>
          {node.key_fingerprint}
        </code>
      </div>
      {editable && (
        <div className="row-wrap">
          <button className="btn primary" type="button" disabled={busy} onClick={() => void decide(mesh.approveNode)}>
            Совпадает, принять
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => void decide(mesh.rejectNode)}>
            Отклонить
          </button>
        </div>
      )}
    </div>
  )
}

const RAW = 'https://raw.githubusercontent.com/o6ez9na/Aeolus/main/scripts'

// Entware's own wget is a busybox applet without TLS ("not an http or ftp
// url"), and Keenetic's firmware has none at all, so on Entware the command
// first puts in wget-ssl. Elsewhere the test is false and it is a plain wget:
// OpenWrt's speaks HTTPS, and so does any Linux distribution's.
const ENTWARE_WGET = '[ -x /opt/bin/opkg ] && opkg update && opkg install wget-ssl ca-bundle;'

// What goes into the copied command is typed by hand; keep it to the
// characters a name, a host or a list of networks can have, so a stray quote
// or semicolon never ends up in a root shell.
const only = (value, re) => value.replace(re, '')
const cleanName = (value) => only(value.trim().toLowerCase(), /[^a-z0-9_.-]/g)
const cleanHost = (value) => only(value.trim().toLowerCase(), /[^a-z0-9.:[\]-]/g)
const cleanSubnets = (value) =>
  value
    .split(/[\s,]+/)
    .map((part) => only(part, /[^0-9a-fA-F.:/]/g))
    .filter(Boolean)
    .join(',')

// The node talks to the panel's HTTPS name, which is where the browser is
// when it came by domain. The hub's address is what clients dial and may be a
// bare IP, which the panel's certificate does not cover.
function defaultPanelHost(hub) {
  const here = window.location.hostname
  const isName = /[a-z]/i.test(here) && here !== 'localhost' && !here.includes(':')
  return isName ? here : hub?.address || here
}

const KINDS = [
  ['router', 'Роутер или Linux'],
  ['docker', 'Сервер с Docker'],
]

/**
 * A node joins by itself: the installer announces it and it waits for an
 * operator. So "adding" one is handing over the right command.
 */
function ConnectNode({ hub, onClose }) {
  const toast = useToast()
  const [kind, setKind] = useState('router')
  const [panel, setPanel] = useState(() => defaultPanelHost(hub))
  const [name, setName] = useState('')
  const [subnets, setSubnets] = useState('')
  const host = cleanHost(panel)
  const node = cleanName(name)
  const nets = cleanSubnets(subnets)

  let command
  if (kind === 'router') {
    const args = [`--panel ${host}`, node && `--name ${node}`, nets && `--subnets ${nets}`]
      .filter(Boolean)
      .join(' ')
    command = `${ENTWARE_WGET} wget -qO- ${RAW}/install-node.sh | sh -s -- ${args}`
  } else {
    const env = [
      `AEOLUS_PANEL_DOMAIN=${host}`,
      node && `AEOLUS_NODE_NAME=${node}`,
      nets && `AEOLUS_NODE_SUBNETS=${nets}`,
    ]
      .filter(Boolean)
      .join(' ')
    command = `curl -fsSL ${RAW}/install.sh | sudo ${env} bash -s -- node`
  }

  return (
    <Drawer title="Подключить узел" onClose={onClose} width={480}>
      <div className="stack-lg">
        <span className="hint">
          Узлу не нужен ни один входящий порт: он сам ходит к панели на 443 и ждёт, пока его примут.
        </span>
        <div className="seg-group fill">
          {KINDS.map(([value, text]) => (
            <button
              key={value}
              type="button"
              className={`seg${kind === value ? ' on' : ''}`}
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
            >
              {text}
            </button>
          ))}
        </div>
        <span className="hint">
          {kind === 'router'
            ? 'OpenWrt, Keenetic с Entware или любой Linux без Docker: агент ставится одним файлом, пакеты, автозапуск и фаервол настраиваются штатными средствами системы.'
            : 'Сервер, где уже есть или можно поставить Docker: агент и OpenVPN поднимаются контейнерами.'}
        </span>
        <label className="field">
          Адрес панели
          <input className="input mono" value={panel} onChange={(event) => setPanel(event.target.value)} />
          <span className="hint">Домен, по которому панель открывается по HTTPS. Узел должен до него достучаться.</span>
        </label>
        <label className="field">
          Имя узла
          <input
            className="input mono"
            placeholder={kind === 'router' ? 'home-router' : 'frankfurt-01'}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {name && node !== name.trim().toLowerCase() && (
            <span className="hint">Только латиница, цифры, точка, дефис и подчёркивание: {node || '—'}</span>
          )}
        </label>
        <label className="field">
          Сети за узлом, через запятую
          <input
            className="input mono"
            placeholder="192.168.5.0/24"
            value={subnets}
            onChange={(event) => setSubnets(event.target.value)}
          />
          <span className="hint">
            Не должны пересекаться с пулами клиентов, транзитом и сетями других узлов. Пусто — узел
            только выпускает клиентов в интернет.
          </span>
        </label>
        <div className="stack" style={{ gap: 8 }}>
          <span className="lbl">1 · Выполни на узле от root</span>
          <pre className="code wrap" style={{ fontSize: 12 }}>
            {command}
          </pre>
          <button
            className="btn"
            type="button"
            disabled={!host}
            onClick={() =>
              navigator.clipboard
                .writeText(command)
                .then(() => toast.info('Команда скопирована'))
                .catch(() => toast.error('Буфер обмена недоступен: выдели и скопируй вручную'))
            }
          >
            <Icon name="copy" size={15} />
            Скопировать
          </button>
          {kind === 'router' && (
            <span className="hint">
              Keenetic: сначала Entware и компонент прошивки «Модули ядра подсистемы Netfilter».
              Команда сама поставит <code className="mono">wget-ssl</code>: встроенный в Entware{' '}
              <code className="mono">wget</code> не умеет HTTPS. Если{' '}
              <code className="mono">anemoi doctor</code> скажет, что транзит не поднят, добавь
              компонент «OpenVPN» (Giant KN-2610 на 5.1 обошёлся без него).
            </span>
          )}
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="lbl">2 · Сверь отпечаток</span>
          <span className="hint">
            Установщик напечатает отпечаток ключа узла. Через несколько секунд заявка появится на этой
            странице и на карте — прими её, если строки совпадают.
          </span>
        </div>
        {kind === 'router' && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="lbl">3 · Проверь</span>
            <span className="hint">
              <code className="mono">anemoi doctor</code> на узле покажет, что не так, если узел не
              появился в сети. Удалить — <code className="mono">anemoi uninstall</code>.
            </span>
          </div>
        )}
      </div>
    </Drawer>
  )
}

export function NodesPage() {
  const { user } = useAuth()
  const mesh = useMesh()
  const navigate = useNavigate()
  const editable = canEdit(user)
  const [params, setParams] = useSearchParams()
  const connecting = params.get('connect') === '1'

  if (mesh.loading) {
    return (
      <>
        <PageHead title="Узлы" />
        <div className="panel empty-state">загрузка узлов…</div>
      </>
    )
  }

  const nodes = mesh.nodes
  const clients = mesh.clients
  const pending = nodes.filter((n) => n.approval === 'pending')
  const members = nodes
    .filter((n) => n.approval === 'approved')
    .sort((a, b) => Number(b.is_hub) - Number(a.is_hub) || a.name.localeCompare(b.name))
  const rejected = nodes.filter((n) => n.approval === 'rejected')
  const up = members.filter((n) => nodeState(n) === 'up').length
  const hub = nodes.find((n) => n.is_hub)

  return (
    <>
      <PageHead
        title="Узлы"
        sub={`${up} в сети из ${members.length}${pending.length ? ` · заявок: ${pending.length}` : ''}`}
        actions={
          editable && (
            <button className="btn primary" type="button" onClick={() => setParams({ connect: '1' })}>
              <Icon name="plus" size={15} stroke={2} />
              Подключить узел
            </button>
          )
        }
      />

      {pending.map((node) => (
        <PendingCard key={node.id} node={node} editable={editable} />
      ))}

      <section className="panel" style={{ overflow: 'hidden' }} aria-label="Узлы сети">
        <div className="table-wrap">
          <table className="table wide">
            <thead>
              <tr>
                <th>Узел</th>
                <th className="hide-m">Транспорт</th>
                <th className="hide-m">Сети</th>
                <th>Клиенты</th>
                <th>Выход для</th>
                <th className="hide-m">Агент</th>
                <th className="hide-m">Сертификат</th>
                <th>
                  <span className="sr-only">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((node) => {
                const state = nodeState(node)
                const granted = clients.filter((c) => c.node_ids.includes(node.id))
                const live = granted.filter((c) => c.session).length
                const exits = granted.filter((c) => c.access.some((g) => g.node_id === node.id && g.is_exit))
                const days = daysUntil(node.server_cert_not_after)
                return (
                  <tr key={node.id} className="clickable" onClick={() => navigate(`/nodes/${node.id}`)}>
                    <td>
                      <div className="name-cell">
                        <span className={dotClass(state)} />
                        <span className="names">
                          <Link
                            to={`/nodes/${node.id}`}
                            className="n"
                            style={{ color: 'var(--text)', textDecoration: 'none' }}
                            onClick={(event) => event.stopPropagation()}
                          >
                            {node.name}
                          </Link>
                          <span className={`l${state === 'down' ? ' err-text' : ''}`}>
                            {node.is_hub ? 'сама панель · ' : ''}
                            {state === 'up' ? node.hostname || node.address : NODE_STATE_LABEL[state]}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="mono muted hide-m">{transportLabel(node)}</td>
                    <td className="mono muted hide-m">{node.subnets.join(', ') || '—'}</td>
                    <td>
                      {granted.length}
                      <span className="dim"> · в сети {live}</span>
                    </td>
                    <td>
                      {exits.length ? (
                        <span className="chip exit">⇱ {exits.length}</span>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td className={`hide-m ${state === 'down' ? 'err-text' : 'muted'}`}>{formatAgo(node.last_seen_at)}</td>
                    <td className={`hide-m ${days !== null && days <= 30 ? 'warn-text' : 'muted'}`}>
                      {days === null ? '—' : `${days} дн`}
                    </td>
                    <td className="actions-cell" onClick={(event) => event.stopPropagation()}>
                      {editable && !node.is_hub && (
                        <button
                          className={`btn sm${node.transit_obfuscated ? '' : ' ghost'}`}
                          type="button"
                          title="Прятать транзит в WebSocket на 443"
                          onClick={() =>
                            void mesh
                              .updateNode(
                                node,
                                { transit_obfuscated: !node.transit_obfuscated },
                                `${node.name}: транзит ${node.transit_obfuscated ? 'напрямую' : 'через HTTPS'}`,
                              )
                              .catch(() => {})
                          }
                        >
                          {node.transit_obfuscated ? 'HTTPS вкл' : 'HTTPS'}
                        </button>
                      )}
                      {editable && !node.is_hub && (
                        <button
                          className="btn sm ghost"
                          type="button"
                          onClick={() =>
                            void mesh
                              .updateNode(
                                node,
                                { is_enabled: !node.is_enabled },
                                node.is_enabled ? `${node.name} выключен` : `${node.name} включён`,
                              )
                              .catch(() => {})
                          }
                        >
                          {node.is_enabled ? 'Выключить' : 'Включить'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {members.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state">Узлов пока нет.</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {rejected.length > 0 && (
        <span className="hint">
          Отклонены: {rejected.map((n) => n.name).join(', ')}. Их агенты продолжают проситься, заявка
          появится снова.
        </span>
      )}

      {connecting && editable && <ConnectNode hub={hub} onClose={() => setParams({})} />}
    </>
  )
}

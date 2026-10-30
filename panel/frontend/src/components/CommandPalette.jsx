import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import { useMesh } from '../lib/mesh'
import { CLIENT_STATE_LABEL, NODE_STATE_LABEL, clientState, dotClass, nodeState } from '../lib/model'
import { useTheme } from '../theme/ThemeContext'
import { Modal } from './Overlay'

/**
 * One box that finds anything: a client by name or address, a node, a page, or
 * a command. Ctrl+K anywhere, or "/" when not typing.
 */
export function CommandPalette({ onClose }) {
  const navigate = useNavigate()
  const { clients, nodes, groups } = useMesh()
  const { toggle } = useTheme()
  const { logout } = useAuth()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef(null)

  const items = useMemo(() => {
    const go = (to) => () => navigate(to)
    const base = [
      { key: 'p-map', label: 'Карта сети', kind: 'раздел', run: go('/map') },
      { key: 'p-clients', label: 'Клиенты', kind: 'раздел', run: go('/clients') },
      { key: 'p-nodes', label: 'Узлы', kind: 'раздел', run: go('/nodes') },
      { key: 'p-ccd', label: 'Доступ (ccd)', kind: 'раздел', run: go('/ccd') },
      { key: 'p-pki', label: 'PKI и сертификаты', kind: 'раздел', run: go('/pki') },
      { key: 'p-traffic', label: 'Трафик', kind: 'раздел', run: go('/traffic') },
      { key: 'p-audit', label: 'Аудит', kind: 'раздел', run: go('/audit') },
      { key: 'a-client', label: 'Новый клиент', kind: 'команда', run: go('/clients?new=1') },
      { key: 'a-groups', label: 'Группы и роли', kind: 'раздел', run: go('/clients') },
      { key: 'a-node', label: 'Подключить узел', kind: 'команда', run: go('/nodes?connect=1') },
      { key: 'a-theme', label: 'Сменить тему', kind: 'команда', run: toggle },
      { key: 'a-logout', label: 'Выйти', kind: 'команда', run: () => void logout() },
    ]
    const clientItems = (clients ?? []).map((client) => {
      const state = clientState(client)
      return {
        key: `c-${client.id}`,
        label: client.common_name,
        sub: [client.label, client.tunnel_address, CLIENT_STATE_LABEL[state]].filter(Boolean).join(' · '),
        dot: dotClass(state),
        mono: true,
        kind: 'клиент',
        run: go(`/map?sel=client:${client.id}`),
      }
    })
    const nodeItems = (nodes ?? [])
      .filter((node) => node.approval !== 'rejected')
      .map((node) => {
        const state = nodeState(node)
        return {
          key: `n-${node.id}`,
          label: node.name,
          sub: [node.subnets.join(', '), NODE_STATE_LABEL[state]].filter(Boolean).join(' · '),
          dot: dotClass(state),
          mono: true,
          kind: 'узел',
          run: go(`/nodes/${node.id}`),
        }
      })
    const groupItems = (groups ?? []).map((group) => ({
      key: `g-${group.id}`,
      label: group.name,
      sub: `${(clients ?? []).filter((c) => c.group_id === group.id).length} участников`,
      kind: 'группа',
      run: go(`/clients?editgroup=${group.id}`),
    }))
    const all = [...clientItems, ...groupItems, ...nodeItems, ...base]
    const q = query.trim().toLowerCase()
    if (!q) return [...base.slice(0, 7), ...clientItems.slice(0, 6), ...nodeItems.slice(0, 6), ...base.slice(7)]
    return all.filter((item) => `${item.label} ${item.sub ?? ''}`.toLowerCase().includes(q))
  }, [clients, nodes, groups, query, navigate, toggle, logout])

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  function pick(item) {
    onClose()
    item.run()
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIndex((i) => Math.min(items.length - 1, i + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex((i) => Math.max(0, i - 1))
    } else if (event.key === 'Enter' && items[index]) {
      event.preventDefault()
      pick(items[index])
    }
  }

  return (
    <Modal title="Поиск и команды" onClose={onClose} className="palette">
      <input
        className="palette-input"
        autoFocus
        placeholder="Клиент, узел, адрес или команда"
        aria-label="Поиск и команды"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setIndex(0)
        }}
        onKeyDown={onKeyDown}
      />
      <div className="palette-list" ref={listRef} role="listbox" aria-label="Результаты">
        {items.length === 0 && <div className="empty-state">ничего не нашлось</div>}
        {items.map((item, i) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={i === index}
            className={`palette-item${i === index ? ' on' : ''}`}
            onMouseEnter={() => setIndex(i)}
            onClick={() => pick(item)}
          >
            {item.dot && <span className={item.dot} />}
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span className={item.mono ? 'mono' : ''} style={{ fontWeight: 500 }}>
                {item.label}
              </span>
              {item.sub && <span className="hint">{item.sub}</span>}
            </span>
            <span className="kind">{item.kind}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}

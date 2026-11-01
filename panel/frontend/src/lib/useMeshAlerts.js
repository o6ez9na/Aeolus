import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

import { useToast } from '../components/Toast'
import { useMesh } from './mesh'
import { nodeState } from './model'

/**
 * Things the network did, as notices at the bottom of the screen rather than
 * banners that push the page down. Only what changes while the panel is open
 * is announced: a node already down when it loads is red on the map and in
 * the list, and telling about it again on every page load would be noise.
 *
 * A dropped tunnel is announced only once it is past the reconnect grace (the
 * mesh marks the first seconds as "reconnecting"), so turning network transit
 * on, which reconnects the node on purpose, never raises an alarm.
 */
export function useMeshAlerts() {
  const { nodes, error } = useMesh()
  const toast = useToast()
  const navigate = useNavigate()
  const seeded = useRef(false)
  const down = useRef(new Set())
  const pending = useRef(new Set())
  const failing = useRef(false)

  useEffect(() => {
    if (!nodes) return
    const nowDown = new Set()
    const nowPending = new Set()
    for (const node of nodes) {
      const state = nodeState(node)
      if (state === 'down') nowDown.add(node.id)
      if (state === 'pending') nowPending.add(node.id)
    }

    if (!seeded.current) {
      seeded.current = true
      down.current = nowDown
      pending.current = nowPending
      return
    }

    for (const node of nodes) {
      if (nowDown.has(node.id) && !down.current.has(node.id)) {
        toast.error(`${node.name}: нет туннеля до панели`, {
          key: `node:${node.id}`,
          duration: 10000,
          action: { label: 'Показать', onClick: () => navigate(`/map?sel=node:${node.id}`) },
        })
      } else if (!nowDown.has(node.id) && down.current.has(node.id) && nodeState(node) === 'up') {
        toast.info(`${node.name}: туннель снова поднят`, { key: `node:${node.id}` })
      }
      if (nowPending.has(node.id) && !pending.current.has(node.id)) {
        toast.warn(`${node.name} просится в сеть — сверь отпечаток ключа`, {
          key: `pending:${node.id}`,
          duration: 12000,
          action: { label: 'Проверить', onClick: () => navigate(`/map?sel=pending:${node.id}`) },
        })
      }
    }
    // A node still reconnecting is neither: it stays out of `down` until it
    // either comes back or runs past the grace.
    down.current = new Set([...nowDown, ...[...down.current].filter((id) => {
      const node = nodes.find((n) => n.id === id)
      return node && nodeState(node) === 'reconnecting'
    })])
    pending.current = nowPending
  }, [nodes, toast, navigate])

  useEffect(() => {
    if (error && !failing.current) {
      failing.current = true
      toast.error(`Панель не отвечает: ${error}`, { key: 'mesh', duration: 10000 })
    } else if (!error && failing.current) {
      failing.current = false
      toast.info('Связь с панелью восстановлена', { key: 'mesh' })
    }
  }, [error, toast])
}

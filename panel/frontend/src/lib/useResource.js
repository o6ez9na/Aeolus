import { useCallback, useEffect, useState } from 'react'

import { api } from '../api/client'

/**
 * GET a path, with a manual `reload` and an optional poll interval.
 * `stale` stays true while a refresh is in flight so the UI can dim instead of
 * flashing an empty table.
 *
 * A null path fetches nothing, which lets a caller hold the hook while it knows
 * the request would be refused anyway.
 */
export function useResource(path, { pollMs = 0 } = {}) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [stale, setStale] = useState(false)
  const [updatedAt, setUpdatedAt] = useState(null)

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!path) {
        setLoading(false)
        return
      }
      if (quiet) setStale(true)
      try {
        const result = await api.get(path)
        setData(result)
        setUpdatedAt(Date.now())
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ошибка запроса')
      } finally {
        setLoading(false)
        setStale(false)
      }
    },
    [path],
  )

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    if (!pollMs) return undefined
    const id = setInterval(() => void load({ quiet: true }), pollMs)
    return () => clearInterval(id)
  }, [load, pollMs])

  return { data, error, loading, stale, updatedAt, reload: load }
}

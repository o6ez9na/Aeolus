import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

const ToastContext = createContext(null)
const LEAVE_MS = 240

/**
 * One line at the bottom of the screen: what an action changed, or something
 * the network did that is worth a look. Nothing here moves the page: the map
 * already shows trouble in red, a notice only points at it.
 *
 * Errors and warnings stay a little longer, since they are the ones worth
 * reading. A toast with a `key` replaces the one already showing under it, so
 * the same incident never stacks up; `dismiss(key)` takes it away early.
 */
export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const seq = useRef(0)

  const leave = useCallback((id) => {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, leaving: true } : item)))
    setTimeout(() => setItems((list) => list.filter((item) => item.id !== id)), LEAVE_MS)
  }, [])

  const push = useCallback(
    (text, kind = 'info', { action, key, duration } = {}) => {
      seq.current += 1
      const id = seq.current
      setItems((list) => [...list.filter((item) => !(key && item.key === key)).slice(-2), { id, text, kind, action, key }])
      setTimeout(() => leave(id), duration ?? (kind === 'err' ? 7000 : kind === 'warn' ? 8000 : 3400))
    },
    [leave],
  )

  const dismiss = useCallback((key) => {
    setItems((list) => list.map((item) => (item.key === key ? { ...item, leaving: true } : item)))
    setTimeout(
      () => setItems((list) => list.filter((item) => !(item.key === key && item.leaving))),
      LEAVE_MS,
    )
  }, [])

  const value = useMemo(
    () => ({
      info: (text, options) => push(text, 'info', options),
      warn: (text, options) => push(text, 'warn', options),
      error: (err, options) => push(err instanceof Error ? err.message : String(err), 'err', options),
      dismiss,
    }),
    [push, dismiss],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div
            key={item.id}
            className={`toast${item.kind === 'info' ? '' : ` ${item.kind}`}${item.leaving ? ' out' : ''}`}
          >
            <span>{item.text}</span>
            {item.action && (
              <button
                type="button"
                className="toast-act"
                onClick={() => {
                  item.action.onClick()
                  leave(item.id)
                }}
              >
                {item.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}

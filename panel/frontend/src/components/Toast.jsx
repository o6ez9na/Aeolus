import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

const ToastContext = createContext(null)

/**
 * One line at the bottom of the screen after an action: what changed, or why it
 * did not. Errors stay a little longer, since they are the ones worth reading.
 */
export function ToastProvider({ children }) {
  const [items, setItems] = useState([])
  const seq = useRef(0)

  const push = useCallback((text, kind = 'info') => {
    seq.current += 1
    const id = seq.current
    setItems((list) => [...list.slice(-2), { id, text, kind }])
    setTimeout(
      () => setItems((list) => list.filter((item) => item.id !== id)),
      kind === 'err' ? 6000 : 3400,
    )
  }, [])

  const value = useMemo(
    () => ({
      info: (text) => push(text, 'info'),
      error: (err) => push(err instanceof Error ? err.message : String(err), 'err'),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.kind === 'err' ? 'err' : ''}`}>
            {item.text}
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

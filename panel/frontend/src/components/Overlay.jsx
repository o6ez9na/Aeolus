import { useEffect, useRef } from 'react'

import { Icon } from './Icon'

function useEscape(onClose) {
  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}

function useFocusIn(ref) {
  useEffect(() => {
    const previous = document.activeElement
    ref.current?.focus()
    return () => previous?.focus?.()
  }, [ref])
}

/** A panel sliding in from the right, for one object's settings or a form. */
export function Drawer({ title, onClose, children, width }) {
  const ref = useRef(null)
  useEscape(onClose)
  useFocusIn(ref)
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        style={width ? { width: `min(${width}px, 100vw)` } : undefined}
      >
        <div className="panel-head" style={{ marginBottom: 16, alignItems: 'center' }}>
          <h2 style={{ fontSize: 17 }}>{title}</h2>
          <button className="icon-btn" type="button" aria-label="Закрыть" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </aside>
    </>
  )
}

export function Modal({ title, onClose, children, className = '' }) {
  const ref = useRef(null)
  useEscape(onClose)
  useFocusIn(ref)
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        {children}
      </div>
    </>
  )
}

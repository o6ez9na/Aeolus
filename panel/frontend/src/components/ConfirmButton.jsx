import { useEffect, useRef, useState } from 'react'

/**
 * Two-step destructive action. The first click arms the button, the second one
 * runs it, and it disarms itself after a few seconds.
 *
 * Deliberately not window.confirm: browsers let the user suppress further
 * dialogs on a page, and a suppressed confirm() returns without asking, which
 * would silently turn deletion into a single click.
 */
export function ConfirmButton({ onConfirm, label = '✕', armedLabel = 'точно?', title }) {
  const [armed, setArmed] = useState(false)
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  function handleClick() {
    if (!armed) {
      setArmed(true)
      timer.current = setTimeout(() => setArmed(false), 4000)
      return
    }
    clearTimeout(timer.current)
    setArmed(false)
    onConfirm()
  }

  return (
    <button
      type="button"
      className={armed ? 'btn danger' : 'btn ghost'}
      onClick={handleClick}
      onBlur={() => setArmed(false)}
      title={title}
      aria-label={armed ? `${title} — подтвердить` : title}
    >
      {armed ? armedLabel : label}
    </button>
  )
}

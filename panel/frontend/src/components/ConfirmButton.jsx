import { useEffect, useRef, useState } from 'react'

/**
 * Two-step destructive action. The first click arms the button, the second one
 * runs it, and it disarms itself after a few seconds.
 *
 * Deliberately not window.confirm: browsers let the user suppress further
 * dialogs on a page, and a suppressed confirm() returns without asking, which
 * would silently turn deletion into a single click.
 */
export function ConfirmButton({
  onConfirm,
  label = 'Удалить',
  armedLabel = 'Точно?',
  title,
  className = 'btn sm danger',
  disabled,
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  function handleClick(event) {
    event.stopPropagation()
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
      className={`${className}${armed ? ' armed' : ''}`}
      onClick={handleClick}
      onBlur={() => setArmed(false)}
      title={title}
      disabled={disabled}
      aria-label={armed ? `${title ?? label} — подтвердить` : (title ?? label)}
    >
      {armed ? armedLabel : label}
    </button>
  )
}

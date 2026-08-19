const BYTE_UNITS = ['б', 'кб', 'мб', 'гб', 'тб', 'пб']

export function formatBytes(bytes) {
  if (!bytes) return '0б'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${BYTE_UNITS[unit]}`
}

export function formatAgo(iso) {
  if (!iso) return 'никогда'
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds}с назад`
  if (seconds < 3600) return `${Math.round(seconds / 60)}м назад`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}ч назад`
  return `${Math.round(seconds / 86400)}д назад`
}

export function daysUntil(iso) {
  if (!iso) return null
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000)
}

/** Ten-cell text meter, matching the terminal look of the reference design. */
export function meter(value, capacity, cells = 10) {
  const ratio = capacity > 0 ? Math.min(1, Math.max(0, value / capacity)) : 0
  const filled = Math.round(ratio * cells)
  return { filled: '─'.repeat(filled), empty: '─'.repeat(cells - filled) }
}

export function pluralRu(n, one, few, many) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

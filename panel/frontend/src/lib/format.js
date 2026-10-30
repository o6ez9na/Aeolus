const BYTE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ']

export function formatBytes(bytes) {
  if (!bytes) return '0 Б'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const shown = value < 10 && unit > 0 ? value.toFixed(1).replace('.', ',') : Math.round(value)
  return `${shown} ${BYTE_UNITS[unit]}`
}

export function formatAgo(iso) {
  if (!iso) return 'никогда'
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds} с назад`
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин назад`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} ч назад`
  return `${Math.round(seconds / 86400)} дн назад`
}

/** "2 ч 14 мин" since a moment, for how long a session has been up. */
export function formatSince(value) {
  if (!value) return ''
  // OpenVPN writes "2026-10-29 08:58:33" in the container's clock, which is UTC.
  const stamp = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  const minutes = Math.max(0, Math.round((Date.now() - stamp.getTime()) / 60000))
  if (Number.isNaN(minutes)) return ''
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`
  return `${Math.floor(hours / 24)} дн ${hours % 24} ч`
}

export function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('ru-RU')
}

export function formatStamp(iso) {
  const date = new Date(iso)
  return `${date.toLocaleDateString('ru-RU')} ${date.toLocaleTimeString('ru-RU')}`
}

export function daysUntil(iso) {
  if (!iso) return null
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000)
}

export function pluralRu(n, one, few, many) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

export function countRu(n, one, few, many) {
  return `${n} ${pluralRu(n, one, few, many)}`
}

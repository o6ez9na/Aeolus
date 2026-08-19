const API_BASE = import.meta.env.VITE_API_BASE ?? '/api/v1'
const REFRESH_STORAGE_KEY = 'aeolus.refresh'

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * The access token lives in memory only, so an XSS payload cannot read it from
 * storage. The refresh token has to survive a page reload, so it goes to
 * localStorage; move both to httpOnly cookies if the panel ever gets a
 * same-origin production deployment.
 */
let accessToken = null
let onLogout = null

export function setOnLogout(handler) {
  onLogout = handler
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_STORAGE_KEY)
}

export function storeTokens(tokens) {
  accessToken = tokens.access_token
  localStorage.setItem(REFRESH_STORAGE_KEY, tokens.refresh_token)
}

export function clearTokens() {
  accessToken = null
  localStorage.removeItem(REFRESH_STORAGE_KEY)
}

async function parseError(response) {
  try {
    const body = await response.json()
    if (typeof body.detail === 'string') return body.detail
    return JSON.stringify(body.detail ?? body)
  } catch {
    return response.statusText
  }
}

function rawRequest(path, init, token) {
  const headers = new Headers(init.headers)
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(`${API_BASE}${path}`, { ...init, headers })
}

let refreshInFlight = null

/** Refresh once even if several requests hit a 401 at the same time. */
async function refreshAccessToken() {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    const refresh = getRefreshToken()
    if (!refresh) throw new ApiError(401, 'Not authenticated')

    const response = await rawRequest(
      '/auth/refresh',
      { method: 'POST', body: JSON.stringify({ refresh_token: refresh }) },
      null,
    )
    if (!response.ok) {
      clearTokens()
      onLogout?.()
      throw new ApiError(response.status, await parseError(response))
    }
    const tokens = await response.json()
    storeTokens(tokens)
    return tokens.access_token
  })()

  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

export async function apiFetch(path, init = {}) {
  let response = await rawRequest(path, init, accessToken)

  if (response.status === 401 && getRefreshToken()) {
    const fresh = await refreshAccessToken()
    response = await rawRequest(path, init, fresh)
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearTokens()
      onLogout?.()
    }
    throw new ApiError(response.status, await parseError(response))
  }

  if (response.status === 204) return undefined
  return response.json()
}

/**
 * Fetch a file through the authorised API and hand it to the browser as a
 * download. A plain <a href> cannot carry the bearer token.
 */
export async function authorizedDownload(path, filename) {
  let response = await rawRequest(path, {}, accessToken)
  if (response.status === 401 && getRefreshToken()) {
    response = await rawRequest(path, {}, await refreshAccessToken())
  }
  if (!response.ok) throw new ApiError(response.status, await parseError(response))

  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export const api = {
  get: (path) => apiFetch(path),
  post: (path, body) =>
    apiFetch(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: (path, body) =>
    apiFetch(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  delete: (path) => apiFetch(path, { method: 'DELETE' }),
}

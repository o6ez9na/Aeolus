import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { api, authorizedDownload } from '../api/client'
import { useToast } from '../components/Toast'
import { exitGrant } from './model'

const MeshContext = createContext(null)
const POLL_MS = 8000

/**
 * Nodes, clients and the map layout, loaded once for the whole shell and kept
 * fresh by polling. Every page edits the same objects through the actions
 * here, so a grant given on the map shows up in the client table without a
 * reload, and every action says in one line what it did.
 */
export function MeshProvider({ children }) {
  const toast = useToast()
  const [nodes, setNodes] = useState(null)
  const [clients, setClients] = useState(null)
  const [groups, setGroups] = useState(null)
  const [layout, setLayoutState] = useState(null)
  const [error, setError] = useState(null)
  const [updatedAt, setUpdatedAt] = useState(null)
  const seen = useRef({})

  // An unchanged poll must not hand React fresh arrays: the map would rebuild
  // every card and anyone mid-drag would lose what they were holding.
  const setIfChanged = useCallback((key, value, set) => {
    const signature = JSON.stringify(value)
    if (seen.current[key] === signature) return
    seen.current[key] = signature
    set(value)
  }, [])

  const reload = useCallback(async () => {
    try {
      const [n, c, g] = await Promise.all([api.get('/nodes'), api.get('/clients'), api.get('/groups')])
      setIfChanged('nodes', n, setNodes)
      setIfChanged('clients', c, setClients)
      setIfChanged('groups', g, setGroups)
      setError(null)
      setUpdatedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить данные')
    }
  }, [setIfChanged])

  useEffect(() => {
    void reload()
    api
      .get('/ui/layout')
      .then((data) => setLayoutState(data))
      .catch(() => setLayoutState({ positions: {} }))
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void reload()
    }, POLL_MS)
    return () => clearInterval(id)
  }, [reload])

  const saveTimer = useRef(null)
  const pendingLayout = useRef(null)

  /** Replace the layout now and write it a moment later, coalescing drags. */
  const setLayout = useCallback(
    (next, { persist = true } = {}) => {
      setLayoutState(next)
      if (!persist) return
      pendingLayout.current = next
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        const body = pendingLayout.current
        pendingLayout.current = null
        api
          .put('/ui/layout', { positions: body.positions ?? {} })
          .catch((err) => toast.error(`Раскладка не сохранилась: ${err.message}`))
      }, 600)
    },
    [toast],
  )

  const run = useCallback(
    async (action, message) => {
      try {
        const result = await action()
        if (message) toast.info(typeof message === 'function' ? message(result) : message)
        await reload()
        return result
      } catch (err) {
        toast.error(err)
        await reload()
        throw err
      }
    },
    [reload, toast],
  )

  const nodeName = useCallback(
    (id) => (nodes ?? []).find((node) => node.id === id)?.name ?? 'узел',
    [nodes],
  )

  const actions = useMemo(() => {
    const patchClient = (client, body) => api.patch(`/clients/${client.id}`, body)

    async function setExitRaw(client, nodeId) {
      const current = exitGrant(client)
      if ((current?.node_id ?? null) === nodeId) return client
      let fresh = client
      if (nodeId && !client.node_ids.includes(nodeId)) {
        fresh = await patchClient(client, { node_ids: [...client.node_ids, nodeId] })
      }
      // The API refuses a second exit rather than moving it, so the old one is
      // switched off first.
      if (current) await api.post(`/ccd/${current.grant_id}/exit`, { is_exit: false })
      if (nodeId) {
        const grant = fresh.access.find((g) => g.node_id === nodeId)
        await api.post(`/ccd/${grant.grant_id}/exit`, { is_exit: true })
      }
      return fresh
    }

    return {
      grant: (client, nodeId) =>
        client.node_ids.includes(nodeId)
          ? Promise.resolve(toast.info(`У ${client.common_name} уже есть доступ к ${nodeName(nodeId)}`))
          : run(
              () => patchClient(client, { node_ids: [...client.node_ids, nodeId] }),
              `${client.common_name} → ${nodeName(nodeId)}: доступ выдан`,
            ),
      revoke: (client, nodeId) =>
        run(
          () => patchClient(client, { node_ids: client.node_ids.filter((id) => id !== nodeId) }),
          `${client.common_name}: доступ к ${nodeName(nodeId)} забран`,
        ),
      setExit: (client, nodeId) =>
        run(
          () => setExitRaw(client, nodeId),
          nodeId
            ? `Весь трафик ${client.common_name} теперь уходит через ${nodeName(nodeId)}`
            : `${client.common_name} больше не выходит в интернет через VPN`,
        ),
      /** Apply one change to many clients, reporting once. */
      bulk: (list, apply, message) =>
        run(async () => {
          for (const client of list) await apply(client, { patchClient, setExitRaw })
        }, message),
      updateClient: (client, body, message) => run(() => patchClient(client, body), message),
      setClientStatus: (client, status) =>
        run(
          () => patchClient(client, { status }),
          status === 'active' ? `${client.common_name} включён` : `${client.common_name} отключён`,
        ),
      createClient: (body) => api.post('/clients', body),
      deleteClient: (client) =>
        run(
          () => api.delete(`/clients/${client.id}`),
          `${client.common_name} удалён, сертификат отозван`,
        ),
      issueCert: (client) =>
        run(
          () => api.post(`/pki/clients/${client.id}/certificate`),
          `Сертификат для ${client.common_name} выпущен`,
        ),
      revokeCert: (client) =>
        run(
          () => api.post(`/pki/clients/${client.id}/revoke`),
          `Сертификат ${client.common_name} отозван`,
        ),
      downloadConfig: (client) =>
        authorizedDownload(`/clients/${client.id}/config`, `${client.common_name}.ovpn`).catch(
          (err) => toast.error(err),
        ),
      /** Resolves to { username, password }: the only time the password is visible. */
      issueImportPassword: (client) =>
        run(
          () => api.post(`/clients/${client.id}/import-password`),
          `${client.common_name}: пароль для OpenVPN Connect выдан`,
        ),
      disableImport: (client) =>
        run(
          () => api.delete(`/clients/${client.id}/import-password`),
          `${client.common_name}: вход по паролю выключен`,
        ),
      updateNode: (node, body, message) => run(() => api.patch(`/nodes/${node.id}`, body), message),
      approveNode: (node) =>
        run(
          () => api.post(`/nodes/${node.id}/approve`),
          `${node.name} принят: агент заберёт сертификат при следующем опросе`,
        ),
      rejectNode: (node) =>
        run(() => api.post(`/nodes/${node.id}/reject`), `Заявка ${node.name} отклонена`),
      deleteNode: (node) => run(() => api.delete(`/nodes/${node.id}`), `${node.name} удалён`),
      createGroup: (body) =>
        run(() => api.post('/groups', body), (group) => `Группа «${group.name}» создана`),
      renameGroup: (group, name) =>
        run(() => api.patch(`/groups/${group.id}`, { name }), `Группа переименована в «${name}»`),
      deleteGroup: (group) =>
        run(
          () => api.delete(`/groups/${group.id}`),
          `Группа «${group.name}» удалена, её доступы сняты с участников`,
        ),
      /** Replace a group's access; every member gets it at once. */
      setGroupGrants: (group, grants, message) =>
        run(
          () =>
            api.put(`/groups/${group.id}/grants`, {
              grants: grants.map((g) => ({
                node_id: g.node_id,
                is_exit: Boolean(g.is_exit),
                networks: g.networks ?? null,
              })),
            }),
          message ?? `Доступы группы «${group.name}» обновлены`,
        ),
      setClientGroup: (client, group) =>
        run(
          () => patchClient(client, { group_id: group?.id ?? null }),
          group
            ? `${client.common_name} в группе «${group.name}»: получил её доступы`
            : `${client.common_name} вышел из группы, её доступы сняты`,
        ),
      setGrantScope: (grant, networks, label) =>
        run(
          () => api.patch(`/ccd/${grant.grant_id}`, { networks }),
          networks ? `${label}: доступ сужен до ${networks.join(', ')}` : `${label}: снова вся сеть узла`,
        ),
      reissueServerCert: (node) =>
        run(
          () => api.post(`/pki/nodes/${node.id}/certificate`),
          `Серверный сертификат ${node.name} перевыпущен`,
        ),
      run,
    }
  }, [nodeName, run, toast])

  const value = useMemo(
    () => ({
      nodes,
      clients,
      groups,
      layout,
      setLayout,
      error,
      updatedAt,
      loading: nodes === null || clients === null || groups === null,
      reload,
      nodeName,
      ...actions,
    }),
    [nodes, clients, groups, layout, setLayout, error, updatedAt, reload, nodeName, actions],
  )

  return <MeshContext.Provider value={value}>{children}</MeshContext.Provider>
}

export function useMesh() {
  const ctx = useContext(MeshContext)
  if (!ctx) throw new Error('useMesh must be used inside <MeshProvider>')
  return ctx
}

import { useState } from 'react'

import { useAuth } from '../auth/AuthContext'
import { grantsWith, grantsWithExit, grantsWithout, membersOf, scopeText } from '../lib/groups'
import { useMesh } from '../lib/mesh'
import { canEdit, clientState, dotClass, nodeState } from '../lib/model'
import { ConfirmButton } from './ConfirmButton'
import { Icon } from './Icon'
import { ScopeEditor } from './ScopeEditor'

/**
 * One group as a role: who is in it and what being in it gives. Every change
 * here reaches all members at once, which is the point of having the group.
 */
export function GroupEditor({ group, onSelectClient, onDeleted }) {
  const { user } = useAuth()
  const mesh = useMesh()
  const editable = canEdit(user)
  const [name, setName] = useState(group.name)
  const [scopeFor, setScopeFor] = useState(null)
  const [busy, setBusy] = useState(false)

  const members = membersOf(group, mesh.clients)
  const others = (mesh.clients ?? []).filter((c) => c.group_id !== group.id && c.status !== 'revoked')
  const nodes = (mesh.nodes ?? [])
    .filter((n) => n.approval === 'approved')
    .sort((a, b) => Number(b.is_hub) - Number(a.is_hub) || a.name.localeCompare(b.name))
  const grantOf = (nodeId) => group.grants.find((g) => g.node_id === nodeId)
  const exit = group.grants.find((g) => g.is_exit)
  const online = members.filter((c) => c.session).length

  async function act(fn) {
    setBusy(true)
    try {
      await fn()
    } catch {
      // reported by the mesh
    } finally {
      setBusy(false)
    }
  }

  const rename = () => {
    const next = name.trim()
    if (next && next !== group.name) void act(() => mesh.renameGroup(group, next))
  }

  return (
    <section className="stack-lg" aria-label={`Группа ${group.name}`}>
      <div className="stack" style={{ gap: 6 }}>
        {editable ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              rename()
            }}
          >
            <input
              className="input"
              style={{ fontWeight: 600, fontSize: 15 }}
              value={name}
              maxLength={64}
              aria-label="Название группы"
              onChange={(event) => setName(event.target.value)}
              onBlur={rename}
            />
          </form>
        ) : (
          <h2 style={{ fontSize: 18 }}>{group.name}</h2>
        )}
        <span className="muted" style={{ fontSize: 13 }}>
          {members.length} в группе · {online} в сети
        </span>
      </div>

      <div className="stack" style={{ gap: 8 }}>
        <span className="lbl">Участники</span>
        <div className="row-wrap" style={{ gap: 6 }}>
          {members.length === 0 && <span className="hint">Пока никого</span>}
          {members.map((client) => (
            <span key={client.id} className="chip mono" style={{ height: 30, paddingRight: editable ? 2 : 9 }}>
              <span className={dotClass(clientState(client))} />
              <button
                type="button"
                style={{ all: 'unset', cursor: 'pointer' }}
                onClick={() => onSelectClient?.(client)}
              >
                {client.common_name}
              </button>
              {editable && (
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 24, height: 24 }}
                  aria-label={`Вывести ${client.common_name} из группы`}
                  title="Вывести из группы: её доступы снимутся"
                  disabled={busy}
                  onClick={() => void act(() => mesh.setClientGroup(client, null))}
                >
                  <Icon name="close" size={11} />
                </button>
              )}
            </span>
          ))}
        </div>
        {editable && others.length > 0 && (
          <select
            className="select"
            style={{ height: 36 }}
            aria-label="Добавить участника"
            value=""
            disabled={busy}
            onChange={(event) => {
              const client = others.find((c) => c.id === event.target.value)
              if (client) void act(() => mesh.setClientGroup(client, group))
            }}
          >
            <option value="">+ Добавить участника…</option>
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.common_name}
                {c.group_name ? ` (сейчас в «${c.group_name}»)` : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="stack" style={{ gap: 6 }}>
        <span className="lbl">Что даёт группа</span>
        <div className="bleed">
          {nodes.map((node) => {
            const grant = grantOf(node.id)
            const on = Boolean(grant)
            const down = nodeState(node) !== 'up'
            return (
              <div key={node.id} className="stack" style={{ gap: 0 }}>
                <div className="row-wrap" style={{ flexWrap: 'nowrap', gap: 0 }}>
                  <button
                    type="button"
                    className="trow"
                    aria-pressed={on}
                    aria-disabled={!editable || busy}
                    onClick={() => {
                      if (!editable || busy) return
                      void act(() =>
                        mesh.setGroupGrants(
                          group,
                          on ? grantsWithout(group, node.id) : grantsWith(group, node.id),
                          on
                            ? `«${group.name}»: ${node.name} больше не даётся${members.length ? `, снят у ${members.length}` : ''}`
                            : `«${group.name}» → ${node.name}${members.length ? `: выдано ${members.length} участникам` : ' добавлен в доступы группы'}`,
                        ),
                      )
                    }}
                  >
                    <span className={on ? 'sw on' : 'sw'} />
                    <span className="t-main">
                      <span className="t-title mono">{node.name}</span>
                      <span className={`t-sub${node.is_hub ? '' : ' mono'}${grant?.networks ? ' exit-text' : ''}`}>
                        {node.is_hub ? 'сама панель' : scopeText(grant?.networks ?? null, node.subnets)}
                      </span>
                    </span>
                    {down && <span className="err-text" style={{ fontSize: 11 }}>недоступен</span>}
                  </button>
                  {editable && on && !node.is_hub && node.subnets.length > 0 && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      aria-expanded={scopeFor === node.id}
                      onClick={() => setScopeFor(scopeFor === node.id ? null : node.id)}
                    >
                      {grant.networks ? 'Изменить' : 'Сузить'}
                    </button>
                  )}
                </div>
                {scopeFor === node.id && grant && (
                  <div style={{ padding: '4px 10px 12px' }}>
                    <ScopeEditor
                      node={node}
                      networks={grant.networks}
                      busy={busy}
                      onCancel={() => setScopeFor(null)}
                      onSave={(networks) =>
                        void act(async () => {
                          await mesh.setGroupGrants(
                            group,
                            grantsWith(group, node.id, { networks }),
                            networks
                              ? `«${group.name}» → ${node.name}: только ${networks.join(', ')}`
                              : `«${group.name}» → ${node.name}: вся сеть`,
                          )
                          setScopeFor(null)
                        })
                      }
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="stack" style={{ gap: 6 }}>
        <span className="lbl">Выход в интернет для всех</span>
        <div className="bleed" style={{ gap: 4 }}>
          {[null, ...nodes].map((node) => {
            const on = (exit?.node_id ?? null) === (node?.id ?? null)
            return (
              <button
                key={node?.id ?? 'none'}
                type="button"
                className={`opt${on ? ' on' : ''}`}
                aria-pressed={on}
                disabled={!editable || busy}
                onClick={() =>
                  !on &&
                  void act(() =>
                    mesh.setGroupGrants(
                      group,
                      grantsWithExit(group, node?.id ?? null),
                      node
                        ? `«${group.name}» выходит в интернет через ${node.name}`
                        : `«${group.name}»: выход задаёт каждый участник сам`,
                    ),
                  )
                }
              >
                <span className="radio" />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }} className={node ? 'mono' : ''}>
                    {node ? `через ${node.name}` : 'Не задавать'}
                  </span>
                  <span className="hint">
                    {node
                      ? node.is_hub
                        ? 'IP панели'
                        : 'IP узла, доступ к нему выдастся сам'
                      : 'каждый участник выбирает выход сам'}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {editable && (
        <ConfirmButton
          className="btn sm danger"
          label="Удалить группу"
          armedLabel={`Удалить? ${members.length} участников потеряют её доступы`}
          title={`Удалить группу ${group.name}`}
          onConfirm={() =>
            void act(async () => {
              await mesh.deleteGroup(group)
              onDeleted?.()
            })
          }
        />
      )}
    </section>
  )
}

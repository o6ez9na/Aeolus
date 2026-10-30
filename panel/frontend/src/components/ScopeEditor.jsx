import { useState } from 'react'

import { Icon } from './Icon'

/**
 * How much of a node's LAN a grant opens: all of it, or only some subnets and
 * single addresses inside it. The panel checks the entries against what the
 * node announces when they are saved.
 */
export function ScopeEditor({ node, networks, onSave, onCancel, busy }) {
  const [mode, setMode] = useState(networks ? 'some' : 'all')
  const [items, setItems] = useState(networks ?? [])
  const [draft, setDraft] = useState('')

  function add(value) {
    const entry = value.trim()
    if (!entry) return
    const normal = entry.includes('/') ? entry : `${entry}/32`
    setItems((list) => (list.includes(normal) ? list : [...list, normal]))
    setDraft('')
  }

  const canSave = mode === 'all' || items.length > 0

  return (
    <div className="scope">
      <div className="seg-group fill">
        <button
          type="button"
          className={`seg${mode === 'all' ? ' on' : ''}`}
          aria-pressed={mode === 'all'}
          onClick={() => setMode('all')}
        >
          Вся сеть узла
        </button>
        <button
          type="button"
          className={`seg${mode === 'some' ? ' on' : ''}`}
          aria-pressed={mode === 'some'}
          onClick={() => setMode('some')}
        >
          Только выбранное
        </button>
      </div>

      {mode === 'all' ? (
        <span className="hint mono">{node.subnets.join(', ')}</span>
      ) : (
        <>
          <div className="row-wrap" style={{ gap: 6 }}>
            {items.length === 0 && <span className="hint">Пока ничего: добавь подсеть или адрес</span>}
            {items.map((item) => (
              <span key={item} className="chip mono" style={{ paddingRight: 2 }}>
                {item}
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 22, height: 22 }}
                  aria-label={`Убрать ${item}`}
                  onClick={() => setItems((list) => list.filter((x) => x !== item))}
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            ))}
          </div>
          <form
            className="row-wrap"
            style={{ flexWrap: 'nowrap' }}
            onSubmit={(event) => {
              event.preventDefault()
              add(draft)
            }}
          >
            <input
              className="input mono"
              style={{ height: 34 }}
              placeholder="192.168.1.10 или 192.168.1.0/26"
              aria-label="Адрес или подсеть"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="btn sm" type="submit">
              Добавить
            </button>
          </form>
          {node.subnets.length > 1 && (
            <div className="row-wrap" style={{ gap: 6 }}>
              {node.subnets
                .filter((s) => !items.includes(s))
                .map((subnet) => (
                  <button key={subnet} type="button" className="chip mono" onClick={() => add(subnet)}>
                    + {subnet}
                  </button>
                ))}
            </div>
          )}
          <span className="hint">
            Адрес без маски — это один хост. Всё должно лежать внутри {node.subnets.join(', ')}.
          </span>
        </>
      )}

      <div className="row-wrap">
        <button
          className="btn sm primary"
          type="button"
          disabled={busy || !canSave}
          onClick={() => onSave(mode === 'all' ? null : items)}
        >
          Сохранить
        </button>
        <button className="btn sm ghost" type="button" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  )
}

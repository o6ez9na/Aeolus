/**
 * Node access as toggleable chips. A native multi-select needs ctrl-click to add
 * a second option and silently drops the selection on a stray click, which is
 * the wrong control for "which exits may this client use".
 */
export function NodePicker({ nodes, value, onChange }) {
  const selected = new Set(value)

  function toggle(id) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }

  if (nodes.length === 0) {
    return <div className="muted">узлов пока нет — сначала добавь узел</div>
  }

  return (
    <div className="picker">
      {nodes.map((node) => {
        const on = selected.has(node.id)
        return (
          <button
            key={node.id}
            type="button"
            className="picker-item"
            aria-pressed={on}
            onClick={() => toggle(node.id)}
          >
            <span className="mark">{on ? '✓' : '+'}</span>
            {node.name}
            <span className="dim">
              {node.openvpn_proto}/{node.openvpn_port}
            </span>
          </button>
        )
      })}
      <button
        type="button"
        className="btn ghost"
        onClick={() => onChange(selected.size === nodes.length ? [] : nodes.map((n) => n.id))}
      >
        {selected.size === nodes.length ? 'снять все' : 'выбрать все'}
      </button>
    </div>
  )
}

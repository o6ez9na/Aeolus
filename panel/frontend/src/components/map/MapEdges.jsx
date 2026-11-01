import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react'
import { memo } from 'react'

/**
 * The line between the panel and a node, or between two nodes.
 *
 * A plain transit tunnel is the usual blue line, clickable: the inspector it
 * opens offers to switch on network transit. With network transit on it turns
 * into a bridge: a blue-to-teal tube with a glow and packets running along it,
 * one way into the panel's LAN (masqueraded there) or both ways between two
 * nodes, and a chip that names it.
 */
export const TransitEdge = memo(function TransitEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  data,
}) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  const opacity = style?.opacity ?? 1
  const chipAt = { transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, opacity }
  const open = (event) => {
    event.stopPropagation()
    data?.onOpen?.()
  }

  if (!data?.bridged) {
    return (
      <>
        <BaseEdge id={id} path={path} style={style} interactionWidth={26} />
        {data?.chip && (
          <EdgeLabelRenderer>
            <button
              type="button"
              className={`edge-chip nodrag nopan${data.chipTone ? ` ${data.chipTone}` : ''}`}
              style={chipAt}
              onClick={open}
            >
              {data.chip}
            </button>
          </EdgeLabelRenderer>
        )}
      </>
    )
  }

  // One gradient per edge, laid along the line itself so it reads source to
  // target however the cards are arranged.
  const gradient = `bridge-grad-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  return (
    <>
      <defs>
        <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}>
          <stop offset="0%" style={{ stopColor: 'var(--transit)' }} />
          <stop offset="100%" style={{ stopColor: 'var(--bridge)' }} />
        </linearGradient>
      </defs>
      <path d={path} className="bridge-glow" style={{ stroke: `url(#${gradient})`, opacity: 0.35 * opacity }} />
      <BaseEdge
        id={id}
        path={path}
        className="bridge-core"
        style={{ stroke: `url(#${gradient})`, strokeWidth: 3.5, opacity }}
        interactionWidth={30}
      />
      <path d={path} className="bridge-pulse" style={{ opacity }} />
      {data.both && <path d={path} className="bridge-pulse rev" style={{ opacity }} />}
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`bridge-chip nodrag nopan${data.selected ? ' sel' : ''}`}
          style={chipAt}
          onClick={open}
          title="Транзит сетей: открыть настройку"
        >
          <span aria-hidden="true">⇄</span> транзит сетей
        </button>
      </EdgeLabelRenderer>
    </>
  )
})

export const edgeTypes = { transit: TransitEdge }

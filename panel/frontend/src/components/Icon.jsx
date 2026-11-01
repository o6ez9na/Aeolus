/** Stroke icons drawn for the panel, on a 20×20 grid. */
const PATHS = {
  // The letter A drawn as the mesh: the hub at the apex, transit tunnels down
  // to two nodes, the network-transit bridge across. Same mark as favicon.svg.
  logo: (
    <>
      <path d="M9.1 5.68L4.74 15.33M10.9 5.68l4.36 9.65M7.01 12.02h5.98" />
      <circle cx="10" cy="3.95" r="2.09" fill="currentColor" stroke="none" />
      <circle cx="4.17" cy="16.62" r="1.55" fill="currentColor" stroke="none" />
      <circle cx="15.83" cy="16.62" r="1.55" fill="currentColor" stroke="none" />
    </>
  ),
  map: (
    <>
      <circle cx="4.5" cy="5.5" r="2" />
      <circle cx="15.5" cy="5.5" r="2" />
      <circle cx="10" cy="15" r="2.2" />
      <path d="M6.3 6.6l2.6 6.4M13.7 6.6l-2.6 6.4M6.5 5.5h7" />
    </>
  ),
  users: (
    <>
      <circle cx="8" cy="7" r="3" />
      <path d="M2.5 17c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" />
      <path d="M13 4.3a3 3 0 0 1 0 5.6M15.2 12.6c1.3.7 2.1 2.1 2.3 4.4" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="3.5" width="14" height="5" rx="1.5" />
      <rect x="3" y="11.5" width="14" height="5" rx="1.5" />
      <path d="M6 6h.01M6 14h.01" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 5h12M4 10h12M4 15h12" />
      <circle cx="7" cy="5" r="1.7" />
      <circle cx="13" cy="10" r="1.7" />
      <circle cx="9" cy="15" r="1.7" />
    </>
  ),
  key: (
    <>
      <circle cx="7" cy="12.5" r="3.5" />
      <path d="M9.5 10L16 3.5M13.5 6l2 2M11.5 8l1.5 1.5" />
    </>
  ),
  activity: <path d="M2 10.5h3.5l2-5 4 9.5 2-4.5H18" />,
  list: <path d="M7.5 5h9.5M7.5 10h9.5M7.5 15h9.5M3.5 5h.01M3.5 10h.01M3.5 15h.01" />,
  search: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13.2 13.2L17 17" />
    </>
  ),
  plus: <path d="M10 4v12M4 10h12" />,
  close: <path d="M5 5l10 10M15 5L5 15" />,
  check: <path d="M4.5 10.5l3.5 3.5 7.5-8" />,
  chevron: <path d="M6 8l4 4 4-4" />,
  download: <path d="M10 3v10M6 9l4 4 4-4M4 16h12" />,
  globe: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M2.5 10h15M10 2.5c2.2 2.3 3.2 4.8 3.2 7.5s-1 5.2-3.2 7.5c-2.2-2.3-3.2-4.8-3.2-7.5s1-5.2 3.2-7.5z" />
    </>
  ),
  theme: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 3.5a6.5 6.5 0 0 0 0 13z" fill="currentColor" />
    </>
  ),
  warn: (
    <>
      <path d="M10 3l8 14H2z" />
      <path d="M10 8.5v3.5M10 14.5h.01" />
    </>
  ),
  alert: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.5v4M10 13.5h.01" />
    </>
  ),
  restart: (
    <>
      <path d="M15.5 6.5A6.5 6.5 0 1 0 16.5 11" />
      <path d="M16 3v4h-4" />
    </>
  ),
  group: (
    <>
      <rect x="2.5" y="4" width="15" height="12" rx="2.5" strokeDasharray="2.5 2" />
      <path d="M6 8.5h8M6 11.5h5" />
    </>
  ),
  layout: (
    <>
      <rect x="2.5" y="3.5" width="5" height="5" rx="1" />
      <rect x="12.5" y="3.5" width="5" height="5" rx="1" />
      <rect x="7.5" y="11.5" width="5" height="5" rx="1" />
      <path d="M7.5 6h5M10 8.5v3" />
    </>
  ),
  logout: <path d="M8 4H5a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 5 16h3M12 6.5L15.5 10 12 13.5M15.5 10H8" />,
  more: (
    <>
      <circle cx="5" cy="10" r="1.3" fill="currentColor" />
      <circle cx="10" cy="10" r="1.3" fill="currentColor" />
      <circle cx="15" cy="10" r="1.3" fill="currentColor" />
    </>
  ),
  copy: (
    <>
      <rect x="7" y="7" width="9.5" height="9.5" rx="1.8" />
      <path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 4 5v6a1.5 1.5 0 0 0 1.5 1.5H7" />
    </>
  ),
  edit: <path d="M4 16l1-4 8.5-8.5 3 3L8 15zM11.5 5.5l3 3" />,
}

export function Icon({ name, size = 18, stroke = 1.7, className, style, label }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {PATHS[name]}
    </svg>
  )
}

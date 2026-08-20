/**
 * Sections whose backend does not exist yet. They say so plainly rather than
 * showing invented data.
 */
export function PlaceholderPage({ title, planned }) {
  return (
    <div className="empty">
      <div className="name">{title} — раздел ещё не реализован</div>
      <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
        {planned.map((item) => (
          <li key={item} className="sub" style={{ lineHeight: 1.9 }}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function TrafficPage() {
  return (
    <PlaceholderPage
      title="трафик"
      planned={[
        'счётчики rx/tx с management-интерфейса OpenVPN',
        'история по узлам и клиентам',
        'лимиты и автоотключение при перерасходе',
      ]}
    />
  )
}

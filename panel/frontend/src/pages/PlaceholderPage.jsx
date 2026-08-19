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

export function PkiPage() {
  return (
    <PlaceholderPage
      title="pki"
      planned={[
        'создание и хранение CA панели',
        'выпуск и отзыв клиентских сертификатов',
        'генерация .ovpn с inline-сертификатами',
        'публикация CRL на узлы через агента anemoi',
      ]}
    />
  )
}

export function CcdPage() {
  return (
    <PlaceholderPage
      title="ccd"
      planned={[
        'client-config-dir на узел',
        'фиксированные адреса и маршруты клиента',
        'push-опции и iroute',
      ]}
    />
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

export function AuditPage() {
  return (
    <PlaceholderPage
      title="аудит"
      planned={[
        'журнал действий операторов',
        'входы и отзывы сессий',
        'события выпуска и отзыва сертификатов',
      ]}
    />
  )
}

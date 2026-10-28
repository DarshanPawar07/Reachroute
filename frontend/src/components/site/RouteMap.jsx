// The picture on the home page: one contact list, and the routes it can take. Solid lines are built; dotted ones are planned.
const STOPS = [
  { key: 'whatsapp', label: 'WhatsApp', sub: 'Available now', color: '#1fa463', live: true },
  { key: 'email', label: 'Email', sub: 'Available now', color: '#3b5bdb', live: true },
  { key: 'instagram', label: 'Instagram', sub: 'Planned', color: '#c2417f', live: false },
  { key: 'facebook', label: 'Facebook Messenger', sub: 'Planned', color: '#1c8fd6', live: false },
];

function Line({ d, stop }) {
  return stop.live ? (
    <>
      <path d={d} fill="none" stroke={stop.color} strokeWidth="5" strokeLinecap="round" opacity="0.28" />
      <path d={d} fill="none" stroke={stop.color} strokeWidth="5" strokeLinecap="round" className="route-flow" />
    </>
  ) : (
    <path d={d} fill="none" stroke={stop.color} strokeWidth="3.5" strokeLinecap="round" strokeDasharray="1 9" opacity="0.8" />
  );
}

function Station({ x, y, stop }) {
  return stop.live ? (
    <circle cx={x} cy={y} r="11" fill="#fff" stroke={stop.color} strokeWidth="5" />
  ) : (
    <circle cx={x} cy={y} r="10" fill="#f5f8f7" stroke={stop.color} strokeWidth="3" strokeDasharray="3 4" />
  );
}

export default function RouteMap() {
  const ys = [44, 114, 186, 256];
  return (
    <figure className="m-0" aria-label="Your contact list can be sent to WhatsApp and email today. Instagram and Facebook Messenger are planned.">
      {/* wide screens: the list on the left, four routes fanning out */}
      <svg viewBox="0 0 560 300" role="img" aria-hidden="true" className="hidden w-full sm:block">
        <rect x="8" y="112" width="118" height="76" rx="16" fill="#12242d" />
        <text x="67" y="145" textAnchor="middle" fill="#fff" fontSize="17" fontWeight="700" fontFamily="Bricolage Grotesque, Figtree, sans-serif">Your list</text>
        <text x="67" y="167" textAnchor="middle" fill="#9fb2ab" fontSize="12.5" fontFamily="Figtree, sans-serif">people who agreed</text>
        {STOPS.map((s, i) => (
          <Line key={s.key} stop={s} d={`M126 150 H180 C240 150 250 ${ys[i]} 305 ${ys[i]} H346`} />
        ))}
        {STOPS.map((s, i) => (
          <g key={s.key}>
            <Station x={358} y={ys[i]} stop={s} />
            <text x="382" y={ys[i] - 2} fill="#12242d" fontSize="17" fontWeight="700" fontFamily="Bricolage Grotesque, Figtree, sans-serif">{s.label}</text>
            <text x="382" y={ys[i] + 18} fill={s.live ? '#4d5f59' : '#687a74'} fontSize="13" fontFamily="Figtree, sans-serif">{s.sub}</text>
          </g>
        ))}
      </svg>

      {/* phones: one line down the page with a stop for each channel */}
      <svg viewBox="0 0 320 360" role="img" aria-hidden="true" className="mx-auto w-full max-w-xs sm:hidden">
        <rect x="8" y="8" width="132" height="46" rx="14" fill="#12242d" />
        <text x="74" y="36" textAnchor="middle" fill="#fff" fontSize="16" fontWeight="700" fontFamily="Bricolage Grotesque, Figtree, sans-serif">Your list</text>
        {STOPS.map((s, i) => {
          const y = 118 + i * 74;
          const from = i === 0 ? 54 : y - 74;
          return (
            <g key={s.key}>
              <Line stop={s} d={`M74 ${from} V${y}`} />
              <Station x={74} y={y} stop={s} />
              <text x="102" y={y - 1} fill="#12242d" fontSize="16" fontWeight="700" fontFamily="Bricolage Grotesque, Figtree, sans-serif">{s.label}</text>
              <text x="102" y={y + 18} fill="#4d5f59" fontSize="13" fontFamily="Figtree, sans-serif">{s.sub}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/** Small line icons, drawn once here so every screen uses the same set. */
const paths = {
  home: <path d="M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10" />,
  whatsapp: <path d="M4 20l1.3-4.2A8 8 0 1 1 8.4 18.8L4 20zm5-11.5c.2 2.6 3.2 5.6 5.8 5.8l1.2-1.3-2-1-.9.6c-.9-.4-1.9-1.4-2.3-2.3l.6-.9-1-2L9 8.5z" />,
  mail: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="m4 7.5 8 6 8-6" />
    </>
  ),
  list: <path d="M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01" />,
  chart: <path d="M5 20V10m7 10V4m7 16v-7" />,
  bell: <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15l1.5-2zM10 21h4" />,
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
    </>
  ),
  shield: <path d="M12 3.5 5 6v5.5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6l-7-2.5zM9.2 12l2 2 3.6-3.8" />,
  plus: <path d="M12 5v14M5 12h14" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  logout: <path d="M10 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H10M14 8l4 4-4 4M18 12H9" />,
  chat: <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V15a2.5 2.5 0 0 1-2-2.5v-6z" />,
  instagram: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4.5" />
      <circle cx="12" cy="12" r="3.6" />
      <path d="M16.9 7.1h.01" />
    </>
  ),
  messenger: <path d="M12 3.5c-4.7 0-8.5 3.4-8.5 7.8 0 2.4 1.1 4.5 2.9 5.9V20l2.9-1.6c.9.3 1.7.4 2.7.4 4.7 0 8.5-3.4 8.5-7.8S16.7 3.5 12 3.5zM8.4 13.1l3-3.2 2 1.9 3-1.9-3 3.2-2-1.9-3 1.9z" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  send: <path d="M20 4 10.5 13.5M20 4l-6 16-3.5-6.5L4 10l16-6z" />,
};

export default function Icon({ name, className = 'h-5 w-5' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

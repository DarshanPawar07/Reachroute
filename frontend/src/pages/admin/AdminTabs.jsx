import { NavLink } from 'react-router-dom';
import { PageHeader } from '../../components/ui.jsx';

const tabs = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/users', label: 'Accounts' },
  { to: '/admin/plans', label: 'Plans' },
  { to: '/admin/audit', label: 'Activity log' },
];

/** The heading and the row of admin tabs shared by every admin page. */
export default function AdminTabs({ title, subtitle, actions }) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
      <nav className="mb-5 flex gap-1 overflow-x-auto border-b border-stone-200">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) => `whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${isActive ? 'border-stone-900 text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-800'}`}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

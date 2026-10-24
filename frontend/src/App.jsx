import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api.js';
import { AuthProvider, useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import WhatsAppHome from './pages/WhatsAppHome.jsx';
import EmailHome from './pages/EmailHome.jsx';
import EmailSettings from './pages/EmailSettings.jsx';
import Replies from './pages/Replies.jsx';
import NewCampaign from './pages/NewCampaign.jsx';
import CampaignDetail from './pages/CampaignDetail.jsx';
import Lists from './pages/Lists.jsx';
import ListDetail from './pages/ListDetail.jsx';
import Usage from './pages/Usage.jsx';
import Notifications from './pages/Notifications.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import VerifyEmail from './pages/VerifyEmail.jsx';
import Account from './pages/Account.jsx';
import AdminAudit from './pages/admin/AdminAudit.jsx';
import AdminOverview from './pages/admin/AdminOverview.jsx';
import AdminPlans from './pages/admin/AdminPlans.jsx';
import AdminUserDetail from './pages/admin/AdminUserDetail.jsx';
import AdminUsers from './pages/admin/AdminUsers.jsx';

function RequireAuth({ children }) {
  const { session } = useAuth();
  return session ? children : <Navigate to="/login" replace />;
}

/** Only administrators see the admin pages; everyone else goes back to the dashboard. */
function RequireAdmin({ children }) {
  const [role, setRole] = useState(null);
  useEffect(() => {
    api('/api/auth/me')
      .then((r) => setRole(r.user.role))
      .catch(() => setRole('user'));
  }, []);
  if (role === null) return <p className="text-sm text-stone-500">Loading...</p>;
  return role === 'admin' ? children : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<Dashboard />} />

            <Route path="whatsapp" element={<WhatsAppHome />} />
            <Route path="whatsapp/replies" element={<Replies kind="whatsapp" />} />
            <Route path="whatsapp/new" element={<NewCampaign kind="whatsapp" />} />
            <Route path="whatsapp/campaigns/:id" element={<CampaignDetail kind="whatsapp" />} />

            <Route path="email" element={<EmailHome />} />
            <Route path="email/settings" element={<EmailSettings />} />
            <Route path="email/replies" element={<Replies kind="email" />} />
            <Route path="email/new" element={<NewCampaign kind="email" />} />
            <Route path="email/campaigns/:id" element={<CampaignDetail kind="email" />} />

            <Route path="lists" element={<Lists />} />
            <Route path="lists/:id" element={<ListDetail />} />
            <Route path="usage" element={<Usage />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="account" element={<Account />} />

            <Route path="admin" element={<RequireAdmin><AdminOverview /></RequireAdmin>} />
            <Route path="admin/users" element={<RequireAdmin><AdminUsers /></RequireAdmin>} />
            <Route path="admin/users/:id" element={<RequireAdmin><AdminUserDetail /></RequireAdmin>} />
            <Route path="admin/plans" element={<RequireAdmin><AdminPlans /></RequireAdmin>} />
            <Route path="admin/audit" element={<RequireAdmin><AdminAudit /></RequireAdmin>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

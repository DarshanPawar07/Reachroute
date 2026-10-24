import { createContext, useContext, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => {
    const token = localStorage.getItem('token');
    return token ? { token, email: localStorage.getItem('email') || '' } : null;
  });

  const finish = (data) => {
    localStorage.setItem('token', data.token);
    localStorage.setItem('email', data.user.email);
    setSession({ token: data.token, email: data.user.email });
  };

  const login = async (email, password) =>
    finish(await api('/api/auth/login', { method: 'POST', body: { email, password } }));

  const register = async (email, password, acceptTerms = false) =>
    finish(await api('/api/auth/register', { method: 'POST', body: { email, password, acceptTerms } }));

  // After a password change or "sign out other devices" the server hands this device a fresh token.
  const replaceToken = (token) => {
    localStorage.setItem('token', token);
    setSession((s) => (s ? { ...s, token } : s));
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('email');
    setSession(null);
  };

  return <AuthContext.Provider value={{ session, login, register, logout, replaceToken }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

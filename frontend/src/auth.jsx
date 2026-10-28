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

  // With { defer: true } the person is not signed in yet: the page gets the answer and calls completeLogin() later
  // (used while they still have to type the code from the sign-up email).
  const login = async (email, password, { defer = false } = {}) => {
    const data = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    if (!defer) finish(data);
    return data;
  };

  const register = async (email, password, acceptTerms = false, { defer = false } = {}) => {
    const data = await api('/api/auth/register', { method: 'POST', body: { email, password, acceptTerms } });
    if (!defer) finish(data);
    return data;
  };

  /** Finish a sign-in that was deferred, or one that came back from Google / GitHub ({ token, email }). */
  const completeLogin = ({ token, email }) => {
    localStorage.setItem('token', token);
    localStorage.setItem('email', email);
    setSession({ token, email });
  };

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

  return <AuthContext.Provider value={{ session, login, register, completeLogin, logout, replaceToken }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

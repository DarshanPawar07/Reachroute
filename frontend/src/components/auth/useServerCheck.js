import { useEffect, useState } from 'react';
import { API_BASE, serverDown } from '../../api.js';

/**
 * Asks the server whether it is awake as soon as an account page opens, so a server that is down or still
 * starting is explained BEFORE the person types their details.
 * Returns { state: 'checking' | 'slow' | 'up' | 'down', message }.
 */
export default function useServerCheck() {
  const [info, setInfo] = useState({ state: 'checking', message: '' });
  useEffect(() => {
    let alive = true;
    const slow = setTimeout(() => alive && setInfo((i) => (i.state === 'checking' ? { state: 'slow', message: '' } : i)), 3000);
    const controller = new AbortController();
    const stop = setTimeout(() => controller.abort(), 70_000);
    fetch(`${API_BASE}/health`, { signal: controller.signal })
      .then((r) => {
        if (!alive) return;
        if (r.ok) setInfo({ state: 'up', message: '' });
        else setInfo({ state: 'down', message: serverDown('gateway', r.status).message });
      })
      .catch((err) => alive && setInfo({ state: 'down', message: serverDown(err.name === 'AbortError' ? 'timeout' : 'network').message }))
      .finally(() => {
        clearTimeout(slow);
        clearTimeout(stop);
      });
    return () => {
      alive = false;
      clearTimeout(slow);
      clearTimeout(stop);
      controller.abort();
    };
  }, []);
  return info;
}

import { useEffect, useState } from 'react';
import { api } from '../api.js';

/** The list of limits an administrator can set: [{ key, label }]. (Every account gets the same list from its plan page.) */
export function useLimitDefs() {
  const [defs, setDefs] = useState([]);
  useEffect(() => {
    api('/api/account/plan')
      .then((r) => setDefs(r.limits.map(({ key, label }) => ({ key, label }))))
      .catch(() => {});
  }, []);
  return defs;
}

/** Only the limits that hold a whole number of 1 or more, as numbers (what the server accepts). */
export function cleanLimits(values) {
  const out = {};
  for (const [key, raw] of Object.entries(values || {})) {
    if (raw === '' || raw === null || raw === undefined) continue;
    out[key] = Number(raw);
  }
  return out;
}

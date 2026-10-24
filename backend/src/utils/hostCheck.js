import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

/**
 * Users can enter any SMTP host. Without this check the server could be used to probe
 * internal services (SSRF). Rejects hosts that resolve to private / loopback addresses.
 *
 * Returns the public IP address that was checked (or null when private hosts are allowed for local testing).
 * Connect to THAT address, not to the host name again: otherwise a hostile DNS server could answer
 * with a public address now and an internal one a moment later ("DNS rebinding").
 */
export async function assertPublicHost(host) {
  if (config.allowPrivateSmtp) return null;
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw Object.assign(new Error(`Could not resolve SMTP host "${host}"`), { status: 400 });
  }
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) {
    throw Object.assign(new Error('SMTP host must be a public server'), { status: 400 });
  }
  return (addresses.find((a) => a.family === 4) || addresses[0]).address;
}

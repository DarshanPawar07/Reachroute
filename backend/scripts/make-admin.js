// Give someone the admin role, or take it away.
//   npm run make-admin -- someone@example.com
//   npm run make-admin -- someone@example.com --remove
// The person must already have an account. There is deliberately no way to do this through the website or the API.
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { setRole } from '../src/admin/accounts.js';
import { record } from '../src/audit/audit.js';

const email = process.argv.slice(2).find((a) => !a.startsWith('--'));
const remove = process.argv.includes('--remove');

if (!email) {
  console.error('Usage: npm run make-admin -- someone@example.com [--remove]');
  process.exit(1);
}

try {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15_000 });
  const user = await setRole(email, remove ? 'user' : 'admin');
  if (!user) throw new Error(`No account with the email ${email}. They need to register first.`);
  await record({ action: remove ? 'role.removed' : 'role.granted', targetId: user.id, targetEmail: user.email, detail: 'from the command line (npm run make-admin)' });
  console.log(remove ? `${user.email} is no longer an administrator.` : `${user.email} is now an administrator. They can open the admin area from their next request.`);
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}

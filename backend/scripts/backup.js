// Make a backup of the database:   npm run backup
// Options:  --dir=backups   --keep=7     (defaults come from BACKUP_DIR and BACKUP_KEEP)
// Run it from a scheduler (cron, Windows Task Scheduler, a GitHub Action) as often as you can afford to lose data.
import path from 'node:path';
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { createBackup, pruneBackups } from '../src/backup/backup.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = path.resolve(arg('dir') || config.backupDir);
const keep = Number(arg('keep') ?? config.backupKeep);

try {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15_000 });
  const started = Date.now();
  const { dir, manifest } = await createBackup({ root });
  const { removed } = await pruneBackups(root, { keep });
  const docs = manifest.collections.reduce((n, c) => n + c.documents, 0);
  const mb = manifest.collections.reduce((n, c) => n + c.bytes, 0) / 1024 / 1024;
  console.log(`Backup of "${manifest.database}" saved to ${dir}`);
  console.log(`${manifest.collections.length} collections, ${docs} documents, ${mb.toFixed(2)} MB, checked after writing (${((Date.now() - started) / 1000).toFixed(1)}s).`);
  if (removed.length) console.log(`Removed old: ${removed.join(', ')} (keeping the newest ${keep}).`);
  console.log('Keep a copy somewhere else too (another disk or cloud storage). The file holds encrypted WhatsApp logins and SMTP passwords, and hashed account passwords: store it like a secret.');
} catch (err) {
  console.error(`Backup failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}

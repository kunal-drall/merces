import { createPool, databaseUrl, migrate } from './index.ts';

const cmd = process.argv[2];
const pool = createPool(databaseUrl());
try {
  if (cmd === 'migrate') {
    const done = await migrate(pool);
    console.log(done.length ? `applied: ${done.join(', ')}` : 'up to date');
  } else if (cmd === 'reset') {
    await pool.query('drop schema public cascade; create schema public;');
    const done = await migrate(pool);
    console.log(`reset; applied ${done.length} migration(s)`);
  } else {
    console.error('usage: db <migrate|reset>');
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}

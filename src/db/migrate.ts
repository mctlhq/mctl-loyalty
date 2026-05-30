import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

// A constant key so concurrent replicas serialize on the same advisory lock.
const MIGRATION_LOCK_KEY = 776_011n;

const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/**
 * Apply schema.sql once on startup. Guarded by a Postgres advisory lock so that
 * when multiple replicas boot at the same time they run migrations serially,
 * not in parallel (avoids the cold-start migration race).
 */
export async function migrate(): Promise<void> {
  const sql = await readFile(SCHEMA_PATH, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(sql);
      // eslint-disable-next-line no-console
      console.log('[migrate] schema applied');
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

import pg from 'pg';
import { config } from '../config.js';

// pg returns BIGINT (int8) as string by default to avoid precision loss. Our
// balances/ids fit in JS safe integers, so parse them as numbers for ergonomics.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number.parseInt(v, 10)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl || undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] idle client error', err);
});

export type PoolClient = pg.PoolClient;

/**
 * Run `fn` inside a single BEGIN/COMMIT transaction. Rolls back on any throw.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

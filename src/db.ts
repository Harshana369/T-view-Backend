import pg from 'pg';
import { env } from './env.js';

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  // pg's default (10) is a guess; bound it explicitly so a scan sweep can't
  // silently balloon connections, and so idle ones get released.
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // A runaway query gives its connection back to the pool instead of
  // holding it forever.
  statement_timeout: 30_000,
});

// node-postgres requires an 'error' listener on the pool: an idle client
// that hits a network error (e.g. Postgres restarts) emits 'error' on the
// pool, and with no listener Node treats that as an uncaught exception and
// kills the whole process.
pool.on('error', (err) => {
  console.error('postgres pool error:', err.message);
});

/**
 * Candle store එක හදනවා. Safe to re-run.
 *
 * Table එකේ නම `perp_candles` — apps/server එකේ `candles` table එකට
 * (ඒකේ `market` column එකකුත් තියෙනවා, spot+futures දෙකම) ගැටෙන්නේ නැතුව
 * එකම `trading` database එකේම තියාගන්න පුළුවන් වෙන්න. apps2 කියන්නේ
 * USDT-M perps විතරයි, ඒ නිසා `market` column එකක් ඕන නෑ.
 */
export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS perp_candles (
      symbol   TEXT             NOT NULL,
      interval TEXT             NOT NULL,
      time     TIMESTAMPTZ      NOT NULL,
      open     DOUBLE PRECISION NOT NULL,
      high     DOUBLE PRECISION NOT NULL,
      low      DOUBLE PRECISION NOT NULL,
      close    DOUBLE PRECISION NOT NULL,
      volume   DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (symbol, interval, time)
    );
  `);

  // Coin එකේ price එකේ decimals ගාණ (BTC 2ක්, 1000SATS 8ක්). Binance දෙන
  // price *string* එකෙන් විතරයි මේක හරියටම ගන්න පුළුවන් (number එකකට
  // හැරෙව්වම trailing zeros නැති වෙනවා) — ඒ නිසා backfill වෙලාවේදීම අල්ලලා
  // මෙතන තියාගන්නවා, DB එකෙන් serve කරද්දීත් chart එකේ price scale එක හරි වෙන්න.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS perp_symbol_meta (
      symbol         TEXT PRIMARY KEY,
      price_decimals INT  NOT NULL
    );
  `);

  // TimescaleDB එකක් නම් hypertable එකක් — නැත්නම් සාමාන්‍ය table එකක්
  // විදිහටම වැඩ කරනවා (query ටික එකමයි, chunk pruning එක විතරයි නැති වෙන්නේ).
  try {
    await pool.query(
      `SELECT create_hypertable('perp_candles', 'time', if_not_exists => TRUE);`,
    );
  } catch (err) {
    console.warn(
      'timescaledb hypertable not created (plain table works too):',
      err instanceof Error ? err.message : err,
    );
  }
}

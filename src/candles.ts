import { fetchKlines } from './binance.js';
import { pool } from './db.js';
import { INTERVAL_MS, type Candle, type CandleSet, type Interval } from './types.js';

interface CandleRow {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * DB එකේ තියෙන අන්තිම `limit` candles, කාලය අනුව ascending.
 * `beforeMs` දුන්නොත්, ඒ මොහොතට **පරණ** ඒවා විතරයි.
 */
async function queryCandles(
  symbol: string,
  interval: Interval,
  limit: number,
  beforeMs?: number,
): Promise<Candle[]> {
  const { rows } = await pool.query<CandleRow>(
    `SELECT time, open, high, low, close, volume
     FROM perp_candles
     WHERE symbol = $1 AND interval = $2
       AND ($4::bigint IS NULL OR time < to_timestamp($4 / 1000.0))
     ORDER BY time DESC
     LIMIT $3`,
    [symbol, interval, limit, beforeMs ?? null],
  );
  return rows
    .map((r) => ({
      time: r.time.getTime() / 1000,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }))
    .reverse();
}

/** Backfill වෙලාවේ අල්ලගත්ත price decimals ගාණ DB එකේ තියාගන්නවා. */
async function savePriceDecimals(symbol: string, priceDecimals: number): Promise<void> {
  await pool.query(
    `INSERT INTO perp_symbol_meta (symbol, price_decimals) VALUES ($1, $2)
     ON CONFLICT (symbol) DO UPDATE SET price_decimals = EXCLUDED.price_decimals`,
    [symbol, priceDecimals],
  );
}

async function loadPriceDecimals(symbol: string): Promise<number | null> {
  const { rows } = await pool.query<{ price_decimals: number }>(
    `SELECT price_decimals FROM perp_symbol_meta WHERE symbol = $1`,
    [symbol],
  );
  return rows[0]?.price_decimals ?? null;
}

/** Candles ටිකක් DB එකට write කරනවා (එකම time එකක් ආපහු ආවොත් update). */
export async function upsertCandles(
  symbol: string,
  interval: Interval,
  candles: Candle[],
): Promise<void> {
  if (candles.length === 0) return;

  const values: unknown[] = [symbol, interval];
  const tuples = candles.map((c) => {
    const base = values.length;
    values.push(new Date(c.time * 1000), c.open, c.high, c.low, c.close, c.volume);
    return `($1, $2, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });

  await pool.query(
    `INSERT INTO perp_candles (symbol, interval, time, open, high, low, close, volume)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (symbol, interval, time) DO UPDATE SET
       open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
       close = EXCLUDED.close, volume = EXCLUDED.volume`,
    values,
  );
}

/**
 * Candles — DB එකෙන් මුලින්ම, ඕන නම් විතරක් Binance එකෙන් backfill කරලා.
 *
 * මේකෙන් තමයි Binance load එක කැපෙන්නේ: scanner එක coins 526කට cycle
 * එකකට වරක් අහද්දී, DB එකේ දැනටමත් අලුත්ම closed candle එක තියෙනවා නම්
 * Binance එකට යන්නෙම නෑ. අලුත් candle එකක් close වුණාට පස්සේ විතරයි
 * (එක coin එකකට interval එකකට වරක්) Binance එකට යන්නේ.
 *
 * `beforeMs` දුන්නොත් (scroll-back pagination) ඒ window එක DB එකේ නැත්නම්
 * ඒ තරමට backfill කරනවා.
 */
export async function getCandles(
  symbol: string,
  interval: Interval,
  limit: number,
  beforeMs?: number,
): Promise<CandleSet> {
  let candles = await queryCandles(symbol, interval, limit, beforeMs);
  let priceDecimals = await loadPriceDecimals(symbol);

  let needBackfill: boolean;
  if (beforeMs !== undefined) {
    // පරණ පැත්තට ඉල්ලනකොට: ඕන ගාණ නැත්නම් විතරයි ගේන්නේ.
    needBackfill = candles.length < limit;
  } else {
    // අලුත්ම window එකට: candle එකක් close වෙලා DB එකේ නැත්නම් ගේනවා.
    const intervalMs = INTERVAL_MS[interval];
    const newest = candles.length > 0 ? candles[candles.length - 1].time * 1000 : 0;
    needBackfill = candles.length < limit || Date.now() - newest > intervalMs;
  }
  // Decimals දන්නේ නැත්නම් ඒකටත් backfill එකක් ඕන (Binance strings වලින්
  // විතරයි ඒක අල්ලන්න පුළුවන්).
  if (priceDecimals === null) needBackfill = true;

  if (needBackfill) {
    // Binance's endTime is inclusive of the candle opening at that exact ms,
    // so subtract 1 to keep the "strictly older" contract.
    const fresh = await fetchKlines(
      symbol,
      interval,
      Math.min(limit, 1500),
      beforeMs !== undefined ? beforeMs - 1 : undefined,
    );
    if (fresh.candles.length > 0) {
      await upsertCandles(symbol, interval, fresh.candles);
      await savePriceDecimals(symbol, fresh.priceDecimals);
      priceDecimals = fresh.priceDecimals;
      candles = await queryCandles(symbol, interval, limit, beforeMs);
    }
  }

  return { candles, priceDecimals: priceDecimals ?? 2 };
}

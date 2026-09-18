import { cachedBinanceFetch } from './binance.js';
import { computeBbRsiTrail, type BbRsiTrailOptions } from './bbRsiTrail.js';
import { computeBreakoutTargets, type BreakoutOptions } from './breakoutTargets.js';
import { getCandles } from './candles.js';
import type { Interval } from './types.js';

/**
 * Coins 500+ පුරාම Breakout Targets rule එක දුවවලා, Entry එකක් තියෙන
 * ඒවා විතරක් දෙනවා.
 *
 * Candles එන්නේ Postgres එකෙන් (candles.ts) — DB එකේ අලුත්ම closed candle
 * එක තියෙනවා නම් Binance එකට request එකක්වත් යන්නේ නෑ. ඒ නිසා මේ sweep
 * එක නිතර දුවවන්න පුළුවන්; Binance එකට යන්නේ candle එකක් close වුණාම
 * විතරයි (coin එකකට interval එකකට වරක්).
 *
 * Browser එකට යවන්නේ hits ටික විතරයි — client එකේම scan කළොත් coins
 * 526ක candles browser එකට download කරන්න වෙනවා (~45MB), මෙතන ඒක
 * DB එකයි server එකයි අතරේ විතරයි.
 */

/** Box formation එකේ පදනම හොයන්න ඕන bars ගාණ (කෙටි window එකකට හසුවෙන්නේ නෑ). */
const CANDLES = 900;
/** Backtest scans වලට — trades කිහිපයක්වත් ලැබෙන්න bars ගොඩක් ඕන. */
const BACKTEST_CANDLES = 3000;
/** එකවර ගණන් හදන symbols ගාණ — DB reads විතරයි, ඒත් pool එක බර වැඩි කරන්නේ නෑ. */
const CONCURRENCY = 12;

/** exchangeInfo කලාතුරකින් වෙනස් වෙන එකක් — විනාඩි 5ක් cache. */
const SYMBOLS_TTL_S = 5 * 60;

interface RawSymbol {
  symbol: string;
  contractType: string;
  status: string;
  quoteAsset: string;
}

/** Trading state එකේ තියෙන USDT perpetual symbols ටික. */
export async function fetchScanSymbols(): Promise<string[]> {
  const info = await cachedBinanceFetch<{ symbols: RawSymbol[] }>(
    'https://fapi.binance.com/fapi/v1/exchangeInfo',
    'scan-symbols',
    SYMBOLS_TTL_S,
  );
  return info.symbols
    .filter(
      (s) =>
        s.contractType === 'PERPETUAL' &&
        s.status === 'TRADING' &&
        s.quoteAsset === 'USDT',
    )
    .map((s) => s.symbol);
}

export interface BreakoutHit {
  symbol: string;
  dir: 'buy' | 'sell';
  /** Trade එකේ identity එක — එකම entry එකට දෙපාරක් notify නොවෙන්න. */
  key: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  /** Entry candle එකේ වෙලාව (unix seconds). */
  time: number;
  /** Entry එක හැදිලා candles කීයක් වහලාද — 0 කියන්නේ දැන් වහපු එක. */
  barsAgo: number;
}

export interface BreakoutScanResult {
  interval: Interval;
  scanned: number;
  hits: BreakoutHit[];
  /** Scan එක ගත්ත වෙලාව (ms) — UI එකේ පෙන්නන්න. */
  tookMs: number;
}

export async function scanBreakouts(
  interval: Interval,
  options: Omit<BreakoutOptions, 'showTargets'>,
  /**
   * Entry එකක් හැදිලා මීට වඩා candles ගානක් වහලා නම් ඒක "අලුත් entry"
   * එකක් නෙවෙයි — rule එක history එකේ තියෙන අන්තිම trade එක හැම වෙලාවෙම
   * දෙන නිසා (chart එකේ පේන ඒකම), මේකෙන් තමයි "දැන් open වුණු ඒවා" විතරක්
   * වෙන් කරගන්නේ.
   */
  maxBarsAgo: number,
): Promise<BreakoutScanResult> {
  const startedAt = Date.now();
  const symbols = await fetchScanSymbols();
  const hits: BreakoutHit[] = [];

  let index = 0;
  let scanned = 0;

  async function worker(): Promise<void> {
    while (index < symbols.length) {
      const symbol = symbols[index++];
      try {
        const { candles } = await getCandles(symbol, interval, CANDLES);
        const r = computeBreakoutTargets(candles, { ...options, showTargets: true });
        if (r.trade) {
          const t = r.trade;
          const barsAgo = candles.length - 1 - t.startIndex;
          if (barsAgo <= maxBarsAgo) {
            hits.push({
              symbol,
              dir: t.dir === 1 ? 'buy' : 'sell',
              key: `${t.startIndex}-${t.dir}`,
              entry: t.entry,
              sl: t.sl,
              tp1: t.tp1,
              tp2: t.tp2,
              tp3: t.tp3,
              time: candles[t.startIndex]?.time ?? 0,
              barsAgo,
            });
          }
        }
      } catch {
        // එක coin එකක් fail වුණාට (delisted, backfill fail) scan එක නවත්තන්නේ නෑ.
      } finally {
        scanned++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  hits.sort((a, b) => a.barsAgo - b.barsAgo || b.time - a.time); // අලුත්ම එක උඩම
  return { interval, scanned, hits, tookMs: Date.now() - startedAt };
}

// ------------------------------------------------- Bollinger + RSI win rate

/** Coin එකක win rate එක. */
export interface WinRateHit {
  symbol: string;
  /** TP/trail එකෙන් ලාභයක් ලැබුණු trades ප්‍රතිශතය. */
  winRate: number;
  trades: number;
  /** ලාභ එකතුව ÷ පාඩු එකතුව. */
  profitFactor: number;
  /** Trade එකකට සාමාන්‍යය, R වලින් (fees + slippage ඇතුළත්ව). */
  expectancy: number;
}

export interface WinRateScanResult {
  interval: Interval;
  /** පෙරහන පැනපු coins — winRate අනුව, වැඩිම එක මුලට. */
  hits: WinRateHit[];
  scanned: number;
  minWinRate: number;
  minTrades: number;
  tookMs: number;
}

/**
 * Coins ඔක්කොම Bollinger + RSI break-even/trail backtest එකෙන් දුවවලා,
 * win rate එක `minWinRate` පනින ඒවා දෙනවා.
 *
 * ⚠️ Win rate එක **exit රීති වලින්** තීරණය වෙනවා — trail එක තද නම් ඒක
 *    ලොකුයි, ඒත් දිනුම් පොඩියි. ඒ නිසා profit factor එකයි expectancy
 *    එකයි දෙකත් එක්කම දෙනවා; win rate එක විතරක් බලලා තීරණයක් ගන්න එපා.
 */
export async function scanWinRate(
  interval: Interval,
  options: Omit<BbRsiTrailOptions, 'signal'> & { signal: BbRsiTrailOptions['signal'] },
  minWinRate: number,
  minTrades: number,
): Promise<WinRateScanResult> {
  const started = Date.now();
  const symbols = await fetchScanSymbols();
  const hits: WinRateHit[] = [];
  // ⚠️ Breakout scan එකේ 900 මෙතනට මදි — bbLength 200 ක warmup එකට
  //    පස්සේ trades කිහිපයක්වත් නෑ. Backtest එකකට bars ගොඩක් ඕන.
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= symbols.length) return;
      const symbol = symbols[index];
      try {
        const { candles } = await getCandles(symbol, interval, BACKTEST_CANDLES);
        if (candles.length < 600) continue;
        const r = computeBbRsiTrail(candles, options);
        const st = r.stats;
        if (st.trades < minTrades) continue;
        if (st.winRate < minWinRate) continue;
        hits.push({
          symbol,
          winRate: st.winRate,
          trades: st.trades,
          profitFactor: Number.isFinite(st.profitFactor) ? st.profitFactor : 999,
          expectancy: st.expectancy,
        });
      } catch {
        // Coin එකක් අසාර්ථක වුණාට sweep එක නවත්තන්නේ නෑ.
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  hits.sort((a, b) => b.winRate - a.winRate);

  return {
    interval,
    hits,
    scanned: symbols.length,
    minWinRate,
    minTrades,
    tookMs: Date.now() - started,
  };
}

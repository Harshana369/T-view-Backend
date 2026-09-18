/**
 * ⚠️ මේක web/src/lib/bbRsi.ts එකේ **පිටපතක්**. දෙකම එකම විදිහට
 *    තියාගන්න ඕන — chart එකේ පේන දෙයයි scanner එකේ ප්‍රතිඵලයයි
 *    වෙනස් වුණොත් වැඩක් නෑ. (breakoutTargets.ts එකේත් එකම විදිහ.)
 */
import { rsiArray, smaArray } from './indicators.js';
import type { Candle } from './types.js';

/**
 * "Bollinger + RSI, Double Strategy v1.1" (© ChartArt, 2016) එකේ port එක.
 *
 * Price එක Bollinger band එකක් පනිනකොට **සහ** RSI එකත් 50 පනිනකොට
 * විතරයි signal එකක්:
 *
 *   LONG  = crossover(rsi, 50)  සහ  crossover(close, BBlower)
 *   SHORT = crossunder(rsi, 50) සහ  crossunder(close, BBupper)
 *
 * ⚠️ මුල් එක **strategy** එකක් — `strategy.entry(..., stop=BBlower)`
 *    කියලා pending stop order එකක් තියලා, කොන්දේසිය නැති හැම bar එකකම
 *    ඒක cancel කරනවා (ඒ නිසා order එක bar එකක් විතරයි ජීවත් වෙන්නේ).
 *    මේ app එක orders දුවවන්නේ නෑ, ඒ නිසා මෙතන තියෙන්නේ **signals සහ
 *    visuals** — fills, equity නෑ.
 */

export interface BbRsiOptions {
  /** Pine `RSIlength`. */
  rsiLength: number;
  /** Pine `BBlength`. */
  bbLength: number;
  /** Pine `BBmult` — මුල් එකේ ඒක ස්ථිර 2ක් (input එකක් නෙවෙයි). */
  bbMult: number;
}

export interface BbRsiSignal {
  index: number;
  dir: 1 | -1;
  /** Pine `stop=` අගය — long එකට BBlower, short එකට BBupper. */
  stop: number;
}

export interface BbRsiResult {
  basis: number[];
  upper: number[];
  lower: number[];
  rsi: number[];
  signals: BbRsiSignal[];
  /** Pine `TrendColor` — 'red' / 'green' / null. */
  trendColor: ('red' | 'green' | null)[];
}

/** Pine `stdev` — biased (population). */
function stdevArray(values: number[], length: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  const mean = smaArray(values, length);
  for (let i = length - 1; i < n; i++) {
    if (Number.isNaN(mean[i])) continue;
    let sum = 0;
    for (let k = i - length + 1; k <= i; k++) {
      const d = values[k] - mean[i];
      sum += d * d;
    }
    out[i] = Math.sqrt(sum / length);
  }
  return out;
}

/** Pine `crossover(a, b)` — `a > b` දැන්, `a[1] <= b[1]` කලින්. */
function crossover(a: number[], b: number[], i: number): boolean {
  if (i === 0) return false;
  if (Number.isNaN(a[i]) || Number.isNaN(b[i]) || Number.isNaN(a[i - 1]) || Number.isNaN(b[i - 1])) {
    return false;
  }
  return a[i] > b[i] && a[i - 1] <= b[i - 1];
}

function crossunder(a: number[], b: number[], i: number): boolean {
  if (i === 0) return false;
  if (Number.isNaN(a[i]) || Number.isNaN(b[i]) || Number.isNaN(a[i - 1]) || Number.isNaN(b[i - 1])) {
    return false;
  }
  return a[i] < b[i] && a[i - 1] >= b[i - 1];
}

export function computeBbRsi(candles: Candle[], o: BbRsiOptions): BbRsiResult {
  const n = candles.length;
  const price = candles.map((c) => c.close);

  const basis = smaArray(price, o.bbLength);
  const dev = stdevArray(price, o.bbLength).map((v) => o.bbMult * v);
  const upper = basis.map((v, i) => v + dev[i]);
  const lower = basis.map((v, i) => v - dev[i]);
  const rsi = rsiArray(price, o.rsiLength);

  // Pine `RSIoverSold = 50`, `RSIoverBought = 50` — දෙකම 50.
  const level = new Array<number>(n).fill(50);

  const signals: BbRsiSignal[] = [];
  const trendColor = new Array<'red' | 'green' | null>(n).fill(null);

  for (let i = 0; i < n; i++) {
    // ── TrendColor ────────────────────────────────────────────────────
    // ⚠️ මුල් එකේ `RSIoverBought and (...)` කියලා තියෙන්නේ. `RSIoverBought`
    //    කියන්නේ **අංකය 50** — Pine එකේ බිංදුව නොවන අංකයක් boolean
    //    context එකකදී `true`. ඒ නිසා **RSI එක මෙතන කිසිම බලපෑමක් නෑ**.
    //    ඒක මුල් script එකේ තියෙන දෙයක්, ඒ නිසා එහෙම්මම තියාගෙන තියෙනවා.
    //
    // ⚠️ තව එකක්: `price[1] > BBupper and price < BBupper` — දෙකේම
    //    සැසඳෙන්නේ **දැන් තියෙන** band එකට (BBupper[1] එකට නෙවෙයි).
    //    ඒක `crossunder()` එකට වඩා ටිකක් වෙනස්.
    if (i > 0 && !Number.isNaN(upper[i]) && !Number.isNaN(basis[i]) && !Number.isNaN(basis[i - 1])) {
      if (price[i - 1] > upper[i] && price[i] < upper[i] && basis[i] < basis[i - 1]) {
        trendColor[i] = 'red';
      } else if (
        !Number.isNaN(lower[i]) &&
        price[i - 1] < lower[i] &&
        price[i] > lower[i] &&
        basis[i] > basis[i - 1]
      ) {
        trendColor[i] = 'green';
      }
    }

    // ── Strategy ──────────────────────────────────────────────────────
    // `if (not na(vrsi))` — RSI එක හැදෙනකම් කිසිවක් නෑ.
    if (Number.isNaN(rsi[i])) continue;

    if (crossover(rsi, level, i) && crossover(price, lower, i)) {
      signals.push({ index: i, dir: 1, stop: lower[i] });
    }
    if (crossunder(rsi, level, i) && crossunder(price, upper, i)) {
      signals.push({ index: i, dir: -1, stop: upper[i] });
    }
  }

  return { basis, upper, lower, rsi, signals, trendColor };
}

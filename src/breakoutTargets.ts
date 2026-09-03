import { atrArray, emaArray, wmaArray } from './indicators.js';
import type { Candle } from './types.js';

/**
 * IMPORTANT: apps2/web/src/lib/breakoutTargets.ts එකේම copy එකක් — දෙකම
 * එකවගේ තියාගන්න ඕන, නැත්නම් server scan එකෙන් එන alert එකයි chart එකේ
 * පේන box/entry එකයි දෙකට දෙක වෙනවා.
 *
 * "Breakout Targets [AlgoAlpha]" (© AlgoAlpha, MPL-2.0) එකේ ගණන් හදන කොටස.
 *
 * අදහස: |close − open| එකේ WMA එකයි EMA එකයි cross වුණාම (= bars වල ලොකුකම
 * අඩු වෙලා, market එක එකතැන පල් වෙනවා), අන්තිම pivot එකේ ඉඳන් දැන් වෙනකම්
 * range එකක් (box එකක්) අඳිනවා. Price එක ඒ box එකෙන් පිට වහපුවම breakout —
 * එතනදී ATR එකෙන් SL එකකුත්, risk එකේ ගුණාකාර විදිහට TP 3කුත් ගණන් හදනවා.
 */

export interface BreakoutOptions {
  /** Range detection period (WMA/EMA + pivot lookback). */
  length: number;
  /** true නම් දැන් තියෙන range එක ඉවර වෙනකම් අලුත් box එකක් අඳින්නේ නෑ. */
  preventOverlap: boolean;
  showTargets: boolean;
  atrPeriod: number;
  slMultiplier: number;
  tp1Multiplier: number;
  tp2Multiplier: number;
  tp3Multiplier: number;
}

export interface RangeBox {
  startIndex: number;
  /** Breakout එකකින් ඉවර වුණාම මේක එතනම නතර වෙනවා. */
  endIndex: number;
  top: number;
  bottom: number;
  /** ඇතුළේ අඳින supply/demand තීරු වල ඝනකම (atr(len)/2). */
  vola: number;
}

export interface BreakoutSignal {
  index: number;
  /** Marker එක අඳින price එක — bullish නම් box එකේ පතුල, bearish නම් උඩ. */
  price: number;
  dir: 1 | -1;
}

export interface TradeLevels {
  startIndex: number;
  /** TP3 වදිනකම් (නැත්නම් අන්තිම bar එක වෙනකම්) දිගු වෙනවා. */
  endIndex: number;
  dir: 1 | -1;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
}

export interface BreakoutResult {
  boxes: RangeBox[];
  signals: BreakoutSignal[];
  /** අන්තිම breakout එකේ trade එක විතරයි පෙන්නන්නේ (Pine එකේ වගේම). */
  trade: TradeLevels | null;
}

/**
 * Pine `ta.pivothigh(left, right)` — bar එකක high එක දෙපැත්තේම bars
 * `left`/`right` ගණනට වඩා උසයි නම් ඒක pivot එකක්. (Confirm වෙන්නේ
 * `right` bars ගාණකට පස්සේ.)
 */
function isPivotHigh(candles: Candle[], index: number, left: number, right: number): boolean {
  if (index - left < 0 || index + right >= candles.length) return false;
  const value = candles[index].high;
  for (let i = index - left; i <= index + right; i++) {
    if (i !== index && candles[i].high >= value) return false;
  }
  return true;
}

function isPivotLow(candles: Candle[], index: number, left: number, right: number): boolean {
  if (index - left < 0 || index + right >= candles.length) return false;
  const value = candles[index].low;
  for (let i = index - left; i <= index + right; i++) {
    if (i !== index && candles[i].low <= value) return false;
  }
  return true;
}

export function computeBreakoutTargets(
  candles: Candle[],
  o: BreakoutOptions,
): BreakoutResult {
  const n = candles.length;
  const boxes: RangeBox[] = [];
  const signals: BreakoutSignal[] = [];
  let trade: TradeLevels | null = null;
  if (n === 0) return { boxes, signals, trade };

  const len = Math.max(2, Math.floor(o.length));
  const half = Math.floor(len / 2);

  // Bar එකේ body එකේ ලොකුකම — ඒකේ WMA/EMA cross එකෙන් "එකතැන පල් වීම" හොයනවා.
  const body = candles.map((c) => Math.abs(c.close - c.open));
  const v1 = wmaArray(body, len);
  const v2 = emaArray(body, len);
  const volaSeries = atrArray(candles, len); // box එකේ තීරු වලට
  const atrTargets = atrArray(candles, Math.max(1, Math.floor(o.atrPeriod))); // SL එකට

  // දැනට active (දිගු වෙමින් තියෙන) boxes — අලුත්ම එක මුලින්.
  const active: RangeBox[] = [];
  let lastPivotHigh: { value: number; index: number } | null = null;
  let lastPivotLow: { value: number; index: number } | null = null;
  // අන්තිම box එකේ දකුණු කෙළවර (overlap වළක්වන්න).
  let lastRight = 0;
  let tp3Hit = false;

  for (let i = 0; i < n; i++) {
    // මේ bar එකේදී confirm වෙන pivot එකක් තියෙනවද? (half bars කලින් එක)
    const candidate = i - half;
    if (candidate >= 0) {
      if (isPivotHigh(candles, candidate, half, half)) {
        lastPivotHigh = { value: candles[candidate].high, index: candidate };
      }
      if (isPivotLow(candles, candidate, half, half)) {
        lastPivotLow = { value: candles[candidate].low, index: candidate };
      }
    }

    if (active.length > 0) lastRight = active[0].endIndex;

    // ── අලුත් range box එකක් ─────────────────────────────────────────
    const crossunder = i > 0 && v1[i] < v2[i] && v1[i - 1] >= v2[i - 1];
    if (crossunder && lastPivotHigh && lastPivotLow) {
      let top = NaN;
      let bottom = NaN;
      let startIndex = -1;

      if (lastPivotHigh.index > lastPivotLow.index) {
        // Pivot high එක ළඟයි — ඒකේ ඉඳන් මෙතනට තියෙන පහළම low එක පතුල.
        top = lastPivotHigh.value;
        startIndex = lastPivotHigh.index;
        const dist = i - startIndex;
        if (dist > 0) {
          let min = candles[i].high;
          for (let k = 0; k < dist; k++) min = Math.min(min, candles[i - k].low);
          bottom = min;
        }
      } else {
        // Pivot low එක ළඟයි — ඒකේ ඉඳන් තියෙන උසම high එක උඩ.
        bottom = lastPivotLow.value;
        startIndex = lastPivotLow.index;
        const dist = i - startIndex;
        if (dist > 0) {
          let max = candles[i].low;
          for (let k = 0; k < dist; k++) max = Math.max(max, candles[i - k].high);
          top = max;
        }
      }

      const close = candles[i].close;
      const noOverlap = !o.preventOverlap || startIndex > lastRight;
      if (!Number.isNaN(top) && !Number.isNaN(bottom) && close <= top && close >= bottom && noOverlap) {
        const box: RangeBox = {
          startIndex,
          endIndex: i,
          top,
          bottom,
          vola: Number.isNaN(volaSeries[i]) ? 0 : volaSeries[i] / 2,
        };
        boxes.unshift(box);
        active.unshift(box);
      }
    }

    // ── තියෙන boxes බලනවා: කැඩුනද, නැත්නම් දිගු කරනවද ─────────────────
    const c = candles[i];
    let newBreakout = false;
    for (let k = active.length - 1; k >= 0; k--) {
      const b = active[k];
      if (c.close > b.top) {
        signals.push({ index: i, price: b.bottom, dir: 1 });
        active.splice(k, 1); // box එක තව දිගු වෙන්නේ නෑ (ඒත් අඳිනවා)
        if (o.showTargets) {
          const sl = c.low - atrTargets[i] * o.slMultiplier;
          const risk = Math.abs(c.close - sl);
          trade = {
            startIndex: i,
            endIndex: i,
            dir: 1,
            entry: c.close,
            sl,
            tp1: c.close + risk * o.tp1Multiplier,
            tp2: c.close + risk * o.tp2Multiplier,
            tp3: c.close + risk * o.tp3Multiplier,
          };
          tp3Hit = false;
          newBreakout = true;
        }
      } else if (c.close < b.bottom) {
        signals.push({ index: i, price: b.top, dir: -1 });
        active.splice(k, 1);
        if (o.showTargets) {
          const sl = c.high + atrTargets[i] * o.slMultiplier;
          const risk = Math.abs(c.close - sl);
          trade = {
            startIndex: i,
            endIndex: i,
            dir: -1,
            entry: c.close,
            sl,
            tp1: c.close - risk * o.tp1Multiplier,
            tp2: c.close - risk * o.tp2Multiplier,
            tp3: c.close - risk * o.tp3Multiplier,
          };
          tp3Hit = false;
          newBreakout = true;
        }
      } else {
        b.endIndex = i;
      }
    }

    // ── Trade lines දිගු කරනවා, TP3 වැදුනාද බලනවා ─────────────────────
    if (!newBreakout && !tp3Hit && trade) {
      trade.endIndex = i;
      if ((trade.dir === 1 && c.high >= trade.tp3) || (trade.dir === -1 && c.low <= trade.tp3)) {
        tp3Hit = true;
      }
    }
  }

  return { boxes, signals, trade };
}

import type { Candle } from './types.js';

/**
 * Breakout Targets rule එකට ඕන ගණන් හදන function ටික විතරයි මෙතන.
 *
 * IMPORTANT: apps2/web/src/lib/indicators.ts + movingAverages.ts එකේ තියෙන
 * ඒවගේම copy එකක් — දෙකම එකවගේ තියාගන්න ඕන, නැත්නම් server scan එකයි
 * chart එකේ පේන එකයි දෙකට දෙක වෙනවා. (apps/server එකේ backtest.ts එකේත්
 * මේ pattern එකම — pure rule එකක් දෙපැත්තේම mirror කරලා තියෙනවා.)
 *
 * හැම එකක්ම input array එකේ දිගටම සමාන දිගක් return කරනවා — ගණන් හදන්න
 * data මදි තැන් වලට NaN.
 */

/** Exponential Moving Average — මුල seed එකට SMA එක ගන්නවා. */
export function emaArray(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** Weighted MA — අලුත්ම bar එකට වැඩිම බර. */
export function wmaArray(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let k = 0; k < period; k++) sum += values[i - k] * (period - k);
    out[i] = sum / denom;
  }
  return out;
}

/** Wilder's RMA (ATR සහ RSI වලට ගන්න smoothing එක). */
export function rmaArray(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + values[i]) / period;
  }
  return out;
}

/** True Range — දැන් bar එකේ range එක, gap එකත් සමඟ. */
function trueRange(cur: Candle, prev: Candle): number {
  return Math.max(
    cur.high - cur.low,
    Math.abs(cur.high - prev.close),
    Math.abs(cur.low - prev.close),
  );
}

/** Average True Range — volatility එක මනින්න. */
export function atrArray(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  const tr = new Array<number>(candles.length - 1);
  for (let i = 1; i < candles.length; i++) tr[i - 1] = trueRange(candles[i], candles[i - 1]);
  const smoothed = rmaArray(tr, period);
  for (let i = 0; i < smoothed.length; i++) out[i + 1] = smoothed[i];
  return out;
}

/**
 * Simple Moving Average — හරි හරියට period එකක සාමාන්‍යය.
 *
 * ⚠️ NaN තියෙන array එකකටත් හරියට වැඩ කරන්න ඕන (උදා: MACD එකේ signal
 *    line එක — `sma(macd, 9)` එකේ macd එකේ මුල NaN). Running sum එකකට
 *    NaN එකක් ඇතුළු වුණොත් ඒක සදහටම NaN (NaN − NaN = NaN), ඒ නිසා
 *    window එකේ NaN කීයක් තියෙනවද කියලා වෙනම ගණන් කරනවා. Window එකේ
 *    NaN එකක් තියෙනකම් NaN, ඒවා පිට වුණාම අගය එනවා — Pine `sma()` වගේම.
 */
export function smaArray(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  let nans = 0;
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) nans++;
    else sum += values[i];
    if (i >= period) {
      const old = values[i - period];
      if (Number.isNaN(old)) nans--;
      else sum -= old;
    }
    if (i >= period - 1 && nans === 0) out[i] = sum / period;
  }
  return out;
}

/** Wilder's RMA (RSI/ATR වලට ගන්න smoothing එක; SMMA එකත් මේකමයි). */
/** Relative Strength Index — Wilder smoothing එකෙන් 0–100 අතර අගයක්. */
export function rsiArray(closes: number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  // පළමුව හැම bar එකකම ලාභය/පාඩුව වෙන වෙනම array දෙකකට දානවා.
  const gains = new Array<number>(closes.length).fill(0);
  const losses = new Array<number>(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains[i] = Math.max(change, 0);
    losses[i] = Math.max(-change, 0);
  }
  // index 0 එකේ change එකක් නැති නිසා ඒක අයින් කරලා smooth කරනවා.
  const avgGain = rmaArray(gains.slice(1), period);
  const avgLoss = rmaArray(losses.slice(1), period);
  for (let i = 0; i < avgGain.length; i++) {
    if (Number.isNaN(avgGain[i])) continue;
    const rs = avgLoss[i] === 0 ? Infinity : avgGain[i] / avgLoss[i];
    out[i + 1] = avgLoss[i] === 0 ? 100 : 100 - 100 / (1 + rs);
  }
  return out;
}

/**
 * ⚠️ මේක web/src/lib/bbRsiTrail.ts එකේ **පිටපතක්**. දෙකම එකම විදිහට
 *    තියාගන්න ඕන — chart එකේ පේන දෙයයි scanner එකේ ප්‍රතිඵලයයි
 *    වෙනස් වුණොත් වැඩක් නෑ. (breakoutTargets.ts එකේත් එකම විදිහ.)
 */
import { computeBbRsi, type BbRsiOptions } from './bbRsi.js';
import { atrArray } from './indicators.js';
import type { Candle } from './types.js';

/**
 * Bollinger + RSI signals එකට **අදියර දෙකක exit** එකක්.
 *
 * Trade එකක ජීවිතය:
 *
 *   1. **මුල් SL** — entry එකෙන් ATR කිහිපයක් ඈතින්.
 *   2. **Break-even** — ලාභය `breakEvenAtR` ක් වුණාම SL එක **entry එකට**
 *      ගෙනෙනවා. ඊට පස්සේ SL එක වැදුනත් **පාඩුවක් නෑ**.
 *   3. **Trail** — ලාභය `trailAfterR` ක් වුණාම, SL එක හොඳම මිලෙන්
 *      `trailAtr × ATR` ක් පිටිපස්සෙන් ඇදෙනවා. Short එකකදී ඒක entry
 *      එකට **පහළින්** යනවා (= අගුළු දාපු ලාභයක්), long එකකදී උඩින්.
 *
 * SL එක **කිසිදාක පිටිපස්සට යන්නේ නෑ** — ලාභය දිහාවට විතරයි.
 *
 * ⚠️ Bar එකක් ඇතුළේ SL එකයි TP එකයි දෙකම වැදුනොත් **SL එක කලින්** කියලා
 *    ගන්නවා. Candle එකකින් ඇත්ත පිළිවෙළ දැනගන්න බෑ, ඒ නිසා ප්‍රතිඵල
 *    අලංකාර කරනවාට වඩා පරිස්සම් වීම හොඳයි.
 */

export type BbExitReason =
  | 'stop'       // මුල් SL එක — පාඩුවක්
  | 'breakeven'  // BE එකට ගෙනාපු SL එක — පාඩුවක් නෑ
  | 'trail'      // trail වෙච්ච SL එක — ලාභයක්
  | 'band'       // අනිත් පැත්තේ BB line එක — ඉලක්කයට ආවා
  | 'target'
  | 'opposite'
  | 'open';

export interface BbRsiTrailOptions {
  signal: BbRsiOptions;
  direction: 'both' | 'long' | 'short';
  atrLength: number;
  /** මුල් SL එක entry එකෙන් කොච්චර ඈතද (×ATR). */
  initialSlAtr: number;
  /** ලාභය මෙච්චර R එකක් වුණාම SL එක entry එකට. 0 = break-even නෑ. */
  breakEvenAtR: number;
  /** BE එකේදී entry එකට වඩා ටිකක් ලාභ පැත්තට (fees ආවරණය කරන්න). */
  breakEvenBufferR: number;
  /** ලාභය මෙච්චර R එකක් වුණාම trail පටන් ගන්නවා. */
  trailAfterR: number;
  /**
   * Trail කරන ක්‍රමය.
   *
   *   `ratio` — ලාභයෙන් ස්ථිර කොටසක් අගුළු දානවා. 1:2 කියන්නේ
   *             `trailRatio = 0.5`: price එක +2R ට ගියොත් SL එක +1R ට,
   *             +4R ට ගියොත් +2R ට. Break-even එකත් ඉබේම ඇතුළත් —
   *             ලාභය 0ට වඩා වැඩි වුණු ගමන් SL එක entry එකට එහා යනවා.
   *   `atr`   — හොඳම මිලෙන් `trailAtr × ATR` ක් පිටිපස්සෙන්.
   */
  trailMode: 'ratio' | 'atr';
  /** `ratio` mode එකට — අගුළු දාන කොටස. 0.5 = 1:2 අනුපාතය. */
  trailRatio: number;
  /** `atr` mode එකට — trail දුර (×ATR). 0 = trail නෑ. */
  trailAtr: number;
  /**
   * Trail පටන් ගත්තාට පස්සේ **අවම වශයෙන්** අගුළු දාන ලාභය (R).
   *
   * මේක නැත්නම් SL එක entry එක ළඟින්ම නතර වෙනවා: ratio 0.5 එකේදී
   * හොඳම ලාභය +0.12R නම් අගුළු වෙන්නේ +0.06R ක් විතරයි — ඒකෙන් වැඩක් නෑ.
   * `minLockR = 0.5` දැම්මොත් trail පටන් ගත්ත ගමන් SL එක අඩුම තරමේ
   * +0.5R කට යනවා, ඒ නිසා trade එක හැරුණත් **සැලකිය යුතු ලාභයක්**
   * ලැබෙනවා.
   *
   * ⚠️ ලබාගත්තු ලාභයට වඩා අගුළු දාන්න බෑ — ඒ නිසා `min(minLockR, best)`.
   */
  minLockR: number;
  /**
   * SL එක **trail වෙන්න පටන් අරගෙන** තියෙද්දී මිල අනිත් පැත්තේ
   * Bollinger line එකට ආවොත් එතනින්ම trade එක වහනවා.
   *
   *   SHORT  →  BB **lower** line එක (මිල බහිනවා = අපේ ලාභය)
   *   LONG   →  BB **upper** line එක (මිල නඟිනවා = අපේ ලාභය)
   *
   * හේතුව: මේක mean-reversion strategy එකක්. Band එකට ආවම චලනය
   * ඉවරයි — එතනින් එහාට trail එකට බලාගෙන ඉන්නවා කියන්නේ ලාභය ආපහු
   * දෙන එක. `startedTrailing` කොන්දේසිය නිසා ලාභයක් අගුළු වෙලා
   * නැත්නම් මේක ක්‍රියාත්මක වෙන්නේ නෑ.
   */
  exitOnBand: boolean;
  /** ස්ථිර take profit (R). 0 = නෑ. */
  takeProfitR: number;
  exitOnOpposite: boolean;
  feePct: number;
  /**
   * පැත්තකට slippage (%) — order එක හිතපු මිලට නොවැදී ඊට නරක මිලකට
   * වැදෙන එක.
   *
   * ⚠️ Trail එක තද වෙන තරමට මේක තීරණාත්මකයි. Ratio trail එකේ සාමාන්‍ය
   *    දිනුම price එකෙන් 0.23% ක් විතරයි — slippage 0.10% ක් වුණොත්
   *    edge එක බිංදුවට යනවා. Stop orders වලට alt perps වල 0.02–0.05%
   *    සාමාන්‍යයි, volatile වෙලාවට ඊට වඩා නරකයි.
   */
  slippagePct: number;
  maxRiskPct: number;
}

export const BB_TRAIL_DEFAULTS: Omit<BbRsiTrailOptions, 'signal'> = {
  direction: 'both',
  atrLength: 14,
  initialSlAtr: 2,
  // Ratio trail එකේදී break-even එක ඉබේම එනවා (ලාභය 0ට වඩා වැඩි
  // වුණාම SL එක entry එකට එහා), ඒ නිසා වෙනම BE පියවරක් ඕන නෑ.
  breakEvenAtR: 0,
  breakEvenBufferR: 0.1,
  // coins 78ක්, 15m, trades 27,000+ මැනලා තෝරගත්ත අගයන්:
  //   after 0.5 + lock 0.5 + ratio 0.7  →  avg lock 0.505R,
  //   +1R ට ගිහින් හැරුණු trades වල සාමාන්‍ය ප්‍රතිඵලය +0.90R.
  // (කලින් තිබුණු after 0 + lock 0 එකේ avg lock 0.007R — නිකරුණේ.)
  trailAfterR: 0.5,
  trailMode: 'ratio',
  trailRatio: 0.7,
  trailAtr: 2,
  minLockR: 0.5,
  exitOnBand: true,
  takeProfitR: 0,
  exitOnOpposite: true,
  feePct: 0.045,
  slippagePct: 0.02,
  maxRiskPct: 10,
};

export interface BbTrade {
  index: number;
  dir: 1 | -1;
  entry: number;
  initialSl: number;
  finalSl: number;
  exitIndex: number;
  exitPrice: number;
  reason: BbExitReason;
  /** R වලින් ප්‍රතිඵලය — fees ඇතුළත්ව. */
  r: number;
  /** Trade එක ඇතුළේ ගිය හොඳම දුර (R). */
  maxFavorableR: number;
  /** Break-even එකට ගියාද. */
  reachedBreakEven: boolean;
  /** SL එක entry එකට ගෙනාපු bar එක (−1 = ගියේ නෑ). */
  breakEvenIndex: number;
  /** Trail පටන් ගත්තාද. */
  startedTrailing: boolean;
  /** Trail පටන් ගත්ත bar එක (−1 = පටන් ගත්තේ නෑ). */
  trailStartIndex: number;
  /** SL එක ගමන් කරපු මග — chart එකේ පඩිපෙළ අඳින්න. */
  stopPath: { index: number; price: number }[];
}

export interface BbTrailStats {
  trades: number;
  wins: number;
  winRate: number;
  expectancy: number;
  totalR: number;
  profitFactor: number;
  maxDrawdownR: number;
  avgWinR: number;
  avgLossR: number;
  byReason: Record<BbExitReason, number>;
  /**
   * Break-even එකට ගිහින්, ඊට පස්සේ SL එක වැදුනු trades. මේවා
   * break-even නැත්නම් **පාඩු** වෙන්න තිබුණු ඒවා.
   */
  savedByBreakEven: number;
  /** හොඳම චලනයෙන් අල්ලගත්ත කොටස. */
  captureRatio: number;
}

export interface BbTrailResult {
  trades: BbTrade[];
  stats: BbTrailStats;
  longStats: BbTrailStats;
  shortStats: BbTrailStats;
  /** Break-even එක තිබ්බම/නැතුව — ඒකෙන් ඇත්තටම වෙනසක් වෙනවද. */
  comparison: { name: string; stats: BbTrailStats }[];
}

function emptyStats(): BbTrailStats {
  return {
    trades: 0, wins: 0, winRate: 0, expectancy: 0, totalR: 0,
    profitFactor: 0, maxDrawdownR: 0, avgWinR: 0, avgLossR: 0,
    byReason: { stop: 0, breakeven: 0, trail: 0, band: 0, target: 0, opposite: 0, open: 0 },
    savedByBreakEven: 0, captureRatio: 0,
  };
}

function summarise(trades: BbTrade[]): BbTrailStats {
  const s = emptyStats();
  for (const t of trades) s.byReason[t.reason]++;
  const closed = trades.filter((t) => t.reason !== 'open');
  if (closed.length === 0) return s;

  const wins = closed.filter((t) => t.r > 0);
  const losses = closed.filter((t) => t.r <= 0);
  const gw = wins.reduce((a, t) => a + t.r, 0);
  const gl = -losses.reduce((a, t) => a + t.r, 0);
  const totalR = closed.reduce((a, t) => a + t.r, 0);

  let peak = 0, equity = 0, maxDd = 0;
  for (const t of closed) {
    equity += t.r;
    if (equity > peak) peak = equity;
    maxDd = Math.max(maxDd, peak - equity);
  }

  const capturable = closed.filter((t) => t.maxFavorableR > 0.1);
  s.trades = closed.length;
  s.wins = wins.length;
  s.winRate = (wins.length / closed.length) * 100;
  s.expectancy = totalR / closed.length;
  s.totalR = totalR;
  s.avgWinR = wins.length ? gw / wins.length : 0;
  s.avgLossR = losses.length ? -gl / losses.length : 0;
  s.profitFactor = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
  s.maxDrawdownR = maxDd;
  s.savedByBreakEven = closed.filter((t) => t.reason === 'breakeven').length;
  s.captureRatio = capturable.length
    ? capturable.reduce((a, t) => a + t.r / t.maxFavorableR, 0) / capturable.length
    : 0;
  return s;
}

function runTrade(
  candles: Candle[],
  atr: number[],
  bands: { upper: number[]; lower: number[] },
  i: number,
  dir: 1 | -1,
  o: BbRsiTrailOptions,
  opposite: Set<number>,
): BbTrade | null {
  const a = atr[i];
  if (!(a > 0)) return null;

  const entry = candles[i].close;
  const risk = a * o.initialSlAtr;
  if (!(risk > 0) || (risk / entry) * 100 > o.maxRiskPct) return null;

  const initialSl = entry - dir * risk;
  const target = o.takeProfitR > 0 ? entry + dir * risk * o.takeProfitR : NaN;
  // Fees + slippage — දෙකම පැත්ත දෙකට, R වලින්.
  const costR = (((o.feePct + o.slippagePct) * 2) / 100) * (entry / risk);

  let stop = initialSl;
  let best = 0;
  let reachedBreakEven = false;
  let startedTrailing = false;
  let breakEvenIndex = -1;
  let trailStartIndex = -1;
  const stopPath: { index: number; price: number }[] = [{ index: i, price: stop }];

  const finish = (j: number, price: number, reason: BbExitReason): BbTrade => ({
    index: i, dir, entry, initialSl, finalSl: stop,
    exitIndex: j, exitPrice: price, reason,
    r: ((price - entry) * dir) / risk - costR,
    maxFavorableR: best,
    reachedBreakEven, breakEvenIndex, startedTrailing, trailStartIndex, stopPath,
  });

  for (let j = i + 1; j < candles.length; j++) {
    const b = candles[j];

    // 1. SL එක — bar එකේ අනිත් දේට කලින්.
    if (dir === 1 ? b.low <= stop : b.high >= stop) {
      // SL එක තිබුණේ කොහෙද කියලා reason එක තීරණය වෙනවා:
      //   entry එකට එහා (ලාභ පැත්තේ) → trail
      //   entry එක ළඟ                → breakeven (පාඩුවක් නෑ)
      //   මුල් තැනේම                 → stop (පාඩුවක්)
      const beyondEntry = dir === 1 ? stop > entry : stop < entry;
      const reason: BbExitReason = startedTrailing && beyondEntry
        ? 'trail'
        : reachedBreakEven
          ? 'breakeven'
          : 'stop';
      return finish(j, stop, reason);
    }

    // 2. Take profit
    if (!Number.isNaN(target) && (dir === 1 ? b.high >= target : b.low <= target)) {
      return finish(j, target, 'target');
    }

    // හොඳම චලනය
    const reach = (((dir === 1 ? b.high : b.low) - entry) * dir) / risk;
    if (reach > best) best = reach;

    // 3. Break-even — ලාභය `breakEvenAtR` ක් වුණාම SL එක entry එකට.
    if (o.breakEvenAtR > 0 && !reachedBreakEven && best >= o.breakEvenAtR) {
      const be = entry + dir * risk * o.breakEvenBufferR;
      if (dir === 1 ? be > stop : be < stop) {
        stop = be;
        stopPath.push({ index: j, price: stop });
      }
      reachedBreakEven = true;
      breakEvenIndex = j;
    }

    // 4. Trail — ලාභය දිහාවට විතරයි, ආපහු නෑ.
    const trailOn = o.trailMode === 'ratio' ? o.trailRatio > 0 : o.trailAtr > 0;
    if (trailOn && best >= o.trailAfterR) {
      // `ratio`: හොඳම ලාභයෙන් `trailRatio` ක් අගුළු දානවා.
      //          (1:2 → best +2R වුණාම SL එක +1R ට.)
      // `atr`  : හොඳම **මිලෙන්** ATR කිහිපයක් පිටිපස්සෙන්.
      let lockR =
        o.trailMode === 'ratio'
          ? best * o.trailRatio
          : (() => {
              const at = atr[j] > 0 ? atr[j] : a;
              const px = dir === 1 ? b.high - at * o.trailAtr : b.low + at * o.trailAtr;
              return ((px - entry) * dir) / risk;
            })();

      // අවම අගුළු — ඒත් ලබාගත්තු ලාභයට වඩා අගුළු දාන්න බෑ.
      if (o.minLockR > 0) lockR = Math.max(lockR, Math.min(o.minLockR, best));

      const candidate = entry + dir * risk * lockR;
      // SL එක දැන් තියෙන මිල පනින්නේ නෑ. එහෙම තැනක් ආවොත් (මිල ආපහු
      // හැරිලා) SL එක **තිබුණු තැනම** තියනවා — මිලට ඇලවුනු SL එකක්
      // ඊළඟ bar එකේම වැදිලා trade එක නිකරුණේ කපනවා.
      const placeable = dir === 1 ? candidate <= b.close : candidate >= b.close;

      if (placeable && (dir === 1 ? candidate > stop : candidate < stop)) {
        stop = candidate;
        if (!startedTrailing) trailStartIndex = j;
        startedTrailing = true;
        stopPath.push({ index: j, price: stop });
      }
    }

    // 5. අනිත් පැත්තේ BB line එක — ලාභයක් අගුළු වෙලා තියෙද්දී විතරයි.
    //    ⚠️ මේ bar එකේම trail පටන් ගත්තා නම් මේක බලන්නේ නෑ. Bar එකක්
    //    ඇතුළේ මොකක් මුලින් වුණාද කියලා candle එකකින් දැනගන්න බෑ, ඒ
    //    නිසා trail එක **කලින් bar එකක** පටන් ගත්තා නම් විතරයි වහන්නේ.
    if (o.exitOnBand && trailStartIndex >= 0 && trailStartIndex < j) {
      const band = dir === 1 ? bands.upper[j] : bands.lower[j];
      if (!Number.isNaN(band) && (dir === 1 ? b.high >= band : b.low <= band)) {
        // Band එකේ limit order එකක් — ඒ මිලට fill වෙනවා. Bar එක ඒක
        // පනිනවා නම් ඒකෙන් අපිට වාසියක් මිසක් අවාසියක් නෑ.
        return finish(j, band, 'band');
      }
    }

    // 6. විරුද්ධ signal එකක්
    if (o.exitOnOpposite && opposite.has(j)) return finish(j, b.close, 'opposite');
  }

  const lastBar = candles[candles.length - 1];
  return finish(candles.length - 1, lastBar.close, 'open');
}

function runAll(
  candles: Candle[],
  atr: number[],
  bands: { upper: number[]; lower: number[] },
  signals: { index: number; dir: 1 | -1 }[],
  o: BbRsiTrailOptions,
): BbTrade[] {
  const trades: BbTrade[] = [];
  let busyUntil = -1;
  for (const s of signals) {
    if (s.index <= busyUntil) continue;
    const opposite = new Set(signals.filter((x) => x.dir !== s.dir).map((x) => x.index));
    const t = runTrade(candles, atr, bands, s.index, s.dir, o, opposite);
    if (!t) continue;
    trades.push(t);
    busyUntil = t.exitIndex;
  }
  return trades;
}

export function computeBbRsiTrail(candles: Candle[], o: BbRsiTrailOptions): BbTrailResult {
  if (candles.length < 60) {
    return {
      trades: [], stats: emptyStats(),
      longStats: emptyStats(), shortStats: emptyStats(), comparison: [],
    };
  }

  const base = computeBbRsi(candles, o.signal);
  const signals = base.signals
    .filter((s) =>
      o.direction === 'long' ? s.dir === 1 : o.direction === 'short' ? s.dir === -1 : true,
    )
    .map((s) => ({ index: s.index, dir: s.dir }));
  const atr = atrArray(candles, o.atrLength);
  const bands = { upper: base.upper, lower: base.lower };

  const trades = runAll(candles, atr, bands, signals, o);

  // Break-even එකෙන් ඇත්තටම වෙනසක් වෙනවද — ඒක මනින්න.
  const variants: { name: string; opts: Partial<BbRsiTrailOptions> }[] = [
    { name: 'Current settings', opts: {} },
    { name: 'Lock 0.5R min (default)', opts: { trailMode: 'ratio', trailRatio: 0.7, breakEvenAtR: 0, trailAfterR: 0.5, minLockR: 0.5 } },
    { name: 'Lock 1.0R min (wider gap)', opts: { trailMode: 'ratio', trailRatio: 0.7, breakEvenAtR: 0, trailAfterR: 1, minLockR: 1 } },
    { name: 'No BB band exit', opts: { exitOnBand: false } },
    { name: 'No min lock (SL hugs entry)', opts: { trailMode: 'ratio', trailRatio: 0.5, breakEvenAtR: 0, trailAfterR: 0, minLockR: 0 } },
    { name: 'Ratio 1:3 (lock third)', opts: { trailMode: 'ratio', trailRatio: 1 / 3, breakEvenAtR: 0, trailAfterR: 0 } },
    { name: 'Ratio 2:3 (lock two thirds)', opts: { trailMode: 'ratio', trailRatio: 2 / 3, breakEvenAtR: 0, trailAfterR: 0 } },
    { name: 'ATR trail 2x + BE', opts: { trailMode: 'atr', trailAtr: 2, breakEvenAtR: 1, trailAfterR: 1.5 } },
    { name: 'Plain stop (no trail)', opts: { trailMode: 'atr', trailAtr: 0, breakEvenAtR: 0 } },
  ];
  const comparison = variants.map((v) => ({
    name: v.name,
    stats: summarise(runAll(candles, atr, bands, signals, { ...o, ...v.opts })),
  }));

  return {
    trades,
    stats: summarise(trades),
    longStats: summarise(trades.filter((t) => t.dir === 1)),
    shortStats: summarise(trades.filter((t) => t.dir === -1)),
    comparison,
  };
}

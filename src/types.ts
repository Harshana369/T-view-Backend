/** Candle time is unix seconds (matches lightweight-charts on the frontend). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** apps2/web එකේ `CandleSet` එකටම ගැලපෙනවා — chart එකේ price scale එකට
 *  ඒ market එකේ decimals ගාණත් එක්කම යනවා. */
export interface CandleSet {
  candles: Candle[];
  priceDecimals: number;
}

/** apps2/web එකේ `Interval` type එකටම ගැලපෙනවා (src/lib/types.ts). */
export const INTERVALS = [
  '1m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '12h',
  '1d',
  '1w',
] as const;
export type Interval = (typeof INTERVALS)[number];

export function isInterval(value: string): value is Interval {
  return (INTERVALS as readonly string[]).includes(value);
}

export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

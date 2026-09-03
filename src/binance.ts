import { cacheGet, cacheSet } from './redis.js';
import type { Candle, Interval } from './types.js';

const BINANCE = 'https://fapi.binance.com';

/** Raw kline row from Binance REST: [openTime, open, high, low, close, volume, ...] */
type RawKline = [number, string, string, string, string, string, ...unknown[]];

/**
 * 429/418 mean Binance is rate-limiting this IP (418 is the ban for ignoring
 * 429s), and continuing to send requests escalates the ban. Honor Retry-After
 * and fail fast until it expires — every user of this shared proxy hits the
 * same block, instead of each one digging the hole deeper independently.
 */
let blockedUntil = 0;

export class BinanceRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = 'BinanceRateLimitError';
  }
}

async function binanceFetch(url: string): Promise<Response> {
  const blockedMs = blockedUntil - Date.now();
  if (blockedMs > 0) {
    throw new BinanceRateLimitError(
      `Binance rate limit — ${Math.ceil(blockedMs / 1000)}s ඉතුරුයි`,
      blockedMs,
    );
  }

  const res = await fetch(url, { headers: { accept: 'application/json' } });

  if (res.status === 429 || res.status === 418) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const banMs = retryAfter > 0 ? retryAfter * 1000 : 60_000;
    blockedUntil = Date.now() + banMs;
    throw new BinanceRateLimitError(
      `Binance rate limit (${res.status}) — ${Math.ceil(banMs / 1000)}s ඉතුරුයි`,
      banMs,
    );
  }

  return res;
}

/**
 * `/fapi/xxx` endpoint එකේ path එක බලලා cache TTL එකක් තෝරනවා.
 *  - exchangeInfo: coin listing එක කලාතුරකින් වෙනස් වෙන එකක් — විනාඩි 5ක්.
 *  - ticker/24hr: watchlist එකේ "All coins" view එකෙන් නිතර call වෙනවා
 *    (coins 500+), price එක දිගටම වෙනස් වුණත් තත්පර 3ක විතරක් cache කළත් ඇති.
 *  - klines: `endTime` දුන්නොත් historical/closed window එකක් — කවදාවත්
 *    වෙනස් වෙන්නේ නෑ, පැය ගාණක් cache කරන්න පුළුවන්. දුන්නේ නැත්නම් "දැන්
 *    හැදෙන candle එකේ" live window එකක් — තත්පර 5ක් විතරයි.
 *  - අනිත් ඔක්කොම: default කෙටි TTL එකක් (safe fallback).
 */
function cacheTtlFor(pathname: string, search: string): number {
  if (pathname.endsWith('/exchangeInfo')) return 300;
  if (pathname.endsWith('/ticker/24hr')) return 3;
  if (pathname.endsWith('/klines')) {
    return search.includes('endTime=') ? 6 * 60 * 60 : 5;
  }
  return 3;
}

export interface ProxyResult {
  status: number;
  contentType: string;
  body: string;
  cache: 'hit' | 'miss';
}

/**
 * `/fapi/xxx` request එකක් Binance API එකට යවලා, Redis එකෙන් cache කරමින්
 * උත්තරේ දෙනවා. Users ගොඩක් denek එකම proxy එකෙන් යද්දී, එකම coin/endpoint
 * එකකට request ගාණක් Binance එකට යනවා වෙනුවට, cache එකෙන් serve වෙනවා.
 * GET request විතරයි cache කරන්නේ.
 */
export async function proxyFapi(
  pathname: string,
  search: string,
  method: string,
): Promise<ProxyResult> {
  const cacheable = method === 'GET';
  const cacheKey = `fapi-proxy:${pathname}${search}`;

  if (cacheable) {
    const cached = await cacheGet(cacheKey);
    if (cached !== null) {
      return { status: 200, contentType: 'application/json', body: cached, cache: 'hit' };
    }
  }

  const upstream = await binanceFetch(`${BINANCE}${pathname}${search}`);
  const body = await upstream.text();
  const contentType = upstream.headers.get('content-type') ?? 'application/json';

  if (cacheable && upstream.ok) {
    await cacheSet(cacheKey, body, cacheTtlFor(pathname, search));
  }

  return { status: upstream.status, contentType, body, cache: 'miss' };
}

/**
 * Binance එකෙන් JSON එකක් ගෙනල්ලා Redis එකේ cache කරනවා. `/fapi/*` proxy
 * එකේ raw passthrough එකට වඩා වෙනස් — මේකෙන් එන දේ server එකේම පාවිච්චි
 * කරන්න පුළුවන් (scan.ts එකේ symbols list එකට වගේ).
 */
export async function cachedBinanceFetch<T>(
  url: string,
  cacheKey: string,
  ttlSeconds: number,
): Promise<T> {
  const cached = await cacheGet(cacheKey);
  if (cached !== null) return JSON.parse(cached) as T;
  const res = await binanceFetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const data = (await res.json()) as T;
  await cacheSet(cacheKey, JSON.stringify(data), ttlSeconds);
  return data;
}

/**
 * `"0.0000123"` වගේ price string එකක තියෙන decimal ගණන. Binance හැම
 * price එකක්ම ඒ market එකේ tick size එකට pad කරලා දෙන නිසා, chart එකේ
 * price scale එකට ඕන precision එක මෙතනින් හරියටම ගන්න පුළුවන් — number
 * එකකට හැරෙව්වට පස්සේ trailing zeros නැති වෙනවා, ඒ නිසා string එකේදීම ගන්නවා.
 */
function decimalsOf(price: string): number {
  const dot = price.indexOf('.');
  return dot < 0 ? 0 : Math.min(8, price.length - dot - 1);
}

export interface KlineSet {
  candles: Candle[];
  priceDecimals: number;
}

/**
 * Candle store එකේ backfill එකට — Binance එකෙන් klines ගෙනල්ලා අපේ
 * `Candle` හැඩයට හරවනවා. (Proxy එකේ raw passthrough එකට වඩා වෙනස්:
 * මේකෙන් එන දේ Postgres එකට කෙලින්ම write කරන්න පුළුවන්.)
 */
export async function fetchKlines(
  symbol: string,
  interval: Interval,
  limit: number,
  endTimeMs?: number,
): Promise<KlineSet> {
  const params = new URLSearchParams({
    symbol: symbol.toUpperCase(),
    interval,
    limit: String(limit),
  });
  if (endTimeMs !== undefined) params.set('endTime', String(endTimeMs));

  const res = await binanceFetch(`${BINANCE}/fapi/v1/klines?${params}`);
  if (!res.ok) {
    throw new Error(`Binance klines request failed: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as RawKline[];
  return {
    candles: raw.map((k) => ({
      time: k[0] / 1000,
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    })),
    priceDecimals: raw.length > 0 ? decimalsOf(raw[0][4]) : 2,
  };
}

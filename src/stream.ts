import type { Candle, Interval } from './types.js';

/**
 * Binance USDT-M **WebSocket** — REST polling එකට වඩා හොඳ පාර.
 *
 * ඇයි මේක ඕන: REST එකේ සීමාව විනාඩියකට weight 2400ක්. `ticker/24hr`
 * එකක weight 40යි — තත්පර 5කට වරක් ඇහුවොත් විනාඩියකට **492**ක්, ඒ
 * කියන්නේ බජට් එකෙන් 20%ක් නිකම්ම මිල බලන්න. Chart එකකට klines
 * polling එකත් ඒ උඩින්.
 *
 * WebSocket එකේ **weight 0**. Binance එකම error message එකේ කියන්නේත්
 * ඒක තමයි.
 *
 * ව්‍යූහය:
 *
 *   Binance  ──(එක WS connection එකක්)──>  මේ file එක  ──>  browsers
 *
 * Browser කීයක් තිබ්බත් Binance එකට යන්නේ **එක** connection එකයි.
 * Streams එකතු/අඩු වෙන්නේ SUBSCRIBE/UNSUBSCRIBE messages වලින්, අලුත්
 * connection වලින් නෙවෙයි.
 *
 * දැනට streams දෙකක්:
 *   `!ticker@arr`            — coins ඔක්කොමගේ මිල, තත්පරයකට වරක්
 *   `<symbol>@kline_<tf>`    — chart එකක candles (demand එකට අනුව)
 */

const WS_URL = 'wss://fstream.binance.com/stream';
const REST = 'https://fapi.binance.com/fapi/v1';

/**
 * ⚠️ **මැනපු දෙයක්:** සමහර ජාල වලින් `fstream.binance.com` එකට WS
 *    handshake එක සාර්ථකයි, ඒත් **frame එකක්වත් එන්නේ නෑ**
 *    (තත්පර 10ක් බලාගෙන හිටියා). `fstream1/2/3` → HTTP 302.
 *    Spot එකේ `stream.binance.com` හොඳට වැඩ කරනවා, futures REST
 *    (`fapi.binance.com`) එකත් වැඩ කරනවා — futures WS එක විතරයි
 *    හිරවෙලා තියෙන්නේ.
 *
 *    ඒ නිසා මේ module එක **දෙකම දන්නවා**: WS එක තත්පර කිහිපයක්
 *    ඇතුළත data දුන්නොත් ඒක, නැත්නම් **server පැත්තේ එක REST poller
 *    එකක්**. Browser එකට වෙනස දැනෙන්නේ නෑ — event හැඩය එකයි.
 *
 * REST fallback එකේ weight (ඇත්තටම `x-mbx-used-weight-1m` එකෙන් මැනපු):
 *
 *   ticker/price  (coins 773ම, මිල විතරක්)     weight  2
 *   ticker/24hr   (change% + volume එක්ක)      weight 40
 *   klines limit=3                             weight  1
 *
 * ඒ නිසා: මිල තත්පර 2කට වරක් (2 × 30 = 60/min) + 24h විස්තර
 * විනාඩියකට වරක් (40/min) = **~100 weight/min**, browser කීයක්
 * තිබ්බත්. කලින් tab එකකට 492ක් ගියා.
 */
const PRICE_POLL_MS = 2000;
const STATS_POLL_MS = 60_000;
/** WS එකෙන් මෙච්චර වෙලාවකින් data නැත්නම් REST එකට. */
const WS_PROBE_MS = 8000;

/** Binance `!ticker@arr` row එකක් — ඕන ක්ෂේත්‍ර විතරක්. */
interface RawTickerEvent {
  s: string;
  c: string;
  P: string;
  q: string;
}

interface RawKlineEvent {
  s: string;
  k: {
    t: number;
    i: string;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    x: boolean;
  };
}

export interface TickerUpdate {
  symbol: string;
  price: number;
  /** Binance string එකේ decimals — price format කරන්න. */
  priceDecimals: number;
  changePct: number;
  notional24h: number;
}

export type StreamEvent =
  | { type: 'tickers'; data: TickerUpdate[] }
  | { type: 'kline'; symbol: string; interval: Interval; candle: Candle; closed: boolean };

type Listener = (event: StreamEvent) => void;

function decimalsOf(value: string): number {
  const dot = value.indexOf('.');
  if (dot < 0) return 0;
  // Binance trailing zeros එක්ක දෙනවා ("0.01000") — ඒවා ගණන් ගන්නේ නෑ.
  return value.replace(/0+$/, '').length - dot - 1;
}

/**
 * Upstream connection එක. Reconnect, re-subscribe, සහ browsers ට
 * බෙදන එක මෙතන.
 */
class BinanceStream {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  /** `<symbol>@kline_<tf>` → කී දෙනෙක් බලාගෙන ඉන්නවද. */
  private klineRefs = new Map<string, number>();
  /** අන්තිම ticker snapshot එක — අලුත් client එකකට වහාම දෙන්න. */
  private tickers = new Map<string, TickerUpdate>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  /** Connection එක හැදෙනකම් රැඳෙන subscribe messages. */
  private pending: string[] = [];

  /** `ws` = Binance WS එකෙන්, `rest` = server පැත්තේ poller එකෙන්. */
  private mode: 'connecting' | 'ws' | 'rest' = 'connecting';
  private sawWsData = false;
  private probeTimer: NodeJS.Timeout | null = null;
  private klineTimers = new Map<string, NodeJS.Timeout>();
  /** 24h විස්තර — ticker/price එකේ නැති ඒවා මෙතන තියාගන්නවා. */
  private stats = new Map<string, { changePct: number; notional24h: number }>();

  /** දැනට තියෙන මිල — ticker snapshot එක. */
  snapshot(): TickerUpdate[] {
    return [...this.tickers.values()];
  }

  connected(): boolean {
    return this.ws?.readyState === 1;
  }

  /** තත්ත්වය — /api/health වලට. */
  status(): {
    mode: string;
    connected: boolean;
    tickers: number;
    klineStreams: number;
  } {
    return {
      mode: this.mode,
      connected: this.mode === 'rest' ? true : this.connected(),
      tickers: this.tickers.size,
      klineStreams: this.klineRefs.size,
    };
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: StreamEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // එක listener එකක් වැටුණාට අනිත් ඒවා නවත්තන්නේ නෑ.
      }
    }
  }

  start(): void {
    if (this.ws || this.mode === 'rest') return;
    this.open();
    // තත්පර කිහිපයකින් frame එකක්වත් ආවේ නැත්නම් REST එකට මාරු වෙනවා.
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (!this.sawWsData) this.switchToRest('WS එකෙන් data නෑ');
    }, WS_PROBE_MS);
  }

  private switchToRest(why: string): void {
    if (this.mode === 'rest') return;
    this.mode = 'rest';
    console.warn(`[stream] REST fallback — ${why}`);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* දැනටමත් වැහිලා */
      }
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    void this.pollStats();
    void this.pollPrices();
    // Process එක ජීවත් වෙන තාක් දුවනවා — නවත්තන්න ඕන දෙයක් නෑ.
    setInterval(() => void this.pollPrices(), PRICE_POLL_MS).unref();
    setInterval(() => void this.pollStats(), STATS_POLL_MS).unref();
    // REST mode එකට මාරු වුණාට පස්සෙත් දැනට ඉල්ලලා තියෙන klines ටික
    // poll කරන්න පටන් ගන්නවා.
    for (const s of this.klineRefs.keys()) this.startKlinePoll(s);
  }

  /** මිල විතරක් — weight 2, coins 773ම. */
  private async pollPrices(): Promise<void> {
    try {
      const rows = (await this.get('/ticker/price')) as { symbol: string; price: string }[];
      if (!Array.isArray(rows)) return;
      const updates: TickerUpdate[] = [];
      for (const r of rows) {
        if (!r.symbol?.endsWith('USDT')) continue;
        const extra = this.stats.get(r.symbol);
        const u: TickerUpdate = {
          symbol: r.symbol,
          price: Number(r.price),
          priceDecimals: decimalsOf(r.price),
          changePct: extra?.changePct ?? 0,
          notional24h: extra?.notional24h ?? 0,
        };
        this.tickers.set(u.symbol, u);
        updates.push(u);
      }
      if (updates.length > 0) this.emit({ type: 'tickers', data: updates });
    } catch {
      // Rate limit / network — ඊළඟ tick එකේදී ආපහු.
    }
  }

  /** 24h change% සහ volume — weight 40, ඒ නිසා විනාඩියකට වරක් විතරයි. */
  private async pollStats(): Promise<void> {
    try {
      const rows = (await this.get('/ticker/24hr')) as {
        symbol: string;
        priceChangePercent: string;
        quoteVolume: string;
      }[];
      if (!Array.isArray(rows)) return;
      for (const r of rows) {
        if (!r.symbol?.endsWith('USDT')) continue;
        this.stats.set(r.symbol, {
          changePct: Number(r.priceChangePercent),
          notional24h: Number(r.quoteVolume),
        });
      }
    } catch {
      /* ඊළඟ එකේදී */
    }
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${REST}${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }

  /**
   * Chart එකක candles — weight 1 (limit 3). Timeframe එක දිග නම්
   * හෙමින්. මේක **එක තැනකින්**, ඒ නිසා tab 10ක් එකම chart එක බැලුවත්
   * poll එකයි.
   */
  private startKlinePoll(stream: string): void {
    if (this.mode !== 'rest' || this.klineTimers.has(stream)) return;
    const [sym, tf] = stream.split('@kline_');
    const symbol = sym.toUpperCase();
    const interval = tf as Interval;
    const tick = async () => {
      try {
        const rows = (await this.get(
          `/klines?symbol=${symbol}&interval=${interval}&limit=3`,
        )) as [number, string, string, string, string, string, ...unknown[]][];
        if (!Array.isArray(rows)) return;
        for (let i = 0; i < rows.length; i++) {
          const k = rows[i];
          this.emit({
            type: 'kline',
            symbol,
            interval,
            candle: {
              time: Math.floor(k[0] / 1000),
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
            },
            // අන්තිම එක තාම හැදෙනවා, ඉස්සර ඒවා වැහිලා.
            closed: i < rows.length - 1,
          });
        }
      } catch {
        /* ඊළඟ එකේදී */
      }
    };
    void tick();
    this.klineTimers.set(stream, setInterval(tick, 3000));
  }

  private stopKlinePoll(stream: string): void {
    const t = this.klineTimers.get(stream);
    if (t) {
      clearInterval(t);
      this.klineTimers.delete(stream);
    }
  }

  private open(): void {
    const ws = new WebSocket(`${WS_URL}?streams=!ticker@arr`);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      // Reconnect එකකදී කලින් තිබුණු kline streams ආපහු ඉල්ලනවා.
      const streams = [...this.klineRefs.keys()];
      if (streams.length > 0) this.send('SUBSCRIBE', streams);
      for (const msg of this.pending.splice(0)) ws.send(msg);
    };

    ws.onmessage = (ev) => {
      if (!this.sawWsData) {
        this.sawWsData = true;
        this.mode = 'ws';
        if (this.probeTimer) {
          clearTimeout(this.probeTimer);
          this.probeTimer = null;
        }
      }
      try {
        this.handle(JSON.parse(String(ev.data)));
      } catch {
        // හැඩය වෙනස් message එකක් — අත්හරිනවා.
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.mode === 'rest') return;
      // Data එකක්වත් නොඇවිත් වැහුණොත් නැවත නැවත උත්සාහ කරන්නේ නෑ.
      if (!this.sawWsData && this.reconnectAttempt >= 2) {
        this.switchToRest('WS එක නැවත නැවත වැහෙනවා');
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // `onclose` එකත් එනවා — reconnect එක එතනින්.
      try {
        ws.close();
      } catch {
        /* දැනටමත් වැහිලා */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    // 1s, 2s, 4s ... උපරිමය 30s. Binance එකට හැම තත්පරයකම වදින්නේ නෑ.
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private send(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', params: string[]): void {
    const msg = JSON.stringify({ method, params, id: this.nextId++ });
    if (this.connected()) this.ws!.send(msg);
    else this.pending.push(msg);
  }

  private handle(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const wrapper = msg as { stream?: string; data?: unknown };
    if (typeof wrapper.stream !== 'string') return;

    if (wrapper.stream === '!ticker@arr') {
      const rows = wrapper.data as RawTickerEvent[];
      if (!Array.isArray(rows)) return;
      const updates: TickerUpdate[] = [];
      for (const r of rows) {
        // USDT perps විතරයි — watchlist එකේ තියෙන්නේ ඒවා.
        if (!r.s?.endsWith('USDT')) continue;
        const u: TickerUpdate = {
          symbol: r.s,
          price: Number(r.c),
          priceDecimals: decimalsOf(r.c),
          changePct: Number(r.P),
          notional24h: Number(r.q),
        };
        this.tickers.set(u.symbol, u);
        updates.push(u);
      }
      if (updates.length > 0) this.emit({ type: 'tickers', data: updates });
      return;
    }

    if (wrapper.stream.includes('@kline_')) {
      const e = wrapper.data as RawKlineEvent;
      if (!e?.k) return;
      this.emit({
        type: 'kline',
        symbol: e.s,
        interval: e.k.i as Interval,
        candle: {
          time: Math.floor(e.k.t / 1000),
          open: Number(e.k.o),
          high: Number(e.k.h),
          low: Number(e.k.l),
          close: Number(e.k.c),
          volume: Number(e.k.v),
        },
        closed: e.k.x,
      });
    }
  }

  /**
   * Chart එකක candles ඕන කියලා කියනවා. Return වෙන function එක call
   * කළාම ඒ ඉල්ලීම අයින් වෙනවා — අන්තිම කෙනාත් ගියාම Binance එකෙන්
   * unsubscribe වෙනවා.
   */
  subscribeKline(symbol: string, interval: Interval): () => void {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    const refs = this.klineRefs.get(stream) ?? 0;
    this.klineRefs.set(stream, refs + 1);
    if (refs === 0) {
      if (this.mode === 'rest') this.startKlinePoll(stream);
      else this.send('SUBSCRIBE', [stream]);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.klineRefs.get(stream) ?? 1) - 1;
      if (left <= 0) {
        this.klineRefs.delete(stream);
        if (this.mode === 'rest') this.stopKlinePoll(stream);
        else this.send('UNSUBSCRIBE', [stream]);
      } else {
        this.klineRefs.set(stream, left);
      }
    };
  }
}

export const stream = new BinanceStream();

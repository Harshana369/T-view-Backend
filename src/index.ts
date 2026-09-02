import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { BinanceRateLimitError, proxyFapi } from './binance.js';
import { getCandles } from './candles.js';
import { migrate } from './db.js';
import { env } from './env.js';
import { isInterval } from './types.js';

/**
 * apps/server එකේම stack එකෙන් (Fastify + TypeScript) හදපු, ඒත් apps2/web
 * එකට ඕන තරමින් විතරක් — වැඩ දෙකයි:
 *   1. /fapi/* requests Binance USDT-M futures API එකට forward කරනවා,
 *      Redis එකෙන් cache කරමින් සහ rate limit එකට honor කරමින් (binance.ts).
 *   2. build කරපු web app එක (apps2/web/dist) serve කරනවා.
 *
 * apps/server එකේ තියෙන auth/alerts/Postgres කොටස් මෙතන wire කරලා නෑ —
 * apps2/web එකේ accounts වගේ, persist වෙන user data වගේ දෙයක් තාම නෑ
 * (scanning ඔක්කොම client side එකෙන්ම Binance එකට කෙලින්ම යනවා). ඒත්
 * @fastify/jwt, pg, bcryptjs, @fastify/websocket dependencies ටික
 * package.json එකේම තියෙනවා — ඉස්සරහට ඕන වුණොත් තව npm install එකක් නැතුව
 * දාන්න පුළුවන්.
 */
const app = Fastify({ logger: true });

// Production වලදී SPA එකයි /fapi proxy එකයි එකම origin එකකින්ම serve වෙනවා
// (browser එකෙන් cross-origin call එකක් යන්නේ නෑ) — ඒ නිසා මේක strictly
// ඕන නෑ, ඒත් apps/server එකේ stack එකටම ගැලපෙන්න, සහ dev වලදී වෙනම port
// එකක ඉඳන් call කරන්න ඕන වුණොත් permissive default එකක් තියාගන්නවා.
await app.register(cors, { origin: true });

app.get('/api/health', async () => ({ ok: true }));

async function handleFapi(req: FastifyRequest, reply: FastifyReply) {
  const url = new URL(req.url, 'http://internal');
  try {
    const result = await proxyFapi(url.pathname, url.search, req.method);
    return reply
      .code(result.status)
      .header('content-type', result.contentType)
      // Cache-Control: browser එකට cache නොකර, හැම විටම proxy එකෙන්ම අහන්න
      // කියනවා — cache එක මෙතන Redis එකේ, browser එකේ නෙවෙයි.
      .header('cache-control', 'no-store')
      .header('x-cache', result.cache)
      .send(result.body);
  } catch (err) {
    if (err instanceof BinanceRateLimitError) {
      return reply
        .code(503)
        .header('retry-after', String(Math.ceil(err.retryAfterMs / 1000)))
        .send(JSON.stringify({ error: 'rate_limited', message: err.message }));
    }
    return reply
      .code(502)
      .send(JSON.stringify({ error: 'upstream_failed', message: String(err) }));
  }
}

app.get('/fapi', handleFapi);
app.get('/fapi/*', handleFapi);

// ---------------------------------------------------------------- candles

interface KlinesQuery {
  symbol?: string;
  interval?: string;
  limit?: string;
  endTime?: string;
}

/**
 * Postgres එකෙන් serve වෙන candles — `/fapi/v1/klines` proxy එකට වඩා
 * මේක තමයි scanner එකට ඕන එක. DB එකේ අලුත්ම closed candle එක තියෙනවා
 * නම් Binance එකට යන්නෙම නෑ, ඒ නිසා coins 526ක් scan කරන එකට Binance
 * weight එකක් යන්නේ නෑ (candles.ts එකේ backfill logic එක බලන්න).
 */
app.get<{ Querystring: KlinesQuery }>('/api/klines', async (req, reply) => {
  const symbol = (req.query.symbol ?? '').toUpperCase();
  const interval = req.query.interval ?? '1h';
  const limit = Math.min(Number(req.query.limit ?? 500), 1500);
  const endTime = req.query.endTime !== undefined ? Number(req.query.endTime) : undefined;

  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    return reply.code(400).send({ error: 'invalid symbol' });
  }
  if (!isInterval(interval)) {
    return reply.code(400).send({ error: 'invalid interval' });
  }
  if (!Number.isInteger(limit) || limit < 1) {
    return reply.code(400).send({ error: 'invalid limit' });
  }
  if (endTime !== undefined && (!Number.isInteger(endTime) || endTime < 1)) {
    return reply.code(400).send({ error: 'invalid endTime' });
  }

  try {
    return await getCandles(symbol, interval, limit, endTime);
  } catch (err) {
    if (err instanceof BinanceRateLimitError) {
      return reply
        .code(503)
        .header('retry-after', String(Math.ceil(err.retryAfterMs / 1000)))
        .send({ error: 'rate_limited', message: err.message });
    }
    return reply.code(502).send({ error: 'candles_failed', message: String(err) });
  }
});

// ------------------------------------------------------------ static web

// In production the server also serves the built frontend, so everything
// runs single-origin on one port.
const webDist = path.resolve(import.meta.dirname, '../../web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/fapi/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
}

await migrate();
await app.listen({ port: env.port, host: '127.0.0.1' });

import { Redis } from 'ioredis';
import { env } from './env.js';

export const redis = new Redis(env.redisUrl, {
  // Don't crash-loop the server if Redis is briefly down — cache is optional.
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

redis.on('error', (err) => {
  console.error('redis error:', err.message);
});

/** Cache read that treats any Redis failure as a miss. */
export async function cacheGet(key: string): Promise<string | null> {
  try {
    return await redis.get(key);
  } catch {
    return null;
  }
}

/** Cache write that ignores Redis failures. */
export async function cacheSet(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  try {
    await redis.set(key, value, 'EX', ttlSeconds);
  } catch {
    // cache is best-effort
  }
}

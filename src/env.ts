export const env = {
  port: Number(process.env.PORT ?? 3002),
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://trading:trading@127.0.0.1:5432/trading',
};

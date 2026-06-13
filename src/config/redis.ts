import Redis from 'ioredis';
import logger from './logger';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: process.env.NODE_ENV === 'test',
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 100, 3000)
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err) => logger.error({ message: 'Redis error', error: err.message }));
redis.on('close', () => logger.warn('Redis connection closed'));

export default redis;

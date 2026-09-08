import { createHmac } from 'crypto';

export function hashApiKey(rawKey: string): string {
  const pepper = process.env.HASH_SECRET;
  if (!pepper) {
    throw new Error('HASH_SECRET is required to hash API keys');
  }

  return createHmac('sha256', pepper).update(rawKey).digest('hex');
}

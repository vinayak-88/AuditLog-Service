const REQUIRED_ENV_VARS: Array<{ key: string }> = [
  { key: 'DATABASE_URL' },
  { key: 'REDIS_HOST' },
  { key: 'REDIS_PORT' },
  { key: 'CORS_ORIGINS' },
  { key: 'HASH_SECRET' },
  { key: 'GENESIS_HASH' },
  { key: 'INTERNAL_API_KEY' }
];

export function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter(({ key }) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`[FATAL] Missing required environment variables: ${missing.map((v) => v.key).join(', ')}`);
    console.error('[FATAL] Set these variables before starting.');
    process.exit(1);
  }
}

const REQUIRED_ENV_VARS: Array<{ key: string }> = [
  { key: 'DATABASE_URL' },
  { key: 'REDIS_HOST' },
  { key: 'REDIS_PORT' },
  { key: 'CORS_ORIGINS' },
  { key: 'HASH_SECRET' },
  { key: 'GENESIS_HASH' },
  { key: 'INTERNAL_API_KEY' }
];

type NumericRule = {
  key: string;
  defaultValue?: number;
  min: number;
  max: number;
};

/*
 * Every numeric setting the application parses with parseInt at module load.
 * min/max bounds are intentionally permissive (positive integers, valid TCP
 * ports) so legitimate deployments are never rejected; the goal is to fail
 * fast on typos such as RATE_LIMIT_EVENTS_MAX=ten rather than misbehaving
 * when the value is first used.
 */
const NUMERIC_ENV_VARS: NumericRule[] = [
  { key: 'PORT', defaultValue: 3000, min: 1, max: 65535 },
  { key: 'REDIS_PORT', min: 1, max: 65535 },
  { key: 'API_KEY_CACHE_TTL_SECONDS', defaultValue: 600, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'RATE_LIMIT_EVENTS_MAX', defaultValue: 200, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'RATE_LIMIT_EVENTS_WINDOW_MS', defaultValue: 60000, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'RATE_LIMIT_VERIFY_MAX', defaultValue: 1, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'RATE_LIMIT_VERIFY_WINDOW_MS', defaultValue: 300000, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'RATE_LIMIT_APPS_MAX', defaultValue: 30, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'RATE_LIMIT_APPS_WINDOW_MS', defaultValue: 60000, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'RATE_LIMIT_SEARCH_MAX', defaultValue: 100, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'RATE_LIMIT_SEARCH_WINDOW_MS', defaultValue: 60000, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'RATE_LIMIT_EXPORT_MAX', defaultValue: 10, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'RATE_LIMIT_EXPORT_WINDOW_MS', defaultValue: 60000, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'ACTIVITY_CACHE_MAX_ENTRIES', defaultValue: 50, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'ACTIVITY_CACHE_TTL_SECONDS', defaultValue: 3600, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'VERIFY_CHAIN_BATCH_SIZE', defaultValue: 500, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'VERIFY_JOB_TTL_SECONDS', defaultValue: 3600, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'VERIFY_ACTIVE_TTL_SECONDS', defaultValue: 3600, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'JSON_EXPORT_MAX_ROWS', defaultValue: 10000, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'ANALYTICS_VOLUME_WINDOW_DAYS', defaultValue: 30, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'ANALYTICS_ACTOR_WINDOW_DAYS', defaultValue: 7, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'ANALYTICS_ACTION_WINDOW_DAYS', defaultValue: 7, min: 1, max: Number.MAX_SAFE_INTEGER },
  { key: 'ANALYTICS_CACHE_TTL_SECONDS', defaultValue: 60, min: 1, max: Number.MAX_SAFE_INTEGER }
];

const PRODUCTION_SECRET_MIN_LENGTH = 32;

function isValidIntegerInRange(raw: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(raw.trim())) return false;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

export function validateEnv(): void {
  const errors: string[] = [];

  const missing = REQUIRED_ENV_VARS.filter(({ key }) => !process.env[key]);
  for (const { key } of missing) {
    errors.push(`Missing required environment variable: ${key}`);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl && !/^(postgresql|postgres):\/\//.test(databaseUrl)) {
    errors.push('DATABASE_URL must be a PostgreSQL connection string (postgresql:// or postgres://)');
  }

  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (process.env.CORS_ORIGINS && corsOrigins.length === 0) {
    errors.push('CORS_ORIGINS must contain at least one allowed origin');
  }

  for (const rule of NUMERIC_ENV_VARS) {
    const raw = process.env[rule.key];
    // Unset values fall back to application defaults; only explicit values
    // are validated. This preserves existing default behavior exactly.
    if (raw === undefined || raw === '') continue;
    if (!isValidIntegerInRange(raw, rule.min, rule.max)) {
      errors.push(
        `${rule.key} must be an integer between ${rule.min} and ${rule.max} (got: ${raw})` +
          (rule.defaultValue !== undefined ? `; unset it to use the default ${rule.defaultValue}` : '')
      );
    }
  }

  /*
   * Weak-secret enforcement is production-gated: local development (compose
   * defaults such as dev-hash-secret) and CI/test environments must keep
   * working, so outside production a short secret only produces a warning.
   */
  for (const key of ['HASH_SECRET', 'INTERNAL_API_KEY']) {
    const value = process.env[key];
    if (!value) continue; // Already reported as missing above.
    if (value.length < PRODUCTION_SECRET_MIN_LENGTH) {
      if (process.env.NODE_ENV === 'production') {
        errors.push(`${key} must be at least ${PRODUCTION_SECRET_MIN_LENGTH} characters in production`);
      } else {
        console.warn(`[WARN] ${key} is shorter than ${PRODUCTION_SECRET_MIN_LENGTH} characters; use a strong secret in production.`);
      }
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[FATAL] ${error}`);
    }
    console.error('[FATAL] Set these variables before starting.');
    process.exit(1);
  }
}

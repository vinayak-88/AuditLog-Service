process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://audituser:auditpass@localhost:5432/auditlog?schema=public';
process.env.HASH_SECRET = process.env.HASH_SECRET || 'test-secret-key';
process.env.GENESIS_HASH = process.env.GENESIS_HASH || 'test-genesis';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key';
process.env.RATE_LIMIT_EVENTS_MAX = process.env.RATE_LIMIT_EVENTS_MAX || '1000';
process.env.RATE_LIMIT_VERIFY_MAX = process.env.RATE_LIMIT_VERIFY_MAX || '1000';

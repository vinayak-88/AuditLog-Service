import rateLimit from 'express-rate-limit';

const eventsMax = parseInt(process.env.RATE_LIMIT_EVENTS_MAX || '200', 10);
const eventsWindowMs = parseInt(process.env.RATE_LIMIT_EVENTS_WINDOW_MS || '60000', 10);

export const eventsRateLimiter = rateLimit({
  windowMs: eventsWindowMs,
  max: eventsMax,
  keyGenerator: (req) => (req as any).auditApp?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      message: `Rate limit exceeded. Max ${eventsMax} events per ${eventsWindowMs / 1000}s.`,
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429
    }
  }
});

const verifyMax = parseInt(process.env.RATE_LIMIT_VERIFY_MAX || '1', 10);
const verifyWindowMs = parseInt(process.env.RATE_LIMIT_VERIFY_WINDOW_MS || '300000', 10);

export const verifyRateLimiter = rateLimit({
  windowMs: verifyWindowMs,
  max: verifyMax,
  keyGenerator: (req) => (req as any).auditApp?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      message: `Rate limit exceeded. Max ${verifyMax} verification per ${verifyWindowMs / 1000}s.`,
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429
    }
  }
});

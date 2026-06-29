import rateLimit from 'express-rate-limit';
import { getDashboardOwnerId } from './auth';

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

const appsMax = parseInt(process.env.RATE_LIMIT_APPS_MAX || '30', 10);
const appsWindowMs = parseInt(process.env.RATE_LIMIT_APPS_WINDOW_MS || '60000', 10);

export const appsRateLimiter = rateLimit({
  windowMs: appsWindowMs,
  max: appsMax,
  keyGenerator: (req) => getDashboardOwnerId(req) || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      message: `Rate limit exceeded. Max ${appsMax} apps per ${appsWindowMs / 1000}s.`,
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429
    }
  }
});

const searchMax = parseInt(process.env.RATE_LIMIT_SEARCH_MAX || '100', 10);
const searchWindowMs = parseInt(process.env.RATE_LIMIT_SEARCH_WINDOW_MS || '60000', 10);

export const searchRateLimiter = rateLimit({
  windowMs: searchWindowMs,
  max: searchMax,
  keyGenerator: (req) => (req as any).auditApp?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      message: `Rate limit exceeded. Max ${searchMax} searches per ${searchWindowMs / 1000}s.`,
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429
    }
  }
});

const exportMax = parseInt(process.env.RATE_LIMIT_EXPORT_MAX || '10', 10);
const exportWindowMs = parseInt(process.env.RATE_LIMIT_EXPORT_WINDOW_MS || '60000', 10);

export const exportRateLimiter = rateLimit({
  windowMs: exportWindowMs,
  max: exportMax,
  keyGenerator: (req) => (req as any).auditApp?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      message: `Rate limit exceeded. Max ${exportMax} exports per ${exportWindowMs / 1000}s.`,
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429
    }
  }
});

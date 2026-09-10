/*
 * Fail-fast validation for required dashboard configuration.
 *
 * Called from next.config.mjs (which runs at `next build` and `next start`,
 * after the repository-root .env is loaded), so missing or malformed values
 * surface before a production request is served instead of failing obscurely
 * at request time. Server-only secrets are only read here on the server;
 * nothing in this module is imported by browser components.
 */

const NEXTAUTH_SECRET_MIN_LENGTH = 32;

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateDashboardEnv(env = process.env) {
  const errors = [];

  if (!env.INTERNAL_API_KEY) {
    errors.push('Missing required environment variable: INTERNAL_API_KEY');
  }

  if (!env.API_URL && !env.NEXT_PUBLIC_API_URL) {
    errors.push('Set API_URL (server) or NEXT_PUBLIC_API_URL (public) to the backend base URL');
  }
  for (const key of ['API_URL', 'NEXT_PUBLIC_API_URL']) {
    if (env[key] && !isHttpUrl(env[key])) {
      errors.push(`${key} must be a valid http(s) URL (got: ${env[key]})`);
    }
  }

  if (!env.NEXTAUTH_SECRET) {
    errors.push('Missing required environment variable: NEXTAUTH_SECRET');
  } else if (env.NEXTAUTH_SECRET.length < NEXTAUTH_SECRET_MIN_LENGTH) {
    errors.push(`NEXTAUTH_SECRET must be at least ${NEXTAUTH_SECRET_MIN_LENGTH} characters`);
  }

  if (!env.GITHUB_CLIENT_ID) {
    errors.push('Missing required environment variable: GITHUB_CLIENT_ID');
  }
  if (!env.GITHUB_CLIENT_SECRET) {
    errors.push('Missing required environment variable: GITHUB_CLIENT_SECRET');
  }

  if (env.NEXTAUTH_URL && !isHttpUrl(env.NEXTAUTH_URL)) {
    errors.push(`NEXTAUTH_URL must be a valid http(s) URL (got: ${env.NEXTAUTH_URL})`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid dashboard configuration:\n- ${errors.join('\n- ')}`);
  }
}

module.exports = { validateDashboardEnv };

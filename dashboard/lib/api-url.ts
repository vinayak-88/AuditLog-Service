const API_VERSION_PREFIX = '/v1';

function getConfiguredApiUrl(baseUrl?: string): string {
  const configuredUrl = baseUrl || process.env.API_URL || process.env.NEXT_PUBLIC_API_URL;

  if (!configuredUrl) {
    throw new Error('API_URL or NEXT_PUBLIC_API_URL must be configured for the dashboard');
  }

  return configuredUrl.endsWith('/') ? configuredUrl : `${configuredUrl}/`;
}

export function buildApiUrl(path: string, baseUrl?: string): URL {
  const normalizedPath = path.replace(/^\/+/, '');
  const versionedPath = normalizedPath === 'v1' || normalizedPath.startsWith('v1/')
    ? normalizedPath
    : `v1/${normalizedPath}`;

  return new URL(versionedPath, getConfiguredApiUrl(baseUrl));
}
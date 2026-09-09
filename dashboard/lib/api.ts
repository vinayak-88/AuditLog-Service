import 'server-only';

import { getServerSession } from 'next-auth';
import { authOptions } from './auth';
import { buildApiUrl } from './api-url';

type ApiOptions = {
  query?: Record<string, string | number | undefined>;
  apiKey?: string;
  init?: RequestInit;
};

function buildUrl(path: string, query?: ApiOptions['query']) {
  const url = buildApiUrl(path, process.env.API_URL || process.env.NEXT_PUBLIC_API_URL);

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
  }

  return url;
}

export async function apiFetch<T>(
  path: string,
  options: ApiOptions = {}
): Promise<T | null> {
  const apiKey = options.apiKey || process.env.DASHBOARD_APP_API_KEY;
  const headers = new Headers(options.init?.headers);

  if (apiKey) {
    headers.set('Authorization', `Bearer ${apiKey}`);
  }

  headers.set('Content-Type', 'application/json');

  const response = await fetch(buildUrl(path, options.query), {
    ...options.init,
    headers,
    cache: 'no-store'
  });

  if (!response.ok) return null;

  return (await response.json()) as T;
}

export async function dashboardFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T | null> {
  const session = await getServerSession(authOptions);

  const ownerId = session?.user?.id;

  if (!ownerId) {
    return null;
  }

  const internalKey = process.env.INTERNAL_API_KEY;

  if (!internalKey) {
    throw new Error('INTERNAL_API_KEY must be configured for dashboard API requests');
  }

  const headers = new Headers(init?.headers);

  headers.set('Authorization', `Bearer ${internalKey}`);
  headers.set('x-owner-id', ownerId);
  headers.set('Content-Type', 'application/json');

  const response = await fetch(buildUrl(path), {
    ...init,
    headers,
    cache: 'no-store'
  });

  if (!response.ok) return null;

  return (await response.json()) as T;
}
import 'server-only';

import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from './auth';
import { buildApiUrl } from './api-url';

type ApiOptions = {
  query?: Record<string, string | number | undefined>;
  init?: RequestInit;
};

function buildUrl(path: string, query?: ApiOptions['query']) {
  const apiUrl = process.env.API_URL;

  if (!apiUrl) {
    throw new Error('API_URL must be configured for server-side dashboard API requests');
  }

  const url = buildApiUrl(path, apiUrl);

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
  }

  return url;
}

export async function dashboardFetch<T>(
  path: string,
  options: ApiOptions = {}
): Promise<T | null> {
  const session = await getServerSession(authOptions);

  const ownerId = session?.user?.id;

  if (!ownerId) {
    redirect('/login');
  }

  const internalKey = process.env.INTERNAL_API_KEY;

  if (!internalKey) {
    throw new Error('INTERNAL_API_KEY must be configured for dashboard API requests');
  }

  const headers = new Headers(options.init?.headers);

  headers.set('Authorization', `Bearer ${internalKey}`);
  headers.set('x-owner-id', ownerId);
  headers.set('Content-Type', 'application/json');

  const response = await fetch(buildUrl(path, options.query), {
    ...options.init,
    headers,
    cache: 'no-store'
  });

  if (!response.ok) return null;

  return (await response.json()) as T;
}
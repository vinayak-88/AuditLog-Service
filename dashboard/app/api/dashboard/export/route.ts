import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { authOptions } from '../../../../lib/auth';
import { dashboardRequest } from '../../../../lib/api';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPORT_QUERY_KEYS = [
  'format',
  'actorId',
  'actorType',
  'action',
  'resourceId',
  'resourceType',
  'startDate',
  'endDate',
  'page',
  'limit'
] as const;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!isUuid(body.appId)) {
    return NextResponse.json({ error: 'A valid application ID is required' }, { status: 400 });
  }

  const query: Record<string, string> = {};
  for (const key of EXPORT_QUERY_KEYS) {
    if (typeof body[key] === 'string' || typeof body[key] === 'number') {
      query[key] = String(body[key]);
    }
  }
  query.format ||= 'csv';

  try {
    const response = await dashboardRequest('/v1/export', { appId: body.appId, query });
    if (!response.ok) {
      return NextResponse.json(
        { error: response.status === 403 ? 'Application access denied' : 'Unable to export events' },
        { status: response.status === 400 ? 400 : response.status === 403 ? 403 : response.status === 429 ? 429 : 502 }
      );
    }

    const headers = new Headers();
    const contentType = response.headers.get('content-type');
    const contentDisposition = response.headers.get('content-disposition');
    if (contentType) headers.set('content-type', contentType);
    if (contentDisposition) headers.set('content-disposition', contentDisposition);

    return new Response(response.body, { status: response.status, headers });
  } catch {
    return NextResponse.json({ error: 'Unable to reach the export service' }, { status: 502 });
  }
}

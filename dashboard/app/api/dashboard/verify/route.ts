import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { authOptions } from '../../../../lib/auth';
import { dashboardRequest } from '../../../../lib/api';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type VerifyResponse = {
  success: boolean;
  data?: unknown;
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

async function requireSession() {
  return getServerSession(authOptions);
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  let body: { appId?: unknown };
  try {
    body = (await request.json()) as { appId?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!isUuid(body.appId)) {
    return NextResponse.json({ error: 'A valid application ID is required' }, { status: 400 });
  }

  try {
    const response = await dashboardRequest('/v1/verify', { appId: body.appId });
    if (!response.ok) {
      if (response.status === 409) {
        try {
          return NextResponse.json(await response.json(), { status: 409 });
        } catch {
          return NextResponse.json({ error: 'A verification job is already running' }, { status: 409 });
        }
      }

      return NextResponse.json(
        { error: response.status === 403 ? 'Application access denied' : 'Unable to start verification' },
        { status: response.status === 400 ? 400 : response.status === 403 ? 403 : response.status === 429 ? 429 : 502 }
      );
    }

    const result = (await response.json()) as VerifyResponse;
    return NextResponse.json(result, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Unable to reach the verification service' }, { status: 502 });
  }
}

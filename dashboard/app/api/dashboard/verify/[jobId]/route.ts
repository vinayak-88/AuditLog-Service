import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { authOptions } from '../../../../../lib/auth';
import { dashboardRequest } from '../../../../../lib/api';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type VerifyJobResponse = {
  success: boolean;
  data?: { appId?: string };
};

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export async function GET(request: Request, { params }: { params: { jobId: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const appId = new URL(request.url).searchParams.get('appId');
  if (!isUuid(params.jobId) || !isUuid(appId)) {
    return NextResponse.json({ error: 'A valid application and verification job ID are required' }, { status: 400 });
  }

  try {
    const response = await dashboardRequest(`/v1/verify/${encodeURIComponent(params.jobId)}`, { appId });
    if (!response.ok) {
      return NextResponse.json(
        { error: response.status === 403 ? 'Application access denied' : 'Unable to read verification status' },
        { status: response.status === 404 ? 404 : response.status === 403 ? 403 : 502 }
      );
    }

    const result = (await response.json()) as VerifyJobResponse;
    if (result.data?.appId !== appId) {
      return NextResponse.json({ error: 'Verification job does not belong to this application' }, { status: 404 });
    }

    return NextResponse.json(result, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Unable to reach the verification service' }, { status: 502 });
  }
}

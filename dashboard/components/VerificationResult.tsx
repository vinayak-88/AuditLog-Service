'use client';

import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { buildApiUrl } from '../lib/api-url';

type VerifyData = {
  valid: boolean;
  entriesChecked: number;
  durationMs: number;
  verifiedAt: string;
  tamperedAt?: { sequenceNumber: number; entryId: string };
};

type VerifyJobResponse = {
  success: boolean;
  data?: {
    jobId: string;
    status: 'pending' | 'complete' | 'failed';
    result?: VerifyData;
    error?: string;
  };
};

const VERIFY_POLL_INTERVAL_MS = 500;
const VERIFY_MAX_POLLS = 60;

export function VerificationResult() {
  const [apiKey, setApiKey] = useState('');
  const [result, setResult] = useState<VerifyData | null>(null);
  const [loading, setLoading] = useState(false);

  async function runVerification() {
    setLoading(true);
    setResult(null);

    try {
      const headers = { Authorization: `Bearer ${apiKey}` };
      const response = await fetch(buildApiUrl('/v1/verify', process.env.NEXT_PUBLIC_API_URL), { headers });
      if (!response.ok) return;

      const body = (await response.json()) as VerifyJobResponse;
      const jobId = body.data?.jobId;
      if (!jobId) return;

      for (let poll = 0; poll < VERIFY_MAX_POLLS; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_INTERVAL_MS));
        const jobResponse = await fetch(
          buildApiUrl(`/v1/verify/${encodeURIComponent(jobId)}`, process.env.NEXT_PUBLIC_API_URL),
          { headers }
        );
        if (!jobResponse.ok) return;

        const jobBody = (await jobResponse.json()) as VerifyJobResponse;
        if (jobBody.data?.status === 'complete') {
          setResult(jobBody.data.result ?? null);
          return;
        }
        if (jobBody.data?.status === 'failed') return;
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid">
      <div className="card toolbar">
        <div className="field">
          <label htmlFor="verify-key">API key</label>
          <input
            id="verify-key"
            className="input"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            type="password"
          />
        </div>
        <button className="button" type="button" onClick={runVerification} disabled={!apiKey || loading}>
          <ShieldCheck size={16} aria-hidden />
          {loading ? 'Checking' : 'Verify'}
        </button>
      </div>

      {result ? (
        <div className="card">
          <div className={result.valid ? 'status-ok' : 'status-danger'}>{result.valid ? 'Valid' : 'Tampered'}</div>
          <p>Entries checked: {result.entriesChecked}</p>
          <p>Duration: {result.durationMs} ms</p>
          {result.tamperedAt ? <p>Break point: sequence {result.tamperedAt.sequenceNumber}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

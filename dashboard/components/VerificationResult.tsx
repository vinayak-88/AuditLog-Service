'use client';

import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';

type VerifyData = {
  valid: boolean;
  entriesChecked: number;
  durationMs: number;
  tamperedAt?: { sequenceNumber: number; entryId: string };
};

type VerifyJobResponse = {
  success: boolean;
  data?: {
    jobId: string;
    status: 'pending' | 'complete' | 'failed';
    pollUrl?: string;
    result?: VerifyData;
    error?: string;
  };
};

const VERIFY_POLL_INTERVAL_MS = 500;
const VERIFY_MAX_POLLS = 60;

export function VerificationResult() {
  const [appId, setAppId] = useState('');
  const [result, setResult] = useState<VerifyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runVerification() {
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const response = await fetch('/api/dashboard/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId })
      });
      const body = (await response.json()) as VerifyJobResponse & { error?: string };
      if (!response.ok && response.status !== 409) {
        setError(body.error ?? 'Unable to start verification');
        return;
      }

      const jobId = body.data?.jobId;
      if (!jobId) {
        setError('Verification did not return a job ID');
        return;
      }

      for (let poll = 0; poll < VERIFY_MAX_POLLS; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_INTERVAL_MS));
        const jobResponse = await fetch(`/api/dashboard/verify/${encodeURIComponent(jobId)}?appId=${encodeURIComponent(appId)}`);
        const jobBody = (await jobResponse.json()) as VerifyJobResponse & { error?: string };
        if (!jobResponse.ok) {
          setError(jobBody.error ?? 'Unable to read verification status');
          return;
        }

        if (jobBody.data?.status === 'complete') {
          setResult(jobBody.data.result ?? null);
          return;
        }
        if (jobBody.data?.status === 'failed') {
          setError(jobBody.data.error ?? 'Verification failed');
          return;
        }
      }
      setError('Verification timed out. Please try again.');
    } catch {
      setError('Unable to reach the verification service');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid">
      <div className="card toolbar">
        <div className="field">
          <label htmlFor="verify-app-id">Application ID</label>
          <input
            id="verify-app-id"
            className="input"
            value={appId}
            onChange={(event) => setAppId(event.target.value)}
            placeholder="Application UUID"
          />
        </div>
        <button className="button" type="button" onClick={runVerification} disabled={!appId || loading}>
          <ShieldCheck size={16} aria-hidden />
          {loading ? 'Checking' : 'Verify'}
        </button>
      </div>

      {error ? <div className="card status-danger">{error}</div> : null}

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

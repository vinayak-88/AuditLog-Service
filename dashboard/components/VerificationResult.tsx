'use client';

import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';

type VerifyData = {
  valid: boolean;
  entriesChecked: number;
  durationMs: number;
  verifiedAt: string;
  tamperedAt?: { sequenceNumber: number; entryId: string };
};

export function VerificationResult() {
  const [apiKey, setApiKey] = useState('');
  const [result, setResult] = useState<VerifyData | null>(null);
  const [loading, setLoading] = useState(false);

  async function runVerification() {
    setLoading(true);
    setResult(null);

    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/verify`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const body = await response.json();

    setResult(body.data ?? null);
    setLoading(false);
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

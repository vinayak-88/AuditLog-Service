'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';

export default function ExportPage() {
  const [appId, setAppId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function downloadCsv() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/dashboard/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, format: 'csv' })
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(body.error ?? 'Unable to export events');
        return;
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = 'audit-events.csv';
      anchor.click();
      URL.revokeObjectURL(downloadUrl);
    } catch {
      setError('Unable to reach the export service');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid">
      <div className="topbar">
        <h1 className="page-title">Export</h1>
      </div>
      <div className="card toolbar">
        <div className="field">
          <label htmlFor="export-app-id">Application ID</label>
          <input
            id="export-app-id"
            className="input"
            value={appId}
            onChange={(event) => setAppId(event.target.value)}
            placeholder="Application UUID"
          />
        </div>
        <button
          className="button"
          type="button"
          onClick={downloadCsv}
          disabled={!appId || loading}
          title="Export CSV"
        >
          <Download size={16} aria-hidden />
          {loading ? 'Exporting' : 'CSV'}
        </button>
      </div>
      {error ? <div className="card status-danger">{error}</div> : null}
    </div>
  );
}

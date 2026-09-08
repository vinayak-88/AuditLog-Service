'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';
import { buildApiUrl } from '../../../lib/api-url';

export default function ExportPage() {
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  async function downloadCsv() {
    setLoading(true);
    try {
      const url = buildApiUrl('/v1/export', process.env.NEXT_PUBLIC_API_URL);
      url.searchParams.set('format', 'csv');
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!response.ok) return;

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = 'audit-events.csv';
      anchor.click();
      URL.revokeObjectURL(downloadUrl);
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
          <label htmlFor="export-key">API key</label>
          <input
            id="export-key"
            className="input"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </div>
        <button
          className="button"
          type="button"
          onClick={downloadCsv}
          disabled={!apiKey || loading}
          title="Export CSV"
        >
          <Download size={16} aria-hidden />
          {loading ? 'Exporting' : 'CSV'}
        </button>
      </div>
    </div>
  );
}

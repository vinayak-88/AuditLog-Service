'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';

export default function ExportPage() {
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const baseUrl = process.env.NEXT_PUBLIC_API_URL!;

  async function downloadCsv() {
    setLoading(true);
    const response = await fetch(`${baseUrl}/export?format=csv`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'audit-events.csv';
    anchor.click();
    URL.revokeObjectURL(url);
    setLoading(false);
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

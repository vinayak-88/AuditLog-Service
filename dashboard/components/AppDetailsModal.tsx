'use client';

import { Check, Copy, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export type AppDetails = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  auditLogCount: number;
};

/**
 * Per-app details dialog. All data comes from the already-fetched
 * GET /v1/apps list response — no extra request, no secrets involved.
 * Open/close/copy state is transient component state only.
 */
export function AppDetailsModal({ app }: { app: AppDetails }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
    setCopied(false);
    setCopyError(null);
  }

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open ]);

  async function onCopyId() {
    try {
      await navigator.clipboard.writeText(app.id);
      setCopyError(null);
      setCopied(true);
    } catch {
      setCopyError('Automatic copy failed — select the ID manually');
    }
  }

  return (
    <>
      <button
        className="button secondary button-sm"
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        Details
      </button>
      {open ? (
        <div
          className="modal-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            className="card modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`app-details-title-${app.id}`}
          >
            <div className="modal-header">
              <h2 className="panel-title" id={`app-details-title-${app.id}`}>
                {app.name}
              </h2>
              <button
                ref={closeRef}
                className="button secondary button-sm"
                type="button"
                onClick={close}
                aria-label={`Close details for ${app.name}`}
              >
                <X size={16} aria-hidden />
              </button>
            </div>
            <dl className="detail-list">
              <div>
                <dt className="muted">Description</dt>
                <dd>{app.description ? app.description : <span className="muted">—</span>}</dd>
              </div>
              <div>
                <dt className="muted">Status</dt>
                <dd>
                  <span
                    className={app.isActive ? 'badge badge-active' : 'badge badge-inactive'}
                  >
                    {app.isActive ? 'Active' : 'Inactive'}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="muted">Audit log count</dt>
                <dd className="count">{app.auditLogCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt className="muted">Created</dt>
                <dd>{new Date(app.createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>
                  <label className="muted" htmlFor={`app-id-${app.id}`}>
                    App ID
                  </label>
                </dt>
                <dd>
                  <input
                    id={`app-id-${app.id}`}
                    className="input key-value"
                    value={app.id}
                    readOnly
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </dd>
              </div>
            </dl>
            {copyError ? (
              <div className="form-error" role="alert">
                {copyError}
              </div>
            ) : null}
            <div className="actions">
              <button className="button" type="button" onClick={onCopyId}>
                {copied ? (
                  <Check size={16} aria-hidden />
                ) : (
                  <Copy size={16} aria-hidden />
                )}
                {copied ? 'Copied!' : 'Copy ID'}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={close}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

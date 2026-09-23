'use client';

import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';

type OneTimeKeyPanelProps = {
  title: string;
  subtitle: ReactNode;
  warningTitle: string;
  warningBody: ReactNode;
  apiKey: string;
  onDone: () => void;
  doneLabel?: string;
  inputId?: string;
};

/**
 * Shared one-time API key display. The key lives only in props/state for the
 * duration of this view and is wiped by the caller when Done closes it. It is
 * never persisted to storage, URLs, or server-rendered data.
 */
export function OneTimeKeyPanel({
  title,
  subtitle,
  warningTitle,
  warningBody,
  apiKey,
  onDone,
  doneLabel = 'Done',
  inputId = 'one-time-api-key'
}: OneTimeKeyPanelProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopyError(null);
      setCopied(true);
    } catch {
      setCopyError('Automatic copy failed — select the key manually');
    }
  }

  return (
    <div className="card grid" role="status">
      <div>
        <h2 className="panel-title">{title}</h2>
        <div className="panel-subtitle">{subtitle}</div>
      </div>
      <div className="notice" role="note">
        <strong>{warningTitle}</strong>
        <div>{warningBody}</div>
      </div>
      <div className="field">
        <label htmlFor={inputId}>API key (shown once)</label>
        <input
          id={inputId}
          className="input key-value"
          value={apiKey}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
      </div>
      <div className="actions">
        <button className="button" type="button" onClick={onCopy}>
          {copied ? (
            <Check size={16} aria-hidden />
          ) : (
            <Copy size={16} aria-hidden />
          )}
          {copied ? 'Copied!' : 'Copy key'}
        </button>
        <button className="button secondary" type="button" onClick={onDone}>
          {doneLabel}
        </button>
      </div>
      {copyError ? (
        <div className="form-error" role="alert">
          {copyError}
        </div>
      ) : null}
    </div>
  );
}

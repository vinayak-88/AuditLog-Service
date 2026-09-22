'use client';

import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

type CreatedApp = {
  id: string;
  name: string;
  apiKey: string;
};

type CreateAppResponse = {
  success: boolean;
  data?: CreatedApp;
  error?: string;
};

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

export function CreateAppForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<CreatedApp | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setOpen(false);
    setName('');
    setDescription('');
    setError(null);
    setLoading(false);
    setCreated(null);
    setCopied(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setCopied(false);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('An application name is required');
      return;
    }
    if (trimmedName.length > MAX_NAME_LENGTH) {
      setError('Name must be at most 100 characters');
      return;
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      setError('Description must be at most 500 characters');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/dashboard/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          description: description.trim() ? description.trim() : undefined
        })
      });
      const body = (await response.json()) as CreateAppResponse;
      if (!response.ok || !body.success || !body.data?.apiKey) {
        setError(body.error ?? 'Unable to create application');
        return;
      }
      setCreated(body.data);
    } catch {
      setError('Unable to reach the application service');
    } finally {
      setLoading(false);
    }
  }

  async function onCopy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.apiKey);
      setError(null);
      setCopied(true);
    } catch {
      setError('Automatic copy failed — select the key manually');
    }
  }

  function onDone() {
    reset();
    router.refresh();
  }

  if (!open) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="button" type="button" onClick={() => setOpen(true)}>
          <Plus size={16} aria-hidden />
          Create app
        </button>
      </div>
    );
  }

  if (created) {
    return (
      <div className="card grid">
        <div>
          <strong>{created.name}</strong> was created. Copy the API key now —
          it will not be shown again.
        </div>
        <div className="field">
          <label htmlFor="new-api-key">API key (shown once)</label>
          <input
            id="new-api-key"
            className="input"
            value={created.apiKey}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button className="button" type="button" onClick={onCopy}>
            {copied ? 'Copied!' : 'Copy key'}
          </button>
          <button className="button secondary" type="button" onClick={onDone}>
            Done
          </button>
        </div>
        {error ? <div className="status-danger">{error}</div> : null}
      </div>
    );
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <div className="grid">
        <div className="field">
          <label htmlFor="create-app-name">Name</label>
          <input
            id="create-app-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My application"
            maxLength={MAX_NAME_LENGTH}
            disabled={loading}
          />
        </div>
        <div className="field">
          <label htmlFor="create-app-description">Description (optional)</label>
          <input
            id="create-app-description"
            className="input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this app uses audit logging for"
            maxLength={MAX_DESCRIPTION_LENGTH}
            disabled={loading}
          />
        </div>
        {error ? <div className="status-danger">{error}</div> : null}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button className="button" type="submit" disabled={loading}>
            {loading ? 'Creating…' : 'Create'}
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={reset}
            disabled={loading}
          >
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}

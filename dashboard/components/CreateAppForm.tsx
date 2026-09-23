'use client';

import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { OneTimeKeyPanel } from './OneTimeKeyPanel';

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

  function reset() {
    setOpen(false);
    setName('');
    setDescription('');
    setError(null);
    setLoading(false);
    setCreated(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

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

  function onDone() {
    reset();
    router.refresh();
  }

  if (!open) {
    return (
      <div className="actions actions-end">
        <button className="button" type="button" onClick={() => setOpen(true)}>
          <Plus size={16} aria-hidden />
          Create app
        </button>
      </div>
    );
  }

  if (created) {
    return (
      <OneTimeKeyPanel
        title="Application created"
        subtitle={
          <>
            <strong>{created.name}</strong> is ready to log events.
          </>
        }
        warningTitle="Copy your API key now — it will not be shown again."
        warningBody="Store it somewhere safe. If you lose it, you can rotate the key later to generate a new one."
        apiKey={created.apiKey}
        onDone={onDone}
      />
    );
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <div className="grid">
        <div>
          <h2 className="panel-title">Create application</h2>
          <div className="panel-subtitle">
            Register a new app to get an API key for event logging.
          </div>
        </div>
        <div className="field">
          <label htmlFor="create-app-name">
            Name <span className="muted">(required)</span>
          </label>
          <input
            id="create-app-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My application"
            maxLength={MAX_NAME_LENGTH}
            required
            aria-required="true"
            disabled={loading}
          />
        </div>
        <div className="field">
          <label htmlFor="create-app-description">
            Description <span className="muted">(optional)</span>
          </label>
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
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="actions">
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

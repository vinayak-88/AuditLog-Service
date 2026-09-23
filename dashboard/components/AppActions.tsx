'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { OneTimeKeyPanel } from './OneTimeKeyPanel';

type AppActionsProps = {
  id: string;
  name: string;
};

type PendingAction = 'rotate' | 'deactivate' | null;

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function AppActions({ id, name }: AppActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingAction>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [deactivated, setDeactivated] = useState(false);

  function cancel() {
    setPending(null);
    setError(null);
  }

  function done() {
    setNewKey(null);
    setDeactivated(false);
    setPending(null);
    setError(null);
    router.refresh();
  }

  async function confirmRotate() {
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/dashboard/apps/${encodeURIComponent(id)}/rotate-key`,
        { method: 'POST' }
      );
      if (!response.ok) {
        setError(await readError(response, 'Unable to rotate application key'));
        return;
      }
      const body = (await response.json()) as {
        success: boolean;
        data?: { newApiKey: string };
        error?: string;
      };
      if (!body.success || !body.data?.newApiKey) {
        setError(body.error ?? 'Unable to rotate application key');
        return;
      }
      setPending(null);
      setNewKey(body.data.newApiKey);
    } catch {
      setError('Unable to reach the application service');
    } finally {
      setWorking(false);
    }
  }

  async function confirmDeactivate() {
    setWorking(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/dashboard/apps/${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
      // The backend returns 204 with no body: do not parse JSON on success.
      if (response.status === 204) {
        setPending(null);
        setDeactivated(true);
        return;
      }
      setError(await readError(response, 'Unable to deactivate application'));
    } catch {
      setError('Unable to reach the application service');
    } finally {
      setWorking(false);
    }
  }

  if (newKey) {
    return (
      <OneTimeKeyPanel
        title="API key rotated"
        subtitle={
          <>
            <strong>{name}</strong> has a new API key. The previous key stopped
            working immediately.
          </>
        }
        warningTitle="Copy the new API key now — it will not be shown again."
        warningBody="Update every client using the old key. If you lose the new key, rotate again to generate another one."
        apiKey={newKey}
        onDone={done}
        inputId={`rotate-key-${id}`}
      />
    );
  }

  return (
    <div className="grid">
      {deactivated ? (
        <div className="card" role="status">
          <div className="status-ok">Deactivated</div>
          <div className="panel-subtitle">
            <strong>{name}</strong> no longer accepts its API key. Existing
            audit logs are preserved.
          </div>
          <div className="actions" style={{ marginTop: '8px' }}>
            <button className="button secondary button-sm" type="button" onClick={done}>
              Done
            </button>
          </div>
        </div>
      ) : pending ? (
        <div className="notice" role="group" aria-label={`Confirm ${pending === 'rotate' ? 'key rotation' : 'deactivation'} for ${name}`}>
          <div>
            {pending === 'rotate' ? (
              <>
                <strong>Rotate the API key for {name}?</strong>
                <div>The current key will stop working immediately.</div>
              </>
            ) : (
              <>
                <strong>Deactivate {name}?</strong>
                <div>
                  It will stop accepting its current API key. Existing audit
                  logs are preserved.
                </div>
              </>
            )}
          </div>
          <div className="actions" style={{ marginTop: '8px' }}>
            <button
              className={pending === 'rotate' ? 'button button-sm' : 'button danger button-sm'}
              type="button"
              onClick={pending === 'rotate' ? confirmRotate : confirmDeactivate}
              disabled={working}
            >
              {working ? 'Working…' : pending === 'rotate' ? 'Confirm rotate' : 'Confirm deactivate'}
            </button>
            <button
              className="button secondary button-sm"
              type="button"
              onClick={cancel}
              disabled={working}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button
            className="button secondary button-sm"
            type="button"
            onClick={() => {
              setError(null);
              setPending('rotate');
            }}
          >
            Rotate key
          </button>
          <button
            className="button danger button-sm"
            type="button"
            onClick={() => {
              setError(null);
              setPending('deactivate');
            }}
          >
            Deactivate
          </button>
        </div>
      )}
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

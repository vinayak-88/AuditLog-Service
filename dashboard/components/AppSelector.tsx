import Link from 'next/link';

type AppSelectorProps = {
  apps: Array<{ id: string; name: string }>;
  selectedAppId: string;
  basePath: string;
  query?: Record<string, string | undefined>;
};

/**
 * Explicit per-app context switcher. Rendered only when the owner has more
 * than one app; the chosen app ID travels as a page query parameter and is
 * sent back to the API as x-app-id by server-side dashboard requests.
 */
export function AppSelector({ apps, selectedAppId, basePath, query = {} }: AppSelectorProps) {
  if (apps.length < 2) return null;

  return (
    <div className="card">
      <div className="field">
        <label>Application</label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {apps.map((app) => {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(query)) {
              if (value !== undefined && value !== '') {
                params.set(key, value);
              }
            }
            params.set('appId', app.id);
            const href = `${basePath}?${params.toString()}`;
            return app.id === selectedAppId ? (
              <span key={app.id} className="button" aria-current="true">
                {app.name}
              </span>
            ) : (
              <Link key={app.id} className="button secondary" href={href}>
                {app.name}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

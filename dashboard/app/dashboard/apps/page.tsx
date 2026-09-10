import { dashboardFetch } from '../../../lib/api';

export const dynamic = 'force-dynamic';

type AppsResponse = {
  success: true;
  data: {
    apps: Array<{
      id: string;
      name: string;
      description: string | null;
      isActive: boolean;
      createdAt: string;
      _count: { auditLogs: number };
    }>;
  };
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load applications';
}

export default async function AppsPage() {
  let apps: AppsResponse['data']['apps'];
  try {
    const response = await dashboardFetch<AppsResponse>('/v1/apps');
    apps = response.data.apps;
  } catch (error) {
    return (
      <div className="grid">
        <div className="topbar">
          <h1 className="page-title">Apps</h1>
        </div>
        <div className="card status-danger">{toErrorMessage(error)}</div>
      </div>
    );
  }

  return (
    <div className="grid">
      <div className="topbar">
        <h1 className="page-title">Apps</h1>
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Events</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <tr key={app.id}>
                <td>
                  {app.name}
                  <div className="muted">{app.description}</div>
                </td>
                <td>{app.isActive ? 'Active' : 'Inactive'}</td>
                <td>{app._count.auditLogs}</td>
                <td>{new Date(app.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {apps.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  No apps registered.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

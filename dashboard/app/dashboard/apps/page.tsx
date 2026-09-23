import { KeyRound } from 'lucide-react';
import { AppActions } from '../../../components/AppActions';
import { CreateAppForm } from '../../../components/CreateAppForm';
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
        <div>
          <h1 className="page-title">Apps</h1>
          <p className="page-subtitle">
            {apps.length === 1 ? '1 application' : `${apps.length} applications`}
          </p>
        </div>
      </div>
      <CreateAppForm />
      {apps.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            <KeyRound size={20} />
          </div>
          <div className="empty-state-title">No apps registered yet</div>
          <div className="muted">
            Create your first app to get an API key and start logging events.
          </div>
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Events</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <tr key={app.id}>
                  <td>
                    <div className="app-name">{app.name}</div>
                    {app.description ? (
                      <div className="app-description">{app.description}</div>
                    ) : null}
                  </td>
                  <td>
                    <span
                      className={app.isActive ? 'badge badge-active' : 'badge badge-inactive'}
                    >
                      {app.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="count">{app._count.auditLogs.toLocaleString()}</td>
                  <td>{new Date(app.createdAt).toLocaleString()}</td>
                  <td>
                    <AppActions id={app.id} name={app.name} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

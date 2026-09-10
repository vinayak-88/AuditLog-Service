import { AppSelector } from '../../components/AppSelector';
import { EventTable } from '../../components/EventTable';
import { StatsCards } from '../../components/StatsCards';
import { dashboardFetch } from '../../lib/api';
import { resolveSelectedAppId, type OwnerAppSummary } from '../../lib/app-selection';

export const dynamic = 'force-dynamic';

type EventsResponse = {
  success: true;
  data: {
    events: Array<{
      id: string;
      actorId: string;
      actorType: string;
      action: string;
      resourceId: string;
      resourceType: string;
      sequenceNumber: number;
      createdAt: string;
    }>;
    pagination: { total: number };
  };
};

type AppsResponse = {
  success: true;
  data: { apps: OwnerAppSummary[] };
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load dashboard data';
}

export default async function DashboardPage({
  searchParams
}: {
  searchParams: Record<string, string | undefined>;
}) {
  let apps: OwnerAppSummary[] = [];
  try {
    const response = await dashboardFetch<AppsResponse>('/v1/apps');
    apps = response.data.apps;
  } catch (error) {
    return (
      <div className="grid">
        <div className="topbar">
          <h1 className="page-title">Overview</h1>
        </div>
        <div className="card status-danger">{toErrorMessage(error)}</div>
      </div>
    );
  }

  const selectedAppId = resolveSelectedAppId(apps, searchParams.appId);

  if (!selectedAppId) {
    return (
      <div className="grid">
        <div className="topbar">
          <h1 className="page-title">Overview</h1>
        </div>
        <div className="card table-wrap">
          <span className="muted">No apps registered.</span>
        </div>
      </div>
    );
  }

  let events: EventsResponse['data']['events'] = [];
  let total = 0;
  try {
    const response = await dashboardFetch<EventsResponse>('/v1/events', {
      query: { limit: 10 },
      appId: selectedAppId
    });
    events = response.data.events;
    total = response.data.pagination.total;
  } catch (error) {
    return (
      <div className="grid">
        <div className="topbar">
          <h1 className="page-title">Overview</h1>
        </div>
        <AppSelector apps={apps} selectedAppId={selectedAppId} basePath="/dashboard" />
        <div className="card status-danger">{toErrorMessage(error)}</div>
      </div>
    );
  }

  return (
    <div className="grid">
      <div className="topbar">
        <h1 className="page-title">Overview</h1>
      </div>
      <AppSelector apps={apps} selectedAppId={selectedAppId} basePath="/dashboard" />
      <StatsCards
        total={total}
        last24h={events.filter((event) => Date.now() - new Date(event.createdAt).getTime() < 86400000).length}
        topAction={events[0]?.action ?? 'None'}
        chainStatus="Unchecked"
      />
      <EventTable events={events} />
    </div>
  );
}

import { AppSelector } from '../../../components/AppSelector';
import { EventTable } from '../../../components/EventTable';
import { SearchFilters } from '../../../components/SearchFilters';
import { dashboardFetch } from '../../../lib/api';
import { resolveSelectedAppId, type OwnerAppSummary } from '../../../lib/app-selection';

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
  };
};

type AppsResponse = {
  success: true;
  data: { apps: OwnerAppSummary[] };
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load events';
}

export default async function EventsPage({
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
          <h1 className="page-title">Events</h1>
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
          <h1 className="page-title">Events</h1>
        </div>
        <div className="card table-wrap">
          <span className="muted">No apps registered.</span>
        </div>
      </div>
    );
  }

  // appId is page context, not a backend search filter.
  const filters = { ...searchParams };
  delete filters.appId;

  let events: EventsResponse['data']['events'] = [];
  try {
    const response = await dashboardFetch<EventsResponse>('/v1/events', {
      query: filters,
      appId: selectedAppId
    });
    events = response.data.events;
  } catch (error) {
    return (
      <div className="grid">
        <div className="topbar">
          <h1 className="page-title">Events</h1>
        </div>
        <AppSelector apps={apps} selectedAppId={selectedAppId} basePath="/dashboard/events" query={filters} />
        <div className="card status-danger">{toErrorMessage(error)}</div>
      </div>
    );
  }

  return (
    <div className="grid">
      <div className="topbar">
        <h1 className="page-title">Events</h1>
      </div>
      <AppSelector apps={apps} selectedAppId={selectedAppId} basePath="/dashboard/events" query={filters} />
      <SearchFilters />
      <EventTable events={events} />
    </div>
  );
}

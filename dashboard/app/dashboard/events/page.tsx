import { EventTable } from '../../../components/EventTable';
import { SearchFilters } from '../../../components/SearchFilters';
import { dashboardFetch } from '../../../lib/api';

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

export default async function EventsPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const response = await dashboardFetch<EventsResponse>('/v1/events', { query: searchParams });

  return (
    <div className="grid">
      <div className="topbar">
        <h1 className="page-title">Events</h1>
      </div>
      <SearchFilters />
      <EventTable events={response?.data.events ?? []} />
    </div>
  );
}

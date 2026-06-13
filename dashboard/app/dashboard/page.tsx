import { EventTable } from '../../components/EventTable';
import { StatsCards } from '../../components/StatsCards';
import { apiFetch } from '../../lib/api';

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

export default async function DashboardPage() {
  const response = await apiFetch<EventsResponse>('/events', { query: { limit: 10 } });
  const events = response?.data.events ?? [];

  return (
    <div className="grid">
      <div className="topbar">
        <h1 className="page-title">Overview</h1>
      </div>
      <StatsCards
        total={response?.data.pagination.total ?? 0}
        last24h={events.filter((event) => Date.now() - new Date(event.createdAt).getTime() < 86400000).length}
        topAction={events[0]?.action ?? 'None'}
        chainStatus="Unchecked"
      />
      <EventTable events={events} />
    </div>
  );
}

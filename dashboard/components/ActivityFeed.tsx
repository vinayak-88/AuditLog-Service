type ActivityEntry = {
  id: string;
  actorId: string;
  action: string;
  resourceId: string;
  createdAt: string;
};

export function ActivityFeed({ events }: { events: ActivityEntry[] }) {
  return (
    <div className="card">
      <h2>Recent Activity</h2>
      <div className="grid">
        {events.map((event) => (
          <div key={event.id}>
            <strong>{event.action}</strong>
            <div className="muted">
              {event.actorId} on {event.resourceId} at {new Date(event.createdAt).toLocaleString()}
            </div>
          </div>
        ))}
        {events.length === 0 ? <div className="muted">No recent activity.</div> : null}
      </div>
    </div>
  );
}

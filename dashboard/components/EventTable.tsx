type EventRow = {
  id: string;
  actorId: string;
  actorType: string;
  action: string;
  resourceId: string;
  resourceType: string;
  sequenceNumber: number;
  createdAt: string;
};

export function EventTable({ events }: { events: EventRow[] }) {
  return (
    <div className="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>Seq</th>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Resource</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{event.sequenceNumber}</td>
              <td>{new Date(event.createdAt).toLocaleString()}</td>
              <td>
                {event.actorId}
                <div className="muted">{event.actorType}</div>
              </td>
              <td>{event.action}</td>
              <td>{event.resourceId}</td>
              <td>{event.resourceType}</td>
            </tr>
          ))}
          {events.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                No events found.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

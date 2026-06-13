type StatsCardsProps = {
  total: number;
  last24h: number;
  topAction: string;
  chainStatus: string;
};

export function StatsCards({ total, last24h, topAction, chainStatus }: StatsCardsProps) {
  const stats = [
    ['Total events', total.toLocaleString()],
    ['Last 24h', last24h.toLocaleString()],
    ['Top action', topAction],
    ['Chain status', chainStatus]
  ];

  return (
    <section className="grid stats">
      {stats.map(([label, value]) => (
        <div className="card" key={label}>
          <div className="muted">{label}</div>
          <div className="stat-value">{value}</div>
        </div>
      ))}
    </section>
  );
}

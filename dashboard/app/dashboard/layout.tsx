import { getServerSession } from 'next-auth';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Activity, Download, KeyRound, LayoutDashboard, Search, ShieldCheck } from 'lucide-react';
import { SignOutButton } from '../../components/AuthControls';
import { authOptions } from '../../lib/auth';

const nav = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/events', label: 'Events', icon: Search },
  { href: '/dashboard/verify', label: 'Verify', icon: ShieldCheck },
  { href: '/dashboard/export', label: 'Export', icon: Download },
  { href: '/dashboard/apps', label: 'Apps', icon: KeyRound }
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect('/login');

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Activity size={22} aria-hidden />
          Audit Log
        </div>
        <nav className="nav">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href}>
                <Icon size={17} aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <SignOutButton />
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

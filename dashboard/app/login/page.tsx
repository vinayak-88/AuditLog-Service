import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { GitHubSignInButton } from '../../components/AuthControls';
import { authOptions } from '../../lib/auth';

export default async function LoginPage() {
  const session = await getServerSession(authOptions);
  if (session) redirect('/dashboard');

  return (
    <main className="auth-page">
      <section className="card auth-panel">
        <h1 className="page-title">Audit Log</h1>
        <p className="muted">Sign in to view the audit dashboard.</p>
        <GitHubSignInButton />
      </section>
    </main>
  );
}

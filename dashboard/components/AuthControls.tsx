'use client';

import { Github, LogOut } from 'lucide-react';
import { signIn, signOut } from 'next-auth/react';

export function GitHubSignInButton() {
  return (
    <button className="button" type="button" onClick={() => signIn('github', { callbackUrl: '/dashboard' })}>
      <Github size={16} aria-hidden />
      Continue with GitHub
    </button>
  );
}

export function SignOutButton() {
  return (
    <button className="button secondary" type="button" onClick={() => signOut({ callbackUrl: '/login' })}>
      <LogOut size={16} aria-hidden />
      Sign out
    </button>
  );
}

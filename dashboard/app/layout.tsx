import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Audit Log Service',
  description: 'Tamper-evident audit trail dashboard'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

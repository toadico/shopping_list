import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Shared Shopping List',
  description: 'Self-hosted collaborative shopping list with offline cache, background sync, and QR onboarding',
  manifest: '/manifest.json',
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
};

export const viewport: Viewport = {
  themeColor: '#10b981',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en">
      <body data-csp-nonce={nonce}>{children}</body>
    </html>
  );
}

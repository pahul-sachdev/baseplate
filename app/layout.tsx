import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import Link from 'next/link';

import { readQuotaToday } from '../src/db/readModels.ts';
import './globals.css';
import { QuotaMeter } from './components/QuotaMeter.tsx';
import { ThemeToggle, themeInitScript } from './theme.tsx';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'BasePlate',
  description: 'LEGO reselling valuation tool',
};

/** Placeholder mark in a fixed slot — a neutral glyph, not a designed logo. Swap freely. */
function LogoMark() {
  return (
    <span
      aria-hidden="true"
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-surface"
      /* LOGO SLOT: replace the SVG below. Keep the 32x32 box so the header does not reflow. */
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="8" width="18" height="11" rx="2" />
        <path d="M8 8V6.5A1.5 1.5 0 0 1 9.5 5h5A1.5 1.5 0 0 1 16 6.5V8" strokeLinecap="round" />
      </svg>
    </span>
  );
}

const NAV = [
  { href: '/', label: 'Lookup' },
  { href: '/watchlist', label: 'Watchlist' },
  { href: '/trending', label: 'Trending' },
  { href: '/retiring', label: 'Retiring' },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Cache-only read: counting rows never spends a request.
  const quota = await readQuotaToday();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        {/* Sticky, and it stays the app header on every route including the detail view. z-30
            clears the z-20 controls inside cards; those are contained by `isolate` on each card
            anyway, so this is headroom rather than a fight. bg-surface is opaque in both themes. */}
        <header className="sticky top-0 z-30 border-b border-border bg-surface">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
            <Link href="/" className="flex items-center gap-2.5">
              <LogoMark />
              <span className="text-lg font-semibold tracking-tight">BasePlate</span>
            </Link>

            <nav className="flex items-center gap-1">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors duration-150 hover:bg-bg hover:text-text"
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="ml-auto flex items-center gap-3">
              <QuotaMeter quota={quota} />
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-5 py-8">{children}</main>
      </body>
    </html>
  );
}

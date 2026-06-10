import type { Metadata } from 'next';
import './globals.css';

// System serif (Iowan/Palatino/Charter) via globals.css --font-sans — mirrors the
// study portal; no next/font (Geist) so the two apps share one typographic system.
export const metadata: Metadata = {
  title: 'Specification Design — Analysis',
  description: 'Codebook + session analysis workbench',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

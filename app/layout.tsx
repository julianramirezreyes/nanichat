import type { Metadata } from 'next';
import './globals.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Local Social Automation',
  description: 'Local-first social account automation',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es"><body>{children}</body></html>;
}

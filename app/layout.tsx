import type { Metadata } from 'next';
// Self-hosted variable fonts (OFL-1.1): the app runs offline, so nothing is loaded from a CDN.
import '@fontsource-variable/inter';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';

export const metadata: Metadata = {
  title: 'Local Social Automation',
  description: 'Local-first social account automation',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es"><body>{children}</body></html>;
}

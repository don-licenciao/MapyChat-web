import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MapyChat Web',
  description: 'Chat seguro con Grok de xAI usando streaming SSE',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="bg-gray-900 text-white">
      <body className="min-h-screen bg-gray-900 text-white">{children}</body>
    </html>
  );
}

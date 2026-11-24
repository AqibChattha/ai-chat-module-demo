import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Assistant',
  description: 'Chat with an AI assistant. Answers stream in as they are written.',
  robots: { index: false }, // a signed-in chat page should not be indexed
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

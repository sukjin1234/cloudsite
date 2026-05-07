import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Personal Cloud",
  description: "A private Supabase-backed cloud file cabinet"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "내 클라우드",
  description: "나만의 파일과 폴더를 안전하게 보관하는 공간"
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

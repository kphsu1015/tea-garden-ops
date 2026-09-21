import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "茶香花園民宿｜內部採購與庫存",
  description: "茶香花園民宿內部採購、庫存與交接管理系統",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
      nosnippet: true,
    },
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}

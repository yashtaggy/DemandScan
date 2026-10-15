import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Suspense } from "react";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DemandScan — NSE Stock Scanner",
  description:
    "Personal NSE stock market scanner powered by Zerodha Kite Connect. Search, filter, and analyse Nifty 500 stocks in real time.",
  robots: { index: false, follow: false }, // Private tool — do not index
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-slate-950 text-slate-100`}
      >
        {/* Suspense boundary required for useSearchParams() in client components */}
        <Suspense>{children}</Suspense>
      </body>
    </html>
  );
}

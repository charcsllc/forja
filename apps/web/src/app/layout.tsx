// src/app/layout.tsx
import React from "react";
import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { GlobalErrorCatcher } from "@/components/GlobalErrorCatcher";
import { Toaster } from "@/components/ui/sonner";
import { InsufficientCreditsModal } from "@/components/workspace/InsufficientCreditsModal";
import { BRAND } from "@/lib/brand";

/*
  ⭐ Geist stands in for the reference's licensed grotesk: same neutral voice, a variable
  weight axis (the "medium" of this theme is 480, not 500) and free.
  Vendored (latin subset, variable 100–900, SIL OFL 1.1 — see ./fonts/OFL.txt) rather than
  `next/font/google`, so builds never fetch from Google Fonts and work offline.
*/
const geistSans = localFont({
  src: "./fonts/geist-latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});
const geistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

/* The favicon is `src/app/icon.svg`, picked up by Next automatically. */
export const metadata: Metadata = {
  title: BRAND.metaTitle,
  description: BRAND.metaDescription,
  applicationName: BRAND.name,
  openGraph: {
    title: BRAND.metaTitle,
    description: BRAND.metaDescription,
    siteName: BRAND.name,
    type: "website",
  },
  twitter: { card: "summary_large_image", title: BRAND.metaTitle, description: BRAND.metaDescription },
};

// SUPER IMPORTANT: NOT EDIT THE FOLLOWING 2 LINES TO FORCE NEXT.JS TO RENDER DYNAMICALLY
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <GlobalErrorCatcher />
        <Toaster position="top-right" richColors />
        {/*
          ⭐ MOUNTED ONCE FOR THE WHOLE APP. Running out of credits can happen on any
          screen, and the modal listens for the event the VCaaS client raises rather
          than being wired per page. See `InsufficientCreditsModal`.
        */}
        <InsufficientCreditsModal />
        <div className="min-h-screen flex flex-col">
          <main className="flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}

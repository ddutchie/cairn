import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: "Cairn — Notes & Projects",
  description: "A calm, local-first workspace for notes and project tracking",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full flex flex-col bg-[var(--background)]">
        <Script id="theme-init" strategy="beforeInteractive">{`
          (function() {
            try {
              if (typeof Element !== 'undefined' && Element.prototype.releasePointerCapture) {
                var original = Element.prototype.releasePointerCapture;
                Element.prototype.releasePointerCapture = function(pointerId) {
                  try {
                    original.call(this, pointerId);
                  } catch (e) {}
                };
              }
            } catch (e) {}

            try {
              var raw = localStorage.getItem('cairn:v1:theme');
              var t = raw ? JSON.parse(raw) : 'dark';
              var resolved = t === 'light' ? 'light' : t === 'system'
                ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
                : 'dark';
              document.documentElement.setAttribute('data-theme', resolved);
            } catch(e) {
              document.documentElement.setAttribute('data-theme', 'dark');
            }
          })();
        `}</Script>
        <TooltipProvider delayDuration={400}>{children}</TooltipProvider>
      </body>
    </html>
  );
}

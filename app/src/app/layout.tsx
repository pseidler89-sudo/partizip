import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Partizip — Kommunale Beteiligung",
    template: "%s · Partizip",
  },
  description:
    "Überparteiliche Plattform für kommunale Beteiligung: verständliche Ratsinformationen und nachvollziehbare Anliegen.",
  // Vorschaukarten für geteilte Links (das Bild kommt aus opengraph-image.tsx
  // — App-Router-Konvention, Next verdrahtet og:image automatisch).
  openGraph: {
    siteName: "Partizip",
    locale: "de_DE",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="de"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50
                     focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm
                     focus:font-medium focus:text-pz-ink focus:shadow focus:ring-2 focus:ring-[color:var(--pz-brand)]"
        >
          Zum Inhalt springen
        </a>
        {children}
      </body>
    </html>
  );
}

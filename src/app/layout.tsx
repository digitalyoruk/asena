import type { Metadata } from "next";
import { Fraunces, Manrope } from "next/font/google";
import "./globals.css";

const display = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
});

const sans = Manrope({
  variable: "--font-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Asena - Bankalar için kurye optimizasyonu",
  description:
    "Asena, bankalar için kurye rota optimizasyonu ve AI ses asistanı. Mitolojideki koruyucu gibi operasyona yol gösterir.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="tr"
      className={`${display.variable} ${sans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}

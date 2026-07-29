import type { ReactNode } from "react";
import { currentConfig, dbAvailable } from "@/lib/data";
import "./globals.css";

export const metadata = {
  title: "LPing Bot",
  description: "Meteora DLMM Paper-Trading & Analyse",
};

export const dynamic = "force-dynamic";

const TABS = [
  { href: "/", label: "Vergleich" },
  { href: "/positionen", label: "Positionen" },
  { href: "/scanner", label: "Scanner" },
  { href: "/parameter", label: "Parameter" },
];

export default async function RootLayout({ children }: { children: ReactNode }) {
  const db = await dbAvailable();
  let paperTrading = true;
  if (db.ok) {
    try {
      paperTrading = (await currentConfig()).global.paperTrading;
    } catch {
      // Bei defekter Config bleibt der sichere Default stehen.
    }
  }

  return (
    <html lang="de">
      <body>
        <header className="topbar">
          <span className="brand">LPing Bot</span>
          <nav className="tabs">
            {TABS.map((tab) => (
              <a key={tab.href} href={tab.href}>
                {tab.label}
              </a>
            ))}
          </nav>
          <span className={`paper-badge${paperTrading ? "" : " live"}`}>
            {paperTrading ? "PAPER-TRADING" : "⚠ LIVE-MODUS"}
          </span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}

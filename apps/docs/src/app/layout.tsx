import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import { Inter, Outfit } from "next/font/google";
import type { ReactNode } from "react";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

export const metadata = {
  metadataBase: new URL("https://oqronkit.rohittiwari.me"),
  title: {
    template: "%s | OqronKit",
    default: "OqronKit — Background Job Engine for Node.js",
  },
  description:
    "Crash-safe, and framework-agnostic backend orchestration engine for Node.js. 12 modules — task queues, distributed workers, schedulers, rate limiters, webhooks, sagas, workflow DAGs, and more. Adapter-driven architecture with Memory, Redis, and Postgres support.",
  keywords: [
    "OqronKit",
    "background jobs Node.js",
    "distributed task queue",
    "job scheduler TypeScript",
    "crash-safe worker",
    "Node.js job engine",
    "distributed worker",
    "rate limiter Node.js",
    "webhook engine",
    "saga orchestrator",
    "workflow DAG",
    "cron scheduler",
    "batch processing",
    "pipeline ETL",
    "pub/sub Node.js",
    "Redis job queue",
    "Postgres job queue",
    "background processing",
    "horizontal scaling",
    "microservices orchestration",
    "adapter-driven architecture",
    "stall detection",
    "heartbeat locks",
    "idempotent jobs",
    "framework agnostic",
    "TypeScript",
    "Node.js",
    "enterprise queue",
    "BullMQ alternative",
    "Inngest alternative",
    "Celery Node.js",
  ],
  authors: [{ name: "Rohit Tiwari", url: "https://rohittiwari.me" }],
  creator: "Rohit Tiwari",
  publisher: "Rohit Tiwari",
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://oqronkit.rohittiwari.me",
    siteName: "OqronKit",
    title: "OqronKit — Background Job Engine for Node.js",
    description:
      "Crash-safe backend orchestration engine with 12 modules. Adapter-driven architecture — Memory, Redis, Postgres. Zero vendor lock-in.",
  },
  twitter: {
    card: "summary_large_image",
    title: "OqronKit — Background Job Engine for Node.js",
    description:
      "Crash-safe background jobs, distributed workers, schedulers, rate limiters, webhooks, sagas — 12 modules for Node.js.",
    creator: "@rohittiwari_dev",
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${outfit.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}

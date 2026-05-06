import type { Metadata } from "next";
import { Community } from "@/components/landing/community";
import { Features } from "@/components/landing/features";
import { Footer } from "@/components/landing/footer";
import { Hero } from "@/components/landing/hero";
import { ModuleGrid } from "@/components/landing/module-grid";
import { QuickStart } from "@/components/landing/quick-start";

export const metadata: Metadata = {
  metadataBase: new URL("https://oqronkit.rohittiwari.me"),
  title: {
    absolute: "OqronKit — Enterprise Background Job Engine for Node.js",
  },
  description:
    "Industry-grade, crash-safe backend orchestration engine for Node.js. 12 enterprise modules — task queues, distributed workers, schedulers, rate limiters, webhooks, sagas, workflow DAGs, and more. Adapter-driven with Memory, Redis, and Postgres.",
  keywords: [
    "OqronKit",
    "background jobs Node.js",
    "distributed task queue",
    "job scheduler TypeScript",
    "crash-safe worker",
    "Node.js job engine",
    "rate limiter",
    "webhook engine",
    "saga orchestrator",
    "workflow DAG",
    "cron scheduler Node.js",
    "batch processing",
    "Redis job queue",
    "Postgres job queue",
    "BullMQ alternative",
    "Inngest alternative",
    "enterprise queue",
    "adapter-driven architecture",
    "horizontal scaling",
    "microservices orchestration",
    "stall detection heartbeat",
    "idempotent background jobs",
    "TypeScript",
    "Node.js",
  ],
  openGraph: {
    siteName: "OqronKit",
    title: "OqronKit — Enterprise Background Job Engine for Node.js",
    description:
      "Crash-safe background jobs, distributed workers, schedulers, rate limiters, webhooks, sagas — 12 enterprise modules. Adapter-driven with Memory, Redis, and Postgres.",
    url: "https://oqronkit.rohittiwari.me",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "OqronKit — Enterprise Background Job Engine for Node.js",
    description:
      "12 enterprise modules for background computation — crash-safe, adapter-driven, horizontally scalable. Task queues, workers, schedulers, and more.",
  },
  alternates: {
    canonical: "/",
  },
};

export default function HomePage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    url: "https://oqronkit.rohittiwari.me",
    name: "OqronKit",
    alternateName: ["Oqron Kit", "oqronkit"],
    description:
      "Industry-grade, crash-safe backend orchestration engine for Node.js with 12 enterprise modules.",
    publisher: {
      "@type": "Person",
      name: "Rohit Tiwari",
      url: "https://rohittiwari.me",
    },
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate:
          "https://oqronkit.rohittiwari.me/docs?search={search_term_string}",
      },
      "query-input": "required name=search_term_string",
    },
  };

  return (
    <div className="flex flex-col min-h-screen w-full">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: safe as we control the content
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Hero />
      <QuickStart />
      <ModuleGrid />
      <Features />
      <Community />
      <Footer />
    </div>
  );
}

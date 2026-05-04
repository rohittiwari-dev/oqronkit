"use client";

import { motion } from "framer-motion";
import {
  ArrowRight,
  Database,
  Globe,
  Layers,
  Lock,
  Shield,
  Zap,
} from "lucide-react";
import Link from "next/link";

const FEATURES = [
  {
    icon: Shield,
    title: "Crash-safe by default",
    description:
      "Heartbeat locks, automatic stall detection, and job reclamation. If a worker crashes, OqronKit recovers the job within ~15 seconds.",
    href: "/docs/crash-safety",
    accent: "#e11d48",
  },
  {
    icon: Layers,
    title: "Adapter-driven architecture",
    description:
      "Memory for dev, Redis or Postgres for production. Switch adapters with zero code changes — from monolith to microservices.",
    href: "/docs/adapters",
    accent: "#f97316",
  },
  {
    icon: Zap,
    title: "Horizontal scaling",
    description:
      "Every module scales natively across processes and machines. Sharded leader election prevents thundering herds.",
    href: "/docs/architecture",
    accent: "#eab308",
  },
  {
    icon: Lock,
    title: "Guaranteed delivery",
    description:
      "guaranteedWorker enables heartbeat-based locks across all modules. Jobs are never lost, even during process crashes.",
    href: "/docs/crash-safety",
    accent: "#ec4899",
  },
  {
    icon: Database,
    title: "Three storage backends",
    description:
      "In-Memory for development, Redis for high-throughput, PostgreSQL for durability. All adapters share a unified contract.",
    href: "/docs/adapters",
    accent: "#f43f5e",
  },
  {
    icon: Globe,
    title: "Framework agnostic",
    description:
      "Express, Fastify, Hono, NestJS — attach the admin API to any HTTP server. No vendor lock-in, ever.",
    href: "/docs/architecture",
    accent: "#fb923c",
  },
] as const;

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: "easeOut" as const },
  },
};

export function Features() {
  return (
    <section className="relative py-24 overflow-hidden border-t border-fd-border/40">
      <div className="container max-w-6xl mx-auto px-4 relative z-10">
        <div className="text-center mb-14">
          <motion.h2
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-3xl sm:text-4xl font-bold tracking-tight text-fd-foreground mb-4"
          >
            Why OqronKit
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.05 }}
            className="text-fd-muted-foreground text-lg max-w-xl mx-auto"
          >
            Built for production from day one. One cohesive TypeScript engine —
            crash-safe, adapter-driven, and open source.
          </motion.p>
        </div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {FEATURES.map((feat) => {
            const Icon = feat.icon;
            return (
              <motion.div key={feat.title} variants={fadeUp}>
                <Link
                  href={feat.href}
                  className="group flex flex-col h-full rounded-xl border border-fd-border bg-fd-card/60 backdrop-blur-sm p-6 transition-all duration-200 hover:border-fd-border/80 hover:bg-fd-card/80 hover:shadow-lg"
                >
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-lg mb-4"
                    style={{
                      background: `${feat.accent}12`,
                      border: `1px solid ${feat.accent}25`,
                    }}
                  >
                    <Icon
                      className="h-[18px] w-[18px]"
                      style={{ color: feat.accent }}
                    />
                  </div>
                  <h3 className="text-base font-semibold text-fd-foreground mb-2">
                    {feat.title}
                  </h3>
                  <p className="text-sm text-fd-muted-foreground leading-relaxed flex-1">
                    {feat.description}
                  </p>
                  <div className="flex items-center gap-1 mt-4 text-xs font-medium text-fd-muted-foreground group-hover:text-fd-foreground transition-colors">
                    Learn more
                    <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
}

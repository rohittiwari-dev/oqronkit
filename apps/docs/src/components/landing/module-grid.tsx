"use client";

import { motion } from "framer-motion";
import {
  ArrowRight,
  Box,
  ChevronRight,
  Clock,
  Cpu,
  HardDrive,
  Layers,
  LayoutGrid,
  Network,
  Radio,
  Repeat,
  Shield,
  Zap,
} from "lucide-react";
import Link from "next/link";

const MODULES = [
  {
    name: "Task Queue",
    description:
      "FIFO, LIFO, priority ordering with crash-safe processing and automatic retries.",
    icon: Box,
    href: "/docs/task-queue",
    accent: "#e11d48",
    status: "stable",
  },
  {
    name: "Distributed Worker",
    description:
      "Decoupled publisher/consumer architecture with heartbeat locks and stall detection.",
    icon: Cpu,
    href: "/docs/distributed-worker",
    accent: "#f43f5e",
    status: "stable",
  },
  {
    name: "Scheduler & Cron",
    description:
      "Cron expressions, RRule, one-shot and recurring schedules with leader election.",
    icon: Clock,
    href: "/docs/scheduler",
    accent: "#f97316",
    status: "stable",
  },
  {
    name: "Rate Limiter",
    description:
      "Sliding-window, fixed-window, and token bucket algorithms with auto-ban tiers.",
    icon: Shield,
    href: "/docs/rate-limiter",
    accent: "#eab308",
    status: "stable",
  },
  {
    name: "Webhook",
    description:
      "Reliable outbound delivery with HMAC signing, circuit breakers, and dead letter queues.",
    icon: Zap,
    href: "/docs/webhook",
    accent: "#ec4899",
    status: "stable",
  },
  {
    name: "Workflow DAG",
    description:
      "Complex dependency graphs with parent-child flows and topological execution.",
    icon: Network,
    href: "/docs/workflow",
    accent: "#fb923c",
    status: "preview",
  },
  {
    name: "Batch",
    description:
      "Accumulator buffering with maxSize and maxWaitMs triggers for bulk processing.",
    icon: LayoutGrid,
    href: "/docs/batch",
    accent: "#f59e0b",
    status: "preview",
  },
  {
    name: "Saga",
    description:
      "Distributed transactions with compensation chains for microservice orchestration.",
    icon: Repeat,
    href: "/docs/saga",
    accent: "#db2777",
    status: "preview",
  },
  {
    name: "Pipeline",
    description:
      "Streaming ETL with stage-based processing and backpressure control.",
    icon: Layers,
    href: "/docs/pipeline",
    accent: "#ea580c",
    status: "roadmap",
  },
  {
    name: "PubSub",
    description:
      "Durable topics and fan-out consumer groups with at-least-once delivery.",
    icon: Radio,
    href: "/docs/pubsub",
    accent: "#e11d48",
    status: "roadmap",
  },
  {
    name: "Cache",
    description:
      "Stampede-protected hierarchical memory tiers with automatic invalidation.",
    icon: HardDrive,
    href: "/docs/cache",
    accent: "#d946ef",
    status: "roadmap",
  },
  {
    name: "Ingest",
    description:
      "Event-driven stateful functions with durable step primitives (run, sleep, invoke).",
    icon: Zap,
    href: "/docs/ingest",
    accent: "#f97316",
    status: "roadmap",
  },
] as const;

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  stable: {
    label: "Stable",
    cls: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  },
  preview: {
    label: "Preview",
    cls: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  },
  roadmap: {
    label: "Roadmap",
    cls: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  },
};

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const cardUp = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: "easeOut" as const },
  },
};

export function ModuleGrid() {
  return (
    <section className="relative py-24 overflow-hidden">
      {/* Warm background blurs */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute top-0 left-1/3 h-64 w-64 rounded-full bg-rose-500/5 blur-3xl" />
        <div className="absolute bottom-0 right-1/4 h-48 w-48 rounded-full bg-orange-500/5 blur-3xl" />
      </div>

      <div className="container max-w-6xl mx-auto px-4 relative z-10">
        <div className="text-center mb-14">
          <motion.h2
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-3xl sm:text-4xl font-bold tracking-tight text-fd-foreground mb-4"
          >
            Explore the modules
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.05 }}
            className="text-fd-muted-foreground text-lg max-w-2xl mx-auto"
          >
            From simple task queues to distributed sagas — every module you need
            to build, scale, and ship production background computation.
          </motion.p>
        </div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {MODULES.map((mod) => {
            const Icon = mod.icon;
            const status = STATUS_LABEL[mod.status];
            return (
              <motion.div key={mod.name} variants={cardUp}>
                <Link
                  href={mod.href}
                  className="group flex flex-col h-full rounded-xl border border-fd-border bg-fd-card/60 backdrop-blur-sm p-5 transition-all duration-200 hover:border-fd-border/80 hover:bg-fd-card/80 hover:shadow-lg"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors duration-200"
                      style={{
                        background: `${mod.accent}12`,
                        border: `1px solid ${mod.accent}25`,
                      }}
                    >
                      <Icon
                        className="h-[18px] w-[18px]"
                        style={{ color: mod.accent }}
                      />
                    </div>
                    <span
                      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${status.cls}`}
                    >
                      {status.label}
                    </span>
                  </div>

                  <h3 className="text-base font-semibold text-fd-foreground mb-1.5">
                    {mod.name}
                  </h3>
                  <p className="text-sm text-fd-muted-foreground leading-relaxed flex-1">
                    {mod.description}
                  </p>
                  <div className="flex items-center gap-1 mt-4 text-xs font-medium text-fd-muted-foreground group-hover:text-fd-foreground transition-colors">
                    Learn more
                    <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="flex justify-center mt-12"
        >
          <Link
            href="/docs"
            className="group inline-flex items-center gap-2 text-sm font-medium text-fd-muted-foreground hover:text-fd-foreground transition-colors"
          >
            View all documentation
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}

"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, Cpu, Terminal } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

const LOG_STREAM = [
  {
    dir: "SYS",
    action: "OqronKit started",
    detail: "adapter: memory · env: production",
    color: "#6b7280",
  },
  {
    dir: "SYS",
    action: "Worker online",
    detail: "worker-01 · polling 100ms",
    color: "#6b7280",
  },
  {
    dir: "RX ",
    action: "Job received",
    detail: "send-email · priority: 5",
    color: "#60a5fa",
  },
  {
    dir: "TX ",
    action: "Job claimed",
    detail: "worker-01 · lock TTL: 30s",
    color: "#4ade80",
  },
  {
    dir: "SYS",
    action: "Heartbeat renewed",
    detail: "worker-01 · send-email-001",
    color: "#6b7280",
  },
  {
    dir: "TX ",
    action: "Job completed",
    detail: "send-email-001 · 245ms",
    color: "#4ade80",
  },
  {
    dir: "RX ",
    action: "Job received",
    detail: "generate-report · priority: 3",
    color: "#60a5fa",
  },
  {
    dir: "TX ",
    action: "Job claimed",
    detail: "worker-01 · lock TTL: 60s",
    color: "#4ade80",
  },
  {
    dir: "RX ",
    action: "Cron fired",
    detail: "daily-cleanup · next: 24h",
    color: "#60a5fa",
  },
  {
    dir: "TX ",
    action: "Job completed",
    detail: "generate-report · 1.2s",
    color: "#4ade80",
  },
  {
    dir: "SYS",
    action: "Stall scan complete",
    detail: "0 stalled · 10 healthy",
    color: "#6b7280",
  },
  { dir: "SYS", action: "Waiting for jobs…", detail: "", color: "#374151" },
] as const;

const TABS = [
  {
    id: "queue",
    label: "Queue",
    filename: "email-queue.ts",
    lines: [
      [
        { t: "import", c: "#ff7b72" },
        { t: " { queue } ", c: "#79c0ff" },
        { t: "from", c: "#ff7b72" },
        { t: " 'oqronkit'", c: "#a5d6ff" },
        { t: ";", c: "#8b949e" },
      ],
      [],
      [
        { t: "export const", c: "#ff7b72" },
        { t: " emailQ = ", c: "#c9d1d9" },
        { t: "queue", c: "#d2a8ff" },
        { t: "({", c: "#c9d1d9" },
      ],
      [
        { t: "  name: ", c: "#c9d1d9" },
        { t: "'send-email'", c: "#a5d6ff" },
        { t: ",", c: "#c9d1d9" },
      ],
      [
        { t: "  handler: ", c: "#c9d1d9" },
        { t: "async", c: "#ff7b72" },
        { t: " (ctx) => {", c: "#c9d1d9" },
      ],
      [
        { t: "    ", c: "#c9d1d9" },
        { t: "await", c: "#ff7b72" },
        { t: " sendEmail(ctx.", c: "#c9d1d9" },
        { t: "data", c: "#79c0ff" },
        { t: ");", c: "#c9d1d9" },
      ],
      [
        { t: "    ", c: "#c9d1d9" },
        { t: "return", c: "#ff7b72" },
        { t: " { sent: ", c: "#c9d1d9" },
        { t: "true", c: "#79c0ff" },
        { t: " };", c: "#c9d1d9" },
      ],
      [{ t: "  }", c: "#c9d1d9" }],
      [{ t: "});", c: "#c9d1d9" }],
      [],
      [
        { t: "await", c: "#ff7b72" },
        { t: " emailQ.", c: "#c9d1d9" },
        { t: "add", c: "#d2a8ff" },
        { t: "({ to: ", c: "#c9d1d9" },
        { t: "'user@ex.com'", c: "#a5d6ff" },
        { t: " });", c: "#c9d1d9" },
      ],
    ],
  },
  {
    id: "worker",
    label: "Worker",
    filename: "billing-worker.ts",
    lines: [
      [
        { t: "import", c: "#ff7b72" },
        { t: " { queue, worker } ", c: "#79c0ff" },
        { t: "from", c: "#ff7b72" },
        { t: " 'oqronkit'", c: "#a5d6ff" },
        { t: ";", c: "#8b949e" },
      ],
      [],
      [{ t: "// API server — publisher only (no handler)", c: "#8b949e" }],
      [
        { t: "export const", c: "#ff7b72" },
        { t: " billingQ = ", c: "#c9d1d9" },
        { t: "queue", c: "#d2a8ff" },
        { t: "({", c: "#c9d1d9" },
      ],
      [
        { t: "  name: ", c: "#c9d1d9" },
        { t: "'billing'", c: "#a5d6ff" },
        { t: ",", c: "#c9d1d9" },
      ],
      [{ t: "});", c: "#c9d1d9" }],
      [],
      [{ t: "// Worker server — consumer only", c: "#8b949e" }],
      [
        { t: "export const", c: "#ff7b72" },
        { t: " billingWorker = ", c: "#c9d1d9" },
        { t: "worker", c: "#d2a8ff" },
        { t: "({", c: "#c9d1d9" },
      ],
      [
        { t: "  topic: ", c: "#c9d1d9" },
        { t: "'billing'", c: "#a5d6ff" },
        { t: ",", c: "#c9d1d9" },
      ],
      [
        { t: "  handler: ", c: "#c9d1d9" },
        { t: "async", c: "#ff7b72" },
        { t: " (ctx) => {", c: "#c9d1d9" },
      ],
      [
        { t: "    ", c: "#c9d1d9" },
        { t: "return", c: "#ff7b72" },
        { t: " chargeBilling(ctx.data);", c: "#c9d1d9" },
      ],
      [{ t: "  }", c: "#c9d1d9" }],
      [{ t: "});", c: "#c9d1d9" }],
    ],
  },
  {
    id: "schedule",
    label: "Schedule",
    filename: "jobs.ts",
    lines: [
      [
        { t: "import", c: "#ff7b72" },
        { t: " { cron, schedule } ", c: "#79c0ff" },
        { t: "from", c: "#ff7b72" },
        { t: " 'oqronkit'", c: "#a5d6ff" },
        { t: ";", c: "#8b949e" },
      ],
      [],
      [{ t: "// Cron — every day at midnight", c: "#8b949e" }],
      [
        { t: "cron", c: "#d2a8ff" },
        { t: "({", c: "#c9d1d9" },
      ],
      [
        { t: "  name: ", c: "#c9d1d9" },
        { t: "'daily-cleanup'", c: "#a5d6ff" },
        { t: ",", c: "#c9d1d9" },
      ],
      [
        { t: "  expression: ", c: "#c9d1d9" },
        { t: "'0 0 * * *'", c: "#a5d6ff" },
        { t: ",", c: "#c9d1d9" },
      ],
      [
        { t: "  handler: ", c: "#c9d1d9" },
        { t: "async", c: "#ff7b72" },
        { t: " () => cleanupOldJobs(),", c: "#c9d1d9" },
      ],
      [{ t: "});", c: "#c9d1d9" }],
      [],
      [{ t: "// Schedule — run once in 5 min", c: "#8b949e" }],
      [
        { t: "schedule", c: "#d2a8ff" },
        { t: "({", c: "#c9d1d9" },
      ],
      [
        { t: "  name: ", c: "#c9d1d9" },
        { t: "'send-reminder'", c: "#a5d6ff" },
        { t: ",", c: "#c9d1d9" },
      ],
      [
        { t: "  runAfter: { minutes: ", c: "#c9d1d9" },
        { t: "5", c: "#79c0ff" },
        { t: " },", c: "#c9d1d9" },
      ],
      [
        { t: "  handler: ", c: "#c9d1d9" },
        { t: "async", c: "#ff7b72" },
        { t: " (ctx) => notify(ctx),", c: "#c9d1d9" },
      ],
      [{ t: "});", c: "#c9d1d9" }],
    ],
  },
] as const;

const STATUS_COLORS: Record<string, string> = {
  Processing: "#3b82f6",
  Healthy: "#22c55e",
  Starting: "#f59e0b",
};

export function Showcase() {
  const [visibleCount, setVisibleCount] = useState(1);
  const [activeTab, setActiveTab] = useState("queue");
  const activeCode = TABS.find((t) => t.id === activeTab);
  const phase =
    visibleCount >= 10
      ? "Healthy"
      : visibleCount >= 4
        ? "Processing"
        : "Starting";

  useEffect(() => {
    const id = setInterval(() => {
      setVisibleCount((n) => (n >= LOG_STREAM.length ? 1 : n + 1));
    }, 1400);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="relative py-28 overflow-hidden">
      <div className="container max-w-7xl mx-auto px-4 relative z-10">
        <div className="text-center mb-16">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-4 py-1.5 text-xs font-semibold text-fd-muted-foreground mb-6"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
            Live job processing simulation
          </motion.div>
          <motion.h2
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.05 }}
            className="text-4xl sm:text-5xl font-bold tracking-tight text-fd-foreground mb-5"
          >
            See it in{" "}
            <span className="bg-linear-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
              Action
            </span>
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1 }}
            className="text-lg text-fd-muted-foreground max-w-2xl mx-auto"
          >
            One typed API — crash-safe queues, distributed workers, and
            schedulers that scale from monolith to microservices.
          </motion.p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2 items-start">
          {/* Left: Terminal */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            className="flex flex-col gap-4"
          >
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0d1117] shadow-2xl shadow-black/30">
              <div className="absolute top-0 inset-x-0 h-px bg-linear-to-r from-transparent via-blue-500/50 to-transparent" />
              <div className="flex items-center justify-between border-b border-white/8 bg-white/3 px-4 py-3">
                <div className="flex gap-1.5">
                  <div className="h-3 w-3 rounded-full bg-[#fa7970]" />
                  <div className="h-3 w-3 rounded-full bg-[#faa356]" />
                  <div className="h-3 w-3 rounded-full bg-[#7ce38b]" />
                </div>
                <div className="flex items-center gap-2 font-mono text-[11px] text-white/30">
                  <Terminal className="h-3 w-3" />
                  oqronkit · worker-01
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                  <span className="font-mono text-[10px] text-green-400/60">
                    LIVE
                  </span>
                </div>
              </div>
              <div className="p-5 font-mono text-[12.5px] leading-7 min-h-[320px] space-y-0.5">
                <AnimatePresence initial={false}>
                  {LOG_STREAM.slice(0, visibleCount).map((log, i) => (
                    <motion.div
                      key={`${i?.toString()}-${log.action}`}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.25 }}
                      className="flex items-baseline gap-3"
                    >
                      <span className="shrink-0 text-white/20 tabular-nums text-[11px]">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span
                        className="shrink-0 font-bold text-[10px] tracking-widest uppercase rounded px-1.5 py-px"
                        style={{
                          color: log.color,
                          background: `${log.color}18`,
                          border: `1px solid ${log.color}30`,
                        }}
                      >
                        {log.dir}
                      </span>
                      <span className="text-white/80 font-semibold">
                        {log.action}
                      </span>
                      {log.detail && (
                        <span className="text-white/30 truncate">
                          {log.detail}
                        </span>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-white/20 tabular-nums text-[11px]">
                    {String(visibleCount + 1).padStart(2, "0")}
                  </span>
                  <span className="inline-block h-4 w-2 bg-green-400/70 animate-pulse rounded-sm" />
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-2xl border border-fd-border bg-fd-card/80 backdrop-blur px-5 py-4">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-11 w-11 items-center justify-center rounded-xl border transition-all duration-500"
                  style={{
                    borderColor: `${STATUS_COLORS[phase]}50`,
                    background: `${STATUS_COLORS[phase]}12`,
                  }}
                >
                  <Cpu
                    className="h-5 w-5 transition-colors duration-500"
                    style={{ color: STATUS_COLORS[phase] }}
                  />
                </div>
                <div>
                  <p className="text-sm font-bold text-fd-foreground">
                    worker-01
                  </p>
                  <p className="text-xs text-fd-muted-foreground">
                    OqronKit Worker
                  </p>
                </div>
              </div>
              <div
                className="flex items-center gap-2 rounded-full border px-3 py-1.5 transition-all duration-500"
                style={{
                  borderColor: `${STATUS_COLORS[phase]}40`,
                  background: `${STATUS_COLORS[phase]}10`,
                }}
              >
                <span
                  className="h-2 w-2 rounded-full animate-pulse"
                  style={{ background: STATUS_COLORS[phase] }}
                />
                <span
                  className="text-sm font-semibold"
                  style={{ color: STATUS_COLORS[phase] }}
                >
                  {phase}
                </span>
              </div>
            </div>
          </motion.div>

          {/* Right: Code tabs */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1 }}
            className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0d1117] shadow-2xl shadow-black/30"
          >
            <div className="absolute top-0 inset-x-0 h-px bg-linear-to-r from-transparent via-violet-500/50 to-transparent" />
            <div className="flex items-center justify-between border-b border-white/8 bg-white/3">
              {TABS.map((tab) => (
                <button
                  type="button"
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`relative px-5 py-3 text-[12px] font-mono font-medium transition-colors ${activeTab === tab.id ? "text-white" : "text-white/30 hover:text-white/60"}`}
                >
                  {tab.label}
                  {activeTab === tab.id && (
                    <motion.div
                      layoutId="codeTab"
                      className="absolute bottom-0 left-0 right-0 h-[2px] bg-violet-400"
                      transition={{
                        type: "spring",
                        stiffness: 500,
                        damping: 30,
                      }}
                    />
                  )}
                </button>
              ))}
              <div className="flex-1" />
              <span className="px-4 font-mono text-[10px] text-white/25">
                {activeCode?.filename}
              </span>
            </div>
            <div className="flex min-h-[360px]">
              <div className="select-none border-r border-white/5 p-5 pr-4 text-right font-mono text-[12px] leading-7 text-white/15">
                {activeCode?.lines.map((_, i) => (
                  <div key={`line-${i?.toString()}`}>{i + 1}</div>
                ))}
              </div>
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeTab}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18 }}
                  className="flex-1 overflow-x-auto p-5 pl-4 font-mono text-[12.5px] leading-7"
                >
                  {activeCode?.lines.map((tokens, li) => (
                    <div
                      key={`line-${li?.toString()}`}
                      className="whitespace-pre"
                    >
                      {tokens.length === 0
                        ? "\u00A0"
                        : tokens.map((tok, ti) => (
                            <span
                              key={`${li?.toString()}-${ti?.toString()}`}
                              style={{ color: tok.c }}
                            >
                              {tok.t}
                            </span>
                          ))}
                    </div>
                  ))}
                </motion.div>
              </AnimatePresence>
            </div>
            <div className="flex items-center justify-between border-b border-white/8 bg-white/3 px-4 py-3">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
                <span className="font-mono text-[10px] text-white/25">
                  TypeScript
                </span>
              </div>
              <Link
                href="/docs"
                className="flex items-center gap-1 font-mono text-[10px] text-white/30 hover:text-violet-400 transition-colors"
              >
                Full docs <ArrowUpRight className="h-3 w-3" />
              </Link>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

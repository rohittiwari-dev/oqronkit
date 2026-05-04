"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Check,
  Copy, RefreshCw,
  Shield,
  Zap
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

/* ─── Code tabs ───────────────────────────────────────────────────────── */
const TABS = [
  {
    id: "queue",
    label: "Queue",
    filename: "triggers/email.ts",
    lines: [
      { tokens: [{ t: "import", c: "kw" }, { t: " { queue } ", c: "id" }, { t: "from", c: "kw" }, { t: " 'oqronkit'", c: "str" }] },
      { tokens: [] },
      { tokens: [{ t: "export const", c: "kw" }, { t: " emailQ = ", c: "tx" }, { t: "queue", c: "fn" }, { t: "({", c: "tx" }] },
      { tokens: [{ t: "  name: ", c: "tx" }, { t: "'send-email'", c: "str" }, { t: ",", c: "tx" }] },
      { tokens: [{ t: "  guaranteedWorker: ", c: "tx" }, { t: "true", c: "bool" }, { t: ",", c: "tx" }] },
      { tokens: [{ t: "  handler: ", c: "tx" }, { t: "async", c: "kw" }, { t: " (ctx) => {", c: "tx" }] },
      { tokens: [{ t: "    ", c: "tx" }, { t: "await", c: "kw" }, { t: " sendEmail(ctx.", c: "tx" }, { t: "data", c: "id" }, { t: ")", c: "tx" }] },
      { tokens: [{ t: "    ", c: "tx" }, { t: "return", c: "kw" }, { t: " { sent: ", c: "tx" }, { t: "true", c: "bool" }, { t: " }", c: "tx" }] },
      { tokens: [{ t: "  },", c: "tx" }] },
      { tokens: [{ t: "})", c: "tx" }] },
      { tokens: [] },
      { tokens: [{ t: "await", c: "kw" }, { t: " emailQ.", c: "tx" }, { t: "add", c: "fn" }, { t: "({ to: ", c: "tx" }, { t: "'user@ex.com'", c: "str" }, { t: " })", c: "tx" }] },
    ],
  },
  {
    id: "worker",
    label: "Worker",
    filename: "triggers/billing.ts",
    lines: [
      { tokens: [{ t: "import", c: "kw" }, { t: " { queue, worker } ", c: "id" }, { t: "from", c: "kw" }, { t: " 'oqronkit'", c: "str" }] },
      { tokens: [] },
      { tokens: [{ t: "// API node — publisher only", c: "cm" }] },
      { tokens: [{ t: "export const", c: "kw" }, { t: " billingQ = ", c: "tx" }, { t: "queue", c: "fn" }, { t: "({", c: "tx" }] },
      { tokens: [{ t: "  name: ", c: "tx" }, { t: "'billing'", c: "str" }, { t: ",", c: "tx" }] },
      { tokens: [{ t: "})", c: "tx" }] },
      { tokens: [] },
      { tokens: [{ t: "// Worker node — consumer only", c: "cm" }] },
      { tokens: [{ t: "export const", c: "kw" }, { t: " billingW = ", c: "tx" }, { t: "worker", c: "fn" }, { t: "({", c: "tx" }] },
      { tokens: [{ t: "  topic: ", c: "tx" }, { t: "'billing'", c: "str" }, { t: ",", c: "tx" }] },
      { tokens: [{ t: "  concurrency: ", c: "tx" }, { t: "5", c: "bool" }, { t: ",", c: "tx" }] },
      { tokens: [{ t: "  handler: ", c: "tx" }, { t: "async", c: "kw" }, { t: " (ctx) => {", c: "tx" }] },
      { tokens: [{ t: "    ", c: "tx" }, { t: "return", c: "kw" }, { t: " chargeBilling(ctx.data)", c: "tx" }] },
      { tokens: [{ t: "  },", c: "tx" }] },
      { tokens: [{ t: "})", c: "tx" }] },
    ],
  },
  {
    id: "cron",
    label: "Schedule",
    filename: "triggers/jobs.ts",
    lines: [
      { tokens: [{ t: "import", c: "kw" }, { t: " { cron, schedule } ", c: "id" }, { t: "from", c: "kw" }, { t: " 'oqronkit'", c: "str" }] },
      { tokens: [] },
      { tokens: [{ t: "export const", c: "kw" }, { t: " cleanup = ", c: "tx" }, { t: "cron", c: "fn" }, { t: "({", c: "tx" }] },
      { tokens: [{ t: "  name: ", c: "tx" }, { t: "'daily-cleanup'", c: "str" }, { t: ",", c: "tx" }] },
      { tokens: [{ t: "  expression: ", c: "tx" }, { t: "'0 0 * * *'", c: "str" }, { t: ",", c: "tx" }] },
      { tokens: [{ t: "  handler: ", c: "tx" }, { t: "async", c: "kw" }, { t: " () => cleanupOldJobs(),", c: "tx" }] },
      { tokens: [{ t: "})", c: "tx" }] },
      { tokens: [] },
      { tokens: [{ t: "export const", c: "kw" }, { t: " reminder = ", c: "tx" }, { t: "schedule", c: "fn" }, { t: "({", c: "tx" }] },
      { tokens: [{ t: "  name: ", c: "tx" }, { t: "'send-reminder'", c: "str" }, { t: ",", c: "tx" }] },
      { tokens: [{ t: "  runAfter: { minutes: ", c: "tx" }, { t: "5", c: "bool" }, { t: " },", c: "tx" }] },
      { tokens: [{ t: "  handler: ", c: "tx" }, { t: "async", c: "kw" }, { t: " (ctx) => notify(ctx),", c: "tx" }] },
      { tokens: [{ t: "})", c: "tx" }] },
    ],
  },
] as const;

const COLORS: Record<string, string> = {
  kw: "#f87171",
  fn: "#c084fc",
  str: "#fbbf24",
  id: "#67e8f9",
  bool: "#fb923c",
  cm: "#6b7280",
  tx: "#c9d1d9",
};

/* ─── Feature highlights ──────────────────────────────────────────────── */
const HIGHLIGHTS = [
  {
    icon: Shield,
    title: "Crash-safe",
    description: "Heartbeat locks ensure no job is ever lost, even during a process crash.",
    color: "#e11d48",
  },
  {
    icon: RefreshCw,
    title: "Automatic retries",
    description: "Configurable retry policies with exponential backoff and dead letter queues.",
    color: "#f97316",
  },
  {
    icon: Zap,
    title: "Zero config scaling",
    description: "Swap adapter from memory to Redis — instant distributed processing.",
    color: "#eab308",
  },
] as const;

export function QuickStart() {
  const [activeTab, setActiveTab] = useState("queue");
  const [copied, setCopied] = useState(false);
  const tab = TABS.find((t) => t.id === activeTab) || TABS[0];

  const rawCode = tab.lines
    .map((l) => l.tokens.map((t) => t.t).join(""))
    .join("\n");

  const onCopy = () => {
    navigator.clipboard.writeText(rawCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="relative py-28 overflow-hidden border-t border-fd-border/30">
      {/* Ambient background */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[800px] rounded-full opacity-[0.04] blur-[120px]" style={{ background: "linear-gradient(135deg, #e11d48, #f97316)" }} />
      </div>

      <div className="container max-w-7xl mx-auto px-4 relative z-10">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr] items-center">
          {/* ═══ LEFT — Content ═══ */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-rose-500/20 bg-rose-500/5 px-3 py-1 text-[11px] font-semibold text-rose-500 dark:text-rose-400 mb-6">
              <span className="h-1 w-1 rounded-full bg-rose-500" />
              Quick Start
            </span>

            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-fd-foreground mb-4 leading-tight">
              Get started in{" "}
              <span
                className="bg-clip-text text-transparent"
                style={{
                  backgroundImage: "linear-gradient(135deg, #e11d48, #f97316)",
                }}
              >
                minutes
              </span>
            </h2>

            <p className="text-fd-muted-foreground text-base leading-relaxed mb-10 max-w-md">
              Define queues, workers, and schedules with typed factory functions.
              OqronKit discovers your triggers automatically and handles the rest.
            </p>

            {/* Feature highlights */}
            <div className="space-y-5 mb-10">
              {HIGHLIGHTS.map((h, i) => {
                const Icon = h.icon;
                return (
                  <motion.div
                    key={h.title}
                    initial={{ opacity: 0, x: -12 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.15 + i * 0.08 }}
                    className="flex items-start gap-3"
                  >
                    <div
                      className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                      style={{
                        background: `${h.color}10`,
                        border: `1px solid ${h.color}20`,
                      }}
                    >
                      <Icon className="h-3.5 w-3.5" style={{ color: h.color }} />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-fd-foreground mb-0.5">
                        {h.title}
                      </h4>
                      <p className="text-xs text-fd-muted-foreground leading-relaxed">
                        {h.description}
                      </p>
                    </div>
                  </motion.div>
                );
              })}
            </div>

            <Link
              href="/docs/quickstart"
              className="group inline-flex items-center gap-2 text-sm font-medium text-fd-foreground hover:text-rose-500 transition-colors"
            >
              Read the full tutorial
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </motion.div>

          {/* ═══ RIGHT — Code block with gradient border ═══ */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="relative"
          >
            {/* Gradient glow behind */}
            <div
              className="absolute -inset-[1px] rounded-2xl opacity-60 blur-sm"
              style={{
                background: "linear-gradient(135deg, #e11d4830, #f9731625, #eab30820, #ec489918)",
              }}
            />

            {/* Code container */}
            <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0d1117]">
              {/* Top accent gradient line */}
              <div
                className="absolute top-0 inset-x-0 h-px"
                style={{
                  background: "linear-gradient(90deg, transparent, #e11d4860, #f9731650, #eab30840, transparent)",
                }}
              />

              {/* ── Tab bar ── */}
              <div className="flex items-center border-b border-white/[0.06] bg-white/[0.02]">
                {TABS.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className={`relative px-5 py-3.5 font-mono text-[12px] font-medium transition-colors ${
                      activeTab === t.id
                        ? "text-white/90"
                        : "text-white/25 hover:text-white/45"
                    }`}
                  >
                    {t.label}
                    {activeTab === t.id && (
                      <motion.div
                        layoutId="qsActiveTab"
                        className="absolute bottom-0 left-0 right-0 h-[2px]"
                        style={{
                          background: "linear-gradient(90deg, #e11d48, #f97316)",
                        }}
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

                <span className="hidden sm:block px-3 font-mono text-[10px] text-white/12">
                  {tab.filename}
                </span>

                <button
                  type="button"
                  onClick={onCopy}
                  className="mr-3 p-1.5 rounded-md text-white/15 hover:text-white/40 hover:bg-white/5 transition-all"
                  aria-label="Copy code"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>

              {/* ── Code body ── */}
              <div className="flex">
                {/* Line numbers */}
                <div className="hidden sm:block select-none border-r border-white/[0.04] py-5 px-4 text-right font-mono text-[12px] leading-7 text-white/8">
                  {tab.lines.map((_, i) => (
                    <div key={`ln-${i?.toString()}`}>{i + 1}</div>
                  ))}
                </div>

                {/* Code */}
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activeTab}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="flex-1 overflow-x-auto py-5 px-5 font-mono text-[13px] leading-7"
                  >
                    {tab.lines.map((line, li) => (
                      <div key={`line-${li?.toString()}`} className="whitespace-pre">
                        {line.tokens.length === 0
                          ? "\u00A0"
                          : line.tokens.map((tok, ti) => (
                              <span
                                key={`${li?.toString()}-${ti?.toString()}`}
                                style={{ color: COLORS[tok.c] }}
                              >
                                {tok.t}
                              </span>
                            ))}
                      </div>
                    ))}
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* ── Footer ── */}
              <div className="flex items-center justify-between border-t border-white/[0.06] bg-white/[0.015] px-4 py-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                  <span className="font-mono text-[10px] text-white/15">
                    TypeScript
                  </span>
                </div>
                <span className="font-mono text-[10px] text-white/10">
                  OqronKit
                </span>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

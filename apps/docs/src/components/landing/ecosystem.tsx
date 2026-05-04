"use client";

import { motion } from "framer-motion";
import { BookOpen, Box, ChevronRight, Clock, Cpu, Shield, Zap } from "lucide-react";
import Link from "next/link";

const ITEMS = [
  {
    key: "queue", label: "Core Module", name: "Task Queue",
    description: "Unified, simple queue for monolithic setups where publisher and consumer live together. FIFO, LIFO, priority ordering, delayed jobs, and retry policies — all built in.",
    icon: Box, badge: "core", badgeColor: "bg-red-500/10 text-red-400 border-red-500/20",
    accentColor: "#7c3aed", glow: "from-violet-500/20 to-purple-600/5", border: "border-violet-500/20 hover:border-violet-500/40",
    href: "/docs/task-queue", cta: "Read the docs", tags: ["FIFO", "Priority", "Delayed", "Retry"],
  },
  {
    key: "worker", label: "Distributed", name: "Worker Engine",
    description: "Pure Industrygrade-style decoupled architecture. Queue pushes on API nodes, Worker polls on processing nodes. Heartbeat locks and stall detection for crash-safety.",
    icon: Cpu, badge: "enterprise", badgeColor: "bg-pink-500/10 text-pink-400 border-pink-500/20",
    accentColor: "#ec4899", glow: "from-pink-500/20 to-rose-600/5", border: "border-pink-500/20 hover:border-pink-500/40",
    href: "/docs/distributed-worker", cta: "View worker", tags: ["Polling", "Stall Detection", "Heartbeat", "Retry"],
  },
  {
    key: "scheduler", label: "Time-based", name: "Scheduler & Cron",
    description: "Cron expressions, RRule, one-shot runAt, repeating runAfter, and semantic recurring schedules. Sharded leader election prevents thundering herds.",
    icon: Clock, badge: "advanced", badgeColor: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    accentColor: "#eab308", glow: "from-yellow-500/20 to-amber-600/5", border: "border-yellow-500/20 hover:border-yellow-500/40",
    href: "/docs/scheduler", cta: "View scheduler", tags: ["Cron", "RRule", "Timezone", "Sharded"],
  },
  {
    key: "ratelimit", label: "Protection", name: "Rate Limiter",
    description: "Distributed sliding-window, fixed-window, and token-bucket algorithms. Multi-tier limits with automatic banning for abuse prevention. Atomic operations via Lua scripts.",
    icon: Shield, badge: "security", badgeColor: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    accentColor: "#10b981", glow: "from-emerald-500/20 to-teal-600/5", border: "border-emerald-500/20 hover:border-emerald-500/40",
    href: "/docs/rate-limiter", cta: "View limiter", tags: ["Multi-tier", "Auto-ban", "Token Bucket", "Atomic"],
  },
  {
    key: "webhook", label: "HTTP Dispatch", name: "Webhook Engine",
    description: "Reliable outbound webhook delivery with exponential backoff, dead letter queues, circuit breakers, HMAC-SHA256 signing, and dynamic endpoint resolution.",
    icon: Zap, badge: "reliable", badgeColor: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    accentColor: "#f59e0b", glow: "from-amber-500/20 to-orange-600/5", border: "border-amber-500/20 hover:border-amber-500/40",
    href: "/docs/webhook", cta: "View webhooks", tags: ["Circuit Breaker", "DLQ", "HMAC Signing", "Retry"],
  },
  {
    key: "docs", label: "Documentation", name: "Full Reference",
    description: "Comprehensive guides, API reference, integration examples, and architecture deep-dives — everything you need from first install to production deployment.",
    icon: BookOpen, badge: "open", badgeColor: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    accentColor: "#3b82f6", glow: "from-blue-500/20 to-indigo-600/5", border: "border-blue-500/20 hover:border-blue-500/40",
    href: "/docs", cta: "Browse docs", tags: ["Quick Start", "API Reference", "Adapters", "Crash Safety"],
  },
] as const;

const containerVariants = { hidden: {}, visible: { transition: { staggerChildren: 0.1 } } };
const cardVariants = { hidden: { opacity: 0, y: 30 }, visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" as const } } };

export function Ecosystem() {
  return (
    <section className="relative py-28 overflow-hidden border-t border-fd-border/50">
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute top-0 left-1/4 h-96 w-96 rounded-full bg-violet-500/5 blur-3xl" />
        <div className="absolute bottom-0 right-1/4 h-72 w-72 rounded-full bg-emerald-500/5 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-blue-500/3 blur-3xl" />
      </div>
      <div className="container max-w-7xl mx-auto px-4 relative z-10">
        <div className="text-center mb-20">
          <motion.div initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-4 py-1.5 text-xs font-semibold text-fd-muted-foreground mb-6">
            <span className="flex h-1.5 w-1.5 rounded-full bg-violet-400 animate-pulse" />
            The complete toolkit
          </motion.div>
          <motion.h2 initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.05 }} className="text-4xl sm:text-5xl font-bold tracking-tight text-fd-foreground mb-5">
            Built to cover the{" "}<span className="bg-linear-to-r from-violet-400 via-purple-400 to-blue-400 bg-clip-text text-transparent">full background stack</span>
          </motion.h2>
          <motion.p initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.1 }} className="text-lg text-fd-muted-foreground max-w-2xl mx-auto">
            From simple task queues to distributed sagas — every module you need to build, scale, and ship production background computation.
          </motion.p>
        </div>
        <motion.div variants={containerVariants} initial="hidden" whileInView="visible" viewport={{ once: true, margin: "-80px" }} className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <motion.div key={item.key} variants={cardVariants}>
                <Link href={item.href} className={`group relative flex flex-col h-full rounded-2xl border bg-fd-card/60 backdrop-blur-sm p-7 transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl ${item.border}`}>
                  <div className={`pointer-events-none absolute inset-0 rounded-2xl bg-linear-to-br ${item.glow} opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
                  <div className="relative flex items-start justify-between mb-5">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: `${item.accentColor}18`, border: `1px solid ${item.accentColor}30` }}>
                      <Icon className="h-5 w-5" style={{ color: item.accentColor }} />
                    </div>
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${item.badgeColor}`}>{item.badge}</span>
                  </div>
                  <div className="relative flex-1 flex flex-col">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-fd-muted-foreground mb-1">{item.label}</p>
                    <h3 className="text-xl font-bold text-fd-foreground mb-3">{item.name}</h3>
                    <p className="text-sm text-fd-muted-foreground leading-relaxed mb-5 flex-1">{item.description}</p>
                    <div className="flex flex-wrap gap-1.5 mb-5">
                      {item.tags.map((tag) => (<span key={tag} className="rounded-md border border-fd-border bg-fd-muted/50 px-2 py-0.5 text-[10px] font-medium text-fd-muted-foreground">{tag}</span>))}
                    </div>
                    <div className="flex items-center gap-1 text-sm font-semibold transition-colors" style={{ color: item.accentColor }}>
                      {item.cta}<ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                    </div>
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

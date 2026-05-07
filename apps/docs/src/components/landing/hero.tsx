"use client";

import { motion } from "framer-motion";
import {
  ArrowRight,
  Box,
  Check,
  Clock,
  Copy,
  Cpu,
  Layers,
  Network,
  Radio,
  Repeat,
  Shield,
  Terminal,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

/* ─── Floating module nodes for the animated visual ────────────────────── */
const NODES = [
  {
    icon: Box,
    label: "Queue",
    color: "#e11d48",
    x: 60,
    y: 25,
    size: 52,
    delay: 0,
  },
  {
    icon: Cpu,
    label: "Worker",
    color: "#f43f5e",
    x: 82,
    y: 48,
    size: 48,
    delay: 0.15,
  },
  {
    icon: Clock,
    label: "Cron",
    color: "#f97316",
    x: 38,
    y: 55,
    size: 44,
    delay: 0.3,
  },
  {
    icon: Shield,
    label: "Limiter",
    color: "#eab308",
    x: 72,
    y: 75,
    size: 46,
    delay: 0.45,
  },
  {
    icon: Zap,
    label: "Webhook",
    color: "#ec4899",
    x: 50,
    y: 80,
    size: 42,
    delay: 0.6,
  },
  {
    icon: Network,
    label: "DAG",
    color: "#fb923c",
    x: 25,
    y: 35,
    size: 40,
    delay: 0.75,
  },
  {
    icon: Layers,
    label: "Pipeline",
    color: "#f59e0b",
    x: 88,
    y: 22,
    size: 38,
    delay: 0.9,
  },
  {
    icon: Repeat,
    label: "Saga",
    color: "#db2777",
    x: 45,
    y: 10,
    size: 36,
    delay: 1.05,
  },
  {
    icon: Radio,
    label: "PubSub",
    color: "#06b6d4",
    x: 14,
    y: 62,
    size: 50,
    delay: 1.2,
  },
] as const;

/* ─── Connection lines between nodes ───────────────────────────────────── */
const CONNECTIONS = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 4],
  [3, 4],
  [5, 0],
  [5, 2],
  [6, 1],
  [7, 0],
  [7, 5],
  [8, 0],
  [8, 1],
  [8, 2],
  [8, 3],
  [8, 4],
] as const;

/* ─── Floating particles (deterministic to avoid SSR hydration mismatch) */
const PARTICLES = [
  { id: 0, x: 8, y: 15, size: 2, duration: 5, delay: 0, color: "#e11d48" },
  { id: 1, x: 22, y: 72, size: 1.5, duration: 6, delay: 0.5, color: "#f97316" },
  { id: 2, x: 35, y: 30, size: 3, duration: 4, delay: 1, color: "#eab308" },
  { id: 3, x: 50, y: 85, size: 1.8, duration: 7, delay: 1.5, color: "#ec4899" },
  {
    id: 4,
    x: 65,
    y: 10,
    size: 2.5,
    duration: 5.5,
    delay: 0.3,
    color: "#f43f5e",
  },
  { id: 5, x: 78, y: 55, size: 1.2, duration: 6.5, delay: 2, color: "#e11d48" },
  {
    id: 6,
    x: 90,
    y: 40,
    size: 2.8,
    duration: 4.5,
    delay: 0.8,
    color: "#f97316",
  },
  {
    id: 7,
    x: 12,
    y: 90,
    size: 1.6,
    duration: 5.8,
    delay: 2.5,
    color: "#eab308",
  },
  {
    id: 8,
    x: 42,
    y: 5,
    size: 2.2,
    duration: 3.5,
    delay: 1.2,
    color: "#ec4899",
  },
  {
    id: 9,
    x: 55,
    y: 65,
    size: 3.5,
    duration: 6.2,
    delay: 0.6,
    color: "#f43f5e",
  },
  {
    id: 10,
    x: 70,
    y: 22,
    size: 1.4,
    duration: 5.2,
    delay: 1.8,
    color: "#e11d48",
  },
  {
    id: 11,
    x: 85,
    y: 78,
    size: 2.6,
    duration: 4.8,
    delay: 0.4,
    color: "#f97316",
  },
  {
    id: 12,
    x: 5,
    y: 50,
    size: 1.9,
    duration: 6.8,
    delay: 2.8,
    color: "#eab308",
  },
  {
    id: 13,
    x: 30,
    y: 95,
    size: 2.1,
    duration: 3.8,
    delay: 1.6,
    color: "#ec4899",
  },
  {
    id: 14,
    x: 48,
    y: 38,
    size: 3.2,
    duration: 5.4,
    delay: 0.2,
    color: "#f43f5e",
  },
  {
    id: 15,
    x: 62,
    y: 82,
    size: 1.3,
    duration: 7.2,
    delay: 2.2,
    color: "#e11d48",
  },
  {
    id: 16,
    x: 75,
    y: 8,
    size: 2.4,
    duration: 4.2,
    delay: 1.4,
    color: "#f97316",
  },
  {
    id: 17,
    x: 88,
    y: 60,
    size: 1.7,
    duration: 5.6,
    delay: 0.9,
    color: "#eab308",
  },
  {
    id: 18,
    x: 18,
    y: 45,
    size: 2.9,
    duration: 6.4,
    delay: 2.6,
    color: "#ec4899",
  },
  {
    id: 19,
    x: 95,
    y: 28,
    size: 1.1,
    duration: 3.2,
    delay: 1.1,
    color: "#f43f5e",
  },
];

/* ─── Live job ticker ─────────────────────────────────────────────────── */
const TICKER = [
  "pubsub order-events[3] offset 2048 published",
  "billing-service acked message in 38ms",
  "analytics-service lag: 0 across 16 partitions",
  "account-events partition key: acct_42",
  "dead-letter replay queued for shipping-service",
  "worker-02 heartbeat renewed",
  "webhook delivered to stripe",
  "reconciliation scan: 0 expired leases",
];

function LiveTicker() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % TICKER.length);
    }, 2200);
    return () => clearInterval(id);
  }, []);

  return (
    <motion.div className="overflow-hidden h-5" initial={false}>
      <motion.span
        key={index}
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -16, opacity: 0 }}
        transition={{ duration: 0.3 }}
        className="block font-mono text-xs text-fd-muted-foreground"
      >
        {TICKER[index]}
      </motion.span>
    </motion.div>
  );
}

/* ─── Animated node component ─────────────────────────────────────────── */
function FloatingNode({
  icon: Icon,
  label,
  color,
  x,
  y,
  size,
  delay,
}: (typeof NODES)[number]) {
  return (
    <motion.div
      className="absolute group"
      style={{ left: `${x}%`, top: `${y}%` }}
      initial={{ opacity: 0, scale: 0 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{
        delay: delay + 0.5,
        duration: 0.5,
        type: "spring",
        stiffness: 200,
      }}
    >
      {/* Floating animation */}
      <motion.div
        animate={{
          y: [0, -8, 0, 6, 0],
          x: [0, 3, 0, -3, 0],
        }}
        transition={{
          duration: 5 + delay * 2,
          repeat: Number.POSITIVE_INFINITY,
          ease: "easeInOut",
        }}
        className="relative"
      >
        {/* Outer glow ring */}
        <motion.div
          className="absolute -inset-3 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
          style={{
            background: `radial-gradient(circle, ${color}25 0%, transparent 70%)`,
          }}
        />

        {/* Pulse ring animation */}
        <motion.div
          className="absolute -inset-1 rounded-xl"
          style={{ border: `1px solid ${color}30` }}
          animate={{ scale: [1, 1.15, 1], opacity: [0.3, 0, 0.3] }}
          transition={{
            duration: 3,
            repeat: Number.POSITIVE_INFINITY,
            delay: delay,
          }}
        />

        {/* Node body */}
        <div
          className="relative flex items-center justify-center rounded-xl backdrop-blur-md transition-all duration-300 group-hover:scale-110 cursor-default"
          style={{
            width: size,
            height: size,
            background: `linear-gradient(135deg, ${color}18, ${color}08)`,
            border: `1px solid ${color}35`,
            boxShadow: `0 0 20px ${color}15, inset 0 1px 0 ${color}15`,
          }}
        >
          <Icon
            className="transition-transform duration-300 group-hover:scale-110"
            style={{
              color,
              width: size * 0.38,
              height: size * 0.38,
            }}
          />
        </div>

        {/* Label tooltip */}
        <motion.span
          className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] font-semibold uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity duration-300"
          style={{ color }}
        >
          {label}
        </motion.span>
      </motion.div>
    </motion.div>
  );
}

/* ─── SVG connection lines ────────────────────────────────────────────── */
function ConnectionLines() {
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      aria-hidden
    >
      <defs>
        <linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#e11d48" stopOpacity="0.15" />
          <stop offset="50%" stopColor="#f97316" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#eab308" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      {CONNECTIONS.map(([a, b], i) => {
        const na = NODES[a];
        const nb = NODES[b];
        return (
          <motion.line
            key={`${a}-${b}`}
            x1={`${na.x}%`}
            y1={`${na.y}%`}
            x2={`${nb.x}%`}
            y2={`${nb.y}%`}
            stroke="url(#lineGrad)"
            strokeWidth="1"
            strokeDasharray="4 6"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ delay: 1.2 + i * 0.08, duration: 0.8 }}
          />
        );
      })}
    </svg>
  );
}

/* ─── Main Hero ───────────────────────────────────────────────────────── */
export function Hero() {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    navigator.clipboard.writeText("npm install oqronkit");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="relative min-h-screen flex items-center overflow-hidden">
      {/* ── Ambient warm glow orbs ─────────────────────────────────────── */}
      <div
        className="pointer-events-none absolute top-[10%] left-[5%] h-[400px] w-[400px] rounded-full opacity-[0.07] blur-[100px]"
        style={{ background: "hsl(347 80% 55%)" }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-[10%] right-[10%] h-[350px] w-[350px] rounded-full opacity-[0.06] blur-[100px]"
        style={{ background: "hsl(30 90% 55%)" }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute top-[40%] left-[50%] h-[300px] w-[300px] rounded-full opacity-[0.04] blur-[80px]"
        style={{ background: "hsl(50 90% 55%)" }}
        aria-hidden
      />

      {/* ── Floating micro-particles ───────────────────────────────────── */}
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden"
        aria-hidden
      >
        {PARTICLES.map((p) => (
          <motion.div
            key={p.id}
            className="absolute rounded-full"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              width: p.size,
              height: p.size,
              background: p.color,
            }}
            animate={{
              y: [0, -30, 0, 20, 0],
              x: [0, 10, 0, -10, 0],
              opacity: [0, 0.5, 0.3, 0.6, 0],
            }}
            transition={{
              duration: p.duration,
              delay: p.delay,
              repeat: Number.POSITIVE_INFINITY,
              ease: "easeInOut",
            }}
          />
        ))}
      </div>

      <div className="container max-w-7xl mx-auto px-4 relative z-10 grid gap-8 lg:grid-cols-2 items-center py-24 lg:py-0 ">
        {/* ═══ LEFT COLUMN ═══ */}
        <div className="flex flex-col max-w-xl mt-6">
          {/* Version badge */}
          <motion.div
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4 }}
            className="mb-6"
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-rose-500/20 bg-rose-500/5 backdrop-blur-sm px-4 py-1.5 text-xs font-semibold text-rose-500 dark:text-rose-400 shadow-sm">
              <span className="flex h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
              Introducing OqronKit
            </span>
          </motion.div>

          {/* Headline with animated gradient */}
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="text-4xl font-extrabold tracking-tight text-fd-foreground sm:text-5xl lg:text-[3.5rem] xl:text-6xl mb-6 leading-[1.08]"
          >
            Background jobs
            <br />
            for{" "}
            <span className="relative inline-block">
              <span
                className="bg-clip-text text-transparent animate-gradient-x bg-[length:200%_auto]"
                style={{
                  backgroundImage:
                    "linear-gradient(90deg, #e11d48, #f97316, #eab308, #ec4899, #e11d48)",
                }}
              >
                Node.js
              </span>
              {/* Underline accent */}
              <motion.span
                className="absolute -bottom-1 left-0 h-[3px] rounded-full"
                style={{
                  background:
                    "linear-gradient(90deg, #e11d48, #f97316, #eab308)",
                }}
                initial={{ width: 0 }}
                animate={{ width: "100%" }}
                transition={{ delay: 0.8, duration: 0.6, ease: "easeOut" }}
              />
            </span>
          </motion.h1>

          {/* Subtitle */}
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="text-lg text-fd-muted-foreground mb-8 leading-relaxed"
          >
            Queues, workers, schedulers, caching, and pub/sub — built on a
            shared adapter layer so you can start in memory and move to
            Redis or Postgres when you&apos;re ready.
          </motion.p>

          {/* Install command */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="mb-6"
          >
            <div className="inline-flex items-center gap-3 rounded-xl border border-fd-border bg-fd-card/80 backdrop-blur-sm px-5 py-3 font-mono text-sm shadow-sm transition-all hover:border-rose-500/30 hover:shadow-md group">
              <Terminal className="h-4 w-4 text-rose-500/60" />
              <span className="select-none text-fd-muted-foreground">$</span>
              <span className="text-fd-foreground">npm install oqronkit</span>
              <button
                type="button"
                onClick={onCopy}
                className="ml-2 p-1.5 rounded-lg text-fd-muted-foreground hover:text-fd-foreground hover:bg-fd-accent transition-all"
                aria-label="Copy install command"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </motion.div>

          {/* CTA Buttons */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.35 }}
            className="flex flex-wrap items-center gap-3 mb-8"
          >
            <Link
              href="/docs/quickstart"
              className="group relative inline-flex h-12 items-center justify-center gap-2 rounded-xl px-7 text-sm font-semibold text-white transition-all hover:scale-[1.02] active:scale-[0.98] overflow-hidden"
              style={{
                background: "linear-gradient(135deg, #e11d48 0%, #f97316 100%)",
                boxShadow:
                  "0 4px 24px rgba(225,29,72,0.3), 0 1px 3px rgba(0,0,0,0.1)",
              }}
            >
              {/* Shimmer effect */}
              <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent group-hover:animate-shimmer" />
              <span className="relative">Get Started</span>
              <ArrowRight className="relative h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/docs/pubsub"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-xl border border-fd-border bg-fd-card/80 backdrop-blur-sm px-7 text-sm font-medium text-fd-foreground transition-all hover:bg-fd-accent hover:text-fd-accent-foreground hover:border-fd-border/80 shadow-sm"
            >
              Pub/Sub Docs
            </Link>
          </motion.div>

          {/* Live ticker */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.5, duration: 0.5 }}
            className="flex items-center gap-2"
          >
            <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <LiveTicker />
          </motion.div>
        </div>

        {/* ═══ RIGHT COLUMN — Animated Module Constellation ═══ */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.8 }}
          className="relative hidden lg:block h-[520px]"
        >
          {/* Central glow */}
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-40 w-40 rounded-full opacity-20 blur-[60px]"
            style={{
              background: "radial-gradient(circle, #e11d48, #f97316)",
            }}
          />

          {/* Connection lines SVG */}
          <ConnectionLines />

          {/* Floating module nodes */}
          {NODES.map((node) => (
            <FloatingNode key={node.label} {...node} />
          ))}

          {/* Central "OqronKit" hub */}
          <motion.div
            className="absolute"
            style={{
              left: "55%",
              top: "48%",
              transform: "translate(-50%, -50%)",
            }}
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.4, duration: 0.6, type: "spring" }}
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{
                duration: 40,
                repeat: Number.POSITIVE_INFINITY,
                ease: "linear",
              }}
              className="absolute -inset-6 rounded-full"
              style={{
                border: "1px dashed",
                borderColor: "#e11d4815",
              }}
            />
            <motion.div
              animate={{ rotate: -360 }}
              transition={{
                duration: 30,
                repeat: Number.POSITIVE_INFINITY,
                ease: "linear",
              }}
              className="absolute -inset-12 rounded-full"
              style={{
                border: "1px dashed",
                borderColor: "#f9731610",
              }}
            />
            <div
              className="relative -left-4 -top-4 flex items-center justify-center rounded-2xl backdrop-blur-lg"
              style={{
                width: 104,
                height: 84,
                background:
                  "linear-gradient(135deg, #e11d4820, #f9731618, #eab30810)",
                border: "1px solid #e11d4830",
                boxShadow:
                  "0 0 40px #e11d4815, 0 0 80px #f9731610, inset 0 1px 0 #ffffff10",
              }}
            >
              <span className="text-lg font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-rose-500 to-orange-500">
                OqronKit
              </span>
            </div>
          </motion.div>

          {/* "12 Modules" counter badge */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 2, duration: 0.5 }}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-full border border-fd-border bg-fd-card/80 backdrop-blur-sm px-4 py-2 shadow-sm"
          >
            <div className="flex -space-x-1">
              {["#e11d48", "#f97316", "#eab308", "#ec4899"].map((c) => (
                <div
                  key={c}
                  className="h-2 w-2 rounded-full border border-fd-card"
                  style={{ background: c }}
                />
              ))}
            </div>
            <span className="text-[11px] font-semibold text-fd-muted-foreground">
              Pub/Sub + 11 Modules
            </span>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}

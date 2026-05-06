"use client";

import { motion } from "framer-motion";
import {
  ArrowUpRight,
  BookOpen,
  Code2,
  MessageSquare,
  Newspaper,
  Play,
} from "lucide-react";
import Link from "next/link";
import { GithubIcon } from "../icons/brand-icons";

const CARDS = [
  {
    title: "Getting Started Tutorial",
    description:
      "Learn the basics — from installation to deploying your first crash-safe queue in production.",
    icon: Play,
    href: "/docs/quickstart",
    accent: "#e11d48",
    cta: "Start Tutorial",
  },
  {
    title: "Architecture Deep Dive",
    description:
      "Understand the adapter-driven design, DI container, leader election, and horizontal scaling.",
    icon: BookOpen,
    href: "/docs/architecture",
    accent: "#f97316",
    cta: "Read More",
  },
  {
    title: "Explore APIs",
    description:
      "Browse the full API surface — storage, broker, and lock adapters with unified contracts.",
    icon: Code2,
    href: "/docs/adapters",
    accent: "#eab308",
    cta: "View APIs",
  },
] as const;

const COMMUNITY = [
  {
    icon: GithubIcon,
    label: "GitHub",
    description: "View source code, submit PRs, or report issues.",
    href: "https://github.com/rohittiwari-dev/oqronkit",
    external: true,
  },
  {
    icon: Newspaper,
    label: "Changelog",
    description: "Stay up to date with the latest releases.",
    href: "https://github.com/rohittiwari-dev/oqronkit/releases",
    external: true,
  },
  {
    icon: MessageSquare,
    label: "Discussions",
    description: "Ask questions and share feedback with the community.",
    href: "https://github.com/rohittiwari-dev/oqronkit/discussions",
    external: true,
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

export function Community() {
  return (
    <section className="relative py-24 overflow-hidden border-t border-fd-border/40">
      <div className="container max-w-6xl mx-auto px-4 relative z-10">
        {/* Resource cards */}
        <div className="mb-20">
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-xs font-semibold text-fd-muted-foreground uppercase tracking-widest mb-8"
          >
            Resources
          </motion.p>

          <motion.div
            variants={stagger}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            className="grid gap-4 sm:grid-cols-3"
          >
            {CARDS.map((card) => {
              const Icon = card.icon;
              return (
                <motion.div key={card.title} variants={fadeUp}>
                  <Link
                    href={card.href}
                    className="group flex flex-col h-full rounded-xl border border-fd-border bg-fd-card/60 backdrop-blur-sm p-6 transition-all duration-200 hover:border-fd-border/80 hover:bg-fd-card/80 hover:shadow-lg"
                  >
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-lg mb-4"
                      style={{
                        background: `${card.accent}12`,
                        border: `1px solid ${card.accent}25`,
                      }}
                    >
                      <Icon
                        className="h-[18px] w-[18px]"
                        style={{ color: card.accent }}
                      />
                    </div>
                    <h3 className="text-base font-semibold text-fd-foreground mb-1.5">
                      {card.title}
                    </h3>
                    <p className="text-sm text-fd-muted-foreground leading-relaxed flex-1">
                      {card.description}
                    </p>
                    <div
                      className="flex items-center gap-1 mt-4 text-xs font-medium transition-colors"
                      style={{ color: card.accent }}
                    >
                      {card.cta}
                      <ArrowUpRight className="h-3 w-3" />
                    </div>
                  </Link>
                </motion.div>
              );
            })}
          </motion.div>
        </div>

        {/* Community links */}
        <div>
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-xs font-semibold text-fd-muted-foreground uppercase tracking-widest mb-8"
          >
            Join the community
          </motion.p>

          <motion.div
            variants={stagger}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            className="grid gap-4 sm:grid-cols-3"
          >
            {COMMUNITY.map((item) => {
              const Icon = item.icon;
              return (
                <motion.div key={item.label} variants={fadeUp}>
                  <Link
                    href={item.href}
                    target={item.external ? "_blank" : undefined}
                    rel={item.external ? "noopener noreferrer" : undefined}
                    className="group flex items-start gap-4 rounded-xl border border-fd-border bg-fd-card/60 backdrop-blur-sm p-5 transition-all duration-200 hover:border-fd-border/80 hover:bg-fd-card/80"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-fd-border bg-fd-card">
                      <Icon className="h-4 w-4 text-fd-muted-foreground group-hover:text-fd-foreground transition-colors" />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-fd-foreground mb-0.5 flex items-center gap-1">
                        {item.label}
                        {item.external && (
                          <ArrowUpRight className="h-3 w-3 text-fd-muted-foreground" />
                        )}
                      </h4>
                      <p className="text-xs text-fd-muted-foreground leading-relaxed">
                        {item.description}
                      </p>
                    </div>
                  </Link>
                </motion.div>
              );
            })}
          </motion.div>
        </div>
      </div>
    </section>
  );
}

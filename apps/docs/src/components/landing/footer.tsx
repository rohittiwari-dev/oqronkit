"use client";

import Image from "next/image";
import Link from "next/link";
import { GithubIcon, XTwitterIcon } from "../icons/brand-icons";
import { ThemeToggle } from "../layout/theme-toggle";

const LINKS = [
  {
    title: "Product",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "Quick Start", href: "/docs/quickstart" },
      { label: "Architecture", href: "/docs/architecture" },
      { label: "Crash Safety", href: "/docs/crash-safety" },
    ],
  },
  {
    title: "Modules",
    links: [
      { label: "Task Queue", href: "/docs/task-queue" },
      { label: "Distributed Worker", href: "/docs/distributed-worker" },
      { label: "Scheduler", href: "/docs/scheduler" },
      { label: "Rate Limiter", href: "/docs/rate-limiter" },
      { label: "Webhook", href: "/docs/webhook" },
    ],
  },
  {
    title: "Connect",
    links: [
      {
        label: "GitHub",
        href: "https://github.com/rohittiwari-dev/oqronkit",
        external: true,
      },
      {
        label: "Twitter / X",
        href: "https://x.com/rohittiwari_dev",
        external: true,
      },
      {
        label: "Rohit Tiwari",
        href: "https://rohittiwari.me",
        external: true,
      },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative border-t border-fd-border/50 bg-fd-card/30 backdrop-blur-sm">
      <div className="container max-w-6xl mx-auto px-4 py-14 relative z-10">
        <div className="grid gap-10 lg:grid-cols-5">
          {/* Brand */}
          <div className="lg:col-span-2">
            <Link href="/" className="flex items-center gap-2 group mb-5 w-fit">
              <Image
                src="/icon.png"
                alt="OqronKit logo"
                width={24}
                height={24}
                className="transition-transform group-hover:scale-105"
              />
              <span className="text-lg font-bold tracking-tight text-fd-foreground">
                OqronKit
              </span>
            </Link>

            <p className="text-sm text-fd-muted-foreground leading-relaxed max-w-xs mb-6">
              The enterprise-grade background job engine for Node.js.
              Crash-safe, adapter-driven, and open source.
            </p>

            <div className="flex gap-3 items-center">
              <Link
                href="https://github.com/rohittiwari-dev/oqronkit"
                target="_blank"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-fd-border text-fd-muted-foreground transition-colors hover:text-fd-foreground hover:bg-fd-accent"
                aria-label="GitHub"
              >
                <GithubIcon className="h-3.5 w-3.5" />
              </Link>
              <Link
                href="https://x.com/rohittiwari_dev"
                target="_blank"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-fd-border text-fd-muted-foreground transition-colors hover:text-fd-foreground hover:bg-fd-accent"
                aria-label="Twitter"
              >
                <XTwitterIcon className="h-3.5 w-3.5" />
              </Link>
              <div className="border-l border-fd-border pl-3">
                <ThemeToggle className="scale-85" />
              </div>
            </div>
          </div>

          {/* Nav columns */}
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:col-span-3">
            {LINKS.map((col) => (
              <div key={col.title}>
                <h3 className="mb-4 text-xs font-semibold text-fd-foreground uppercase tracking-wider">
                  {col.title}
                </h3>
                <ul className="space-y-2.5">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        target={link.href ? "_blank" : undefined}
                        rel={link.href ? "noopener noreferrer" : undefined}
                        className="text-sm text-fd-muted-foreground transition-colors hover:text-fd-foreground"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-fd-border/40 pt-6 sm:flex-row">
          <p className="text-xs text-fd-muted-foreground">
            © {new Date().getFullYear()} Rohit Tiwari. Released under the MIT
            License.
          </p>
          <div className="flex items-center gap-1.5 text-xs text-fd-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
            All systems operational
          </div>
        </div>
      </div>
    </footer>
  );
}

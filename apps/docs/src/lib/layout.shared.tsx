import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Image from "next/image";

export const gitConfig = {
  user: "rohittiwari-dev",
  repo: "choronoforge",
  branch: "main",
};

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2 group">
          <Image
            src="/icon.png"
            alt="OqronKit"
            width={28}
            height={28}
            className="transition-transform group-hover:scale-105"
          />
          <span className="font-bold tracking-tight text-fd-foreground">
            OqronKit
          </span>
        </span>
      ),
    },
    links: [
      {
        text: "Documentation",
        url: "/docs",
        active: "nested-url",
      },
      {
        text: "Modules",
        url: "/docs/task-queue",
        active: "nested-url",
      },
      {
        text: "API Reference",
        url: "/docs/adapters",
        active: "nested-url",
      },
    ],
    githubUrl: "https://github.com/rohittiwari-dev/choronoforge",
  };
}

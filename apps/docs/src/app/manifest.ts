import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OqronKit",
    short_name: "OqronKit",
    description:
      "Enterprise-grade, crash-safe background job engine for Node.js. 12 modules — queues, workers, schedulers, rate limiters, webhooks, sagas, and more.",
    start_url: "/",
    display: "browser",
    background_color: "#09090b",
    theme_color: "#7C3AED",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "48x48",
        type: "image/x-icon",
      },
      {
        src: "/icon.png",
        sizes: "any",
        type: "image/svg+xml",
      },
      {
        src: "/apple-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  };
}

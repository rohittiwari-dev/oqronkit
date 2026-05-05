/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OqronKit — Distributed Queue + Worker Examples
 *  Real-world production examples showcasing decoupled Queue/Worker architecture.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Queue/Worker vs. Monolithic queue():
 *  • Publisher Queue → A queue with NO handler. Strictly for publishing.
 *                      Consumes ZERO CPU/polling overhead.
 *                      Deployed on light, auto-scaling API / Ingress pods.
 *
 *  • Worker         → Pure consumer. Strictly for processing logic.
 *                      No `.add()` method provided.
 *                      Deployed on heavy background worker pods.
 *
 *  This separation ensures your API servers can push 100k jobs/sec
 *  without competing for memory/CPU heavily utilized by video rendering.
 */

import { queue, worker } from "oqronkit";

// ═══════════════════════════════════════════════════════════════════════════════
//  1. PUBLISHER ONLY (API / Web Tier)
//     Use `queue()` without a handler to return an IPublisherQueue
//     that skips the polling engine completely.
// ═══════════════════════════════════════════════════════════════════════════════

type VideoMetadata = {
  videoId: string;
  s3ResourceUri: string;
  codec: "h264" | "hevc" | "av1";
  bitrate: number;
};

/**
 * Publisher Queue: Video Encoder
 * It only exposes `.add()` and `.addBulk()` methods.
 * Guaranteed to never crash your API tier.
 */
export const videoEncodeQueue = queue<VideoMetadata, string>({
  name: "video-encode-topic",
  // Notice: no "handler" defined!
});

/**
 * Controller Example:
 * API hit happens, we quickly buffer it into the backend.
 */
export async function handleUserUpload(userId: string, tempFilePath: string) {
  const dbId = `vid_` + Date.now().toString(36);

  // Fast dispatch to Redis/DB broker. Instantly frees up the API request.
  const job = await videoEncodeQueue.add(
    {
      videoId: dbId,
      s3ResourceUri: tempFilePath,
      codec: "hevc",
      bitrate: 4500,
    },
    {
      jobId: dbId, // Prevents the user from accidentally duplicating uploads
    },
  );

  return { success: true, trackingId: job.id };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  2. CONSUMER ONLY (Worker / Compute Tier)
//     Use `worker()` to register a topic handler.
//     These run on dedicated infrastructure and chew through jobs.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Background Worker: Video Encoder
 * This worker pulls from "video-encode-topic" securely ensuring locks.
 */
export const videoEncodeWorker = worker<VideoMetadata, string>({
  topic: "video-encode-topic",

  // Only process 2 huge videos per server to avoid OOM
  concurrency: 2,

  // High availability heartbeat lock protection against Spot Instance termination
  guaranteedWorker: true,
  heartbeatMs: 5_000,
  lockTtlMs: 30_000,

  // Handle 1 retry if transcoding crashes
  retries: {
    max: 1,
    strategy: "fixed",
    baseDelay: 10_000,
  },

  // Centralized success/fail logging decoupled from publishers
  hooks: {
    onSuccess: (job, finalUrl) => {
      console.log(
        `[WORKER] Video ${job.data.videoId} completed! Uploaded to: ${finalUrl}`,
      );
    },
    onFail: (job, err) => {
      console.error(
        `[WORKER] Video ${job.data.videoId} died permanently:`,
        err,
      );
    },
  },

  // The mighty execution engine
  handler: async (ctx) => {
    const { videoId, codec, s3ResourceUri } = ctx.data;

    ctx.log("info", `[Transcoder] Fetching source from ${s3ResourceUri}...`);
    ctx.progress(10, `Downloading source`);
    await new Promise((r) => setTimeout(r, 2000));

    // Support Mid-execution cancellation explicitly
    if (ctx.signal.aborted) {
      throw new Error("Transcoding cancelled by User");
    }

    ctx.progress(40, `Transcoding to ${codec}...`);
    await new Promise((r) => setTimeout(r, 10000)); // Heavy FFmpeg computation Simulation

    ctx.progress(90, `Uploading MP4 chunks...`);
    await new Promise((r) => setTimeout(r, 1500));

    ctx.progress(100, `Done!`);

    // This return value becomes the `job.result` fetched by API querying the tracker
    return `https://cdn.example.com/videos/${videoId}.mp4`;
  },
});

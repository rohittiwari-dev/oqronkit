/**
 * OqronKit — Advanced Patterns Examples
 *
 * Demonstrates Job Dependencies (DAG), Cron Clustering, and Sandboxed Workers.
 */
import {
  cronModule,
  defineConfig,
  scheduleModule,
  queue as taskQueue,
} from "oqronkit";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. JOB DEPENDENCIES (DAG) — Extract → Transform → Load Pipeline
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Step 1: Extract raw data from a source.
 */
export const extractQueue = taskQueue<
  { source: string; format: "csv" | "json" | "parquet" },
  { rowCount: number; tempPath: string }
>({
  name: "pipeline-extract",
  concurrency: 3,
  retries: { max: 2, strategy: "fixed", baseDelay: 5_000 },
  removeOnComplete: { count: 100 },

  handler: async (ctx) => {
    ctx.progress(10, `Downloading ${ctx.data.source}`);

    // Simulate extraction
    await new Promise((r) => setTimeout(r, 500));
    ctx.progress(50, "Parsing data");

    await new Promise((r) => setTimeout(r, 300));
    ctx.progress(100, "Extraction complete");

    return {
      rowCount: 15_000,
      tempPath: `/tmp/extracted-${ctx.id}.json`,
    };
  },
});

/**
 * Step 2: Transform data. Waits for extract to complete.
 */
export const transformQueue = taskQueue<
  { tempPath: string; transformations: string[] },
  { outputPath: string; processedRows: number }
>({
  name: "pipeline-transform",
  concurrency: 2,
  removeOnComplete: { count: 100 },

  handler: async (ctx) => {
    ctx.progress(10, "Loading extracted data");
    await new Promise((r) => setTimeout(r, 400));

    ctx.progress(
      50,
      `Applying ${ctx.data.transformations.length} transformations`,
    );
    await new Promise((r) => setTimeout(r, 600));

    ctx.progress(100, "Transformation complete");
    return {
      outputPath: `/tmp/transformed-${ctx.id}.json`,
      processedRows: 14_800,
    };
  },
});

/**
 * Step 3: Load into warehouse. Waits for transform to complete.
 */
export const loadQueue = taskQueue<
  { outputPath: string; targetTable: string },
  { insertedRows: number; duration: number }
>({
  name: "pipeline-load",
  concurrency: 1,
  removeOnComplete: { count: 100 },

  handler: async (ctx) => {
    const start = Date.now();
    ctx.progress(10, `Loading into ${ctx.data.targetTable}`);
    await new Promise((r) => setTimeout(r, 800));

    ctx.progress(100, "Load complete");
    return {
      insertedRows: 14_800,
      duration: Date.now() - start,
    };
  },
});

/**
 * Orchestrate the full ETL pipeline using job dependencies.
 *
 * @example
 * ```typescript
 * const pipeline = await runETLPipeline({
 *   source: "s3://bucket/users.csv",
 *   format: "csv",
 *   transforms: ["normalize-emails", "deduplicate"],
 *   targetTable: "analytics.users",
 * });
 * console.log(pipeline);
 * // { extract: "job-1", transform: "job-2", load: "job-3" }
 * ```
 */
export async function runETLPipeline(params: {
  source: string;
  format: "csv" | "json" | "parquet";
  transforms: string[];
  targetTable: string;
}) {
  // Step 1: Extract (starts immediately)
  const extractJob = await extractQueue.add({
    source: params.source,
    format: params.format,
  });

  // Step 2: Transform (waits for extract)
  const transformJob = await transformQueue.add(
    {
      tempPath: "", // Will be populated by extract's result in production
      transformations: params.transforms,
    },
    {
      dependsOn: [extractJob.id],
      parentFailurePolicy: "cascade-fail",
    },
  );

  // Step 3: Load (waits for transform)
  const loadJob = await loadQueue.add(
    {
      outputPath: "", // Will be populated by transform's result
      targetTable: params.targetTable,
    },
    {
      dependsOn: [transformJob.id],
      parentFailurePolicy: "cascade-fail",
    },
  );

  return {
    extract: extractJob.id,
    transform: transformJob.id,
    load: loadJob.id,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. FAN-OUT / FAN-IN — Multiple parents converging into one child
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Process multiple data sources in parallel, then merge results.
 *
 * @example
 * ```typescript
 * const merge = await runFanOutFanIn(["users.csv", "orders.csv", "products.csv"]);
 * // merge job won't start until ALL 3 source jobs complete
 * ```
 */
export async function runFanOutFanIn(sources: string[]) {
  // Fan-out: create parallel extract jobs
  const parentIds: string[] = [];
  for (const source of sources) {
    const job = await extractQueue.add({
      source,
      format: "csv",
    });
    parentIds.push(job.id);
  }

  // Fan-in: merge job waits for ALL parents
  const mergeJob = await transformQueue.add(
    {
      tempPath: "merge-all",
      transformations: ["concat", "deduplicate"],
    },
    {
      dependsOn: parentIds,
      parentFailurePolicy: "cascade-fail",
    },
  );

  return { parentIds, mergeJobId: mergeJob.id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CRON CLUSTERING — Multi-Region Scheduling Config
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Example configs for multi-region deployment.
 * Each region owns a subset of shards for geo-distributed scheduling.
 */

/** US-East region config — handles shards 0-3 */
export const usEastConfig = defineConfig({
  project: "global-saas",
  environment: "production",
  modules: [
    scheduleModule({
      clustering: {
        totalShards: 8,
        ownedShards: [0, 1, 2, 3],
        region: "us-east",
      },
    }),
    cronModule({
      clustering: {
        totalShards: 8,
        ownedShards: [0, 1, 2, 3],
        region: "us-east",
      },
    }),
  ],
});

/** EU-West region config — handles shards 4-7 */
export const euWestConfig = defineConfig({
  project: "global-saas",
  environment: "production",
  modules: [
    scheduleModule({
      clustering: {
        totalShards: 8,
        ownedShards: [4, 5, 6, 7],
        region: "eu-west",
      },
    }),
    cronModule({
      clustering: {
        totalShards: 8,
        ownedShards: [4, 5, 6, 7],
        region: "eu-west",
      },
    }),
  ],
});

/**
 * Hono adapter for ChronoForge monitoring routes.
 *
 * Usage:
 *   import { Hono } from 'hono';
 *   import { chronoHonoApp } from './adapters/hono.js';
 *   const app = new Hono();
 *   app.route('/api/chrono', chronoHonoApp);
 */
import { Hono } from "hono";
import { dispatch } from "../handlers/monitoring.handlers.js";

export const chronoHonoApp = new Hono();

chronoHonoApp.all("*", async (c) => {
  const url = new URL(c.req.url);
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    query[k] = v;
  });

  const result = await dispatch({
    method: c.req.method,
    path: url.pathname.replace(/^\/api\/chrono/, ""),
    query,
    params: c.req.param(),
  });
  return c.json(result.body, result.status as never);
});

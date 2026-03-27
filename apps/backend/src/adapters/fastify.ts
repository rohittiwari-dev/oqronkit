/**
 * Fastify adapter for ChronoForge monitoring routes.
 * Register this plugin into your Fastify instance.
 *
 * Usage:
 *   import Fastify from 'fastify';
 *   import { chronoPlugin } from './adapters/fastify.js';
 *   const fastify = Fastify();
 *   fastify.register(chronoPlugin, { prefix: '/api/chrono' });
 */
import type { FastifyPluginAsync } from "fastify";
import { dispatch } from "../handlers/monitoring.handlers.js";

export const chronoPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.all("/*", async (req, reply) => {
    const result = await dispatch({
      method: req.method,
      path: `/${(req.params as Record<string, string>)["*"]}`,
      query: req.query as Record<string, string>,
      params: req.params as Record<string, string>,
    });
    return reply.status(result.status).send(result.body);
  });
};

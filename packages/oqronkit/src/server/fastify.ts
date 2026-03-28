import { dispatch } from "./handlers.js";

/**
 * Fastify plugin for OqronKit monitoring.
 *
 * Usage:
 *   const { OqronKit } = require('oqronkit');
 *   fastify.register(OqronKit.fastifyPlugin);
 */
export function fastifyPlugin(
  fastify: any,
  _opts: any,
  done: () => void,
): void {
  fastify.all("*", async (req: any, reply: any) => {
    // Strip prefix logic inside Fastify might require checking exact paths
    // But the dispatch matches absolute base paths.
    // For simplicity we pass req.params and query.
    // Since wildcard capture matches rest, we map `*` as the sub-path
    const pathParams = req.params["*"];
    const path = pathParams ? `/${pathParams}` : req.url;

    const result = await dispatch({
      method: req.method,
      path,
      query: req.query,
      params: req.params,
    });

    return reply.status(result.status).send(result.body);
  });
  done();
}

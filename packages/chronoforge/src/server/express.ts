import { dispatch } from "./handlers.js";

/**
 * Express.js middleware/router for ChronoForge monitoring.
 *
 * Usage:
 *   const { ChronoForge } = require('chronoforge');
 *   app.use('/api/chrono', ChronoForge.expressRouter());
 */
export function expressRouter(): any {
  // Return a generic middleware function that matches Express signature: (req, res, next)
  return async function chronoMiddleware(req: any, res: any, next: any) {
    // We only want to handle our sub-routes
    // In express, if mounted via app.use('/api/chrono', middleware),
    // req.path is the sub-path (e.g. /health).

    // Safety check, although Express generally strips the mount point
    const matchPath = req.path;

    try {
      const result = await dispatch({
        method: req.method,
        path: matchPath,
        query: req.query || {},
        params: req.params || {},
      });

      if (
        result.status === 404 &&
        result.body &&
        (result.body as any).error === "Not found"
      ) {
        // If not found in our handlers, let express continue
        return next();
      }

      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  };
}

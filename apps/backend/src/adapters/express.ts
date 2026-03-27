/**
 * Express.js adapter for ChronoForge monitoring routes.
 * Mount this router into your existing Express app.
 *
 * Usage:
 *   import express from 'express';
 *   import { chronoRouter } from './adapters/express.js';
 *   app.use('/api/chrono', chronoRouter);
 */

import type { Request, Response } from "express";
import { Router } from "express";
import { dispatch } from "../handlers/monitoring.handlers.js";

export const chronoRouter = Router();

chronoRouter.all("*", async (req: Request, res: Response) => {
  const result = await dispatch({
    method: req.method,
    path: req.path,
    query: req.query as Record<string, string>,
    params: req.params,
  });
  res.status(result.status).json(result.body);
});

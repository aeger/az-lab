import type { Router } from 'express';
import express from 'express';

export const healthRouter: Router = express.Router();

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '2.0.0', time: new Date().toISOString() });
});

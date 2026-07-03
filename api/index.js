/**
 * api/index.js — Vercel Serverless Function entry point
 *
 * Imports the core Express app and exports it for Vercel's serverless runtime.
 */

import app from '../server/app.js';

export default app;

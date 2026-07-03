/**
 * server/index.js — Local Server Entry Point
 *
 * Imports the core Express app, registers static files serving for production,
 * and binds the listening port.
 */

import app from './app.js';
import dotenv from 'dotenv';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Serve static compiled frontend in production
app.use(express.static(join(__dirname, '..', 'dist')));

// Fallback for SPA routing
app.get(/^\/(.*)$/, (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(join(__dirname, '..', 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  🌐  Translation Moderator API`);
  console.log(`  ────────────────────────────`);
  console.log(`  Running on http://localhost:${PORT}`);
  console.log();
});

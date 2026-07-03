/**
 * server/index.js — Express API for the Translation Moderator
 *
 * Endpoints:
 *   GET  /api/projects                       → list configured projects
 *   GET  /api/projects/:id/translations      → fetch & parse translation pairs
 *   POST /api/projects/:id/translations      → commit updated translations & open PR
 *   GET  /api/projects/:id/prs               → list open translation PRs
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { getFileContent, commitTranslations, getOpenTranslationPRs } from './github.js';
import { parseTranslationFile, reconstructFile } from './parser.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Load project configuration
const configPath = join(__dirname, '..', 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

// ── GET /api/projects ────────────────────────────────────────────────

app.get('/api/projects', (req, res) => {
  const projects = config.projects.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    repo: p.repo,
    icon: p.icon,
    hasTranslations: !!p.translationFile,
    note: p.note || null,
  }));
  res.json({ projects });
});

// ── GET /api/projects/:id/translations ───────────────────────────────

app.get('/api/projects/:id/translations', async (req, res) => {
  try {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!project.translationFile) {
      return res.status(400).json({
        error: 'No translation file configured',
        note: project.note,
      });
    }

    // Fetch file from GitHub
    const { content, sha } = await getFileContent(
      project.repo,
      project.translationFile,
      project.branch
    );

    // Parse to extract en + jp
    const { source, target } = parseTranslationFile(
      content,
      project.variableName,
      project.sourceLocale,
      project.targetLocale
    );

    // Build a flat list of translation pairs
    const keys = new Set([...Object.keys(source), ...Object.keys(target)]);
    const pairs = [];

    for (const key of keys) {
      const enVal = source[key];
      const jpVal = target[key];
      pairs.push({
        key,
        en: enVal !== undefined ? enVal : null,
        jp: jpVal !== undefined ? jpVal : null,
        isArray: Array.isArray(enVal) || Array.isArray(jpVal),
      });
    }

    // Sort: keys with missing JP first, then alphabetical
    pairs.sort((a, b) => {
      const aMissing = a.jp === null ? 0 : 1;
      const bMissing = b.jp === null ? 0 : 1;
      if (aMissing !== bMissing) return aMissing - bMissing;
      return a.key.localeCompare(b.key);
    });

    res.json({
      project: {
        id: project.id,
        name: project.name,
        repo: project.repo,
        branch: project.branch,
        file: project.translationFile,
      },
      sha,
      totalKeys: pairs.length,
      translatedKeys: pairs.filter(p => p.jp !== null).length,
      pairs,
    });
  } catch (err) {
    console.error('Error fetching translations:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/projects/:id/translations ──────────────────────────────

app.post('/api/projects/:id/translations', async (req, res) => {
  try {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { updates, sha } = req.body;
    // updates: { key: newValue, ... }

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No changes to commit' });
    }

    // Fetch current file to get latest content
    const { content: currentContent, sha: currentSha } = await getFileContent(
      project.repo,
      project.translationFile,
      project.branch
    );

    // Verify SHA matches (optimistic concurrency)
    if (sha && sha !== currentSha) {
      return res.status(409).json({
        error: 'File has been modified since you loaded it. Please refresh and try again.',
      });
    }

    // Parse existing translations
    const { target } = parseTranslationFile(
      currentContent,
      project.variableName,
      project.sourceLocale,
      project.targetLocale
    );

    // Apply updates
    const mergedTarget = { ...target };
    const changedKeys = [];
    for (const [key, value] of Object.entries(updates)) {
      if (JSON.stringify(mergedTarget[key]) !== JSON.stringify(value)) {
        mergedTarget[key] = value;
        changedKeys.push(key);
      }
    }

    if (changedKeys.length === 0) {
      return res.status(400).json({ error: 'No actual changes detected' });
    }

    // Reconstruct file
    const updatedContent = reconstructFile(
      currentContent,
      project.variableName,
      project.targetLocale,
      mergedTarget
    );

    // Commit and open PR
    const result = await commitTranslations({
      fullRepo: project.repo,
      baseBranch: project.branch,
      filePath: project.translationFile,
      fileContent: updatedContent,
      fileSha: currentSha,
      changedKeys,
    });

    res.json({
      success: true,
      changedKeys: changedKeys.length,
      pr: result,
    });
  } catch (err) {
    console.error('Error saving translations:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/projects/:id/prs ────────────────────────────────────────

app.get('/api/projects/:id/prs', async (req, res) => {
  try {
    const project = config.projects.find(p => p.id === req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const prs = await getOpenTranslationPRs(project.repo);
    res.json({ prs });
  } catch (err) {
    console.error('Error fetching PRs:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve static compiled frontend in production
app.use(express.static(join(__dirname, '..', 'dist')));

// Fallback for SPA routing
app.get(/^\/(.*)$/, (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(join(__dirname, '..', 'dist', 'index.html'));
});

// ── Start ────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  🌐  Translation Moderator API`);
  console.log(`  ────────────────────────────`);
  console.log(`  Running on http://localhost:${PORT}`);
  console.log(`  Projects: ${config.projects.length}`);
  console.log();
});

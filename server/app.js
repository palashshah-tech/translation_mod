/**
 * server/app.js — Core Express Application
 *
 * Defines all routes and middlewares. Imported by local dev server
 * and Vercel Serverless Function entry point.
 */

import express from 'express';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

import { getFileContent, commitTranslations, getOpenTranslationPRs } from './github.js';
import { parseTranslationFile, reconstructFile } from './parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Configure JWKS client to fetch Firebase public keys dynamically
const client = jwksClient({
  jwksUri: 'https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com',
  cache: true,
  rateLimit: true,
  jwksRequestsPerMinute: 100
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, function(err, key) {
    if (err) return callback(err);
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

// Authentication middleware
async function authMiddleware(req, res, next) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    console.warn('⚠️ FIREBASE_PROJECT_ID is not set in env. Skipping API token verification.');
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const token = authHeader.split(' ')[1];

  jwt.verify(token, getKey, {
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
    algorithms: ['RS256'],
    clockTolerance: 60 // 60 seconds tolerance to prevent clock skew errors
  }, (err, decoded) => {
    if (err) {
      console.error('Token verification failed:', err.message);
      return res.status(401).json({ error: `Unauthorized: Token verification failed (${err.message})` });
    }

    const email = decoded.email || '';
    if (!email.endsWith('@xiberlinc.one')) {
      return res.status(403).json({ error: 'Forbidden: Access restricted to @xiberlinc.one accounts' });
    }

    req.user = decoded;
    next();
  });
}

// Protect all /api/ endpoints with authMiddleware
app.use('/api', authMiddleware);

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
    if (!project.translationFile && project.format !== 'json-split') {
      return res.status(400).json({
        error: 'No translation file configured',
        note: project.note,
      });
    }

    let source = {};
    let target = {};
    let sha = '';

    if (project.format === 'json-split') {
      const sourceRes = await getFileContent(
        project.repo,
        project.sourceFile,
        project.branch
      );
      const targetRes = await getFileContent(
        project.repo,
        project.targetFile,
        project.branch
      );
      source = JSON.parse(sourceRes.content);
      target = JSON.parse(targetRes.content);
      sha = targetRes.sha;
    } else {
      // Fetch file from GitHub
      const { content, sha: fileSha } = await getFileContent(
        project.repo,
        project.translationFile,
        project.branch
      );
      sha = fileSha;

      // Parse to extract en + jp/ja
      const parsed = parseTranslationFile(
        content,
        project.variableName,
        project.sourceLocale,
        project.targetLocale
      );
      source = parsed.source;
      target = parsed.target;
    }

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
        file: project.format === 'json-split' ? project.targetFile : project.translationFile,
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

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No changes to commit' });
    }

    let updatedContent = '';
    let targetPath = '';
    let targetSha = '';
    let changedKeys = [];

    if (project.format === 'json-split') {
      const { content: currentContent, sha: currentSha } = await getFileContent(
        project.repo,
        project.targetFile,
        project.branch
      );

      if (sha && sha !== currentSha) {
        return res.status(409).json({
          error: 'File has been modified since you loaded it. Please refresh and try again.',
        });
      }

      const targetJson = JSON.parse(currentContent);
      const mergedTarget = { ...targetJson };

      for (const [key, value] of Object.entries(updates)) {
        if (JSON.stringify(mergedTarget[key]) !== JSON.stringify(value)) {
          mergedTarget[key] = value;
          changedKeys.push(key);
        }
      }

      if (changedKeys.length === 0) {
        return res.status(400).json({ error: 'No actual changes detected' });
      }

      updatedContent = JSON.stringify(mergedTarget, null, 2) + '\n';
      targetPath = project.targetFile;
      targetSha = currentSha;
    } else {
      const { content: currentContent, sha: currentSha } = await getFileContent(
        project.repo,
        project.translationFile,
        project.branch
      );

      if (sha && sha !== currentSha) {
        return res.status(409).json({
          error: 'File has been modified since you loaded it. Please refresh and try again.',
        });
      }

      const { target } = parseTranslationFile(
        currentContent,
        project.variableName,
        project.sourceLocale,
        project.targetLocale
      );

      const mergedTarget = { ...target };
      for (const [key, value] of Object.entries(updates)) {
        if (JSON.stringify(mergedTarget[key]) !== JSON.stringify(value)) {
          mergedTarget[key] = value;
          changedKeys.push(key);
        }
      }

      if (changedKeys.length === 0) {
        return res.status(400).json({ error: 'No actual changes detected' });
      }

      updatedContent = reconstructFile(
        currentContent,
        project.variableName,
        project.targetLocale,
        mergedTarget
      );
      targetPath = project.translationFile;
      targetSha = currentSha;
    }

    // Commit and open PR
    const result = await commitTranslations({
      fullRepo: project.repo,
      baseBranch: project.branch,
      filePath: targetPath,
      fileContent: updatedContent,
      fileSha: targetSha,
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

export default app;

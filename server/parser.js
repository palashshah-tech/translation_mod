/**
 * parser.js — Parse and reconstruct JS translation files
 *
 * Handles the two translation file formats used across Xiberlinc repos:
 *   1. `export const translations = { en: {...}, jp: {...} }`  (xiberlinc)
 *   2. `const DICTIONARY = { en: {...}, jp: {...} }`           (working_memory)
 *
 * Strategy: Use brace-matching to extract locale blocks, then vm.runInNewContext
 * for safe evaluation. Reconstruction replaces only the target-locale block,
 * preserving all surrounding code (imports, exports, React context, etc.).
 */

import vm from 'node:vm';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Find the index of the matching closing brace, respecting strings.
 * @param {string} src  Full source text
 * @param {number} openBraceIdx  Index of the opening `{`
 * @returns {number} Index of the matching `}`  (-1 if not found)
 */
function findMatchingBrace(src, openBraceIdx) {
  let depth = 0;
  let inStr = false;
  let strChar = null;
  let escaped = false;

  for (let i = openBraceIdx; i < src.length; i++) {
    const ch = src[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }

    if (inStr) {
      if (ch === strChar) { inStr = false; strChar = null; }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = true;
      strChar = ch;
      continue;
    }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Find the index of the matching closing bracket `]`, respecting strings.
 */
function findMatchingBracket(src, openBracketIdx) {
  let depth = 0;
  let inStr = false;
  let strChar = null;
  let escaped = false;

  for (let i = openBracketIdx; i < src.length; i++) {
    const ch = src[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }

    if (inStr) {
      if (ch === strChar) { inStr = false; strChar = null; }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = true;
      strChar = ch;
      continue;
    }

    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ── Core: Extract locale block ──────────────────────────────────────

/**
 * Locate the `localeName: { ... }` block inside the top-level variable.
 * Returns { start, end, content } where start/end are indices in src.
 */
function findLocaleBlock(src, variableName, locale) {
  // 1. Find the variable declaration
  const varPattern = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+${variableName}\\s*=\\s*\\{`
  );
  const varMatch = src.match(varPattern);
  if (!varMatch) {
    throw new Error(`Could not find variable "${variableName}" in file`);
  }
  const objOpenBrace = varMatch.index + varMatch[0].length - 1;

  // 2. Find the locale key (e.g. "en: {" or "jp: {")
  //    Search only within the top-level object
  const objCloseBrace = findMatchingBrace(src, objOpenBrace);
  const objBody = src.substring(objOpenBrace, objCloseBrace + 1);

  // Match  locale: {  or  locale: [  (some files might be arrays at top level)
  const localePattern = new RegExp(`(\\b${locale}\\s*:\\s*)\\{`);
  const localeMatch = objBody.match(localePattern);
  if (!localeMatch) {
    throw new Error(`Locale "${locale}" not found in variable "${variableName}"`);
  }

  const localeOpenBrace = objOpenBrace + localeMatch.index + localeMatch[0].length - 1;
  const localeCloseBrace = findMatchingBrace(src, localeOpenBrace);

  if (localeCloseBrace === -1) {
    throw new Error(`Could not find matching brace for locale "${locale}"`);
  }

  return {
    start: localeOpenBrace,
    end: localeCloseBrace,
    content: src.substring(localeOpenBrace, localeCloseBrace + 1),
  };
}

// ── Parse ────────────────────────────────────────────────────────────

/**
 * Parse a JS translation file and return { en: {...}, jp: {...} }.
 * Works with both exports/const patterns used in the Xiberlinc repos.
 */
export function parseTranslationFile(fileContent, variableName, sourceLocale, targetLocale) {
  const srcBlock = findLocaleBlock(fileContent, variableName, sourceLocale);
  let tgtBlock;
  try {
    tgtBlock = findLocaleBlock(fileContent, variableName, targetLocale);
  } catch {
    tgtBlock = null;
  }

  // Evaluate blocks in a sandbox
  const sandbox = {};
  vm.runInNewContext(`source = ${srcBlock.content}`, sandbox);

  let targetObj = {};
  if (tgtBlock) {
    vm.runInNewContext(`target = ${tgtBlock.content}`, sandbox);
    targetObj = sandbox.target;
  }

  return {
    source: sandbox.source,
    target: targetObj,
  };
}

// ── Reconstruct ──────────────────────────────────────────────────────

/**
 * Serialize a translations object back to JS object literal text.
 */
function serializeTranslations(obj, indent = '    ') {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    // Quote the key only if it contains special characters
    const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);

    if (Array.isArray(value)) {
      const items = value.map(v => JSON.stringify(v));
      // If total length is short, single line
      const singleLine = `[${items.join(', ')}]`;
      if (singleLine.length < 100) {
        lines.push(`${indent}${safeKey}: ${singleLine}`);
      } else {
        lines.push(`${indent}${safeKey}: [`);
        items.forEach((item, i) => {
          lines.push(`${indent}  ${item}${i < items.length - 1 ? ',' : ''}`);
        });
        lines.push(`${indent}]`);
      }
    } else if (typeof value === 'object' && value !== null) {
      // Nested object (rare but possible)
      lines.push(`${indent}${safeKey}: {`);
      const nested = serializeTranslations(value, indent + '  ');
      lines.push(nested);
      lines.push(`${indent}}`);
    } else {
      lines.push(`${indent}${safeKey}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join(',\n');
}

/**
 * Reconstruct the full file by replacing the target-locale block.
 */
export function reconstructFile(originalContent, variableName, targetLocale, updatedTranslations) {
  const block = findLocaleBlock(originalContent, variableName, targetLocale);

  const newBlock = `{\n${serializeTranslations(updatedTranslations)}\n  }`;

  return (
    originalContent.substring(0, block.start) +
    newBlock +
    originalContent.substring(block.end + 1)
  );
}

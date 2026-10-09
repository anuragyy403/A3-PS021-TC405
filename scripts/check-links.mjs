#!/usr/bin/env node
/**
 * Link check for README.md and docs/**\/*.md (plain Node, no dependencies).
 *
 *   node scripts/check-links.mjs
 *
 * Checks every Markdown link [text](target) outside code blocks:
 *   - relative file/folder targets must exist;
 *   - #anchors (same file or other .md file) must match a heading, using
 *     GitHub's slug rules (lowercase, drop punctuation, spaces → "-", -1/-2 for repeats).
 * External http(s)/mailto links are listed but not fetched.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function mdFiles() {
  const files = [path.join(ROOT, 'README.md')];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'docs'));
  return files;
}

/** Markdown with fenced code blocks and inline code removed. */
function prose(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '``');
}

export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (!anchorCache.has(file)) {
    const seen = new Map();
    const set = new Set();
    for (const line of prose(readFileSync(file, 'utf8')).split(/\r?\n/)) {
      const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (!m) continue;
      const base = slug(m[2].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`/g, ''));
      const n = seen.get(base) ?? 0;
      set.add(n === 0 ? base : `${base}-${n}`);
      seen.set(base, n + 1);
    }
    anchorCache.set(file, set);
  }
  return anchorCache.get(file);
}

const problems = [];
let checked = 0;
let external = 0;
for (const file of mdFiles()) {
  const text = prose(readFileSync(file, 'utf8'));
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:)/.test(target)) { external += 1; continue; }
    checked += 1;
    const [rawPath, anchor] = target.split('#');
    const resolved = rawPath ? path.resolve(path.dirname(file), decodeURIComponent(rawPath)) : file;
    const where = path.relative(ROOT, file);
    if (!existsSync(resolved)) {
      problems.push(`${where}: missing file  ${target}`);
      continue;
    }
    if (anchor !== undefined && resolved.endsWith('.md') && !anchorsOf(resolved).has(anchor)) {
      problems.push(`${where}: missing anchor  ${target}`);
    }
  }
}

console.log(`checked ${checked} relative links in ${mdFiles().length} Markdown files (${external} external links not fetched)`);
for (const p of problems) console.log(`  BROKEN  ${p}`);
console.log(problems.length ? `${problems.length} broken link(s)` : 'all relative links and anchors resolve');
if (problems.length) process.exitCode = 1;

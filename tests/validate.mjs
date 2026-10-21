#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = 'stackwise';
const SKILL_DIR = join(root, 'skills', PLUGIN);
const MAX_SKILL_LINES = 250;
// Claude Code truncates description + when_to_use at this length in the skill listing.
const MAX_DESCRIPTION_CHARS = 1536;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const failures = [];
let checks = 0;

function check(ok, message) {
  checks += 1;
  if (!ok) failures.push(message);
  return ok;
}

function readText(rel) {
  const path = join(root, rel);
  if (!check(existsSync(path), `${rel} is missing`)) return null;
  return readFileSync(path, 'utf8');
}

function readJson(rel) {
  const text = readText(rel);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    check(false, `${rel} does not parse: ${err.message}`);
    return null;
  }
}

function parseFrontmatter(text) {
  // Claude Code reads frontmatter only when the opening fence is the first line.
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return fields;
}

function checkPluginManifest() {
  const manifest = readJson('.claude-plugin/plugin.json');
  if (!manifest) return;
  check(manifest.name === PLUGIN, `plugin.json name is "${manifest.name}", expected "${PLUGIN}"`);
  check(NAME_PATTERN.test(manifest.name ?? ''), 'plugin.json name must be kebab-case');
  check(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version), 'plugin.json version must be semver');
  check(typeof manifest.description === 'string' && manifest.description.length > 0, 'plugin.json needs a description');
  check(typeof manifest.author?.name === 'string' && manifest.author.name.length > 0, 'plugin.json author.name is required');
  for (const key of ['homepage', 'repository']) {
    if (manifest[key] === undefined) continue;
    // An unparseable homepage stops the plugin from loading.
    check(URL.canParse?.(manifest[key]) ?? true, `plugin.json ${key} is not a URL`);
  }
  return manifest;
}

function checkMarketplace(manifest) {
  const market = readJson('.claude-plugin/marketplace.json');
  if (!market) return;
  check(NAME_PATTERN.test(market.name ?? ''), 'marketplace.json name must be kebab-case');
  check(typeof market.owner?.name === 'string' && market.owner.name.length > 0, 'marketplace.json owner.name is required');
  if (!check(Array.isArray(market.plugins) && market.plugins.length > 0, 'marketplace.json plugins[] must be non-empty')) return;
  const entry = market.plugins.find((p) => p.name === PLUGIN);
  if (!check(entry, `marketplace.json has no plugin named "${PLUGIN}"`)) return;
  check(typeof entry.source === 'string' || typeof entry.source === 'object', 'marketplace plugin entry needs a source');
  if (typeof entry.source === 'string') {
    check(entry.source === '.' || entry.source.startsWith('./'), 'relative source must be "." or start with "./"');
    check(!entry.source.split('/').includes('..'), 'source must not contain ".."');
    check(existsSync(join(root, entry.source, '.claude-plugin', 'plugin.json')), `source "${entry.source}" has no .claude-plugin/plugin.json`);
  }
  if (manifest && entry.version !== undefined) {
    check(entry.version === manifest.version, `marketplace version ${entry.version} differs from plugin.json ${manifest.version}`);
  }
}

function checkSkill() {
  const rel = `skills/${PLUGIN}/SKILL.md`;
  const text = readText(rel);
  if (text === null) return;
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  check(lines <= MAX_SKILL_LINES, `${rel} has ${lines} lines, limit ${MAX_SKILL_LINES}`);

  const fm = parseFrontmatter(text);
  if (!check(fm, `${rel} has no frontmatter on line 1`)) return;
  check(fm.name === PLUGIN, `${rel} frontmatter name is "${fm.name}", expected "${PLUGIN}"`);
  check(typeof fm.description === 'string' && fm.description.length >= 40, `${rel} needs a description`);
  check((fm.description ?? '').length <= MAX_DESCRIPTION_CHARS, `${rel} description exceeds ${MAX_DESCRIPTION_CHARS} chars`);

  const linked = new Set();
  for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(target) || linked.has(target)) continue;
    linked.add(target);
    check(existsSync(join(SKILL_DIR, target)), `${rel} links to missing ${target}`);
  }

  const refDir = join(SKILL_DIR, 'references');
  if (!check(existsSync(refDir), 'references/ directory is missing')) return;
  for (const file of readdirSync(refDir).filter((f) => f.endsWith('.md'))) {
    check(linked.has(`references/${file}`), `references/${file} is not linked from SKILL.md`);
    const body = readFileSync(join(refDir, file), 'utf8');
    const head = body.split('\n').slice(0, 15).join('\n');
    check(/^## Checklist/m.test(head), `references/${file} must open with a "## Checklist" section`);
    check(body.includes('❌') && body.includes('✅'), `references/${file} needs ❌/✅ snippets`);
  }
}

function checkCommand() {
  const text = readText('commands/review.md');
  if (text === null) return;
  const fm = parseFrontmatter(text);
  if (!check(fm, 'commands/review.md has no frontmatter')) return;
  check(Boolean(fm.description), 'commands/review.md needs a description');
  check(text.includes('$ARGUMENTS'), 'commands/review.md should pass $ARGUMENTS through');
  check(text.includes('--comment'), 'commands/review.md must document --comment');
}

// A wrong hunk header makes the fixture unreadable by `git apply` and shifts every
// expected file:line, so the counts are checked rather than trusted.
function checkHunks(rel, text) {
  let hunk = null;
  const close = () => {
    if (!hunk) return;
    check(hunk.old === hunk.wantOld && hunk.new === hunk.wantNew,
      `${rel}: hunk "${hunk.header}" declares -${hunk.wantOld} +${hunk.wantNew}, body has -${hunk.old} +${hunk.new}`);
  };
  for (const line of text.split('\n')) {
    const header = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (header) {
      close();
      hunk = { header: header[0], wantOld: Number(header[1] ?? 1), wantNew: Number(header[2] ?? 1), old: 0, new: 0 };
    } else if (line.startsWith('diff --git')) {
      close();
      hunk = null;
    } else if (hunk) {
      if (line.startsWith('+')) hunk.new += 1;
      else if (line.startsWith('-')) hunk.old += 1;
      else if (line.startsWith(' ')) { hunk.old += 1; hunk.new += 1; }
    }
  }
  close();
}

function checkEvals() {
  for (const name of ['dotnet', 'node', 'react']) {
    const diff = readText(`evals/${name}/pr.diff`);
    const expected = readText(`evals/${name}/expected.md`);
    if (diff !== null) checkHunks(`evals/${name}/pr.diff`, diff);
    if (expected !== null) {
      check(/^## must/m.test(expected), `evals/${name}/expected.md needs a "## must" section`);
      check(/`[^`]+:\d+`/.test(expected), `evals/${name}/expected.md findings need file:line`);
    }
  }
  readText('evals/README.md');
}

function checkDocs() {
  for (const rel of ['README.md', 'LICENSE', 'ATTRIBUTION.md', 'ANALYSIS.md']) readText(rel);
  const readme = readText('README.md') ?? '';
  check(readme.includes(`/plugin marketplace add devmaxxx/${PLUGIN}`), 'README must show the marketplace install line');
}

const manifest = checkPluginManifest();
checkMarketplace(manifest);
checkSkill();
checkCommand();
checkEvals();
checkDocs();

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`\n${failures.length} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`ok ${checks} checks passed`);

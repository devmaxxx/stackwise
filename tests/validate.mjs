#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = 'stackwise';
const SKILL_DIR = join(root, 'skills', PLUGIN);
const MAX_SKILL_LINES = 250;
// References are read whole during a review, so each one is held to a token budget.
const MAX_REFERENCE_LINES = 300;
// SKILL.md tells the reviewer to read only this many lines of a reference first, so the
// checklist and its "do not flag" notes must end before it.
const CHECKLIST_MAX_LINES = 100;
// Claude Code truncates description + when_to_use at this length in the skill listing.
const MAX_DESCRIPTION_CHARS = 1536;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MIN_FIXTURES = 6;
const LENS_AGENTS = ['stackwise-contract', 'stackwise-data', 'stackwise-auth', 'stackwise-react-effects', 'stackwise-silent-failure'];
const COMPANION_SKILLS = ['stackwise-fix', 'stackwise-tests', 'stackwise-respond', 'stackwise-describe'];
// Lens agents review, so they get no Write or Edit tool. Agent frontmatter cannot narrow
// Bash to read commands; their instructions do that.
const READ_ONLY_AGENT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash']);
// Pre-approved tools run without a prompt, so skills and the command may pre-approve only
// reads. Edits, builds, tests and every gh write go through the user's permission mode.
const PRE_APPROVED_TOOL = /^(?:Read|Grep|Glob|Bash\((?:git (?:diff|log|show|status|blame|grep|fetch|rev-parse|merge-base)|gh (?:pr (?:view|diff)|repo view)):\*\))$/;
// Claude Code ignores these in plugin agents, so setting one would silently do nothing.
const PLUGIN_AGENT_IGNORED_FIELDS = ['permissionMode', 'hooks', 'mcpServers', 'initialPrompt'];
const HOOK_ENV_SWITCHES = ['STACKWISE_SECURITY_HOOK', 'STACKWISE_PREPUSH'];

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

// URL.canParse is missing before Node 18.17, and the engine floor is 18.
function isUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
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
    check(isUrl(manifest[key]), `plugin.json ${key} is not a URL`);
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
    const refLines = body.split('\n').length - (body.endsWith('\n') ? 1 : 0);
    check(refLines <= MAX_REFERENCE_LINES, `references/${file} has ${refLines} lines, limit ${MAX_REFERENCE_LINES}`);
    const head = body.split('\n').slice(0, 15).join('\n');
    check(/^## Checklist/m.test(head), `references/${file} must open with a "## Checklist" section`);
    check(body.includes('❌') && body.includes('✅'), `references/${file} needs ❌/✅ snippets`);
    const sections = body.split('\n').flatMap((line, i) => (/^## /.test(line) ? [i + 1] : []));
    if (sections.length > 1) {
      check(sections[1] <= CHECKLIST_MAX_LINES + 1, `references/${file}: checklist runs to line ${sections[1] - 1}, limit ${CHECKLIST_MAX_LINES}`);
    }
  }
  for (const agent of LENS_AGENTS) {
    check(text.includes(`stackwise:${agent}`), `${rel} does not dispatch the ${agent} lens agent`);
  }
  for (const skill of COMPANION_SKILLS) {
    check(text.includes(`\`${skill}\``), `${rel} does not name the ${skill} companion skill`);
  }
}

// Skills substitute $0, $1 and $ARGUMENTS in their body, so a stray one in an example
// would silently become the user's argument text.
function checkSkillBody(rel, text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  check(!/\$(\d|ARGUMENTS)/.test(body), `${rel} contains a $N or $ARGUMENTS placeholder`);
}

function checkCompanionSkills() {
  const found = readdirSync(join(root, 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const name of COMPANION_SKILLS) check(found.includes(name), `skills/${name}/ is missing`);
  for (const name of found) {
    const rel = `skills/${name}/SKILL.md`;
    const text = readText(rel);
    if (text === null) continue;
    checkSkillBody(rel, text);
    if (name === PLUGIN) continue;
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    check(lines <= MAX_SKILL_LINES, `${rel} has ${lines} lines, limit ${MAX_SKILL_LINES}`);
    const fm = parseFrontmatter(text);
    if (!check(fm, `${rel} has no frontmatter on line 1`)) continue;
    check(fm.name === name, `${rel} frontmatter name is "${fm.name}", expected "${name}"`);
    check(NAME_PATTERN.test(fm.name ?? ''), `${rel} name must be kebab-case`);
    check(typeof fm.description === 'string' && fm.description.length >= 40, `${rel} needs a description`);
    check((fm.description ?? '').length <= MAX_DESCRIPTION_CHARS, `${rel} description exceeds ${MAX_DESCRIPTION_CHARS} chars`);
    checkPreApprovedTools(rel, fm['allowed-tools']);
  }
}

function checkPreApprovedTools(rel, allowed) {
  const extra = String(allowed ?? '').split(',').map((t) => t.trim()).filter((t) => t && !PRE_APPROVED_TOOL.test(t));
  check(extra.length === 0, `${rel} allowed-tools may pre-approve only reads, got: ${extra.join(', ')}`);
}

function checkAgents(skillText) {
  const dir = join(root, 'agents');
  if (!check(existsSync(dir), 'agents/ directory is missing')) return;
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  for (const agent of LENS_AGENTS) check(files.includes(`${agent}.md`), `agents/${agent}.md is missing`);
  for (const file of files) {
    const rel = `agents/${file}`;
    const text = readFileSync(join(dir, file), 'utf8');
    const fm = parseFrontmatter(text);
    if (!check(fm, `${rel} has no frontmatter on line 1`)) continue;
    const name = file.replace(/\.md$/, '');
    check(fm.name === name, `${rel} name is "${fm.name}", expected "${name}"`);
    check(NAME_PATTERN.test(fm.name ?? ''), `${rel} name must be kebab-case without ":"`);
    check(typeof fm.description === 'string' && fm.description.length >= 40, `${rel} needs a description`);
    const tools = (fm.tools ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    check(tools.length > 0 && tools.every((t) => READ_ONLY_AGENT_TOOLS.has(t)), `${rel} tools must be a subset of Read, Grep, Glob, Bash, got: ${fm.tools}`);
    for (const field of PLUGIN_AGENT_IGNORED_FIELDS) check(!(field in fm), `${rel} sets ${field}, which plugin agents ignore`);
    if (skillText !== null) check(skillText.includes(`stackwise:${name}`), `${rel} is never dispatched by skills/${PLUGIN}/SKILL.md`);
  }
}

function checkHooks(readme) {
  const config = readJson('hooks/hooks.json');
  if (!config) return;
  if (!check(config.hooks && typeof config.hooks === 'object', 'hooks/hooks.json needs a top-level "hooks" object')) return;
  const scripts = new Set();
  for (const [event, groups] of Object.entries(config.hooks)) {
    check(event === 'PreToolUse', `hooks/hooks.json: unexpected event ${event}`);
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        check(hook.type === 'command', `hooks/hooks.json: ${event} hook must be a command`);
        const script = (hook.command ?? '').match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[\w.-]+\.mjs)/)?.[1];
        if (!check(script, `hooks/hooks.json: command "${hook.command}" must run a script under \${CLAUDE_PLUGIN_ROOT}/hooks/`)) continue;
        check(/"\$\{CLAUDE_PLUGIN_ROOT\}[^"]*"/.test(hook.command), `hooks/hooks.json: quote the \${CLAUDE_PLUGIN_ROOT} path in "${hook.command}"`);
        check(typeof hook.timeout === 'number' && hook.timeout <= 30, `hooks/hooks.json: ${script} needs a timeout of at most 30 s`);
        scripts.add(script);
      }
    }
  }
  for (const script of scripts) {
    const source = readText(script);
    if (source === null) continue;
    // Both hooks are advisory: exit 2 or a permission decision would block the tool call.
    check(!/process\.exit(Code\s*=\s*|\()\s*2\b/.test(source), `${script} must never exit 2`);
    check(!/permissionDecision/.test(source), `${script} must not return a permissionDecision`);
  }
  for (const name of HOOK_ENV_SWITCHES) {
    check([...scripts].some((s) => existsSync(join(root, s)) && readFileSync(join(root, s), 'utf8').includes(name)), `no hook script reads ${name}`);
    check(readme.includes(name), `README does not document ${name}`);
  }
}

function checkTemplate(readme) {
  const rel = 'templates/github/stackwise-review.yml';
  const text = readText(rel);
  if (text === null) return;
  check(/uses: anthropics\/claude-code-action@v\d+\.\d+\.\d+\s/.test(text), `${rel} must pin anthropics/claude-code-action to a version tag`);
  check(/uses: actions\/checkout@v\d+\.\d+\.\d+\s/.test(text), `${rel} must pin actions/checkout to a version tag`);
  check(text.includes('${{ secrets.ANTHROPIC_API_KEY }}'), `${rel} must read the ANTHROPIC_API_KEY secret`);
  check(/plugins: stackwise@stackwise/.test(text), `${rel} must install the stackwise plugin`);
  check(/pull_request:[\s\S]*paths:/.test(text), `${rel} must trigger on pull_request with path filters`);
  check(readme.includes(rel), `README does not link ${rel}`);
}

// A relative link that 404s on GitHub is the first thing a visitor hits, in the README
// or in any page it leads to.
function checkMarkdownLinks() {
  const skip = new Set(['.git', 'node_modules']);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (skip.has(d.name)) return [];
    const path = join(dir, d.name);
    return d.isDirectory() ? walk(path) : [path];
  });
  for (const path of walk(root).filter((p) => p.endsWith('.md'))) {
    const rel = relative(root, path);
    // Fixture repos are review inputs, not docs.
    if (/^evals\/[^/]+\/repo\//.test(rel)) continue;
    const text = readFileSync(path, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^([a-z]+:|#)/i.test(target)) continue;
      const linked = decodeURIComponent(target.replace(/#.*$/, ''));
      check(existsSync(join(dirname(path), linked)), `${rel} links to missing ${linked}`);
    }
  }
}

// The published plugin must not carry the author's machine paths or name another plugin,
// and stands on its own: the projects it adapted from are named only in ATTRIBUTION.md,
// as their licenses require. The names are split so this file does not match itself.
function checkRepoText() {
  // Case-sensitive on purpose: `/users/me` is an API route in the fixtures, not a home.
  const homePath = /\/(Users|home)\/[A-Za-z]|[A-Z]:\\Users\\/;
  const otherPlugin = new RegExp(`\\b${'bo'}${'nd'}\\b`, 'i');
  const sourceNames = new RegExp(
    [['awesome', '-skills'], ['code-review', '-skill'], ['vercel', '-labs'], ['aaron', 'ontheweb'], ['ws', 'hobson'],
      ['trail', 'of ?bits'], ['super', 'powers'], ['pr-review', '-toolkit'], ['pr', '-agent'], ['dotnet', '/skills'],
      ['mcol', 'lina'], ['node', 'bestpractices']].map((parts) => parts.join('')).join('|'),
    'i',
  );
  const skip = new Set(['.git', 'node_modules']);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (skip.has(d.name)) return [];
    const path = join(dir, d.name);
    return d.isDirectory() ? walk(path) : [path];
  });
  for (const path of walk(root)) {
    if (statSync(path).size > 1_000_000 || !/\.(md|mjs|js|json|ya?ml|diff|cs|ts|tsx|css|txt)$|LICENSE$/.test(path)) continue;
    const rel = relative(root, path);
    const text = readFileSync(path, 'utf8');
    check(!homePath.test(text), `${rel} contains an absolute home-directory path`);
    check(!otherPlugin.test(text), `${rel} mentions another plugin by name`);
    if (rel !== 'ATTRIBUTION.md') check(!sourceNames.test(text), `${rel} names a source project; only ATTRIBUTION.md may`);
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
  checkPreApprovedTools('commands/review.md', fm['allowed-tools']);
}

// A wrong hunk header makes the fixture unreadable by `git apply` and shifts every
// expected file:line, so the counts are checked rather than trusted. Returns the
// new-side line numbers each file's hunks cover.
function checkHunks(rel, text) {
  const covered = new Map();
  let file = null;
  let hunk = null;
  let nextLine = 0;
  const close = () => {
    if (!hunk) return;
    check(hunk.old === hunk.wantOld && hunk.new === hunk.wantNew,
      `${rel}: hunk "${hunk.header}" declares -${hunk.wantOld} +${hunk.wantNew}, body has -${hunk.old} +${hunk.new}`);
  };
  const cover = () => {
    if (!covered.has(file)) covered.set(file, new Set());
    covered.get(file).add(nextLine);
    nextLine += 1;
  };
  for (const line of text.split('\n')) {
    const header = line.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      close();
      hunk = { header: header[0], wantOld: Number(header[1] ?? 1), wantNew: Number(header[3] ?? 1), old: 0, new: 0 };
      nextLine = Number(header[2]);
    } else if (line.startsWith('diff --git')) {
      close();
      hunk = null;
    } else if (!hunk && line.startsWith('+++ ')) {
      file = line.replace(/^\+\+\+ (b\/)?/, '');
    } else if (hunk) {
      if (line.startsWith('+')) { hunk.new += 1; cover(); }
      else if (line.startsWith('-')) hunk.old += 1;
      else if (line.startsWith(' ')) { hunk.old += 1; hunk.new += 1; cover(); }
    }
  }
  close();
  return covered;
}

// Every `path:line` an expected.md cites must be a line the fixture diff shows,
// otherwise a correct review can never match it. A bare file name may stand for
// the one diff path that ends with it.
function checkCitations(name, expected, covered) {
  for (const [, path, line] of expected.matchAll(/`([\w./-]+\.\w+):(\d+)`/g)) {
    const matches = [...covered.keys()].filter((p) => p === path || p.endsWith(`/${path}`));
    if (!check(matches.length === 1, `evals/${name}/expected.md cites ${path}, which matches ${matches.length} files in pr.diff`)) continue;
    check(covered.get(matches[0]).has(Number(line)), `evals/${name}/expected.md cites ${path}:${line}, outside the diff's hunks`);
  }
}

function checkEvals() {
  const evalDir = join(root, 'evals');
  const fixtures = readdirSync(evalDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  check(fixtures.length >= MIN_FIXTURES, `evals/ has ${fixtures.length} fixtures, expected at least ${MIN_FIXTURES}`);
  const evalReadme = readText('evals/README.md') ?? '';
  for (const name of fixtures) {
    const diff = readText(`evals/${name}/pr.diff`);
    const expected = readText(`evals/${name}/expected.md`);
    const covered = diff === null ? new Map() : checkHunks(`evals/${name}/pr.diff`, diff);
    if (expected !== null) {
      check(/^## must/m.test(expected), `evals/${name}/expected.md needs a "## must" section`);
      check(/`[^`]+:\d+`/.test(expected), `evals/${name}/expected.md findings need file:line`);
      check(/Required references:/.test(expected), `evals/${name}/expected.md needs a "Required references:" line`);
      if (diff !== null) checkCitations(name, expected, covered);
    }
    check(evalReadme.includes(`\`${name}/\``), `evals/README.md does not list the ${name} fixture`);
  }
}

function checkVersions(manifest) {
  if (!manifest) return;
  const version = manifest.version;
  const pkg = readJson('package.json');
  if (pkg) check(pkg.version === version, `package.json version ${pkg.version} differs from plugin.json ${version}`);
  const changelog = readText('CHANGELOG.md') ?? '';
  check(changelog.includes(`## [${version}]`), `CHANGELOG.md has no "## [${version}]" section`);
  const readme = readText('README.md') ?? '';
  check(readme.includes(`version-${version}-`), `README version badge does not say ${version}`);
  check(readme.includes('CHANGELOG.md'), 'README must link CHANGELOG.md');
}

function checkDocs() {
  for (const rel of ['README.md', 'LICENSE', 'ATTRIBUTION.md', 'CHANGELOG.md']) readText(rel);
  const readme = readText('README.md') ?? '';
  check(readme.includes(`/plugin marketplace add devmaxxx/${PLUGIN}`), 'README must show the marketplace install line');
  return readme;
}

const manifest = checkPluginManifest();
checkMarketplace(manifest);
checkSkill();
checkCompanionSkills();
checkAgents(readText(`skills/${PLUGIN}/SKILL.md`));
checkCommand();
checkEvals();
checkVersions(manifest);
const readme = checkDocs();
checkHooks(readme);
checkTemplate(readme);
checkMarkdownLinks();
checkRepoText();

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`\n${failures.length} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`ok ${checks} checks passed`);

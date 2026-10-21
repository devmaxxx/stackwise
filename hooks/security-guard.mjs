#!/usr/bin/env node
// PreToolUse hook for Write|Edit|MultiEdit. Warn-only: it never sets a permission
// decision and always exits 0, so a false positive costs a line of context, not a
// blocked edit. Turn it off with STACKWISE_SECURITY_HOOK=0.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_EXISTING_BYTES = 1024 * 1024;
const MAX_STDIN_BYTES = 16 * 1024 * 1024;
const MAX_HITS = 8;
const MAX_SHOWN_CHARS = 120;
// Minified bundles and data blobs put a whole file on one line: every hit there is
// noise, and a long line is where a regex gets slow.
const MAX_LINE_CHARS = 2000;
const MAX_NEW_LINES = 20000;

const JS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];
const CS = ['.cs'];

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'bun.lock', 'bun.lockb', 'packages.lock.json', 'composer.lock', 'Cargo.lock',
]);

const PLACEHOLDER = /example|sample|dummy|placeholder|changeme|change_me|your[_-]|redacted|xxx|\*{3}|<[^>]*>|\$\{|\{\{|\$\(|%[A-Z_]+%|#\{|process\.env|import\.meta\.env|GetEnvironmentVariable|os\.environ/i;

// Identifier words that name a credential, matched against the last word (or last two)
// of the assigned name, so `resetToken` and `DB_PASSWORD` count but `bypass`,
// `passwordHash` and `secretName` do not.
const SECRET_WORDS = new Set(['password', 'passwd', 'pwd', 'passphrase', 'secret', 'token', 'apikey']);
const SECRET_PAIRS = new Set(['api key', 'private key', 'access key', 'secret key', 'client secret']);

function identifierWords(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function namesCredential(name) {
  const words = identifierWords(name);
  if (words.length === 0) return false;
  const last = words[words.length - 1];
  if (SECRET_WORDS.has(last)) return true;
  return words.length > 1 && SECRET_PAIRS.has(`${words[words.length - 2]} ${last}`);
}

const CREDENTIAL_HINT = /pass|pwd|secret|token|key/i;

// An env-var name (`JWT_SECRET`) or a run of one character is a reference or filler,
// not a value.
function isPlaceholderValue(value) {
  return PLACEHOLDER.test(value) || /^[A-Z][A-Z0-9_]+$/.test(value) || /^(.)\1+$/.test(value);
}

function looksLikeKey(value) {
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

// Each `find` returns null or { secret?: string } for a single line; `secret` is the
// substring to mask when the line is shown.
const RULES = [
  {
    id: 'aws-access-key',
    title: 'AWS access key id',
    exts: null,
    find: (line) => match(line, /\bA(?:KI|SI)A[0-9A-Z]{16}\b/),
    hint: 'Load it from the environment or a secret store, and rotate the key if it was ever committed.',
  },
  {
    id: 'github-token',
    title: 'GitHub token',
    exts: null,
    find: (line) => match(line, /\bgh[pousr]_[A-Za-z0-9]{36,255}\b|\bgithub_pa[t]_[A-Za-z0-9_]{40,255}\b/),
    hint: 'Read it from GH_TOKEN or a secret store; revoke this token if it was ever pushed.',
  },
  {
    id: 'slack-token',
    title: 'Slack token',
    exts: null,
    find: (line) => match(line, /\bxox[abposr]-[A-Za-z0-9-]{10,}/),
    hint: 'Read it from the environment or a secret store; revoke it if it was ever pushed.',
  },
  {
    id: 'stripe-live-key',
    title: 'Stripe live secret key',
    exts: null,
    find: (line) => match(line, /\b[sr]k_live_[A-Za-z0-9]{20,}/),
    hint: 'Live keys belong in a secret store; roll the key in the Stripe dashboard if it was committed.',
  },
  {
    id: 'sk-api-key',
    title: 'API secret key (sk-...)',
    exts: null,
    find: (line) => {
      const hit = match(line, /(?<![\w-])sk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/);
      return hit && looksLikeKey(hit.secret.slice(3)) && !PLACEHOLDER.test(hit.secret) ? hit : null;
    },
    hint: 'Read the key from the environment; rotate it if it was ever committed.',
  },
  {
    id: 'google-api-key',
    title: 'Google API key',
    exts: null,
    find: (line) => match(line, /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/),
    hint: 'Read the key from configuration and restrict it in the cloud console.',
  },
  {
    id: 'private-key',
    title: 'Private key block',
    exts: null,
    find: (line) => match(line, /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/),
    hint: 'Keep private keys out of the repo; mount them from a secret store at runtime.',
  },
  {
    id: 'hardcoded-credential',
    title: 'Hard-coded credential',
    exts: null,
    find: (line) => {
      if (!CREDENTIAL_HINT.test(line)) return null;
      // The lookbehind pins each attempt to the start of an identifier, which keeps
      // the scan linear on long runs of word characters.
      const re = /(?<![\w.$-])(["']?)([A-Za-z_][\w.-]*)\1\s*(?::=|[:=])\s*(["'`])([^"'`\s]{8,})\3/g;
      for (const m of line.matchAll(re)) {
        const value = m[4];
        if (namesCredential(m[2]) && !isPlaceholderValue(value)) return { secret: value };
      }
      return null;
    },
    hint: 'Move the value to configuration or a secret store and read it at runtime.',
  },
  {
    id: 'connection-string-credential',
    title: 'Credential in a connection string',
    exts: null,
    find: (line) => {
      const m = line.match(/(?:^|[;"'\s])(?:Password|Pwd)\s*=\s*([^;"'\s]{8,})/i);
      return m && !isPlaceholderValue(m[1]) ? { secret: m[1] } : null;
    },
    hint: 'Keep the connection string in user secrets, the environment or a vault, not in tracked files.',
  },
  {
    id: 'ef-raw-sql-interpolation',
    title: 'Raw SQL built from a string (EF Core)',
    exts: CS,
    code: true,
    find: (line) => {
      const call = line.match(/\b(?:FromSqlRaw|ExecuteSqlRaw(?:Async)?|SqlQueryRaw)\s*(?:<[^>()]*>)?\s*\(([^\n]*)/);
      if (!call) return null;
      const arg = call[1];
      if (/^\s*(?:\$+@?|@\$+)"/.test(arg)) return {};
      if (/"\s*\+|\+\s*\$?@?"|\bstring\.Format\s*\(|\bString\.Format\s*\(/.test(arg)) return {};
      return null;
    },
    hint: 'Use FromSql/ExecuteSql with an interpolated string (EF parameterizes it) or pass DbParameters; never splice values into FromSqlRaw.',
  },
  {
    id: 'allow-anonymous',
    title: 'Anonymous endpoint',
    exts: CS,
    code: true,
    find: (line) => (line.includes('AllowAnonymous') && /\[[^\]]*\bAllowAnonymous\b[^\]]*\]|\.AllowAnonymous\s*\(/.test(line) ? {} : null),
    hint: 'Confirm the endpoint is meant to be public; a webhook still needs a signature check.',
  },
  {
    id: 'dotnet-tls-bypass',
    title: 'TLS certificate validation disabled',
    exts: CS,
    code: true,
    find: (line) => {
      if (/\bDangerousAcceptAnyServerCertificateValidator\b/.test(line)) return {};
      return /\bServerCertificate(?:Custom)?ValidationCallback\s*\+?=\s*(?:delegate\b[^{]*\{\s*return\s+true\b|(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>\s*true\b)/.test(line) ? {} : null;
    },
    hint: 'Validate the certificate (or pin it); never accept any certificate outside a local test.',
  },
  {
    id: 'dangerously-set-inner-html',
    title: 'dangerouslySetInnerHTML without sanitizing',
    exts: JS,
    code: true,
    find: (line) => (/\bdangerouslySetInnerHTML\b/.test(line) && !/sanitiz\w*\s*\(/i.test(line) ? {} : null),
    hint: 'Render text instead, or sanitize the HTML (e.g. DOMPurify.sanitize) on the same path.',
  },
  {
    id: 'eval',
    title: 'eval()',
    exts: JS,
    code: true,
    find: (line) => (/(?<![\w$.])eval\s*\(/.test(line) ? {} : null),
    hint: 'Parse the data (JSON.parse) or map inputs to known functions; eval runs whatever reaches it.',
  },
  {
    id: 'new-function',
    title: 'new Function()',
    exts: JS,
    code: true,
    find: (line) => (/\bnew\s+Function\s*\(/.test(line) ? {} : null),
    hint: 'Avoid compiling code from strings; map inputs to known functions instead.',
  },
  {
    id: 'shell-exec-interpolation',
    title: 'Shell command built from a string',
    exts: JS,
    code: true,
    find: (line) => {
      if (!line.includes('exec')) return null;
      if (/(?<![\w$])(?:[\w$]+\.)?(?:exec|execSync|execAsync)\s*\(\s*`[^`]*\$\{/.test(line)) return {};
      const concat = /(?<![\w$.])(?:(?:child_process|childProcess|cp)\.)?(?:exec|execSync|execAsync)\s*\(\s*(?:(["'])[^"']*\1|[A-Za-z_$][\w$.]*)\s*\+/;
      return concat.test(line) ? {} : null;
    },
    hint: 'Use execFile/spawn with an argument array (no shell), and validate each argument.',
  },
  {
    id: 'reject-unauthorized',
    title: 'TLS certificate validation disabled',
    exts: JS,
    code: true,
    find: (line) => (/\brejectUnauthorized\s*:\s*false\b/.test(line) ? {} : null),
    hint: 'Keep certificate validation on; trust a private CA with the `ca` option instead.',
  },
  {
    id: 'node-tls-env',
    title: 'TLS certificate validation disabled',
    exts: null,
    find: (line) => (/\bNODE_TLS_REJECT_UNAUTHORIZED["']?\s*[:=]\s*["'`]?0(?![\w.])/.test(line) ? {} : null),
    hint: 'Remove NODE_TLS_REJECT_UNAUTHORIZED=0; it turns off certificate checks for the whole process.',
  },
];

// Documentation keys such as the AWS `...EXAMPLE` id are skipped by the placeholder test.
function match(line, re) {
  const m = line.match(re);
  return m && !PLACEHOLDER.test(m[0]) ? { secret: m[0] } : null;
}

function isCommentLine(trimmed) {
  return /^(?:\/\/|\/\*|\*|<!--)/.test(trimmed);
}

// A short secret keeps no prefix: four characters of an eight-character password is half of it.
function mask(line, secret) {
  if (!secret) return line;
  return line.split(secret).join(`${secret.length >= 16 ? secret.slice(0, 4) : ''}***`);
}

// The warning shows the line, so every secret on it is masked, not only the one that
// raised the hit. Masked text reads as a placeholder, which ends each rule's loop.
function maskSecrets(line, rules) {
  let out = line;
  for (const rule of rules) {
    for (let i = 0; i < MAX_HITS; i += 1) {
      const secret = rule.find(out)?.secret;
      if (!secret) break;
      out = mask(out, secret);
    }
  }
  return out;
}

function shorten(text) {
  return text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS - 3)}...` : text;
}

function lineSet(text) {
  return new Set(String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
}

// Lines of `next` that `previous` did not already contain, with their 1-based line
// number in `next`. Pre-existing lines are not this edit's doing, so they stay quiet.
function addedLines(previous, next) {
  const seen = lineSet(previous);
  const out = [];
  String(next ?? '').split(/\r?\n/).forEach((raw, i) => {
    const trimmed = raw.trim();
    if (trimmed && !seen.has(trimmed)) out.push({ text: trimmed, line: i + 1 });
  });
  return out;
}

function defaultReadExisting(path) {
  try {
    if (statSync(path).size > MAX_EXISTING_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// Returns { filePath, hits: [{ id, title, hint, text, line? }] }. Pure apart from
// `readExisting`, which tests replace.
export function scan({ toolName, toolInput, readExisting = defaultReadExisting }) {
  const filePath = typeof toolInput?.file_path === 'string' ? toolInput.file_path : '';
  const result = { filePath, hits: [] };
  if (!filePath || LOCKFILES.has(basename(filePath.replace(/\\/g, '/')))) return result;

  let lines;
  if (toolName === 'Write') {
    const content = toolInput.content;
    if (typeof content !== 'string') return result;
    const existing = readExisting(filePath);
    if (existing === null) return result;
    lines = addedLines(existing, content);
  } else if (toolName === 'Edit') {
    // A line number inside new_string would not match the file, so none is shown.
    lines = addedLines(toolInput.old_string, toolInput.new_string).map(({ text }) => ({ text }));
  } else if (toolName === 'MultiEdit') {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    lines = edits.flatMap((e) => addedLines(e?.old_string, e?.new_string).map(({ text }) => ({ text })));
  } else {
    return result;
  }

  if (lines.some(({ text }) => text.includes('\u0000'))) return result;
  const ext = extname(filePath).toLowerCase();
  const rules = RULES.filter((r) => r.exts === null || r.exts.includes(ext));

  for (const { text, line } of lines.slice(0, MAX_NEW_LINES)) {
    if (text.length > MAX_LINE_CHARS) continue;
    const comment = isCommentLine(text);
    for (const rule of rules) {
      if (rule.code && comment) continue;
      const hit = rule.find(text);
      if (!hit) continue;
      result.hits.push({ id: rule.id, title: rule.title, hint: rule.hint, text: shorten(maskSecrets(text, rules)), line });
      if (result.hits.length >= MAX_HITS) return result;
      // One warning per line is enough; the first matching rule is the most specific.
      break;
    }
  }
  return result;
}

function displayPath(filePath, cwd) {
  if (!cwd || !isAbsolute(filePath)) return filePath;
  const rel = relative(cwd, filePath);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : filePath;
}

export function formatOutput(result, { toolName, cwd } = {}) {
  if (!result.hits.length) return null;
  const where = displayPath(result.filePath, cwd);
  const titles = [...new Set(result.hits.map((h) => h.title))].join(', ');
  const count = result.hits.length;
  const items = result.hits.map((h) => {
    const at = h.line ? ` (line ${h.line})` : '';
    return `- ${h.title}${at}: \`${h.text}\` — ${h.hint}`;
  });
  const context = [
    `stackwise security hook: this ${toolName ?? 'edit'} to ${where} adds ${count === 1 ? 'a line that matches a risky pattern' : `${count} lines that match risky patterns`}. Nothing was blocked.`,
    'Check each one now: fix it, or keep it and say why it is safe.',
    ...items,
    'Turn this hook off with STACKWISE_SECURITY_HOOK=0.',
  ].join('\n');
  return {
    systemMessage: `stackwise: ${count} security warning${count === 1 ? '' : 's'} in ${where} (${titles})`,
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context },
  };
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (process.env.STACKWISE_SECURITY_HOOK === '0') return;
  const raw = await readStdin();
  if (!raw) return;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!input || typeof input !== 'object') return;
  const result = scan({ toolName: input.tool_name, toolInput: input.tool_input });
  const output = formatOutput(result, { toolName: input.tool_name, cwd: input.cwd });
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

function isMain() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  // A closed pipe must not turn into an uncaught error and a non-zero exit.
  process.stdout.on('error', () => {});
  main().catch(() => {}).finally(() => {
    process.exitCode = 0;
  });
}

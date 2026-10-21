#!/usr/bin/env node
// PreToolUse hook on Bash, opt-in with STACKWISE_PREPUSH=1. A PreToolUse hook's
// context reaches Claude alongside the tool result, so the push is not held back;
// what the hook adds is the outgoing range, resolved to shas before the push moves
// the upstream ref and that range becomes empty.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_STDIN_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 3000;
// git options that take their value as the next word.
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
// `git push` options that take their value as the next word, so it is not read as the remote.
const PUSH_OPTIONS_WITH_VALUE = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);

// Splits a shell command into simple commands, each a list of words, honouring quotes
// and backslashes so `-c 'credential.helper=!gh auth git-credential' push` stays one
// option value and a quoted `&&` does not end a command.
export function simpleCommands(command) {
  const commands = [];
  let wordsSoFar = [];
  let word = null;
  const endWord = () => {
    if (word !== null) wordsSoFar.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (wordsSoFar.length) commands.push(wordsSoFar);
    wordsSoFar = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? command.length : close;
      word = (word ?? '') + command.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) j += 1;
        text += command[j];
        j += 1;
      }
      word = (word ?? '') + text;
      i = j;
    } else if (ch === '\\' && i + 1 < command.length) {
      i += 1;
      if (command[i] !== '\n') word = (word ?? '') + command[i];
    } else if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      endCommand();
    } else if (ch === ' ' || ch === '\t' || ch === '\r' || ((ch === '(' || ch === '{') && word === null)) {
      endWord();
    } else {
      word = (word ?? '') + ch;
    }
  }
  endCommand();
  return commands;
}

// Returns { dir, ref? } for the first command that runs `git push` and publishes commits,
// or null. `dir` is the directory git would run in (`cd x &&` and `git -C x` applied);
// `ref` is the first refspec when the push names one other than HEAD.
export function findPush(command, cwd = process.cwd()) {
  if (typeof command !== 'string' || !/\bpush\b/.test(command)) return null;
  let dir = cwd;
  for (const w of simpleCommands(command)) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
    if (w[0] === 'cd' && w[1]) {
      dir = resolve(dir, w[1].replace(/^~(?=$|[/\\])/, homedir()));
      continue;
    }
    if (!/(^|[/\\])git(\.exe)?$/.test(w[0] ?? '')) continue;
    let i = 1;
    let gitDir = dir;
    while (i < w.length && w[i].startsWith('-')) {
      if (w[i] === '-C' && w[i + 1]) gitDir = resolve(gitDir, w[i + 1]);
      i += GIT_OPTIONS_WITH_VALUE.has(w[i]) ? 2 : 1;
    }
    if (w[i] !== 'push') continue;
    const args = w.slice(i + 1);
    if (args.some((a) => a === '--delete' || a === '-d' || a === '--dry-run' || a === '-n' || /^\+?:/.test(a))) continue;
    const positional = [];
    for (let j = 0; j < args.length; j += 1) {
      if (PUSH_OPTIONS_WITH_VALUE.has(args[j])) j += 1;
      else if (!args[j].startsWith('-')) positional.push(args[j]);
    }
    // `git push --tags [remote]` publishes tags only, which the review has nothing to say about.
    if (args.includes('--tags') && positional.length <= 1) continue;
    const ref = positional[1];
    if (ref && /^\+?refs\/tags\//.test(ref)) continue;
    return ref && !/^\+?HEAD(:|$)/.test(ref) ? { dir: gitDir, ref } : { dir: gitDir };
  }
  return null;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

function resolves(cwd, run, rev) {
  try {
    return run(cwd, ['rev-parse', '--verify', '--quiet', rev]) || null;
  } catch {
    return null;
  }
}

// Returns null when git cannot run here or the push publishes only a tag, else
// { head?, base?, baseRef?, count? }. With `ref` (a refspec from findPush) the range is
// that ref's commits, not HEAD's: `git push origin feat-b` from main publishes feat-b.
export function outgoingRange(cwd, run = git, ref = null) {
  try {
    run(cwd, ['rev-parse', '--git-dir']);
  } catch {
    return null;
  }
  let source = 'HEAD';
  let bases = ['@{u}', 'origin/HEAD', 'origin/main'];
  if (ref) {
    const [src, dst] = ref.replace(/^\+/, '').split(':');
    if (!resolves(cwd, run, `refs/heads/${src}`) && resolves(cwd, run, `refs/tags/${src}`)) return null;
    source = src;
    const target = (dst || src).replace(/^refs\/heads\//, '');
    bases = [`${src}@{u}`, `origin/${target}`, 'origin/HEAD', 'origin/main'];
  }
  const head = resolves(cwd, run, `${source}^{commit}`);
  if (!head) return {};
  for (const candidate of bases) {
    try {
      const base = resolves(cwd, run, `${candidate}^{commit}`);
      if (!base) continue;
      let name = candidate;
      if (candidate.endsWith('@{u}')) {
        try {
          name = run(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', candidate]) || candidate;
        } catch {
          name = candidate;
        }
      }
      const count = Number(run(cwd, ['rev-list', '--count', `${base}..${head}`]));
      return { head, base, baseRef: name, count: Number.isFinite(count) ? count : 0 };
    } catch {
      // Not resolvable here; try the next candidate.
    }
  }
  return { head };
}

export function formatOutput(range) {
  // A branch already in step with its base (a tag push, a re-push) publishes no new code.
  if (!range || (range.base && range.count === 0)) return null;
  const header = 'stackwise pre-push (STACKWISE_PREPUSH=1): this hook does not hold the push back, so the push may already have run.';
  const report = 'Report every must finding to the user before any further push, PR, merge or deploy step.';
  if (range.base && range.count > 0) {
    const n = `${range.count} commit${range.count === 1 ? '' : 's'}`;
    const short = range.head.slice(0, 7);
    return {
      systemMessage: `stackwise: pre-push review requested for ${n} (${range.baseRef}..${short})`,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: [
          header,
          `It publishes ${n}: ${range.base}..${range.head} (${range.baseRef} before the push).`,
          `Review exactly these commits with the stackwise skill on \`git diff ${range.base}...${range.head}\`. Use the shas, not branch names: the push moves the upstream ref.`,
          report,
        ].join('\n'),
      },
    };
  }
  return {
    systemMessage: 'stackwise: pre-push review requested (outgoing commits not resolved)',
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: [
        header,
        'The outgoing commits could not be resolved: no upstream and no origin default branch.',
        'Review the commits this push publishes with the stackwise skill.',
        report,
      ].join('\n'),
    },
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
  if (process.env.STACKWISE_PREPUSH !== '1') return;
  const raw = await readStdin();
  if (!raw) return;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (input?.tool_name !== undefined && input.tool_name !== 'Bash') return;
  const cwd = input?.tool_input?.cwd ?? input?.cwd ?? process.cwd();
  const push = findPush(input?.tool_input?.command, cwd);
  if (!push) return;
  const output = formatOutput(outgoingRange(push.dir, git, push.ref));
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

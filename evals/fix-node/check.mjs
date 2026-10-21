#!/usr/bin/env node
// Scores a stackwise-fix run on the fix-node fixture:
//   node evals/fix-node/check.mjs <dir> [<commit count before the run>]
// It drives both the module and the real server, because the crash finding can be
// fixed in either src/assets.js or src/server.js.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dirArg, countArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: node check.mjs <dir> [<commit count before the run>]');
  process.exit(2);
}
const dir = resolve(dirArg);
// No trailing separator on purpose: a fix that relies on the caller passing one
// still lets a sibling directory such as public-private/ through.
const root = join(dir, 'public');
const TRAVERSAL = '/assets/..%2fpackage.json';
const SIBLING = '/assets/..%2fpublic-private%2fsecret.txt';
const MALFORMED = '/assets/%E0%A4%A';

let failed = 0;
function report(ok, name, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  return ok;
}

async function settle(promise) {
  try {
    return { value: await promise };
  } catch (err) {
    return { error: `${err?.name ?? 'Error'}: ${err?.message ?? err}` };
  }
}

function insideRoot(path) {
  return resolve(path).startsWith(resolve(root) + sep);
}

async function checkModule() {
  const mod = await import(pathToFileURL(join(dir, 'src', 'assets.js')).href);

  const css = await settle(mod.serveAsset(root, '/assets/app.css'));
  report(css.value?.status === 200 && /^text\/css/.test(css.value?.type ?? ''),
    'app.css is still served as text/css', css.error ?? `status ${css.value?.status}, type ${css.value?.type}`);

  const missing = await settle(mod.serveAsset(root, '/assets/missing.css'));
  report(missing.value?.status === 404, 'a missing file is still 404', missing.error ?? `status ${missing.value?.status}`);

  for (const [name, path] of [['traversal', TRAVERSAL], ['sibling-prefix traversal', SIBLING]]) {
    const res = await settle(mod.serveAsset(root, path));
    report(res.value !== undefined && res.value.status !== 200,
      `serveAsset refuses the ${name} ${path}`, res.error ?? `status ${res.value?.status}`);
  }

  if (typeof mod.resolveAsset === 'function') {
    for (const path of [TRAVERSAL, SIBLING]) {
      let resolved;
      try {
        resolved = mod.resolveAsset(root, path);
      } catch {
        resolved = null;
      }
      const ok = typeof resolved !== 'string' || insideRoot(resolved);
      report(ok, `resolveAsset never returns a path outside the root for ${path}`, ok ? '' : resolved);
    }
  }

  const bad = await settle(mod.serveAsset(root, MALFORMED));
  const status = bad.value?.status;
  report(bad.value !== undefined && status >= 400 && status < 500,
    `serveAsset answers ${MALFORMED} with a 4xx instead of rejecting`, bad.error ?? `status ${status}`);
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

function get(port, path) {
  return new Promise((done) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => done({ status: res.statusCode, type: res.headers['content-type'] ?? '' }));
    });
    req.on('error', (err) => done({ error: err.code ?? err.message }));
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function checkServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [join(dir, 'src', 'server.js')], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    let up = false;
    for (let i = 0; i < 50 && child.exitCode === null; i += 1) {
      if (!(await get(port, '/')).error) {
        up = true;
        break;
      }
      await sleep(100);
    }
    if (!report(up, 'the server starts', up ? '' : stderr.trim().split('\n')[0])) return;

    const bad = await get(port, MALFORMED);
    await sleep(300);
    const alive = child.exitCode === null;
    report(alive && bad.status >= 400 && bad.status < 500,
      `the server answers ${MALFORMED} with a 4xx and keeps running`,
      alive ? `status ${bad.status ?? bad.error}` : `process exited: ${stderr.trim().split('\n').find((l) => /Error/.test(l)) ?? 'no stderr'}`);
    if (!alive) return;

    const traversal = await get(port, TRAVERSAL);
    report(traversal.status !== undefined && traversal.status !== 200,
      `the server refuses ${TRAVERSAL}`, `status ${traversal.status ?? traversal.error}`);

    const css = await get(port, '/assets/app.css');
    report(css.status === 200 && /^text\/css/.test(css.type), 'the server still serves app.css', `status ${css.status ?? css.error}`);
  } finally {
    child.kill();
  }
}

// Not trimmed: porcelain status lines start with a significant space.
function git(...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

function checkRepo() {
  if (countArg === undefined) {
    console.log('SKIP commit count (no expected count given)');
  } else {
    const count = git('rev-list', '--count', 'HEAD').trim();
    report(count === countArg, 'no new commit was made', `${count} commits, expected ${countArg}`);
  }

  const testsUntouched = git('diff', '--name-only', 'HEAD', '--', 'test/').trim();
  report(testsUntouched === '', 'existing tests are untouched', testsUntouched);

  // A new regression test is fine; edits anywhere else are scope creep.
  const outside = git('status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ untracked: line.startsWith('??'), path: line.slice(3) }))
    .filter(({ untracked, path }) => !path.startsWith('src/') && !(untracked && path.startsWith('test/')))
    .map(({ path }) => path);
  report(outside.length === 0, 'changes stay in src/ (plus new tests)', outside.join(', '));
}

// A sibling directory whose name starts with the root's name catches a containment
// check written as startsWith(root) without the separator.
const sibling = join(dir, 'public-private');
mkdirSync(sibling, { recursive: true });
writeFileSync(join(sibling, 'secret.txt'), 'not an asset\n');
try {
  await checkModule();
  await checkServer();
} finally {
  rmSync(sibling, { recursive: true, force: true });
}
checkRepo();

console.log(failed === 0 ? 'ok all checks passed' : `${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

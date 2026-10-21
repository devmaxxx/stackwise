import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatOutput as formatGuard, scan } from '../hooks/security-guard.mjs';
import { findPush, formatOutput as formatPrepush, outgoingRange, simpleCommands } from '../hooks/prepush-review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(root, 'hooks', 'security-guard.mjs');
const PREPUSH = join(root, 'hooks', 'prepush-review.mjs');

// Sample secrets are assembled from parts so this file never holds a literal token
// that a secret scanner (or the release grep) would flag.
const S = {
  aws: 'AK' + 'IA' + 'Z7Q2M4P8R1T6V3W9',
  awsSecret: 'wJa' + 'lrXUtnFq7K' + 'Zq8Mb2Pd4R'.repeat(3),
  github: 'gh' + 'p_' + 'A1b2'.repeat(9),
  githubFine: 'github_pa' + 't_' + 'Ab3'.repeat(15),
  slack: 'xo' + 'xb-' + '1234567890-AbCdEfGhIjKl',
  stripe: 'sk' + '_live_' + 'Ab3'.repeat(8),
  skKey: 'sk' + '-ant-' + 'Ab3Cd4'.repeat(6),
  google: 'AI' + 'za' + 'Sy' + 'A1b2C3d4E5'.repeat(3) + 'abc',
  pem: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  pass: 'Pass' + 'word',
};

const temps = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'stackwise-hooks-'));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function writeHits(filePath, content, existing = '') {
  return scan({ toolName: 'Write', toolInput: { file_path: filePath, content }, readExisting: () => existing }).hits;
}

function ruleIds(filePath, content) {
  return writeHits(filePath, content).map((h) => h.id);
}

const cleanEnv = () => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(tmpdir(), 'stackwise-no-gitconfig') };
  delete env.STACKWISE_SECURITY_HOOK;
  delete env.STACKWISE_PREPUSH;
  return env;
};

function run(script, input, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...cleanEnv(), ...extraEnv },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 0, `${script} exited ${result.status}: ${result.stderr}`);
  assert.equal(result.stderr, '', 'hooks stay quiet on stderr');
  assert.doesNotMatch(result.stdout, /permissionDecision/, 'hooks never decide permissions');
  return result.stdout;
}

describe('security-guard rules', () => {
  const cases = [
    // [rule id, file, line that must warn, near miss that must not]
    ['aws-access-key', 'config.ts', `const key = '${S.aws}';`, `const key = '${S.aws.slice(0, 12)}';`],
    ['github-token', 'ci.yml', `token: ${S.github}`, `token: ${S.github.slice(0, 20)}`],
    ['github-token', 'ci.yml', `token: ${S.githubFine}`, `token: ${'github_pa' + 't_' + 'short'}`],
    ['slack-token', 'notify.js', `const hook = '${S.slack}';`, `const hook = '${'xo' + 'xz-1234567890-AbCdEf'}';`],
    ['stripe-live-key', 'pay.ts', `const k = '${S.stripe}';`, `const k = '${'sk' + '_test_' + 'Ab3'.repeat(8)}';`],
    ['sk-api-key', 'llm.ts', `const k = '${S.skKey}';`, `const k = 'sk-${'a'.repeat(40)}';`],
    ['google-api-key', 'maps.js', `const k = '${S.google}';`, `const k = '${S.google.slice(0, 30)}';`],
    ['private-key', 'key.txt', S.pem, '-----BEGIN PUBLIC KEY-----'],
    ['hardcoded-credential', 'db.ts', `const db${S.pass} = 'Tr0ub4dor9x';`, `const bypass = 'Tr0ub4dor9x';`],
    ['hardcoded-credential', 'settings.json', `"Api${'Key'}": "q8Z1mR4tW7yB2nC5"`, `"${S.pass}Hash": "q8Z1mR4tW7yB2nC5"`],
    ['connection-string-credential', 'appsettings.json', `"Db": "Server=db;User Id=app;${S.pass}=S3cretValue1;"`, `"Db": "Server=db;User Id=app;${S.pass}=short;"`],
    ['ef-raw-sql-interpolation', 'Repo.cs', `var u = db.Users.FromSqlRaw($"SELECT * FROM Users WHERE Name = '{name}'");`, `var u = db.Users.FromSql($"SELECT * FROM Users WHERE Name = {name}");`],
    ['ef-raw-sql-interpolation', 'Repo.cs', `db.Users.FromSqlRaw("SELECT * FROM Users WHERE Name = '" + name + "'");`, `db.Users.FromSqlRaw("SELECT * FROM Users WHERE Id = {0}", id);`],
    ['ef-raw-sql-interpolation', 'Repo.cs', `await db.Database.ExecuteSqlRawAsync(string.Format("DELETE FROM T WHERE Id = {0}", id));`, `await db.Database.ExecuteSqlAsync($"DELETE FROM T WHERE Id = {id}");`],
    ['allow-anonymous', 'Program.cs', `app.MapPost("/hooks/pay", Handle).AllowAnonymous();`, `app.MapPost("/hooks/pay", Handle).RequireAuthorization();`],
    ['allow-anonymous', 'HooksController.cs', '[AllowAnonymous]', '[Authorize(Policy = "Admin")]'],
    ['dotnet-tls-bypass', 'Http.cs', 'handler.ServerCertificateCustomValidationCallback = (m, c, ch, e) => true;', 'handler.ServerCertificateCustomValidationCallback = (m, c, ch, e) => e == SslPolicyErrors.None;'],
    ['dotnet-tls-bypass', 'Http.cs', 'handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;', 'handler.SslProtocols = SslProtocols.Tls13;'],
    ['dangerously-set-inner-html', 'Bio.tsx', '<div dangerouslySetInnerHTML={{ __html: bio }} />', '<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(bio) }} />'],
    ['eval', 'calc.js', 'const result = eval(expr);', 'const result = await redis.eval(script, 0);'],
    ['new-function', 'calc.ts', "const fn = new Function('a', body);", 'const registry = new FunctionRegistry();'],
    ['shell-exec-interpolation', 'git.mjs', 'exec(`git log ${ref}`, cb);', "execFile('git', ['log', ref], cb);"],
    ['shell-exec-interpolation', 'clean.cjs', "execSync('rm -rf ' + dir);", "execSync('rm -rf ./dist');"],
    ['reject-unauthorized', 'client.ts', 'const agent = new https.Agent({ rejectUnauthorized: false });', 'const agent = new https.Agent({ rejectUnauthorized: true });'],
    ['node-tls-env', 'setup.js', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';", "if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') warn();"],
    ['node-tls-env', '.env', 'NODE_TLS_REJECT_UNAUTHORIZED=0', 'NODE_TLS_REJECT_UNAUTHORIZED=1'],
  ];
  for (const [id, file, bad, nearMiss] of cases) {
    test(`${id} warns on ${file}`, () => {
      assert.deepEqual(ruleIds(file, bad), [id]);
    });
    test(`${id} near miss stays quiet (${file})`, () => {
      assert.deepEqual(ruleIds(file, nearMiss), []);
    });
  }
});

describe('security-guard scope', () => {
  test('placeholders and environment lookups are skipped', () => {
    const lines = [
      `apiKey: "your-api-key-here"`,
      `const ${S.pass.toLowerCase()} = "\${DB_PASS}";`,
      `secret: 'JWT_SECRET'`,
      `const token = "aaaaaaaaaaaa";`,
      `"Db": "Server=db;${S.pass}=$(DB_PASS);"`,
      `const key = '${'AK' + 'IA' + 'IOSFODNN7EXAMPLE'}';`,
    ];
    assert.deepEqual(ruleIds('config.ts', lines.join('\n')), []);
  });

  test('code rules apply only to their languages', () => {
    assert.deepEqual(ruleIds('notes.md', '<div dangerouslySetInnerHTML={{ __html: x }} />'), []);
    assert.deepEqual(ruleIds('query.ts', `db.FromSqlRaw($"SELECT {x}")`), []);
  });

  test('comment lines do not trigger code rules', () => {
    assert.deepEqual(ruleIds('Program.cs', '// [AllowAnonymous] was removed here'), []);
    assert.deepEqual(ruleIds('calc.js', '// never call eval(input)'), []);
  });

  test('lockfiles and binary content are skipped', () => {
    assert.deepEqual(ruleIds('package-lock.json', `"token": "${S.github}"`), []);
    assert.deepEqual(ruleIds('blob.ts', `\u0000${S.github}`), []);
  });

  test('Write reports only lines the file did not already have', () => {
    const line = `const result = eval(expr);`;
    assert.deepEqual(writeHits('/repo/calc.js', `${line}\n`, `${line}\n`), []);
    const hits = writeHits('/repo/calc.js', `const a = 1;\n  ${line}\n`, 'const a = 1;\n');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
  });

  test('a file too large to diff against is skipped', () => {
    const hits = scan({ toolName: 'Write', toolInput: { file_path: '/repo/big.js', content: 'eval(x);' }, readExisting: () => null }).hits;
    assert.deepEqual(hits, []);
  });

  test('Edit warns only when new_string adds the pattern', () => {
    const line = 'const result = eval(expr);';
    const quiet = scan({ toolName: 'Edit', toolInput: { file_path: '/r/a.js', old_string: line, new_string: `${line}\nlog(result);` } });
    assert.deepEqual(quiet.hits, []);
    const loud = scan({ toolName: 'Edit', toolInput: { file_path: '/r/a.js', old_string: 'const result = 1;', new_string: line } });
    assert.deepEqual(loud.hits.map((h) => h.id), ['eval']);
    assert.equal(loud.hits[0].line, undefined);
  });

  test('MultiEdit checks every edit', () => {
    const edits = [
      { old_string: 'a', new_string: 'const result = eval(expr);' },
      { old_string: 'b', new_string: 'const agent = new https.Agent({ rejectUnauthorized: false });' },
    ];
    const hits = scan({ toolName: 'MultiEdit', toolInput: { file_path: '/r/a.ts', edits } }).hits;
    assert.deepEqual(hits.map((h) => h.id), ['eval', 'reject-unauthorized']);
  });

  test('other tools and missing paths are ignored', () => {
    assert.deepEqual(scan({ toolName: 'Read', toolInput: { file_path: '/r/a.js' } }).hits, []);
    assert.deepEqual(scan({ toolName: 'Write', toolInput: { content: 'eval(x)' } }).hits, []);
  });

  test('secrets are masked and hits are capped at eight', () => {
    const [hit] = writeHits('ci.yml', `token: ${S.github}`);
    assert.ok(hit.text.includes(`${S.github.slice(0, 4)}***`));
    assert.ok(!hit.text.includes(S.github));
    const [pair] = writeHits('s3.js', `new S3({ accessKeyId: "${S.aws}", secretAccessKey: "${S.awsSecret}" });`);
    assert.ok(!pair.text.includes(S.aws) && !pair.text.includes(S.awsSecret), pair.text);
    const [short] = writeHits('db.js', `const ${S.pass.toLowerCase()} = "hunter2!x";`);
    assert.ok(!short.text.includes('hunt'), short.text);
    const many = Array.from({ length: 12 }, (_, i) => `const r${i} = eval(e${i});`).join('\n');
    assert.equal(writeHits('calc.js', many).length, 8);
  });

  test('long lines are shortened and huge lines skipped', () => {
    const [hit] = writeHits('calc.js', `const result = eval(expr); // ${'x'.repeat(300)}`);
    assert.ok(hit.text.length <= 120);
    assert.deepEqual(writeHits('bundle.js', `eval(a);${';'.repeat(5000)}`), []);
  });

  test('a long run of word characters scans quickly', () => {
    const started = Date.now();
    writeHits('big.ts', `${'tokenpass'.repeat(220)} = 'x'\n`.repeat(200));
    assert.ok(Date.now() - started < 2000);
  });

  test('many brackets on one line scan quickly', () => {
    const started = Date.now();
    writeHits('Big.cs', `${'[a'.repeat(990)} AllowAnonymous\n`.repeat(50));
    assert.ok(Date.now() - started < 2000);
  });

  test('formatOutput names the file relative to cwd and how to turn the hook off', () => {
    const result = scan({ toolName: 'Write', toolInput: { file_path: '/repo/src/calc.js', content: 'eval(x);' }, readExisting: () => '' });
    const out = formatGuard(result, { toolName: 'Write', cwd: '/repo' });
    assert.match(out.systemMessage, /1 security warning in src\/calc\.js/);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /STACKWISE_SECURITY_HOOK=0/);
    assert.equal(formatGuard({ filePath: 'x', hits: [] }), null);
  });
});

describe('security-guard process', () => {
  const input = (dir) => ({
    hook_event_name: 'PreToolUse',
    cwd: dir,
    tool_name: 'Write',
    tool_input: { file_path: join(dir, 'src', 'Bio.tsx'), content: '<div dangerouslySetInnerHTML={{ __html: bio }} />\n' },
  });

  test('warns as JSON context and exits 0', () => {
    const dir = tempDir();
    const out = JSON.parse(run(GUARD, input(dir)));
    assert.match(out.systemMessage, /stackwise: 1 security warning/);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /dangerouslySetInnerHTML/);
  });

  test('reads the existing file so unchanged lines stay quiet', () => {
    const dir = tempDir();
    const file = join(dir, 'calc.js');
    writeFileSync(file, 'const result = eval(expr);\n');
    const stdout = run(GUARD, { cwd: dir, tool_name: 'Write', tool_input: { file_path: file, content: 'const result = eval(expr);\nexport default result;\n' } });
    assert.equal(stdout, '');
  });

  test('STACKWISE_SECURITY_HOOK=0 turns it off', () => {
    assert.equal(run(GUARD, input(tempDir()), { STACKWISE_SECURITY_HOOK: '0' }), '');
  });

  test('malformed or empty stdin exits 0 with no output', () => {
    assert.equal(run(GUARD, '{not json'), '');
    assert.equal(run(GUARD, ''), '');
    assert.equal(run(GUARD, 'null'), '');
    assert.equal(run(GUARD, { tool_name: 'Write', tool_input: 'nope' }), '');
  });

  test('a clean write prints nothing', () => {
    const dir = tempDir();
    assert.equal(run(GUARD, { cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'a.ts'), content: 'export const a = 1;\n' } }), '');
  });
});

describe('prepush command matching', () => {
  const cwd = resolve('/work/repo');
  const cases = [
    ['git push', cwd],
    ['git push origin feat/x', cwd, 'feat/x'],
    ['npm test && git push -u origin HEAD', cwd],
    ["git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main", cwd, 'main'],
    ['FOO=1 git push', cwd],
    ['cd ../other && git push', resolve('/work/other')],
    ['git -C sub push --force-with-lease', resolve('/work/repo/sub')],
    ['git push --tags origin main', cwd, 'main'],
    ['git push -o ci.skip origin feat/y:main', cwd, 'feat/y:main'],
    ['git status\ngit push', cwd],
  ];
  for (const [command, dir, ref] of cases) {
    test(`matches: ${command.replace(/\n/g, '\\n')}`, () => {
      assert.deepEqual(findPush(command, cwd), ref ? { dir, ref } : { dir });
    });
  }
  for (const command of [
    'git status',
    'git push --delete origin old-branch',
    'git push origin -d old-branch',
    'git push origin :old-branch',
    'git push origin --tags',
    'git push --dry-run origin main',
    'git push -n',
    'git push origin refs/tags/v1.0.0',
    'echo git push',
    'git commit -m "do not git push && yet"',
    'git stash push -m wip',
    'npm run push',
  ]) {
    test(`ignores: ${command}`, () => {
      assert.equal(findPush(command, cwd), null);
    });
  }

  test('quotes and escapes are honoured when splitting commands', () => {
    assert.deepEqual(simpleCommands(`git commit -m "a && b" && git push`), [['git', 'commit', '-m', 'a && b'], ['git', 'push']]);
    assert.deepEqual(simpleCommands(`echo it\\'s; ls`), [['echo', "it's"], ['ls']]);
  });

  test('cd ~ resolves against the home directory', () => {
    assert.deepEqual(findPush('cd ~/proj && git push', cwd), { dir: join(homedir(), 'proj') });
  });

  test('non-string input is ignored', () => {
    assert.equal(findPush(undefined), null);
  });
});

describe('prepush outgoing range', () => {
  const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  function repoWithOutgoing(extra) {
    const dir = tempDir();
    const remote = join(dir, 'remote.git');
    const work = join(dir, 'work');
    gitIn(dir, 'init', '-q', '--bare', remote);
    gitIn(dir, 'init', '-q', '-b', 'main', work);
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) gitIn(work, 'config', k, v);
    gitIn(work, 'remote', 'add', 'origin', remote);
    const commit = (name) => {
      writeFileSync(join(work, name), `${name}\n`);
      gitIn(work, 'add', name);
      gitIn(work, 'commit', '-q', '-m', `add ${name}`);
    };
    commit('a.txt');
    gitIn(work, 'push', '-q', '-u', 'origin', 'main');
    const base = gitIn(work, 'rev-parse', 'HEAD');
    for (let i = 0; i < extra; i += 1) commit(`f${i}.txt`);
    return { work, base, head: gitIn(work, 'rev-parse', 'HEAD') };
  }

  test('counts the commits ahead of the upstream', () => {
    const { work, base, head } = repoWithOutgoing(2);
    const range = outgoingRange(work, (cwd, args) => gitIn(cwd, ...args));
    assert.deepEqual(range, { head, base, baseRef: 'origin/main', count: 2 });
    const out = formatPrepush(range);
    assert.match(out.systemMessage, /2 commits \(origin\/main\.\./);
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`git diff ${base}\\.\\.\\.${head}`));
  });

  test('nothing ahead of the base means nothing to review', () => {
    const { work } = repoWithOutgoing(0);
    const range = outgoingRange(work, (cwd, args) => gitIn(cwd, ...args));
    assert.equal(range.count, 0);
    assert.equal(formatPrepush(range), null);
  });

  test('a named branch is reviewed, not the checked-out one', () => {
    const { work, base, head } = repoWithOutgoing(1);
    gitIn(work, 'switch', '-q', '-c', 'side', base);
    const range = outgoingRange(work, (cwd, args) => gitIn(cwd, ...args), 'main');
    assert.deepEqual(range, { head, base, baseRef: 'origin/main', count: 1 });
  });

  test('a tag pushed by name publishes no code', () => {
    const { work } = repoWithOutgoing(1);
    gitIn(work, 'tag', 'v9.9.9');
    assert.equal(outgoingRange(work, (cwd, args) => gitIn(cwd, ...args), 'v9.9.9'), null);
  });

  test('outside a repository there is nothing to say', () => {
    assert.equal(outgoingRange(tempDir()), null);
    assert.equal(formatPrepush(null), null);
  });

  test('without an upstream or origin the reminder is generic', () => {
    const out = formatPrepush({ head: 'abc' });
    assert.match(out.systemMessage, /not resolved/);
    assert.match(out.hookSpecificOutput.additionalContext, /stackwise skill/);
  });

  test('the hook process reports the range only when enabled', () => {
    const { work, base } = repoWithOutgoing(2);
    const input = { hook_event_name: 'PreToolUse', cwd: work, tool_name: 'Bash', tool_input: { command: 'git push' } };
    assert.equal(run(PREPUSH, input), '');
    const out = JSON.parse(run(PREPUSH, input, { STACKWISE_PREPUSH: '1' }));
    assert.match(out.systemMessage, /pre-push review requested for 2 commits/);
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(base));
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  });

  test('the hook process ignores other commands, deletes and bad stdin', () => {
    const { work } = repoWithOutgoing(1);
    const env = { STACKWISE_PREPUSH: '1' };
    assert.equal(run(PREPUSH, { cwd: work, tool_name: 'Bash', tool_input: { command: 'git status' } }, env), '');
    assert.equal(run(PREPUSH, { cwd: work, tool_name: 'Bash', tool_input: { command: 'git push --delete origin x' } }, env), '');
    assert.equal(run(PREPUSH, { cwd: tempDir(), tool_name: 'Bash', tool_input: { command: 'git push' } }, env), '');
    assert.equal(run(PREPUSH, '{oops', env), '');
    assert.equal(run(PREPUSH, '', env), '');
  });
});

describe('hooks.json', () => {
  const config = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  const handlers = Object.values(config.hooks).flat().flatMap((group) => group.hooks.map((h) => ({ ...h, matcher: group.matcher })));

  test('registers both scripts on PreToolUse, in shell form with a quoted plugin path', () => {
    assert.deepEqual(Object.keys(config.hooks), ['PreToolUse']);
    for (const h of handlers) {
      assert.equal(h.type, 'command');
      assert.equal(h.args, undefined);
      assert.ok(h.timeout > 0 && h.timeout <= 30);
      const script = h.command.match(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[\w-]+\.mjs)"$/);
      assert.ok(script, `unexpected command: ${h.command}`);
      assert.ok(existsSync(join(root, script[1])), `${script[1]} is missing`);
    }
    assert.deepEqual(handlers.map((h) => h.matcher), ['Write|Edit|MultiEdit', 'Bash']);
  });
});

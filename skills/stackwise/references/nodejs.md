# Node.js backend (Express, Fastify, NestJS)

## Checklist

### Event loop
- [ ] No sync I/O on a request path: `readFileSync`, `writeFileSync`, `existsSync`, `execSync`, `crypto.pbkdf2Sync`/`scryptSync`, `zlib.*Sync`.
- [ ] No `JSON.parse`/`JSON.stringify` of unbounded payloads in the handler; body size limits set (`express.json({ limit })`, Fastify `bodyLimit`).
- [ ] Regexes applied to user input have no nested quantifiers (`(a+)+`, `(.*)*`) — ReDoS; or use a linear engine / length cap.
- [ ] CPU-heavy work (image resize, big sorts, PDF) goes to a worker thread or a queue.

### Promises and errors
- [ ] No floating promises: every promise is awaited, returned, or has `.catch` with a logged outcome.
- [ ] `forEach(async ...)` is not used where completion or errors matter (use `for...of` or `Promise.all`).
- [ ] Express 4: async handlers forward errors (`try/catch` + `next(err)`, a wrapper, or `express-async-errors`); a rejected promise otherwise hangs the request or crashes on `unhandledRejection`.
- [ ] Express 5: rejected promises reach error middleware automatically — do not flag missing wrappers there. Check the major version in `package.json`.
- [ ] Error middleware has four parameters `(err, req, res, next)`; with three it is a normal middleware and never sees errors.
- [ ] Error responses do not include `err.stack` or internal messages in production.
- [ ] A response is sent exactly once per path (no `res.send` after `next(err)`; `return` after sending).
- [ ] `process.on('unhandledRejection'|'uncaughtException')` logs and exits; it does not keep a corrupted process alive.

### Fastify / NestJS
- [ ] Fastify routes declare a JSON `schema` for body/query/params (validation and fast serialization); response schema does not drop fields the client needs.
- [ ] Fastify hooks: async hooks do not also call `done`; `reply.send` in a hook is followed by `return reply`.
- [ ] Fastify plugins that must share decorators are wrapped in `fastify-plugin`; encapsulation is otherwise intended.
- [ ] NestJS: global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`; nested DTOs have `@ValidateNested()` + `@Type()`; guards on new controllers.

### Streams
- [ ] Streams are joined with `stream/promises` `pipeline()` (errors and cleanup propagate), not chained `.pipe()`.
- [ ] Writes respect backpressure (`write()` returning false → wait for `drain`), or use `pipeline`.
- [ ] Large downloads/uploads stream rather than buffer into memory.

### Process and config
- [ ] Graceful shutdown on `SIGTERM`: stop accepting (`server.close()`), finish in-flight work, close DB pools, exit with a timeout.
- [ ] Env config validated at startup (zod/envalid/`@nestjs/config` schema); no `process.env.X` read deep in code with a silent fallback for secrets.
- [ ] Timeouts on outbound HTTP (`fetch` with `AbortSignal.timeout`, axios `timeout`).

### Injection and files
- [ ] `child_process.exec`/`execSync` never receive interpolated input; use `execFile`/`spawn` with an args array and no `shell: true`.
- [ ] File paths from input are resolved and checked to stay inside the base dir (path traversal).
- [ ] Database queries are parameterized (`$1`, `?`, query builders); no template-string SQL.

### Dependencies
- [ ] `package.json` changes come with a lockfile change (and vice versa). A committed lockfile now out of sync breaks `npm ci`, so it is a should; with no lockfile in the repo, mention it under Notes only. No unexpected registry or git URL; install scripts of new packages considered.
- [ ] New dependency justified (size, maintenance, license); not a duplicate of an existing one.
- [ ] Version ranges did not jump a major without code changes for it.

## Sync I/O in a request

```js
// ❌ Blocks every other request while the disk read runs.
app.get('/terms', (req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'terms.html'), 'utf8'));
});

// ✅
app.get('/terms', async (req, res, next) => {
  try { res.type('html').send(await fs.promises.readFile(termsPath, 'utf8')); }
  catch (err) { next(err); }
});
```

Sync reads at module load (startup config) are fine.

## Express 4 async errors

```js
// ❌ Express 4: if findById rejects, the error middleware never runs; the request hangs
//    and Node reports an unhandled rejection.
app.get('/users/:id', async (req, res) => {
  const user = await db.users.findById(req.params.id);
  res.json(user);
});

// ✅
app.get('/users/:id', async (req, res, next) => {
  try { res.json(await db.users.findById(req.params.id)); }
  catch (err) { next(err); }
});
```

## Error middleware arity

```js
// ❌ Three params: Express treats it as a normal middleware.
app.use((err, req, res) => res.status(500).json({ error: 'internal' }));

// ✅
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(500).json({ error: 'internal' }));
```

## Floating promise

```ts
// ❌ A rejection is unhandled; the caller thinks the email was sent.
sendWelcomeEmail(user);
return res.status(201).json(user);

// ✅ Await it, or enqueue it to a job runner that retries and logs.
await queue.add('welcome-email', { userId: user.id });
```

## ReDoS

```js
// ❌ "aaaaaaaaaaaaaaaaaaaaaaaaaaaa!" takes seconds.
const ok = /^(\w+\s?)*$/.test(req.query.name);

// ✅ Cap length and use a pattern without nested quantifiers.
const ok = name.length <= 100 && /^[\w ]+$/.test(name);
```

## Streams

```js
// ❌ An error on either side leaks the file descriptor; no backpressure across errors.
fs.createReadStream(src).pipe(zlib.createGzip()).pipe(res);

// ✅
await pipeline(fs.createReadStream(src), zlib.createGzip(), res);
```

## Graceful shutdown

```js
// ❌ Kubernetes sends SIGTERM; in-flight requests are cut and the pool is not drained.
app.listen(port);

// ✅
const server = app.listen(port);
process.on('SIGTERM', () => {
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
});
```

## Command injection and path traversal

```js
// ❌ file = "a.txt; rm -rf /"
exec(`convert ${req.query.file} out.png`);
// ✅
execFile('convert', [file, 'out.png']);

// ❌ name = "../../etc/passwd"
res.sendFile(path.join(UPLOADS, req.params.name));
// ✅
const p = path.resolve(UPLOADS, req.params.name);
if (!p.startsWith(UPLOADS + path.sep)) return res.sendStatus(400);
res.sendFile(p);
```

## Config validation

```ts
// ❌ A typo in the env name silently signs tokens with "dev".
const secret = process.env.JWT_SECRET || 'dev';

// ✅
const env = z.object({ JWT_SECRET: z.string().min(32), PORT: z.coerce.number().default(3000) }).parse(process.env);
```

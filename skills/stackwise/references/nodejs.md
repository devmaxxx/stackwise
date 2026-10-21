# Node.js backend (Express, Fastify)

Check the framework major in `package.json` first. NestJS lives in [nestjs.md](nestjs.md); status codes,
idempotency, paging and cache headers in [api-design.md](api-design.md).

## Checklist

### Event loop
- [ ] No sync I/O on a request path: `readFileSync`, `writeFileSync`, `existsSync`, `execSync`, `crypto.pbkdf2Sync`/`scryptSync`, `zlib.*Sync`. Sync reads at module load are fine.
- [ ] Body size limits set (`express.json({ limit })`, Fastify `bodyLimit`) and not raised app-wide for one upload route; no `JSON.parse`/`stringify` of unbounded payloads in a handler.
- [ ] Regexes on user input have no nested quantifiers (`(a+)+`, `(\w+\s?)*`) — ReDoS; cap the length or use a linear engine.
- [ ] CPU-heavy work (image resize, PDF, big sorts, bcrypt in a loop) goes to a worker thread or a queue.
- [ ] `Promise.all(input.map(...))` over an input-sized array is capped (`p-limit`, chunks): 10k ids must not mean 10k concurrent queries.
- [ ] No Redis `KEYS pattern` on a request path (it blocks the whole Redis server); use `SCAN`.

### Promises and errors
- [ ] No floating promises: every promise is awaited, returned, or has a `.catch` that logs.
- [ ] No `forEach(async ...)` where completion or errors matter (use `for...of` or `Promise.all`).
- [ ] Express 4: async handlers forward errors (`try/catch` + `next(err)`, a wrapper, or `express-async-errors`); a rejection otherwise hangs the request or crashes on `unhandledRejection`.
- [ ] Express 5 forwards rejected promises to error middleware by itself — do not flag missing wrappers there.
- [ ] Error middleware has four parameters `(err, req, res, next)`; with three it is a normal middleware and never sees errors.
- [ ] One response per path: `return` after `res.status(404).json(...)`; no `res.send` after `next(err)` (`ERR_HTTP_HEADERS_SENT`).
- [ ] Error responses carry no `err.stack`, SQL or internal messages in production.
- [ ] Every `EventEmitter`, stream, socket and `pg.Pool` that can emit `'error'` has a listener; an unhandled `'error'` event throws and kills the process.
- [ ] `process.on('unhandledRejection'|'uncaughtException')` logs and exits; it does not keep a corrupted process alive.

### Request state and memory
- [ ] No per-request data in module scope (`let currentUser`, `lastOrder`): concurrent requests overwrite it. Use `req`, `res.locals` or `AsyncLocalStorage`.
- [ ] `AsyncLocalStorage` is entered with `als.run(store, () => next())`; its store is lost in callbacks a library queues itself (old callback pools, custom thenables). Auth and tenant checks read `req`, not only `getStore()`.
- [ ] Per-request timers and listeners (`setInterval`, `emitter.on`) are cleared on `res.on('close')`; `MaxListenersExceededWarning` is the symptom.
- [ ] In-process caches are bounded (LRU `max` + TTL) and keyed by tenant/user when the value is per user.

### Express
- [ ] `trust proxy` matches the deployment: `true` lets any client set `req.ip` through `X-Forwarded-For` (rate-limit and audit bypass); unset behind a load balancer puts every client on one IP.
- [ ] CORS: `cors()` without options, or `origin` from an unset env var, sends `*`; `origin: true` with `credentials: true` lets any site read authenticated responses.
- [ ] `helmet()` and auth middleware are mounted before the routers and `express.static` they protect; Express runs middleware in registration order.
- [ ] `req.query.x` is `string | string[]`, and under Express 4's default `qs` parser also an object (`?id[$ne]=1`); validate before string methods or Mongo filters.
- [ ] Express 5 upgrade: `req.query` is a read-only getter (middleware that reassigns it breaks), `?a[b]=` no longer parses nested, wildcards need a name (`/*splat`), `req.body` is `undefined` without a matching parser.
- [ ] A webhook route that checks a signature gets `express.raw()` before the global `express.json()`, so the HMAC covers the bytes that were sent.
- [ ] Validation output is what gets used: `const body = Schema.parse(req.body)` then `body`; a middleware that validates but keeps `req.body` passes unknown keys and uncoerced strings on.

### Fastify
- [ ] Routes declare `schema` for body/query/params, and body schemas set `additionalProperties: false`; Fastify's Ajv strips unknown keys only then.
- [ ] Response schemas: a field added to the result but not to `schema.response` is silently dropped; a field added to the schema is exposed. Check both when a DTO changes.
- [ ] Async handlers either return the value or call `reply.send()` and `return reply` — never both; sending from a callback inside an async handler needs `return reply`.
- [ ] Async hooks do not also call `done`; `reply.send` in a hook is followed by `return reply`.
- [ ] A hook registered inside an encapsulated plugin covers only that plugin's routes; a route on the root or a sibling skips it. Shared hooks and decorators use `fastify-plugin`.
- [ ] Schemas are compiled once at startup (`addSchema`, route options), not built per request.

### Data access
- [ ] A client from `pool.connect()` is released in `finally`; each leak drains the pool until every request hangs (pg's default `connectionTimeoutMillis` 0 waits forever).
- [ ] A transaction runs on one client: `pool.query('BEGIN')` … `pool.query('COMMIT')` uses different connections. A `pool.query` inside the transaction does not see its rows and can wait on its locks.
- [ ] No slow outbound I/O (HTTP, queue publish, email) between `BEGIN` and `COMMIT`; row locks are held meanwhile.
- [ ] Read-then-write of a counter or balance is a lost update; use `UPDATE ... SET stock = stock - $1 WHERE id = $2 AND stock >= $1` and check `rowCount`.
- [ ] pg returns `int8` (`COUNT(*)`, `SUM`, bigint ids) and `numeric` as strings: `count === 0` is never true, `total + fee` concatenates.
- [ ] `BigInt` values (Prisma `BigInt` columns) make `res.json` throw; send them as strings. `JSON.parse` rounds ids above 2^53 before a reviver sees them ([cross-stack-contract.md](cross-stack-contract.md)).
- [ ] Queries are parameterized (`$1`, `?`, builders); no template-string SQL. Prisma `$queryRawUnsafe`/`$executeRawUnsafe` with interpolation is injection (tagged `$queryRaw` is safe); identifiers come from an allow-list.

### Streams
- [ ] Streams are joined with `stream/promises` `pipeline()` (errors and cleanup propagate), not chained `.pipe()`.
- [ ] Writes respect backpressure (`write()` returning false → wait for `drain`), or use `pipeline`.
- [ ] Large downloads/uploads stream rather than buffer into memory.

### Process and config
- [ ] Graceful shutdown on `SIGTERM`: stop accepting (`server.close()`), finish in-flight work, close DB pools, exit with a timeout.
- [ ] Env config validated at startup (zod/envalid/schema); no `process.env.X` read deep in code with a silent fallback for secrets.
- [ ] Timeouts on outbound HTTP (`fetch` with `AbortSignal.timeout`, axios `timeout`).

### Injection, files and auth
- [ ] `child_process.exec`/`execSync` never receive interpolated input; use `execFile`/`spawn` with an args array and no `shell: true`.
- [ ] File paths from input are resolved and checked to stay inside the base dir (path traversal).
- [ ] No deep merge or `set(obj, path, value)` with keys from input (`__proto__`, `constructor`) — prototype pollution; validate to known keys or use `Object.create(null)`/`Map`.
- [ ] `jwt.decode()` is never the auth check (it does not verify); `jwt.verify` pins `algorithms` (on jsonwebtoken ≤ 8 omitting it allows key-confusion tokens).
- [ ] `crypto.timingSafeEqual` throws on unequal lengths: compare lengths (or HMAC both sides) first, or the endpoint 500s on a short token.
- [ ] Numbers from the query are checked: `Number('abc')` is `NaN`, and `Math.min(NaN, 100)` is `NaN`, so a clamp lets it through.

### Dependencies
- [ ] `package.json` changes come with a lockfile change (and vice versa). A committed lockfile now out of sync breaks `npm ci`, so it is a should; with no lockfile in the repo, mention it under Notes only. No unexpected registry or git URL; install scripts of new packages considered.
- [ ] New dependency justified (size, maintenance, license); not a duplicate of an existing one.
- [ ] Version ranges did not jump a major (Express 4 → 5, Fastify 4 → 5) without code changes for it.
- [ ] A package loaded through both `require` and `import` can load twice, splitting `instanceof` checks and module singletons. Flag only when the diff mixes the two.

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
//    and, on Node 15+, the unhandled rejection kills the process.
app.get('/users/:id', async (req, res) => {
  res.json(await db.users.findById(req.params.id));
});
// ✅
app.get('/users/:id', async (req, res, next) => {
  try { res.json(await db.users.findById(req.params.id)); }
  catch (err) { next(err); }
});
```

## Error middleware and double responses

```js
// ❌ Three params: Express treats it as a normal middleware.
app.use((err, req, res) => res.status(500).json({ error: 'internal' }));
// ✅
app.use((err, req, res, next) => res.status(500).json({ error: 'internal' }));

// ❌ No return: a missing order sends 404, then res.json throws ERR_HTTP_HEADERS_SENT.
if (!order) res.status(404).json({ error: 'not found' });
res.json(order);
// ✅
if (!order) return res.status(404).json({ error: 'not found' });
```

## Request state in module scope

```js
// ❌ Shared by every in-flight request: request B can log or bill as user A.
let currentUser;
app.use((req, res, next) => { currentUser = req.user; next(); });
// ✅ Keep it on the request, or in AsyncLocalStorage.
const ctx = new AsyncLocalStorage();
app.use((req, res, next) => ctx.run({ user: req.user }, () => next()));
```

Breaks when: two requests interleave at any `await` between the write and the read.

## Proxies and CORS

```js
// ❌ A client sending X-Forwarded-For: 1.2.3.4 becomes req.ip; the rate limiter never trips.
app.set('trust proxy', true);
// ✅ Trust exactly the hops you run (one load balancer).
app.set('trust proxy', 1);

// ❌ ALLOWED_ORIGINS unset in one environment → origin undefined → Access-Control-Allow-Origin: *
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') }));
// ✅ Fail at startup when the list is missing; never pair origin: true with credentials.
app.use(cors({ origin: env.ALLOWED_ORIGINS, credentials: true }));
```

## Fastify schemas and replies

```js
// ❌ { "role": "admin" } reaches the handler; `discount` is missing from the response schema, so never sent.
body: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' } } },
response: { 201: { type: 'object', properties: { id: { type: 'string' } } } },
// ✅
body: { type: 'object', required: ['sku'], additionalProperties: false, properties: { sku: { type: 'string' } } },
response: { 201: { type: 'object', properties: { id: { type: 'string' }, discount: { type: 'number' } } } },

// ❌ No return: a missing user gets the 404, then user.profile throws after the reply was sent.
if (!user) reply.code(404).send({ error: 'not found' });
return user.profile;
// ✅
if (!user) return reply.code(404).send({ error: 'not found' });
```

## pg pools and transactions

```js
// ❌ BEGIN, INSERT and COMMIT can each run on a different connection: no transaction at all.
await pool.query('BEGIN');
await pool.query('INSERT INTO orders (sku) VALUES ($1)', [sku]);
await pool.query('COMMIT');
// ✅ One client, rollback on error, release in finally.
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT INTO orders (sku) VALUES ($1)', [sku]);
  await client.query('COMMIT');
} catch (err) { await client.query('ROLLBACK'); throw err; }
finally { client.release(); }
```

```js
// ❌ COUNT(*) is int8, which pg returns as the string "0": this branch never runs.
if (rows[0].count === 0) return res.sendStatus(404);
// ✅
if (Number(rows[0].count) === 0) return res.sendStatus(404);
```

## Floating promise and ReDoS

```ts
// ❌ A rejection is unhandled; the caller thinks the email was sent.
sendWelcomeEmail(user);
return res.status(201).json(user);
// ✅ Await it, or enqueue it to a job runner that retries and logs.
await queue.add('welcome-email', { userId: user.id });

// ❌ "aaaaaaaaaaaaaaaaaaaaaaaaaaaa!" takes seconds.
const ok = /^(\w+\s?)*$/.test(req.query.name);
// ✅ Cap length and use a pattern without nested quantifiers.
const ok = name.length <= 100 && /^[\w ]+$/.test(name);
```

## Streams and shutdown

```js
// ❌ An error on either side leaks the file descriptor.
fs.createReadStream(src).pipe(zlib.createGzip()).pipe(res);
// ✅
await pipeline(fs.createReadStream(src), zlib.createGzip(), res);

// ✅ SIGTERM: stop accepting, drain, close the pool, force-exit after a deadline.
const server = app.listen(port);
process.on('SIGTERM', () => {
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
});
```

## Command injection, path traversal, prototype pollution

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
```

```js
// ❌ Body {"__proto__": {"isAdmin": true}}: after the merge every plain object has isAdmin.
deepMerge(settings, req.body);
// ✅ Validate to the known keys, then copy those.
const { theme, locale } = SettingsSchema.parse(req.body);
Object.assign(settings, { theme, locale });
```

## Config validation

```ts
// ❌ A typo in the env name silently signs tokens with "dev".
const secret = process.env.JWT_SECRET || 'dev';
// ✅
const env = z.object({ JWT_SECRET: z.string().min(32), PORT: z.coerce.number().default(3000) }).parse(process.env);
```

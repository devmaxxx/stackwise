# Security (cross-stack, changed lines only)

Walk this list over the changed lines, and over the removed ones. For each hit, name the attacker, the request they send, and what they get. No attacker story, no finding.
Read the actual default, guard or value, not the flag or function name. When a shared security helper changes, list its callers.

## Checklist

### Access control (OWASP A01)
- [ ] Every new endpoint, route, server action, GraphQL resolver, SignalR hub method, webhook and queue/cron handler requires authentication or is deliberately public. A Next server action is a public POST endpoint.
- [ ] Every id from the route, query, body or a queue message is scoped to the caller's owner or tenant (IDOR). A UUID is not a permission.
- [ ] Authorization holds on every path to the data: GraphQL field resolvers reachable through a nested query, batch endpoints (each id), exports, background jobs acting on ids from a message.
- [ ] Tenant filters stay on: a new `IgnoreQueryFilters()`, `FromSqlRaw`, Dapper or a second `DbContext` bypasses them; a pooled connection that keeps another request's `SET app.tenant_id` leaks across tenants.
- [ ] Role and policy checks happen on the server. A hidden button is not authorization; a role read from an unsigned cookie or the request body is not either.
- [ ] Mass assignment: `data: req.body`, `{ ...req.body }`, `Object.assign(entity, req.body)`, entity-bound model binding, `TryUpdateModelAsync` without an include list. `isAdmin`, `tenantId` and `balance` become writable.
- [ ] Open redirect: `returnUrl`/`next`/`redirect` passed to `Redirect()`/`res.redirect()` without `Url.IsLocalUrl`. `startsWith('/')` lets `//evil.example` and `/\evil.example` through.
- [ ] CSRF: a cookie-authenticated POST/PUT/DELETE without an antiforgery token or a `SameSite` + `Origin` check; a GET that changes state.
- [ ] CORS that reflects `Origin` with credentials, or an origin regex without anchors (`/example\.com/` matches `example.com.evil.net`); a `message` listener that never checks `event.origin`.

### Fail-open and insecure defaults
- [ ] Fallback secrets: `process.env.JWT_SECRET || 'dev'`, `config["Signing:Key"] ?? "changeme"`. A default is a finding when production can start with it; `env.X!` plus validation at startup fails secure (nodejs.md).
- [ ] Security switches that default open when config is missing: `REQUIRE_AUTH ?? false`, `if (!opts.Enabled) return next()`, `rejectUnauthorized: false`, `ServerCertificateCustomValidationCallback = (_, _, _, _) => true`.
- [ ] Debug features on by default in production: developer exception page, Swagger UI, GraphQL introspection/playground, `/debug` routes, verbose errors. Gate them on the environment, not on a flag that defaults on.
- [ ] Default credentials: seeded admin users or known passwords in migrations or seeders that run in production.
- [ ] Permissive defaults for cookies and CORS (`SameSite=None`, `Secure` off, `*`): ask who gains access.
- [ ] A catch, timeout or missing dependency on an auth, validation or signature path that ends in "allow" (error-handling.md).

### Injection (A03)
- [ ] SQL: interpolation into `FromSqlRaw`, `ExecuteSqlRaw`, `$queryRawUnsafe`, `knex.raw`, `sequelize.query`; identifiers (`ORDER BY`, column names) from an allow-list. `FromSql($"…")` parameterizes; `FromSqlRaw($"…")` does not.
- [ ] NoSQL: request objects reaching a filter (`{ password: { $ne: null } }`), `$where`, a `$regex` built from input.
- [ ] OS command: `exec`/`execSync` with a template string, `spawn(..., { shell: true })`, `Process.Start("cmd", "/c " + x)`. Use `execFile` or an argument list.
- [ ] Path: `path.join(root, input)` or `Path.Combine(root, input)` without confining the resolved path to the root; `Path.Combine` drops the root when `input` is absolute.
- [ ] HTML: `dangerouslySetInnerHTML`, `Html.Raw`, `v-html`, `innerHTML` with unsanitized input; `href={userUrl}` (`javascript:`); JSON embedded in a `<script>` without escaping `<`.
- [ ] Templates: user input used as the template (`Handlebars.compile(input)`, `ejs.render(input)`) is server-side template injection.
- [ ] Logs: newlines from input in plain-text log lines forge entries. Structured logging avoids it.
- [ ] Prototype pollution: deep merge, `set(obj, path, value)` or `obj[key] = value` with keys from input (`__proto__`, `constructor`).
- [ ] ReDoS: a user-supplied pattern, or a nested quantifier run on user input (nodejs.md); `new Regex(input)` without a timeout.
- [ ] XXE: `XmlReader`/`XmlDocument` with `DtdProcessing.Parse` or an `XmlResolver`; libxml parsers with entity expansion on.

### SSRF
- [ ] A server-side fetch of a URL from input (webhook targets, image import, link preview, PDF render) checks scheme and host against an allow-list after parsing, and blocks loopback, private, link-local (169.254.169.254) and IPv6-local ranges.
- [ ] Redirects are re-validated (`redirect: 'manual'`, `AllowAutoRedirect = false`); for open targets, check the resolved IP and connect to that IP, or DNS rebinding passes the check.
- [ ] A headless browser or HTML-to-PDF renderer given user HTML can load `file://` and internal URLs.

### Authentication and sessions (A07)
- [ ] JWT: `jwt.decode()` where `jwt.verify()` belongs (decode checks nothing); `verify` pins `algorithms`, `issuer` and `audience`; no `ValidateIssuer`/`ValidateAudience`/`ValidateLifetime`/`ValidateIssuerSigningKey = false`.
- [ ] Sessions: cookies are `HttpOnly`, `Secure`, `SameSite`; the session id rotates at login (fixation); logout and password change revoke server-side sessions and refresh tokens.
- [ ] Reset, email-change, invite and magic-link tokens come from a CSPRNG, are single-use, expire, are stored hashed and compared in constant time.
- [ ] Enumeration and brute force: login, reset, signup, OTP and invite endpoints are rate-limited per account and per IP, and answer the same for "no such user" and "wrong password".
- [ ] OAuth/OIDC: `state` checked, PKCE for public clients, exact `redirect_uri` match, `nonce` and audience checked on the ID token.

### Crypto and secrets (A02)
- [ ] Passwords use a KDF (Identity's hasher, bcrypt, scrypt, Argon2), never MD5/SHA-x or reversible encryption.
- [ ] Tokens, codes and ids that grant access come from a CSPRNG (`crypto.randomBytes`/`randomUUID`, `RandomNumberGenerator`), never `Math.random()` or `new Random()`.
- [ ] Weak crypto at a security use site: AES-ECB, a static or reused IV/nonce (GCM nonce reuse leaks the key stream), unauthenticated CBC, a hard-coded key, MD5/SHA-1 signatures.
- [ ] Secret and signature comparisons are constant time (`crypto.timingSafeEqual`, `CryptographicOperations.FixedTimeEquals`). `timingSafeEqual` throws on unequal lengths, so check length first.
- [ ] No secrets in client bundles (`NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*` are inlined), in production source maps, or in committed `.env`, `appsettings.json`, fixtures or image layers.

### Data exposure
- [ ] Responses do not serialize fields the caller should not see (password hash, reset token, internal notes, other tenants' rows). Check the serialized shape, not the type name.
- [ ] PII and tokens stay out of logs, URLs (query strings reach proxy logs and `Referer`), analytics and error reports.
- [ ] Production errors do not echo stack traces, SQL or internal hostnames.
- [ ] Per-user responses are not cached publicly (`Cache-Control: public`, a shared cache key; performance.md).

### Uploads, archives and deserialization
- [ ] Uploads: size limit; type sniffed from content (magic bytes), not the extension or `Content-Type`; served with `nosniff` and `Content-Disposition: attachment` or from another origin. SVG and HTML uploads run script.
- [ ] Stored outside the web root under a generated name; the client's filename never becomes a path.
- [ ] Zip slip: entry names (`../../x`) joined to the target without a containment check; no cap on entry count or total size (zip bomb). `ZipFile.ExtractToDirectory` checks paths; a hand-written `entry.ExtractToFile` loop does not.
- [ ] No `BinaryFormatter`, Newtonsoft `TypeNameHandling.All`/`Auto`, `node-serialize`, `eval`/`new Function`/`vm` on input, or unsafe YAML loading.

### Webhooks and integrations
- [ ] The signature is verified over the raw body (before JSON parsing), in constant time, with a timestamp tolerance.
- [ ] Payment and quota handlers are idempotent per event id (replays, double clicks).

### Money, quotas and races
- [ ] Check-then-act across an `await`: a balance, quota, stock or coupon is read, checked, then written in separate statements, so concurrent requests spend twice. Use one conditional update, a unique constraint, a row lock or a concurrency token.
- [ ] Single-use things (coupon, invite, reset token) are consumed atomically, not "find unused, then mark used".
- [ ] Client-sent prices or totals, negative or zero quantities, and float arithmetic on money.

### Dependencies (A06)
- [ ] New or bumped packages have no known advisory (`dotnet list package --vulnerable`, `npm audit`) and are the intended package (typosquats, new install scripts).
- [ ] Lockfile changes match the manifest change.

### Security regressions (removed checks)
- [ ] Removed or weakened checks: a deleted `[Authorize]`, auth middleware, tenant predicate, validation rule, rate limiter, CSRF check or `if (!owner) return 403`. Read the `-` lines as closely as the `+` lines.
- [ ] A changed shared security function (auth handler, policy, sanitizer, token validator): find its callers and confirm each keeps its guarantee.
- [ ] `git log -S '<removed line>'` on a removed check shows why it was added; reverting a past security fix is a must.
- [ ] Validation or authorization logic that changed while its tests stayed the same or were deleted.

### Do not flag
- Parameterized queries, `FromSql($"…")`/`FromSqlInterpolated`, tagged `` sql`…` `` templates.
- Defaults in `appsettings.Development.json`, test configs or fixtures that production never loads.
- Weak hashes for non-security uses: cache keys, ETags, checksums, sharding.
- Missing rate limits on endpoints that are neither auth-adjacent nor expensive.
- A scenario with no reachable input from an attacker.

## Fail-open default

```csharp
// ❌ A missing setting reads as false, so a new environment runs without tenant isolation.
if (!_opts.Value.EnforceTenantIsolation) { await _next(ctx); return; }

// ✅ Isolation is unconditional. If it must be switchable, the switch is explicit
//    and validated at startup (ValidateOnStart) so a missing value cannot turn it off.
```

## JWT decode vs verify

```ts
// ❌ decode() checks no signature: any client can send { "sub": "admin" }.
const claims = jwt.decode(token);

// ❌ No pinned algorithm or audience: libraries that pick the algorithm from the header
//    accept `none`, or HS256 signed with the RS256 public key; tokens for other apps pass.
const claims = jwt.verify(token, publicKey);

// ✅
const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: ISSUER, audience: AUDIENCE });
```

## IDOR and mass assignment

```ts
// ❌ Any signed-in user edits any tenant's invoice, and can send { "status": "paid" } as well.
app.patch('/invoices/:id', auth, async (req, res) => {
  res.json(await db.invoice.update({ where: { id: req.params.id }, data: req.body }));
});

// ✅ Scope to the caller and accept only the editable fields (a zod object strips unknown keys).
const data = InvoicePatch.parse(req.body);
const { count } = await db.invoice.updateMany({ where: { id: req.params.id, tenantId: req.user.tenantId }, data });
if (count === 0) return res.sendStatus(404);
```

## Server action without a check

```tsx
// ❌ Anyone can POST to this action with any id.
'use server';
export async function deleteProject(id: string) {
  await db.project.delete({ where: { id } });
}

// ✅
export async function deleteProject(id: string) {
  const session = await auth();
  if (!session) throw new Error('Unauthorized');
  await db.project.delete({ where: { id, ownerId: session.user.id } });
}
```

## Tenant filter bypass

```csharp
// ❌ Added to find soft-deleted rows; it also drops the tenant filter, so any tenant's id loads.
var doc = await _db.Documents.IgnoreQueryFilters().FirstOrDefaultAsync(d => d.Id == id, ct);

// ✅ Put the tenant predicate back (EF Core 10: ignore only the named soft-delete filter).
var doc = await _db.Documents.IgnoreQueryFilters()
    .FirstOrDefaultAsync(d => d.Id == id && d.TenantId == _tenant.Id, ct);
```

## Open redirect

```csharp
// ❌ /login?returnUrl=https://evil.example/login lands the user on a phishing copy after sign-in.
return Redirect(returnUrl);

// ✅ Url.IsLocalUrl rejects absolute URLs, //host and /\host.
return Url.IsLocalUrl(returnUrl) ? LocalRedirect(returnUrl) : RedirectToAction("Index", "Home");
```

## NoSQL operator injection

```ts
// ❌ { "email": "a@b.c", "password": { "$ne": null } } signs in as that user.
const user = await users.findOne({ email: req.body.email, password: req.body.password });

// ✅ Parse to strings, then verify a hash.
const { email, password } = LoginSchema.parse(req.body);
const user = await users.findOne({ email });
if (!user || !(await argon2.verify(user.passwordHash, password))) return res.sendStatus(401);
```

## SSRF

```ts
// ❌ ?url=http://169.254.169.254/latest/meta-data/ returns cloud credentials.
const r = await fetch(req.query.url as string);

// ✅ Parse, allow-list and refuse redirects.
const u = new URL(String(req.query.url));
if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) return res.sendStatus(400);
const r = await fetch(u, { redirect: 'manual' });
```

Breaks when: an allowed host answers `302 Location: http://10.0.0.5/admin` and the client follows it.

## Constant-time comparison

```ts
// ❌ !== stops at the first differing byte; response timing leaks the signature.
if (req.get('x-signature') !== sign(rawBody)) return res.sendStatus(401);

// ✅ Equal-length buffers, then timingSafeEqual.
const got = Buffer.from(req.get('x-signature') ?? '', 'hex');
const want = Buffer.from(sign(rawBody), 'hex');
if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.sendStatus(401);
```

C#: `CryptographicOperations.FixedTimeEquals(computed, Convert.FromHexString(header))`. `FromHexString` throws on bad hex, so catch that and return 401.

## Prototype pollution

```ts
// ❌ { "__proto__": { "isAdmin": true } } gives every object in the process isAdmin.
function merge(dst: any, src: any) {
  for (const k in src) typeof src[k] === 'object' ? merge((dst[k] ??= {}), src[k]) : (dst[k] = src[k]);
}
merge(settings, req.body);

// ✅ Validate the body against a schema. For dynamic keys, skip __proto__, constructor
//    and prototype, and use a Map or Object.create(null).
```

## Check-then-act on money

```csharp
// ❌ Two concurrent withdrawals both read 100, both pass, both write 0: 200 paid out.
var acct = await _db.Accounts.SingleAsync(a => a.Id == id, ct);
if (acct.Balance < amount) return Results.BadRequest();
acct.Balance -= amount;
await _db.SaveChangesAsync(ct);

// ✅ One conditional statement; 0 rows means insufficient funds.
var n = await _db.Accounts.Where(a => a.Id == id && a.Balance >= amount)
    .ExecuteUpdateAsync(s => s.SetProperty(a => a.Balance, a => a.Balance - amount), ct);
if (n == 0) return Results.Conflict();
```

## Zip slip

```ts
// ❌ An entry named ../../app/server.js overwrites code outside the target folder.
for (const e of entries) await fs.writeFile(path.join(dest, e.name), e.data);

// ✅
const root = path.resolve(dest);
const target = path.resolve(root, e.name);
if (!target.startsWith(root + path.sep)) throw new Error(`Unsafe entry: ${e.name}`);
```

# HTTP API design

HTTP semantics for new or changed endpoints in any stack. Wire types (nullability, enums, dates,
number precision, page shape) between C# and TypeScript are in [cross-stack-contract.md](cross-stack-contract.md).

## Checklist

### Breaking changes
- [ ] Removing or renaming a response field, changing its type or meaning, making a request field required, narrowing accepted values, or changing a status code breaks deployed clients; it needs a new version or an expand-then-contract rollout.
- [ ] Changing a list's default sort, default page size or filter semantics is breaking too: clients and saved links depend on them.
- [ ] A versioned change goes into the new version only; the old handler is not edited in place. A retired version answers `410` or keeps working until its announced `Sunset` date.
- [ ] A new value in a response enum breaks generated clients with exhaustive switches; flag it when such clients exist ([cross-stack-contract.md](cross-stack-contract.md)).

### Methods and idempotency
- [ ] GET and HEAD change no state: prefetchers, crawlers and `<img src>` call them. A GET that logs out, deletes or sends mail is a defect.
- [ ] POST that creates an order, payment, transfer or message accepts an `Idempotency-Key` (or a client-generated id) and replays the stored response for a repeat; a client retry after a timeout otherwise charges twice.
- [ ] The idempotency record is claimed atomically (unique constraint on `(tenant, key)`), not SELECT-then-INSERT; the same key with a different body is rejected (`409`/`422`).
- [ ] PUT and DELETE are idempotent: a PUT that appends or increments is not, and a repeated DELETE answers `204` or `404`, never `500`.
- [ ] PATCH: an absent field is left unchanged and an explicit `null` clears it. `x ?? null`, spreading a DTO over the entity, or a non-nullable C# `bool`/`int` in the patch DTO overwrites fields the client never sent.
- [ ] PUT replaces the resource: fields missing from the body are reset or rejected, as the siblings do; a PUT that ignores missing fields is a PATCH under the wrong method.

### Status codes
- [ ] Create returns `201` (with `Location` or the new id, matching siblings); no body returns `204`; accepted-for-later returns `202`.
- [ ] `401` means not authenticated, `403` authenticated but not allowed; answer `404` instead of `403` where existence itself is private (other tenants' ids).
- [ ] Invalid input is `400`/`422` (follow the siblings), a uniqueness or state conflict is `409`, a failed `If-Match` is `412`, rate limiting is `429`.
- [ ] Client mistakes never surface as `500`: a malformed id, an unknown enum value or a missing row (`First()`, `findOneOrFail`, `findUniqueOrThrow` uncaught) maps to `400`/`404`.
- [ ] No `200` with `{ "success": false }` or an error message in the body: clients, retries and monitors read the status.

### Errors
- [ ] A new endpoint uses the API's existing error envelope (RFC 9457 Problem Details or the house shape); it does not invent another.
- [ ] Validation errors are keyed by the request path the client sent (`items[2].qty`), not internal property names.
- [ ] Bodies carry no stack trace, SQL, internal hostnames or provider error text; login and reset flows give the same answer for unknown user and wrong password.

### Pagination, sorting, filtering
- [ ] List endpoints are paginated with a default and an enforced maximum page size; `?limit=100000` is clamped or rejected.
- [ ] Offset paging has a total order: `ORDER BY created_at` alone repeats or skips rows that tie; add a unique tiebreaker (`, id`).
- [ ] Feeds, exports and large or hot tables use keyset (cursor) paging: with offsets, rows inserted between requests shift pages and deep offsets scan.
- [ ] Cursors are opaque, encode the full sort key with the tiebreaker, and are parsed strictly; a cursor from another sort or filter is rejected.
- [ ] Sort and filter fields come from an allow-list mapped to columns: `?sort=passwordHash` must not reach the query (it leaks order) and an unknown field is `400`, not `500`.
- [ ] Tenant and ownership scope is applied before user filters; a filter like `?ownerId=` never widens what the caller may see.

### Concurrency and caching
- [ ] A resource that several users or tabs edit uses optimistic concurrency: `ETag` on GET, `If-Match` on PUT/PATCH/DELETE, `412` on mismatch. Last-write-wins silently loses the other edit.
- [ ] The ETag changes whenever the representation does (row version or content hash); a `304` carries the same `ETag`, `Cache-Control` and `Vary` as the `200` would.
- [ ] Per-user or authenticated responses send `Cache-Control: private` or `no-store`; `public` or `s-maxage` lets a CDN serve one user's data to the next. Cookie-authenticated responses get no protection from the `Authorization` rule.
- [ ] A response that varies by `Accept-Language`, `Accept` or a tenant header sends `Vary` for it, or caches mix variants.
- [ ] Missing `Cache-Control` on an authenticated JSON response is a should only when a CDN or shared cache sits in front.

### Async work, bulk and limits
- [ ] Work longer than a few seconds (exports, imports, bulk sends) answers `202` with `Location` of a status resource (`/jobs/{id}`: state, progress, result link, error) instead of holding the request past proxy timeouts.
- [ ] The job status resource is access-checked to its creator, and the result link expires.
- [ ] Rate-limited endpoints answer `429` with `Retry-After`; rate-limit headers match the siblings. Login, OTP and reset are limited per account as well as per IP.
- [ ] Bulk endpoints cap the item count and report per-item results; a partial failure is not a `200` that silently drops items. Whether the batch is atomic is stated.

### GraphQL (when resolvers change)
- [ ] Query depth and complexity are limited; list fields have a maximum `first`/`limit`.
- [ ] Field resolvers that load relations batch through a DataLoader created per request (a shared one caches across users).
- [ ] Authorization runs in field resolvers that expose sensitive data, not only on the root query: any path that reaches `User.email` reads it.

Do not flag naming style (plural nouns, path casing, `400` vs `422`) when the change follows its siblings; flag inconsistency and semantic defects.

## Idempotent create

```ts
// ❌ The client times out, retries, and the card is charged twice.
app.post('/payments', async (req, res) => res.status(201).json(await charge(req.body)));

// ✅ Claim the key first; a repeat replays the stored response.
const key = req.get('Idempotency-Key');
const claimed = await idem.claim(req.user.tenantId, key, hash(req.body)); // unique (tenant, key)
if (!claimed.isNew) return res.status(claimed.status).json(claimed.body);
const payment = await charge(req.body);
await idem.complete(claimed.id, 201, payment);
res.status(201).json(payment);
```

## PATCH: absent vs null

```ts
// ❌ PATCH { "nickname": "Al" } also clears phone: an absent field becomes null.
await users.update(id, { nickname: body.nickname ?? null, phone: body.phone ?? null });
// ✅ Copy only the keys that were sent; an explicit null clears.
const data: Partial<User> = {};
if ('nickname' in body) data.nickname = body.nickname;
if ('phone' in body) data.phone = body.phone;
await users.update(id, data);
```

```csharp
// ❌ A PATCH body without "isActive" binds false and deactivates the user.
public record PatchUser(string? Name, bool IsActive);
// ✅ Nullable means "not sent"; for nullable fields that can be cleared, use JSON Merge Patch or an Optional<T> wrapper.
public record PatchUser(string? Name, bool? IsActive);
```

## Status codes

```ts
// ❌ Monitors and retries see success; a signed-in user without rights gets 401 and re-logs in.
if (!valid) return res.status(200).json({ success: false, error: 'invalid email' });
if (!canEdit(user, doc)) return res.status(401).end();
// ✅
if (!valid) return res.status(422).json(problem('invalid email', { email: ['must be an email'] }));
if (!canEdit(user, doc)) return res.status(403).end();
```

## Stable pagination

```sql
-- ❌ Rows with equal created_at come back in any order: page 2 repeats or skips some.
SELECT * FROM orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50 OFFSET $2;
-- ✅ Keyset with a unique tiebreaker; the cursor carries (created_at, id).
SELECT * FROM orders WHERE tenant_id = $1 AND (created_at, id) < ($2, $3)
ORDER BY created_at DESC, id DESC LIMIT 50;
```

## Sort allow-list

```ts
// ❌ ?sort=passwordHash orders users by their hash; an unknown field throws a 500.
const users = await prisma.user.findMany({ orderBy: { [req.query.sort]: 'asc' } });
// ✅
const SORTS = { name: 'name', joined: 'createdAt' } as const;
const field = SORTS[req.query.sort as keyof typeof SORTS];
if (!field) return res.status(400).json(problem('unknown sort'));
```

## Optimistic concurrency

```ts
// ❌ Two editors load version 7; the second save overwrites the first.
await db.query('UPDATE docs SET body = $1 WHERE id = $2', [body, id]);
// ✅ If-Match carries the version from the GET's ETag.
const { rowCount } = await db.query(
  'UPDATE docs SET body = $1, version = version + 1 WHERE id = $2 AND version = $3',
  [body, id, Number(req.get('If-Match'))]);
if (rowCount === 0) return res.status(412).json(problem('document changed'));
```

## Cache headers on per-user data

```ts
// ❌ A CDN keeps the first caller's profile for five minutes and serves it to everyone.
app.get('/me', auth, (req, res) => res.set('Cache-Control', 'public, max-age=300').json(req.user));
// ✅
app.get('/me', auth, (req, res) => res.set('Cache-Control', 'private, no-store').json(req.user));
```

## Long-running work

```ts
// ❌ A 90-second export: the load balancer cuts it at 60 s and the client retries, starting another.
app.post('/exports', async (req, res) => res.json(await buildExport(req.body)));
// ✅
app.post('/exports', async (req, res) => {
  const job = await jobs.enqueue('export', { ...req.body, ownerId: req.user.id });
  res.status(202).location(`/exports/${job.id}`).json({ id: job.id, state: 'queued' });
});
```

## Rate limits

```ts
// ❌ 400 tells the client its request is wrong; it will not back off.
if (await limiter.exceeded(req.user.id)) return res.status(400).json({ error: 'slow down' });
// ✅
if (await limiter.exceeded(req.user.id)) return res.status(429).set('Retry-After', '30').json(problem('rate limited'));
```

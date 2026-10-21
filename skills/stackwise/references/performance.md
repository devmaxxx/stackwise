# Performance (cross-stack, ranked by impact)

Flag only with evidence: a hot path (per request, per row, per render, inside a loop), a list endpoint, data that is large or grows with users, tenants or time, or a measured claim. Without one, it is a nit at most.
Name the n that breaks it ("200 orders → 201 queries"). Stack detail lives in efcore.md, nodejs.md, dotnet-csharp.md, aspnetcore.md and react.md; this file ranks and links to them.

## Checklist

### 1. Round trips and N+1
- [ ] A query, HTTP call or cache read inside a loop, `.map(async …)` or a per-row resolver. Count calls as a function of n; batch with `IN`/`$in`, `Include`/projection, or a join (efcore.md).
- [ ] GraphQL field resolvers that query per parent: one call per item in the list. Use a request-scoped DataLoader.
- [ ] Lazy loading or navigation access in a loop (`order.Customer.Name` per row with proxies on).
- [ ] Writes one at a time: `SaveChangesAsync`, `INSERT` or an API call per item. Batch them (`AddRange`, `ExecuteUpdateAsync`, `createMany`, `bulkWrite`).
- [ ] The client asks for a list, then fetches details per row.

### 2. Unbounded data and memory
- [ ] A list endpoint or query with no limit: `ToListAsync()` on a growing table, `find({})`, `findMany()` without `take`. Cap and page it (keyset for deep pages).
- [ ] Filtering, sorting, paging or counting in app memory after loading everything: `ToListAsync()` then `.Where`, `findMany()` then `.filter`, `.length` of a fetched list as a count.
- [ ] A new `WHERE`/`ORDER BY`/join column on a large table with no index in the migration.
- [ ] Whole files, bodies or exports buffered: `ReadToEndAsync`, `fs.readFile` on uploads, `await res.text()` on a large download. Stream them (nodejs.md).
- [ ] A module-level or static `Map`, `Dictionary` or array keyed by user, request or id that only grows. Use LRU/TTL with a max size.
- [ ] Unbounded fan-out: `Promise.all(items.map(…))` or `Task.WhenAll(items.Select(…))` over a user-sized list exhausts the pool or hits rate limits. Cap concurrency.
- [ ] O(n²): `includes`/`find`/`indexOf`/`List.Contains` on one list inside a loop over another. Build a `Set`/`Map`/`HashSet`/`ToDictionary` once.
- [ ] Several collection `Include`s in one query (cartesian explosion; efcore.md).

### 3. Sequential awaits and waterfalls
- [ ] Independent awaits in sequence (`await a(); await b();` with no data dependency). Run them with `Promise.all`/`Task.WhenAll`; not on one `DbContext` (efcore.md).
- [ ] `await` in a `for` loop over independent items, where a bounded parallel loop fits.
- [ ] React/Next: a child fetches only after the parent's fetch renders it, or a server component awaits independent data in sequence (react.md).

### 4. Blocking the event loop or thread pool
- [ ] Node on a request path: `readFileSync`, `execSync`, `pbkdf2Sync`, `bcrypt.hashSync`, `zlib.*Sync`, `JSON.parse` of multi-MB bodies, CPU loops over large arrays, ReDoS (nodejs.md).
- [ ] .NET: `.Result`, `.Wait()`, `GetAwaiter().GetResult()`, `Thread.Sleep` or sync I/O on a request path starve the thread pool (dotnet-csharp.md).
- [ ] A lock, DB transaction or pooled connection held across a slow external call.
- [ ] A client or pool created per request: `new HttpClient()` (socket exhaustion; aspnetcore.md), `new PrismaClient()`, `new Pool()`.

### 5. Caching
- [ ] Per-user or per-tenant data under a shared key, or `Cache-Control: public` on an authenticated response. One user's data reaches another (security.md).
- [ ] A cache key that omits an input that changes the result (tenant, locale, role, filters, page).
- [ ] Stampede: an expensive entry expires and every concurrent request recomputes it. `IMemoryCache.GetOrCreateAsync` does not coalesce; use `HybridCache`, a shared in-flight promise, or stale-while-revalidate.
- [ ] Writes that never invalidate the cached read (or only one instance's in-process copy), so users see their edit vanish until the TTL ends.

### 6. Payload size and over-fetching
- [ ] Full entities or `SELECT *` loaded when the caller uses a few fields. Project (`Select(x => new Dto(…))`, Prisma `select`, a Mongo projection).
- [ ] Responses that carry nested graphs, base64 blobs, full history or unused fields on a list endpoint.
- [ ] Large JSON without compression, or images served at full size.

### 7. Client bundle
- [ ] A heavy dependency added to client code, or imported whole (`import _ from 'lodash'`, an icon barrel). Import the one function, or lazy-load below the fold (`next/dynamic`, `React.lazy`).
- [ ] A server-only module pulled into a client component (also a leak; react.md).
- [ ] The LCP image is lazy-loaded or has no dimensions; the hero `next/image` lacks `priority`.

### 8. Re-renders
- [ ] A context `value={{ … }}` built inline re-renders every consumer on each parent render. Memoize it or split the context.
- [ ] A list of hundreds of rows or more without virtualization, or heavy work per row in render.
- [ ] State set to an equal new object on every poll or keystroke high in the tree. Skip no-op updates; move state down.
- [ ] Missing `memo`/`useMemo` is a finding only for a measured or plainly expensive child (react.md).

### 9. Allocations (hot path only)
- [ ] .NET: `new JsonSerializerOptions()` per call; `new Regex(…)` per call (use `static readonly` or `[GeneratedRegex]`); `ContainsKey` then the indexer (use `TryGetValue`); `ToLower()` to compare (use `StringComparison.OrdinalIgnoreCase`); string concatenation in a loop.
- [ ] Node: `{ ...acc, [k]: v }` inside `reduce` (O(n²)); a `RegExp` or `Intl.*Format` built per item; `JSON.parse(JSON.stringify(x))` per request.

### Do not flag
- Cold paths: startup, migrations, admin screens over a handful of rows, one-off scripts.
- Sequential awaits that depend on each other, run in one transaction, or share a `DbContext`.
- LINQ or array methods chosen over hand-written loops, off a hot path.
- "Could be cached" with no repeated identical call and no measured cost.

## N+1

```ts
// ❌ 50 posts → 51 round trips.
const posts = await repo.posts.latest(50);
for (const p of posts) p.author = await repo.users.byId(p.authorId);

// ✅ One query for all authors.
const authors = await repo.users.byIds([...new Set(posts.map((p) => p.authorId))]);
const byId = new Map(authors.map((a) => [a.id, a]));
for (const p of posts) p.author = byId.get(p.authorId);
```

```ts
// ❌ Resolves once per post in the list.
Post: { author: (post, _, { repo }) => repo.users.byId(post.authorId) },
// ✅ A DataLoader created per request in the context batches the ids.
Post: { author: (post, _, { loaders }) => loaders.userById.load(post.authorId) },
```

## Filter in memory

```csharp
// ❌ Loads every invoice, then filters in memory, with a List.Contains per row.
var all = await _db.Invoices.ToListAsync(ct);
var due = all.Where(i => i.DueDate < today && overdueIds.Contains(i.CustomerId)).ToList();

// ✅ The same predicate runs in SQL (Contains on a collection becomes IN).
var due = await _db.Invoices
    .Where(i => i.DueDate < today && overdueIds.Contains(i.CustomerId))
    .ToListAsync(ct);
```

Breaks when: the table reaches a million rows; every call moves them all over the network.

## Unbounded fan-out

```ts
// ❌ 5,000 recipients → 5,000 requests at once; the provider answers 429.
await Promise.all(recipients.map((r) => mailer.send(r)));

// ✅ p-limit caps concurrency.
const limit = pLimit(10);
await Promise.all(recipients.map((r) => limit(() => mailer.send(r))));
```

```csharp
// ✅ .NET 6+
await Parallel.ForEachAsync(recipients,
    new ParallelOptions { MaxDegreeOfParallelism = 10, CancellationToken = ct },
    async (r, token) => await _mailer.SendAsync(r, token));
```

## Sequential awaits

```ts
// ❌ 300 + 200 + 250 ms in a row.
const user = await getUser(id);
const plan = await getPlan(id);
const usage = await getUsage(id);

// ✅ About 300 ms.
const [user, plan, usage] = await Promise.all([getUser(id), getPlan(id), getUsage(id)]);
```

## Blocking

```ts
// ❌ About 250 ms of CPU per login on the event loop; every other request waits.
const hash = bcrypt.hashSync(password, 12);
// ✅ The async version runs on the libuv thread pool.
const hash = await bcrypt.hash(password, 12);
```

```csharp
// ❌ Blocks a pool thread per request; under load the pool starves and latency climbs.
var rate = _rates.GetAsync(currency).Result;
// ✅
var rate = await _rates.GetAsync(currency, ct);
```

## Caching

```ts
// ❌ The first caller's dashboard is served to everyone for five minutes.
const data = await cache.wrap('dashboard', () => buildDashboard(req.user.id), 300_000);
// ✅ Key by every input that changes the result.
const data = await cache.wrap(`dashboard:${req.user.tenantId}:${req.user.id}`,
  () => buildDashboard(req.user.id), 300_000);
```

```csharp
// ❌ When the entry expires, every concurrent request runs the 2-second report query.
var report = await _memory.GetOrCreateAsync("report", _ => BuildReportAsync(ct));
// ✅ HybridCache runs the factory once per key and the other callers wait for it.
var report = await _hybrid.GetOrCreateAsync("report", async token => await BuildReportAsync(token), cancellationToken: ct);
```

```ts
// ❌ One entry per user, forever; the heap grows until the process is OOM-killed.
const sessions = new Map<string, Session>();
// ✅ lru-cache
const sessions = new LRUCache<string, Session>({ max: 10_000, ttl: 15 * 60_000 });
```

## Over-fetching

```csharp
// ❌ Loads every column, including the large Notes text, to show names.
var users = await _db.Users.Where(u => u.TeamId == teamId).ToListAsync(ct);
return users.Select(u => new UserListItem(u.Id, u.Name));

// ✅ Project in the query.
return await _db.Users.Where(u => u.TeamId == teamId)
    .Select(u => new UserListItem(u.Id, u.Name)).ToListAsync(ct);
```

## Client bundle and re-renders

```tsx
// ❌ The whole library ships in the first-load bundle for one modal.
import { Chart } from 'heavy-chart-lib';
// ✅ In a client component: load it when the modal opens.
const Chart = dynamic(() => import('heavy-chart-lib').then((m) => m.Chart), { ssr: false });
```

```tsx
// ❌ A new object every render: every consumer re-renders whenever the provider's parent does.
<AuthContext.Provider value={{ user, signOut }}>{children}</AuthContext.Provider>
// ✅
const value = useMemo(() => ({ user, signOut }), [user, signOut]);
```

## Allocations

```csharp
// ❌ Per call: new options discard the serializer's metadata cache; new Regex parses again.
var json = JsonSerializer.Serialize(evt, new JsonSerializerOptions(JsonSerializerDefaults.Web));
var ok = new Regex(@"^[A-Z]{3}\d{4}$").IsMatch(code);

// ✅ Build once.
private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
[GeneratedRegex(@"^[A-Z]{3}\d{4}$")] private static partial Regex CodePattern();
```

```ts
// ❌ Copies the accumulator on every step: O(n²).
const byId = items.reduce((acc, it) => ({ ...acc, [it.id]: it }), {});
// ✅
const byId = Object.fromEntries(items.map((it) => [it.id, it]));
```

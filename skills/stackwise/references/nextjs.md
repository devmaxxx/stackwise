# Next.js (App Router)

What only holds on the server or in Next.js routing; hooks, effects, a11y and client rules are in react.md.
Versions matter: Next 15 made request APIs async; Next 16 renamed `middleware` to `proxy` and added `'use cache'`.

## Checklist

### Server/client boundary
- [ ] `'use client'` sits on the smallest interactive leaf. On a `layout.tsx` or `page.tsx` it pulls every import below it into the client bundle.
- [ ] Modules that touch the DB, secrets or private APIs start with `import 'server-only'`; browser-only modules with `import 'client-only'`. Cue: a DB client or a non-`NEXT_PUBLIC_` env read reachable from a `'use client'` file.
- [ ] `NEXT_PUBLIC_*` holds nothing secret: it is inlined into client JS at build time, so it also ignores runtime env changes. Cue: `NEXT_PUBLIC_*_SECRET`, `_TOKEN`, or a server API key.
- [ ] Props from a Server to a Client Component carry only what the UI shows: a whole ORM row (`passwordHash`, email, internal flags) ships in the RSC payload. Values are serializable (no class instances; no functions other than server actions).
- [ ] No module-level mutable variable in server code holds request data: concurrent requests share the module. Cue: `let currentUser` assigned in a page, layout or action.
- [ ] `params` and `searchParams` are user input: validated, and never used to grant access (`?admin=1`). On Next 15+ they and `cookies()`/`headers()` are Promises and must be awaited.

### Server actions and route handlers
- [ ] Each `'use server'` function verifies the session, authorizes the specific resource, and validates its arguments (zod). It is a public POST endpoint callable with any arguments, whether or not a page renders its form. Cue: no `auth()`/session call in its first lines.
- [ ] Authorization is on the record, not only on login: `deletePost(id)` checks the post belongs to the caller (IDOR). Bound arguments (`.bind(null, id)`) and hidden fields are client input too.
- [ ] No mass assignment: `data: Object.fromEntries(formData)` or `data: body` lets the caller set `role`, `ownerId`, `price`. Pick fields through a schema; take user id and role from the session.
- [ ] Return values hold only what the UI needs: an action's return value is serialized to the client. Cue: `return db.user.update(…)`.
- [ ] Route handlers (`route.ts`) authenticate each exported method, and cookie-authenticated POST/PUT/DELETE handlers check `Origin` or a CSRF token (server actions check Origin, route handlers do not).
- [ ] Nothing state-changing runs in a `GET` handler or during a page render: prefetching and crawlers call them.
- [ ] `serverActions.allowedOrigins` lists exact hosts, not broad wildcards.

### Proxy (middleware) and navigation
- [ ] Auth is not enforced only in `middleware.ts`/`proxy.ts`. A matcher change, a moved route or a server action outside the matcher skips it; pages, actions and handlers re-check in the data layer.
- [ ] The matcher covers the subtree it protects: `'/dashboard'` misses `/dashboard/settings` (use `'/dashboard/:path*'`); a negative lookahead that excludes `api` also exposes `/api/admin`.
- [ ] `redirect()`, `permanentRedirect()` and `notFound()` throw: inside `try` the `catch` swallows them. Call them after the `try`, or put `unstable_rethrow(err)` first in the `catch`.
- [ ] A missing or unauthorized record calls `notFound()`, not `return null` (a 200 empty page) or `record!.field` (a 500).
- [ ] `generateStaticParams` is not used on pages that render per-user or permissioned data, since the prerendered HTML is shared. With `dynamicParams = false`, records created after the build 404.
- [ ] When middleware does auth, `next` is not on a version open to the `x-middleware-subrequest` bypass (CVE-2025-29927; fixed in 15.2.3, 14.2.25, 13.5.9, 12.3.5).

### Caching and revalidation
- [ ] Data that must be fresh is not frozen at build: a route with no request-time API prerenders, so a plain `fetch` runs once in `next build`. Cue: prices or stock read with no `cookies()`, `headers()`, `connection()` or `cache: 'no-store'`.
- [ ] Per-user data never lands in a shared cache. `unstable_cache` or `'use cache'` over a function that reads the user from a closure without the user in its arguments or `keyParts` serves one user's data to another.
- [ ] `cookies()`/`headers()` are read outside cached functions and passed in as arguments (`'use cache: private'` is the exception).
- [ ] Each mutation revalidates what it changed, after the write and before `redirect()`: `updateTag` (Server Actions only) when the user must see the write at once, `revalidateTag(tag, 'max')` when one stale view is fine, or `revalidatePath`. Tag names match the fetch `tags` or `cacheTag`.
- [ ] `React.cache` dedupes per request and compares arguments by identity: `getUser({ id })` with a fresh object misses every call. Pass primitives.

### Data fetching and streaming
- [ ] Independent awaits in a page, layout or action run in parallel (`Promise.all`) or stream under separate `<Suspense>`. Cue: two `await`s in a row on unrelated data, or a parent that awaits before rendering a child that awaits again.
- [ ] A slow fetch at the top of a layout does not block the whole route: move it into a child under `<Suspense>` or `loading.tsx`.
- [ ] Server Components call data functions directly, not `fetch('http://localhost:3000/api/…')` to their own route handlers (an extra hop, and it fails at build when no server runs).
- [ ] Logging and analytics after the response use `after()`, not an `await` before `return`.

### HTML, metadata and images
- [ ] JSON-LD in `<script dangerouslySetInnerHTML>` escapes `<` (`JSON.stringify(x).replace(/</g, '\\u003c')`); a product or review name containing `</script>` otherwise runs as HTML.
- [ ] `images.remotePatterns` names exact hosts and paths: `hostname: '**'`, or an omitted `protocol`/`pathname`/`search`, turns the optimizer into a proxy for any URL. `dangerouslyAllowSVG` comes with `contentDispositionType: 'attachment'` and a CSP.

Do not flag: a `'use client'` file importing only types from a server module; `redirect()` outside a `try`; a missing `revalidate` on routes that already read `cookies()` or `headers()`.

## Server action without authorization

```ts
// ❌ Anyone can call this with any id: actions are public POST endpoints.
'use server';
export async function deleteInvoice(id: string) { await db.invoice.delete({ where: { id } }); }

// ✅
export async function deleteInvoice(raw: unknown) {
  const id = z.string().uuid().parse(raw);
  const session = await auth();
  if (!session) throw new Error('Unauthenticated');
  await db.invoice.delete({ where: { id, ownerId: session.userId } });
  revalidatePath('/invoices');
}
```

## Mass assignment and oversharing returns

```ts
// ❌ A crafted form adds role=admin; the full row (passwordHash too) goes back to the browser.
export async function updateProfile(form: FormData) {
  return db.user.update({ where: { id: (await auth())!.userId }, data: Object.fromEntries(form) });
}

// ✅
const Profile = z.object({ name: z.string().max(80), bio: z.string().max(500) });
export async function updateProfile(form: FormData) {
  const { userId } = await requireUser();
  await db.user.update({ where: { id: userId }, data: Profile.parse(Object.fromEntries(form)) });
  return { ok: true };
}
```

## Server-only leak and secret env

```tsx
// ❌ A 'use client' file imports the DB module: the build fails, or secrets get bundled.
'use client';
import { db } from '@/lib/db';
const payments = createPaymentsClient(process.env.NEXT_PUBLIC_PAYMENTS_SECRET!);  // shipped to every visitor

// ✅ lib/db.ts starts with `import 'server-only'`; the page fetches and passes plain data.
export default async function Page() {
  const items = await db.item.findMany({ select: { id: true, name: true } });
  return <ItemList items={items} />;
}
```

## Whole row passed to a Client Component

```tsx
// ❌ Every field of `user` is in the RSC payload, visible in the page source.
const user = await db.user.findUnique({ where: { id } });
return <ProfileCard user={user} />;

// ✅
return <ProfileCard name={user.name} avatarUrl={user.avatarUrl} />;
```

## Middleware-only auth and matcher gaps

```ts
// ❌ /dashboard/billing is not matched, and server actions posted to other paths skip it.
export const config = { matcher: ['/dashboard'] };

// ✅ Match the subtree, and still check in the data layer that every page and action uses.
export const config = { matcher: ['/dashboard/:path*'] };
export async function getInvoices() { const { userId } = await requireUser(); /* … */ }
```

## `redirect()` inside try/catch

```ts
// ❌ redirect() throws NEXT_REDIRECT; the catch logs it and returns an error instead.
try {
  await createOrder(input);
  redirect('/orders');
} catch (e) {
  return { error: 'Could not create order' };
}

// ✅ Redirect after the try (or call unstable_rethrow(e) first in the catch).
try { await createOrder(input); } catch { return { error: 'Could not create order' }; }
redirect('/orders');
```

## Per-user data in a shared cache

```ts
// ❌ The key is built from the arguments (none) and the function: every user gets the first user's cart.
const userId = (await auth()).userId;
const getCart = unstable_cache(() => db.cart.findMany({ where: { userId } }), ['cart']);

// ✅ The user is an argument, so it is part of the key.
const getCart = unstable_cache((userId: string) => db.cart.findMany({ where: { userId } }), ['cart']);
const cart = await getCart((await auth()).userId);
```

## Data frozen at build time

```tsx
// ❌ No request-time API: prerendered at build, so prices never change after deploy.
export default async function Prices() {
  const prices = await fetch('https://api.example.com/prices').then(r => r.json());
  return <PriceTable prices={prices} />;
}

// ✅ Choose freshness explicitly.
const prices = await fetch(url, { next: { revalidate: 60, tags: ['prices'] } }).then(r => r.json());
```

## Mutation without revalidation

```ts
// ❌ In a server action: the post page still shows the old title after the redirect.
await db.post.update({ where: { id }, data: { title } });
redirect(`/posts/${id}`);

// ✅ Expire the tag, then redirect. Next 16: updateTag; Next 15: revalidateTag('posts').
await db.post.update({ where: { id }, data: { title } });
updateTag('posts');
redirect(`/posts/${id}`);
```

Breaks when: `revalidateTag('posts', 'max')` is used here instead; it serves the stale page once while it refreshes.

## Server waterfall

```tsx
// ❌ Sequential: total = user + orders + recommendations latency.
const user = await getUser(id);
const orders = await getOrders(id);
const recs = await getRecommendations(id);

// ✅ Parallel, with the slow part streamed.
const [user, orders] = await Promise.all([getUser(id), getOrders(id)]);
return <><Header user={user} /><Orders orders={orders} />
  <Suspense fallback={<RecsSkeleton />}><Recommendations id={id} /></Suspense></>;
```

## JSON-LD and image config

```tsx
// ❌ A product named "</script><script>alert(1)</script>" runs as HTML.
<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
// ✅
<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, '\\u003c') }} />

// ❌ Any host, any path: the optimizer fetches and serves whatever URL it is given.
images: { remotePatterns: [{ hostname: '**' }] }
// ✅
images: { remotePatterns: [{ protocol: 'https', hostname: 'cdn.example.com', pathname: '/products/**' }] }
```

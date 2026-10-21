# React (and Next.js)

## Checklist

### Hooks
- [ ] Hooks are called unconditionally at the top level (not in `if`, loops, early-return branches, or callbacks).
- [ ] Effect, memo and callback dependency arrays list every reactive value they read; `eslint-disable react-hooks/exhaustive-deps` additions are justified.
- [ ] No stale closure: intervals, subscriptions, debounced handlers and async callbacks read current state (functional `setState`, a ref, or correct deps).
- [ ] Effects that subscribe, start timers or open sockets return a cleanup.

### Effects
- [ ] No effect that only derives state from props/state (`useEffect(() => setFull(a + b), [a, b])`) — compute during render.
- [ ] No effect that resets state when a prop changes — use a `key` or compute.
- [ ] Event-driven work (submit, click) runs in the handler, not in an effect watching a flag.
- [ ] Fetching in an effect handles races: `AbortController` or an `ignore` flag in cleanup; or a data library (TanStack Query, SWR) does it.

### Rendering
- [ ] List `key`s are stable ids, not array index for lists that reorder, insert or delete; not `Math.random()`.
- [ ] State is not mutated in place (`arr.push`, `obj.x = ...` then `setState(obj)`).
- [ ] No component defined inside another component's body (remounts every render, loses state).
- [ ] Re-render cost: only flag `useMemo`/`memo` absence when there is a visible cost (large lists, expensive compute, unstable props into a memoized child). Do not ask for memo by default; React Compiler may already handle it.
- [ ] Context values that change every render (`value={{ a, b }}`) feeding many consumers.

### Server components and Next.js
- [ ] `'use client'` sits at the smallest interactive leaf, not on a layout that pulls the whole tree to the client.
- [ ] Server-only code (DB clients, secrets, `process.env` without `NEXT_PUBLIC_`) is not imported into a client component; `import 'server-only'` guards such modules.
- [ ] Props passed from server to client components are serializable and contain no secrets or whole DB rows.
- [ ] Server actions check authentication and authorization themselves and validate input — they are public endpoints.
- [ ] Independent awaits in a server component run in parallel (`Promise.all`) or stream behind separate `Suspense` boundaries; no request waterfall.

### Async UI
- [ ] Loading, empty and error states exist for new data views; an error boundary or route `error.tsx` covers thrown errors.
- [ ] `Suspense` boundaries are placed so one slow part does not blank the page.
- [ ] Optimistic updates roll back on failure.

### Forms
- [ ] Submit is guarded against double submission (disabled while pending, `useFormStatus`, or idempotency key).
- [ ] Controlled inputs do not switch between controlled and uncontrolled (`value={x ?? ''}`).
- [ ] Client validation is mirrored on the server.

### Accessibility
- [ ] Interactive elements are `button`/`a`, not clickable `div`s; inputs have labels; images have `alt`.
- [ ] Focus is managed for dialogs and route changes; nothing is keyboard-unreachable.

### Security and bundle
- [ ] `dangerouslySetInnerHTML` only with sanitized HTML (DOMPurify) or trusted constants; `href` from user input rejects `javascript:` URLs.
- [ ] Tokens are not kept in `localStorage` when an httpOnly cookie is possible.
- [ ] New heavy dependencies are lazy-loaded (`React.lazy`, `next/dynamic`) if not needed on first paint; no full-library imports from barrels (`import _ from 'lodash'`).

## Missing dependency → stale closure

```tsx
// ❌ The interval captures the first `step`; changing step has no effect.
useEffect(() => {
  const id = setInterval(() => setCount(count + step), 1000);
  return () => clearInterval(id);
}, []);

// ✅
useEffect(() => {
  const id = setInterval(() => setCount(c => c + step), 1000);
  return () => clearInterval(id);
}, [step]);
```

## Fetch race

```tsx
// ❌ Type "ab" fast: the response for "a" can land after "ab" and overwrite it.
useEffect(() => {
  fetch(`/api/search?q=${q}`).then(r => r.json()).then(setResults);
}, [q]);

// ✅
useEffect(() => {
  const ctrl = new AbortController();
  fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
    .then(r => r.json()).then(setResults)
    .catch(e => { if (e.name !== 'AbortError') setError(e); });
  return () => ctrl.abort();
}, [q]);
```

## Derived state in an effect

```tsx
// ❌ Extra render with a stale value in between.
const [visible, setVisible] = useState<Todo[]>([]);
useEffect(() => setVisible(todos.filter(t => !t.done)), [todos]);

// ✅
const visible = todos.filter(t => !t.done);
```

## Keys

```tsx
// ❌ Deleting row 0 moves row 1's input state into row 0.
{rows.map((r, i) => <Row key={i} row={r} />)}
// ✅
{rows.map(r => <Row key={r.id} row={r} />)}
```

## Server-only leak

```tsx
// ❌ 'use client' file imports the DB module: the build fails, or worse, secrets are bundled.
'use client';
import { db } from '@/lib/db';

// ✅ Fetch in a server component and pass plain data down.
export default async function Page() {
  const items = await db.item.findMany({ select: { id: true, name: true } });
  return <ItemList items={items} />;
}
```

## Waterfall

```tsx
// ❌ Sequential: total = user + posts latency.
const user = await getUser(id);
const posts = await getPosts(id);

// ✅
const [user, posts] = await Promise.all([getUser(id), getPosts(id)]);
```

## XSS

```tsx
// ❌ comment.body is user content.
<div dangerouslySetInnerHTML={{ __html: comment.body }} />
// ✅
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(comment.body) }} />

// ❌ href="javascript:alert(1)"
<a href={profile.website}>site</a>
// ✅
<a href={/^https?:\/\//.test(profile.website) ? profile.website : undefined}>site</a>
```

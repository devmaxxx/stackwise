# React

Correctness first, then accessibility, security, and performance in impact order.
Server Components, server actions, route handlers and caching are in nextjs.md.

## Checklist

### Hooks and effects
- [ ] Hooks run unconditionally at the top level: none inside `if`, a loop, a callback, or after an early `return`. (`use()` is the one hook that may sit in a condition.)
- [ ] Effect, memo and callback deps list every reactive value the body reads. A missing one is a stale closure in intervals, subscriptions, debounced handlers and async callbacks. Cue: a prop or state read in the body but absent from `[...]`, or a new `eslint-disable … exhaustive-deps`.
- [ ] State computed from previous state uses the updater form inside timers and `[]`-dep callbacks. Cue: `setCount(count + 1)` in `setInterval`.
- [ ] Effects that subscribe, start timers, open sockets or add listeners return a cleanup that removes the same handler with the same options.
- [ ] A fetch in an effect handles races: `AbortController` or an `ignore` flag in the cleanup, or a data library. Cue: `fetch(...).then(setX)` with no cleanup.
- [ ] No effect that only derives state from props/state, or resets state when a prop changes (use a `key`): compute during render.
- [ ] Work caused by an event (submit, click, tracking an action) runs in the handler, not in an effect watching a flag.
- [ ] Nothing relies on a mount effect running once: a `key` change, a route change or a remount runs it again in prod. One-time app init uses a module-level guard. Cue: a POST or `sdk.init()` in `useEffect(…, [])`.
- [ ] A dep that is a new object, array or function each render re-runs the effect every render, and loops if the effect sets state. Cue: `const opts = {…}` then `[opts]`.
- [ ] `useEffectEvent` (React 19.2+) results stay out of dependency arrays and are called only from inside effects.

### State and rendering
- [ ] State and props are never mutated in place (`push`, `splice`, `sort()`, `reverse()`, `obj.x = …` then `setState(obj)`): React bails out on the same reference, and `props.items.sort()` reorders the parent's data. Use `toSorted` or spreads.
- [ ] List `key`s are stable ids: not the index on lists that reorder, insert or delete; never `Math.random()` or `crypto.randomUUID()` in render.
- [ ] No component defined inside another component's body: it remounts on every render, so inputs lose focus on each keystroke.
- [ ] `ref.current` is not read or written during render (only in effects and handlers); the one exception is lazy init `if (ref.current === null) ref.current = …`.
- [ ] `{n && <X />}` with a numeric `n` renders a literal `0`. Use `n > 0 ? … : null`.
- [ ] Server data is not copied into `useState` or a global store and kept in sync by an effect; the copy drifts. Read it from the query result.
- [ ] Inputs stay controlled (`value={x ?? ''}`); an input with `value` has `onChange`, or uses `defaultValue`.
- [ ] SSR'd render output does not read `window`/`localStorage`, `Date.now()`, `Math.random()` or the user's locale (hydration mismatch); `suppressHydrationWarning` sits only on the one node expected to differ.

### Data libraries and async UI
- [ ] TanStack Query: `queryKey` includes every variable `queryFn` reads, or the cache serves one id's data for another; mutations invalidate or update the queries they change.
- [ ] Zustand v5 and other `useSyncExternalStore` stores: a selector that returns a new object or array each call loops ("Maximum update depth exceeded"). Use `useShallow` or select primitives.
- [ ] `use(promise)` in a Client Component gets a promise created outside render (a Server Component prop, a cache, a library); one created during render suspends again on every render.
- [ ] Every `Suspense`, `use()` or `useSuspenseQuery` data path has an error boundary or route `error.tsx` above it. New data views have loading, empty and error states.
- [ ] A boundary is not so high that one slow part blanks the page; a fallback that replaces visible content on each keystroke or tab switch needs `startTransition` or `useDeferredValue`.
- [ ] `startTransition` never wraps a controlled input's own `setValue` (typing lags or drops). In an async transition, state set after an `await` needs its own `startTransition`.
- [ ] `useFormStatus` is called in a component rendered inside the `<form>`; in the component that renders the form it always reports `pending: false`.
- [ ] Optimistic updates (`useOptimistic`, `onMutate`) roll back on failure, and never show a payment or order as done before the server confirms it.
- [ ] Submit is guarded against double submission (disabled while pending, `useFormStatus`, or an idempotency key).

### Accessibility and UX (only what the markup proves)
- [ ] Actions are `<button>`, navigation is `<a>`/`<Link>`. A `div`/`span` with `onClick` is unreachable by keyboard and silent to screen readers.
- [ ] Inputs have a label (`<label htmlFor>`, a wrapping label, or `aria-label`); icon-only buttons have `aria-label`; images have `alt` (`alt=""` when decorative).
- [ ] Dialogs move focus in and restore it on close; `outline: none` / `outline-none` has a `:focus-visible` replacement.
- [ ] Async feedback (validation errors, toasts) is announced (`role="alert"`, `aria-live`), and a failed submit focuses the first invalid field.
- [ ] No zoom lock (`user-scalable=no`, `maximum-scale=1`) and no paste blocking (`onPaste` + `preventDefault`).
- [ ] New motion honours `prefers-reduced-motion`; destructive actions have a confirmation or undo.

### Security
- [ ] `dangerouslySetInnerHTML`, `ref.current.innerHTML` and `insertAdjacentHTML` get sanitized HTML (DOMPurify) or trusted constants only.
- [ ] `href`/`src` built from user data reject `javascript:` and `data:` (allow `https:` and relative paths).
- [ ] Redirect targets from the URL (`?next=`, `?returnTo=`) are allow-listed or forced to same-origin paths. Cue: `router.push(params.get('next')!)`.
- [ ] `message` listeners check `event.origin`; `postMessage` with sensitive data names the target origin, not `'*'`.
- [ ] Tokens stay out of `localStorage` when an httpOnly cookie is possible; no secrets in client env (`VITE_*`, `REACT_APP_*`, `NEXT_PUBLIC_*`).

### Performance, in impact order (flag only with a visible cost)
- [ ] 1 Waterfalls: independent requests awaited one after another in a handler or effect, or queries chained by `enabled` that do not need the previous result. `Promise.all`; start early, await late.
- [ ] 2 Bundle: barrel imports from big libraries (`lucide-react`, `@mui/*`, `react-icons`, `lodash`, `date-fns`) without deep imports or `optimizePackageImports`; heavy widgets (editor, chart, map, PDF) not needed for first paint imported statically; analytics SDKs in the initial bundle.
- [ ] 3 Re-renders: context `value={{…}}` rebuilt each render for many consumers; a whole store or `useSearchParams` subscribed for a value read only in a handler; inline object or `= []` defaults passed to a `memo` child; `useState(expensive())` without a lazy initializer.
- [ ] 4 Rendering: lists of hundreds of rows without virtualization or `content-visibility`; `<img>` without `width`/`height` (layout shift).
- [ ] 5 Micro: `find`/`includes` inside a loop over large arrays (build a `Map`/`Set`), a RegExp built per iteration. Hot paths with large data only.

Do not flag: missing `useMemo`/`useCallback`/`memo` without a visible cost (React Compiler, via `babel-plugin-react-compiler` or `reactCompiler: true`, memoizes on its own); effects that run twice only under StrictMode in dev; `forwardRef` vs ref-as-prop, or `useContext` vs `use` (style).

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
useEffect(() => { fetch(`/api/search?q=${q}`).then(r => r.json()).then(setResults); }, [q]);

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

## Unstable dependency → effect loop

```tsx
// ❌ `filters` is a new object each render: fetch → setRows → render → fetch …
const filters = { status, page };
useEffect(() => { load(filters).then(setRows); }, [filters]);

// ✅ Depend on the primitives.
useEffect(() => { load({ status, page }).then(setRows); }, [status, page]);
```

Breaks when: the parent re-renders for any reason; the request repeats until the tab is closed.

## Effect assumed to run once

```tsx
// ❌ A remount (new `key`, back navigation) starts a second trial and sends a second charge.
useEffect(() => { fetch('/api/trial/start', { method: 'POST' }); }, []);

// ✅ Consequential writes go in the handler that causes them, behind an idempotency key.
<button onClick={() => startTrial({ idempotencyKey: planId })}>Start trial</button>
```

## Mutating props or state

```tsx
// ❌ sort() reorders the parent's array in place; setItems(items) is skipped (same reference).
const sorted = props.rows.sort(byDate);
items.push(newItem); setItems(items);

// ✅
const sorted = props.rows.toSorted(byDate);
setItems(prev => [...prev, newItem]);
```

## Keys and component identity

```tsx
// ❌ Deleting row 0 moves row 1's input state into row 0.
{rows.map((r, i) => <Row key={i} row={r} />)}
// ✅
{rows.map(r => <Row key={r.id} row={r} />)}

// ❌ Field is a new component type each render: the input loses focus on every keystroke.
function Form() { const Field = () => <input value={v} onChange={set} />; return <Field />; }
// ✅ Declare Field at module level and pass `v` and `set` as props.
```

## Query keys and copied server state

```tsx
// ❌ Switching customer shows the first customer's orders from cache.
useQuery({ queryKey: ['orders'], queryFn: () => getOrders(customerId) });
// ✅
useQuery({ queryKey: ['orders', customerId], queryFn: () => getOrders(customerId) });

// ❌ A second copy that drifts from the cache after refetches and mutations.
const [users, setUsers] = useState<User[]>([]);
useEffect(() => { if (data) setUsers(data); }, [data]);
// ✅ Render from `data`; keep only UI state (selection, filters) in useState.
```

## Store selectors and `use()`

```tsx
// ❌ Zustand v5: a new object every call → infinite re-render.
const { name, email } = useUser(s => ({ name: s.name, email: s.email }));
// ✅
const { name, email } = useUser(useShallow(s => ({ name: s.name, email: s.email })));

// ❌ Client Component: a new promise each render, so it suspends again on every render.
const user = use(fetch(`/api/users/${id}`).then(r => r.json()));
// ✅ Receive the promise from a Server Component, or use a query library.
```

## Transitions and form status

```tsx
// ❌ The input's own value in a transition: keystrokes lag or get dropped.
<input value={q} onChange={e => startTransition(() => setQ(e.target.value))} />
// ✅ Urgent update for the input, deferred value for the slow list.
<input value={q} onChange={e => setQ(e.target.value)} />
const deferredQ = useDeferredValue(q);

// ❌ Always false: useFormStatus reads a parent <form>, and this component has none above it.
function Signup() { const { pending } = useFormStatus(); return <form action={signup}><button disabled={pending}>Join</button></form>; }
// ✅ Move the hook into a <SubmitButton /> rendered inside the form.
```

## Accessibility

```tsx
// ❌ No keyboard access, no role, no label.
<div onClick={remove}><TrashIcon /></div>
<input placeholder="Email" />

// ✅
<button type="button" onClick={remove} aria-label="Delete invoice"><TrashIcon aria-hidden /></button>
<label htmlFor="email">Email</label><input id="email" type="email" autoComplete="email" />
```

## XSS

```tsx
// ❌ comment.body is user content; profile.website may be "javascript:alert(1)".
<div dangerouslySetInnerHTML={{ __html: comment.body }} />
<a href={profile.website}>site</a>

// ✅
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(comment.body) }} />
<a href={/^https?:\/\//.test(profile.website) ? profile.website : undefined}>site</a>
```

## Open redirect

```tsx
// ❌ /login?next=https://evil.example sends the user off-site after login.
router.push(searchParams.get('next') ?? '/');

// ✅ Same-origin paths only ("//evil.example" is protocol-relative, so reject it too).
const next = searchParams.get('next');
router.push(next?.startsWith('/') && !next.startsWith('//') ? next : '/');
```

## Bundle

```tsx
// ❌ The whole icon pack and a chart library land in the first-paint bundle.
import { FaCheck } from 'react-icons/fa';
import { RevenueChart } from './RevenueChart';   // shown only on the "Reports" tab

// ✅
import { Check } from 'lucide-react';             // with optimizePackageImports or a deep import
const RevenueChart = lazy(() => import('./RevenueChart'));  // next/dynamic in Next.js
```

## Context value churn

```tsx
// ❌ A new value on every render: every consumer re-renders when the provider does.
<CartContext.Provider value={{ items, add, remove }}>

// ✅ A stable value, or split state and actions into two contexts.
const value = useMemo(() => ({ items, add, remove }), [items, add, remove]);
```

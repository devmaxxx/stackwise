# TypeScript

Types that lie to the compiler, runtime values the types do not cover, and type designs that let invalid states compile.

## Checklist

### Trust boundaries and casts
- [ ] Data crossing a trust boundary (HTTP body, query, env, `localStorage`, `postMessage`, queue messages, third-party responses) is validated at runtime (zod/valibot) before use.
- [ ] No new `any` flowing into logic: explicit, or implicit via `JSON.parse`, `res.json()`, `catch (e)` or untyped libraries. Cue: `JSON.parse(raw).field` with no schema.
- [ ] No `as` asserting a shape the compiler cannot see (`res.json() as User`, `{} as Config`); `as unknown as T` is always a finding unless justified.
- [ ] Config objects and lookup tables use `satisfies`, not `as` or a wide annotation: `as Record<Status, …>` accepts a missing key, `satisfies` rejects it and keeps the literal types.
- [ ] No non-null `!` hiding a value that can be undefined (map lookups, `find`, optional props, `document.getElementById`).
- [ ] A type guard (`x is Foo`) or assertion function (`asserts x is Foo`) checks everything it claims.
- [ ] `fetch` does not reject on 4xx/5xx: `res.ok` is checked before the body is treated as data.

### Narrowing and exhaustiveness
- [ ] A `switch` over a union is exhaustive (`default` assigns to `never`), and maps over a union are `Record<Union, …>`, so a new member fails the build.
- [ ] With `noUncheckedIndexedAccess`, `arr[i]` and `record[key]` are handled as possibly `undefined`; without it, indexes that come from input are checked by hand.
- [ ] `Object.keys(obj)` is `string[]` by design (objects may hold extra keys at runtime); `as (keyof T)[]` after it is a cast, and `obj[key]` may hit an unexpected key.
- [ ] Membership in a literal list narrows through a guard (`(x: string): x is Role => (ROLES as readonly string[]).includes(x)`), not `ROLES.includes(x as Role)` plus a cast at each use.
- [ ] Optional chaining does not quietly turn a required value into `undefined` that is then sent or stored.
- [ ] `??` instead of `||`, and explicit comparisons instead of truthiness, where `0`, `''` or `false` are valid values; `===`, not `==`.

### Async
- [ ] No floating promise: each call that returns a Promise is awaited, returned, or `void`ed with a `.catch`. Cue: `audit.log(x);` inside an async function.
- [ ] `arr.forEach(async …)` does not wait for anything; use `for…of` with `await`, or `await Promise.all(arr.map(…))`.
- [ ] Async functions are not passed where a `void` callback is expected (`onClick`, `forEach`, `setTimeout`, `emitter.on`, Express 4 handlers): TS allows it, and the rejection goes unhandled.
- [ ] `Promise.allSettled` where partial success is intended: one rejection in `Promise.all` drops the other results while those calls keep running.
- [ ] `catch (e)` treats `e` as `unknown` and narrows before reading `.message`.

### Values and parsing
- [ ] `parseInt` has a radix; `Number()`/`parseFloat` results are checked for `NaN` before arithmetic or storage.
- [ ] Dates: `new Date('2024-03-10')` is UTC midnight but `new Date('2024-03-10T00:00')` is local time; non-ISO strings parse differently per engine.
- [ ] A function does not mutate an array or object it received (`items.sort()`, `opts.x = …`); `sort()` without a comparator also orders numbers as strings. `readonly T[]` parameters make the compiler catch it.
- [ ] Enums: any `number` is assignable to a numeric enum, and `Object.values` of a numeric enum returns names and numbers. Prefer string unions or `as const` objects; numeric enums on the wire are fragile (see cross-stack-contract.md).

### Config and module boundaries
- [ ] `tsconfig` changes do not loosen `strict`, `strictNullChecks` or `noImplicitAny`, or add `skipLibCheck` to hide real errors; new `@ts-ignore`/`@ts-expect-error` carry a reason.
- [ ] Patch objects tell "absent" from "set to undefined": `'name' in patch` is true for `{ name: undefined }` from a spread, so the field gets cleared. `exactOptionalPropertyTypes` separates the two.
- [ ] `paths` aliases (`@/lib/x`) are not rewritten by `tsc`: a package built with plain `tsc` and run by `node` needs a bundler, `tsc-alias` or relative imports. Cue: a new alias in a package whose start script is `node dist/…`.
- [ ] `__dirname` and `require` in a `"type": "module"` package compile with `@types/node` but throw at runtime; use `import.meta.dirname` or `fileURLToPath(import.meta.url)`.
- [ ] A library's new entry point is listed in `package.json` `exports`, with `types` first in its conditions; otherwise consumers get `ERR_PACKAGE_PATH_NOT_EXPORTED` or untyped imports.

### Type design
- [ ] Illegal states are unrepresentable: a status plus optional fields that only fit some statuses (`{ status; data?; error? }`) becomes a discriminated union. Cue: `!` on `data` right after `status === 'success'`.
- [ ] Mutually exclusive booleans (`isLoading`/`isError`/`isSuccess`, `primary`/`danger` props) become one union field, so impossible combinations do not compile.
- [ ] Ids of different entities, and amounts in different units, are not interchangeable where a mix-up is costly: branded types (`string & { readonly __brand: 'UserId' }`). Cue: `transfer(from: string, to: string, amount: number)`.
- [ ] Invariants (non-empty, positive, `start < end`, valid email) are enforced once in a factory or constructor that returns the branded or validated type, not re-checked, or forgotten, at each use.
- [ ] No exported mutable module state (`export let config`, an exported `Map` that importers write to); export functions, or `readonly`/`as const` data.
- [ ] `Partial<T>` stays at the edge: form state or a PATCH body is validated into a complete `T` before domain code takes it. Cue: a domain function with a `Partial<Order>` parameter that uses `!` inside.

## Casts instead of validation

```ts
// ❌ If the API returns { data: [...] } or an error object, this crashes later, far away.
const users = (await res.json()) as User[];

// ✅
const UserSchema = z.object({ id: z.string(), email: z.string().email(), name: z.string().nullable() });
if (!res.ok) throw new Error(`GET /users ${res.status}`);
const users = z.array(UserSchema).parse(await res.json());
```

```ts
// ❌ Request body trusted as typed.
app.post('/orders', (req, res) => createOrder(req.body as CreateOrder));

// ✅
const body = CreateOrderSchema.safeParse(req.body);
if (!body.success) return res.status(400).json(body.error.flatten());
await createOrder(body.data);
```

## Lying type guard

```ts
// ❌ Returns true for any object with a `type` key.
function isPayment(x: unknown): x is Payment { return typeof x === 'object' && x !== null && 'type' in x; }

// ✅ Use a schema: PaymentSchema.safeParse(x).success
```

## `as` vs `satisfies`

```ts
// ❌ Compiles with 'refunded' missing; LABELS[status] is undefined at runtime.
const LABELS = { pending: 'Pending', paid: 'Paid' } as Record<Status, string>;

// ✅ A missing or misspelled key is a compile error, and the literal values are kept.
const LABELS = { pending: 'Pending', paid: 'Paid', refunded: 'Refunded' } satisfies Record<Status, string>;
```

## Exhaustive switch

```ts
// ❌ Adding 'refunded' to Status compiles and renders nothing.
switch (order.status) {
  case 'pending': return <Pending />;
  case 'paid': return <Paid />;
}

// ✅
switch (order.status) {
  case 'pending': return <Pending />;
  case 'paid': return <Paid />;
  default: { const _exhaustive: never = order.status; return _exhaustive; }
}
```

## Index access and `Object.keys`

```ts
// ❌ prices[sku] is undefined for an unknown SKU; total becomes NaN.
const total = items.reduce((s, i) => s + prices[i.sku] * i.qty, 0);
// ✅
const total = items.reduce((s, i) => {
  const price = prices[i.sku];
  if (price === undefined) throw new Error(`Unknown SKU ${i.sku}`);
  return s + price * i.qty;
}, 0);
```

```ts
// ❌ `row` came from JSON with extra columns: the cast hides keys the code never expected.
for (const k of Object.keys(row) as (keyof Invoice)[]) total += row[k] as number;
// ✅ Iterate the keys you own: for (const k of AMOUNT_FIELDS) total += row[k];
```

## `||` vs `??`

```ts
// ❌ A discount of 0 becomes 10.
const discount = input.discount || 10;
// ✅
const discount = input.discount ?? 10;
```

## Floating promises and async callbacks

```ts
// ❌ Not awaited: approve() resolves before the write lands, and a failed write is an unhandled rejection.
async function approve(id: OrderId) { db.order.update(id, { approved: true }); notify(id); }

// ❌ forEach ignores the returned promises; "done" is logged before any charge settles.
invoices.forEach(async inv => { await charge(inv); });
console.log('done');

// ✅
await Promise.all(invoices.map(inv => charge(inv)));
```

## catch variables

```ts
// ❌ e is unknown (useUnknownInCatchVariables); e.message may not exist.
catch (e: any) { log(e.message); }
// ✅
catch (e) { log(e instanceof Error ? e.message : String(e)); }
```

## Optional-field soup → discriminated union

```ts
// ❌ Compiles: { status: 'error' } with no error, or data and error both set.
type Load<T> = { status: 'idle' | 'loading' | 'success' | 'error'; data?: T; error?: Error };

// ✅ Each state carries exactly its fields; `data` exists only after narrowing.
type Load<T> =
  | { status: 'idle' } | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error };
```

## Branded ids and factories

```ts
// ❌ Arguments swapped: compiles, and money moves the wrong way.
transfer(order.customerId, merchant.id, 1999);

// ✅ Brands make the two ids incompatible; the factory is the only way to get a Cents.
type CustomerId = string & { readonly __brand: 'CustomerId' };
type Cents = number & { readonly __brand: 'Cents' };
function cents(n: number): Cents {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`Invalid amount ${n}`);
  return n as Cents;
}
```

## `Partial<T>` in the domain

```ts
// ❌ Every caller can pass a half-built order; the `!`s move the crash downstream.
function placeOrder(o: Partial<Order>) { return charge(o.customerId!, o.total!); }

// ✅ Validate at the edge, then the domain takes the complete type.
const order = OrderSchema.parse(formState);
placeOrder(order);
```

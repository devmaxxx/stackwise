# TypeScript

## Checklist

- [ ] No new `any` (explicit or via untyped `JSON.parse`, `catch (e)`, untyped libraries) on values that flow into logic.
- [ ] No `as` cast that asserts a shape the compiler cannot see (`res.json() as User`, `{} as Config`); `as unknown as T` is always a finding unless justified.
- [ ] No non-null `!` hiding a value that can be undefined (map lookups, `find`, optional props, `document.getElementById`).
- [ ] Data crossing a trust boundary (HTTP body, query, env, `localStorage`, `postMessage`, third-party API response) is validated at runtime (zod/valibot/schema) before use.
- [ ] Narrowing uses a discriminant or a real type guard; a user-defined guard (`x is Foo`) actually checks what it claims.
- [ ] `switch` over a union is exhaustive (`default` assigns to `never`) so a new member fails the build.
- [ ] With `noUncheckedIndexedAccess`, `arr[i]` / `record[key]` are handled as possibly `undefined`; without it, check indexes from input by hand.
- [ ] Optional chaining does not silently turn a required value into `undefined` that is then sent or stored.
- [ ] `==` vs `===`; `||` vs `??` where `0`, `''` or `false` are valid values.
- [ ] Numbers from strings: `parseInt` with radix, `Number()` result checked for `NaN`.
- [ ] Dates: `new Date(string)` parsing of non-ISO formats; timezone assumptions.
- [ ] `tsconfig` changes do not loosen `strict`, `strictNullChecks`, or add `skipLibCheck` to hide real errors.
- [ ] `// @ts-ignore` / `@ts-expect-error` additions have a reason.
- [ ] Enums: string unions or `as const` objects preferred; numeric enums used as wire values are fragile (see cross-stack-contract.md).

## Casts instead of validation

```ts
// ❌ If the API returns { data: [...] } or an error object, this crashes later, far away.
const users = (await res.json()) as User[];

// ✅
const UserSchema = z.object({ id: z.string(), email: z.string().email(), name: z.string().nullable() });
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

## Index access

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

## `||` vs `??`

```ts
// ❌ A discount of 0 becomes 10.
const discount = input.discount || 10;
// ✅
const discount = input.discount ?? 10;
```

## catch variables

```ts
// ❌ e is unknown (useUnknownInCatchVariables); e.message may not exist.
catch (e: any) { log(e.message); }
// ✅
catch (e) { log(e instanceof Error ? e.message : String(e)); }
```

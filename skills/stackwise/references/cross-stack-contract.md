# Cross-stack contract: C# DTOs vs TypeScript clients

The wire format is the contract, not the C# type and not the TS type. For every DTO
the diff changes, write down what the JSON looks like and compare both sides to it.

## Checklist

- [ ] **Nullability**: a C# `string?`/`int?` or a property that can be omitted is `T | null` (or optional) in TS; a non-nullable C# reference type that is actually null at runtime (NRT is compile-time only) still reaches the client as `null`.
- [ ] **Required vs optional**: C# `required`/`[Required]` on requests matches TS required fields; a new required request field breaks existing clients.
- [ ] **Enums**: C# enums serialize as integers by default; with `JsonStringEnumConverter` as strings. The TS type matches what is configured (`0 | 1 | 2` vs `'Pending' | 'Paid'`). Reordering or inserting a member in an int-serialized enum silently changes meaning.
- [ ] **Casing**: System.Text.Json in ASP.NET Core defaults to camelCase; a custom `JsonSerializerOptions`, `[JsonPropertyName]`, or Newtonsoft settings change it. Dictionary keys are not camel-cased by default.
- [ ] **Dates**: `DateTime` with `Kind=Unspecified` serializes without an offset and the browser parses it as local time; prefer `DateTimeOffset` or UTC with `Z`. `DateOnly`/`TimeOnly` arrive as strings (`"2026-10-21"`), and `new Date("2026-10-21")` is UTC midnight — one day off west of UTC.
- [ ] **Numbers**: C# `decimal` and `long` exceed JS `number` precision (above 2^53 or many decimal places); money and ids of that size travel as strings. TS uses `string` for them, not `number`.
- [ ] **Guids** are strings in TS; casing of hex digits is not relied on.
- [ ] **Pagination shape** matches the sibling endpoints and the client helper (`items/total/page/pageSize` vs `data/nextCursor`); `total` semantics agree.
- [ ] **Errors**: the client parses the error shape the server sends (ProblemDetails `title/status/detail/errors` vs a custom envelope); validation errors map to form fields by the same key casing.
- [ ] **Breaking changes**: renaming or removing a response field, changing a type, narrowing an accepted value, or changing a status code is breaking for deployed clients (mobile, other services, cached SPA bundles). It needs a new version, a deprecation period, or an expand-then-contract rollout.
- [ ] **Versioning**: route or header version bumps are applied to the new behaviour only; old version keeps working.
- [ ] **Generated clients** (OpenAPI → NSwag, orval, openapi-typescript, Kiota): the spec and the generated files were regenerated in the same PR as the C# change; a hand edit to a generated file is overwritten next time.
- [ ] **Polymorphism**: `[JsonDerivedType]` discriminators match a TS discriminated union's tag values.
- [ ] **Empty collections vs null**: the server returns `[]` where the client does `.map` without a null check.

## Snippets

```csharp
// ❌ Server: int enum, reordered in this PR — every stored "Shipped" (2) now reads as "Cancelled".
public enum OrderStatus { Pending, Paid, Cancelled, Shipped }
```
```ts
// TS client still has: type OrderStatus = 0 | 1 | 2 | 3 with 2 = Shipped
```
```csharp
// ✅ Append new members, or serialize as strings everywhere.
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
```

```csharp
// ❌ Unspecified kind: "2026-10-21T09:00:00" — the browser shows 09:00 in its own zone.
public DateTime StartsAt { get; init; }
// ✅
public DateTimeOffset StartsAt { get; init; }   // "2026-10-21T09:00:00+00:00"
```

```csharp
// ❌ 12345678901234567 becomes 12345678901234568 in JS.
public long ExternalId { get; init; }
// ✅
[JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)]
public long ExternalId { get; init; }
```
```ts
externalId: string;
```

```ts
// ❌ C# changed `string MiddleName` to `string? MiddleName`; TS still says string.
type User = { middleName: string };
user.middleName.toUpperCase();   // TypeError for users without one
// ✅
type User = { middleName: string | null };
```

```diff
# ❌ Response DTO renamed a field; the generated client was not regenerated.
- public string FullName { get; init; }
+ public string DisplayName { get; init; }
  src/client/api.gen.ts  (unchanged, still reads fullName)
```
Fix: regenerate the client in this PR, and either keep `FullName` for a release or version the endpoint.

# C# / .NET

Language checks for any changed `.cs` file. Framework items live in aspnetcore.md and
efcore.md; swallowed exceptions and fallbacks that hide errors are in error-handling.md.

## Checklist

### Async and cancellation
- [ ] No `.Result`, `.Wait()`, `.GetAwaiter().GetResult()` on a request or UI path. Do not flag `.Result` on a task already awaited (after `await Task.WhenAll`).
- [ ] No `async void` outside event handlers, and no async lambda where an `Action` is expected (`Parallel.ForEach(x, async ...)`, `list.ForEach(async ...)`, timer callbacks).
- [ ] A `ValueTask` is awaited exactly once; a task returned without `await` from inside `using`/`try` escapes that scope before it finishes.
- [ ] `CancellationToken` is accepted and forwarded to every awaited I/O call, not replaced by `CancellationToken.None`/`default`; async iterators mark it `[EnumeratorCancellation]`.
- [ ] Fire-and-forget (`_ = DoAsync()`, unawaited `Task.Run`) has an owner that logs failures and a scope that outlives the request.
- [ ] Fan-out over input-sized collections is bounded (`Parallel.ForEachAsync` with `MaxDegreeOfParallelism`, `SemaphoreSlim`), not `Task.WhenAll(ids.Select(CallAsync))`.
- [ ] `ContinueWith` chains become `await`: `ContinueWith` also runs on faulted tasks, and `t.Result` there throws `AggregateException`.
- [ ] Do not flag a missing `ConfigureAwait(false)` in ASP.NET Core app code (no `SynchronizationContext`); it matters in libraries that may run under one.

### Shared state and concurrency
- [ ] Fields of singletons, statics and cached objects written per request are thread-safe: a plain `Dictionary`/`List`/`HashSet` written from two threads corrupts itself.
- [ ] Results gathered inside `Parallel.ForEachAsync` or `Task.WhenAll` lambdas are returned or go to a concurrent collection, not `list.Add` on a shared `List<T>`.
- [ ] `SemaphoreSlim` as an async lock: `WaitAsync` before the `try`, `Release` in `finally`. A release after a cancelled wait breaks mutual exclusion.
- [ ] `ConcurrentDictionary.GetOrAdd(key, factory)` may run the factory twice; factories with side effects (inserts, paid calls) need `Lazy<T>` values.
- [ ] A cached `Task` or `Lazy<T>` that faults is evicted; otherwise every later caller gets the same exception until restart.
- [ ] Check-then-act on shared state (`if (!d.ContainsKey(k)) d[k] = v`, `if (stock >= n) stock -= n`) is atomic: `TryAdd`, `Interlocked`, a lock, or the database.
- [ ] No `lock` on `this`, a `Type` or a string; no `await` inside a region guarded by `Monitor.Enter`.

### Nullability
- [ ] No new `!` that hides a real null: `FirstOrDefault(...)!`, `Deserialize<T>(json)!` (the JSON literal `null` returns null), `return null!`, `default!`.
- [ ] A `?.` added to silence a warning does not skip a call that must run (`_audit?.Record(x)`, `order?.Submit()`).
- [ ] Runtime guards stay: removing `ArgumentNullException.ThrowIfNull` because the parameter "is non-nullable" is a bug; NRT is compile-time only.
- [ ] `#nullable disable` or `#pragma warning disable CS86xx` is not added to dodge warnings; a `disable` pragma has its `restore`.
- [ ] Turning NRT on (`<Nullable>enable</Nullable>`) for entities or DTOs changes EF column nullability and request validation; see efcore.md and aspnetcore.md.

### Type design
- [ ] Domain types enforce invariants at construction (constructor or factory validates); no public setter on state that must stay consistent (`Status`, `Balance`, `Total`).
- [ ] Illegal states are unrepresentable: one status enum or a closed set of records, not two booleans that can both be true (`IsPaid && IsCancelled`).
- [ ] Mutable collections are not exposed (`public List<Line> Lines { get; set; }`, returning the backing list); expose `IReadOnlyList<T>` and mutate through methods.
- [ ] Ids and amounts that are easy to swap get distinct types where the diff adds the risk (`Transfer(Guid from, Guid to)`, an amount without its currency).
- [ ] Value objects validate on every path: `record with { X = bad }` and `default(SomeStruct)` skip constructor checks; validate in the `init` accessor.
- [ ] No `implicit operator` on value objects; it lets a raw `Guid` pass as any id type.
- [ ] Request/DTO members that must be set are `required` or constructor parameters; an unset non-nullable `string` property is `null` at runtime.
- [ ] Structs are `readonly`; a mutating method called through a `readonly` field or an `in` parameter changes a defensive copy and the write is lost.
- [ ] Reflection mappers (AutoMapper, Mapster) leave unmatched members at `default` after a rename unless the configuration is asserted valid or the map is explicit.

### Disposal and resources
- [ ] `IDisposable`/`IAsyncDisposable` values are disposed; `await using` for async-disposable types. A type that owns a disposable field is disposable itself.
- [ ] Wrapping a stream the method does not own (`new StreamReader(stream)` in a `using`) passes `leaveOpen: true`.
- [ ] `CancellationTokenSource`s, especially `CreateLinkedTokenSource` over a long-lived token, and timers are disposed.

### Exceptions (detail in error-handling.md)
- [ ] `throw;` not `throw ex;`; a wrapping exception keeps the original as `innerException`.
- [ ] No empty `catch`, and no `catch (Exception)` that returns a default, carries on with a write, or ends in "allow".
- [ ] `catch (Exception)` around awaited work lets `OperationCanceledException` through; a client disconnect is not an error.
- [ ] Exceptions are not the expected path where they mask others (`FirstAsync` + `catch (InvalidOperationException)` as "not found").

### LINQ and collections
- [ ] A deferred `IEnumerable<T>` (a query or `yield`) is not enumerated twice (`Any()` then `foreach`).
- [ ] `Select`/`Where` lambdas have no side effects (logging, mutation, I/O): on a deferred sequence they run zero or several times.
- [ ] `First()`/`Single()` only where an empty or duplicate result is impossible; `Single` over data with no unique constraint throws in production.
- [ ] Records with collection members compare those members by reference; flag only when equality is relied on (keys, `Distinct`, change detection, tests).

### Public API and wire format
- [ ] Adding an optional parameter to a public method of a shipped library breaks callers compiled against the old version (`MissingMethodException`); add an overload.
- [ ] Persisted or sent enums keep their numbers: a member inserted mid-list renumbers every value stored as an int; append or set explicit values.
- [ ] Renamed or retyped members of serialized types (messages, cache entries, stored JSON) still read old payloads; Newtonsoft `$type` (`TypeNameHandling`) ties the wire to CLR type names.
- [ ] Newtonsoft `TypeNameHandling` other than `None` on untrusted input is remote code execution; polymorphism goes through `[JsonDerivedType]` discriminators.

### Time, culture, numbers
- [ ] No `DateTime.Now` in server logic; `DateTimeOffset.UtcNow` or an injected `TimeProvider` keeps schedules and tests deterministic.
- [ ] Keys, roles, headers and extensions compare ordinally (`StringComparison.OrdinalIgnoreCase`); `ToUpper() ==` and `StartsWith("x")` are culture-sensitive.
- [ ] Machine formats parse and print with `CultureInfo.InvariantCulture` (`decimal.Parse`, `ToString("0.00")`, `DateTime.Parse`).
- [ ] Money is `decimal` and rounding names its `MidpointRounding`; counters and quantities from input are range-checked or `checked`.
- [ ] Regex over user input has a timeout or `RegexOptions.NonBacktracking`; .NET regexes have no default timeout.

### Only on a hot path or large data
- [ ] `new JsonSerializerOptions(...)` per call rebuilds its metadata cache every time → one static instance.
- [ ] `new Regex(...)` per call → a static instance or `[GeneratedRegex]`; string `+=` in a loop → `StringBuilder`; `Count() > 0` on a lazy sequence → `Any()`.
- [ ] `stackalloc` inside a loop is a crash anywhere (uncatchable stack overflow), not a perf nit.
- [ ] `ArrayPool` buffers are returned exactly once and never touched after `Return`.
- [ ] LINQ, boxing and closure allocations matter only on a profiled hot path; do not flag them elsewhere.

## Sync over async

```csharp
// ❌ Blocks a thread-pool thread per request; deadlocks under a sync context.
public IActionResult Get(int id) => Ok(_service.GetAsync(id).Result);

// ✅
public async Task<IActionResult> Get(int id, CancellationToken ct) => Ok(await _service.GetAsync(id, ct));
```

Breaks when: traffic spikes and the pool starves; every request waits on the pool injection rate.

## async void and async lambdas

```csharp
// ❌ An exception here tears down the process; callers cannot await it.
public async void Handle(OrderPlaced e) => await _mailer.SendAsync(e.Email);

// ❌ Each lambda is async void: ForEach returns before any upload ends.
Parallel.ForEach(files, async f => await _blob.UploadAsync(f, ct));

// ✅ Awaited and bounded.
await Parallel.ForEachAsync(files, new ParallelOptions { MaxDegreeOfParallelism = 8, CancellationToken = ct },
    async (f, token) => await _blob.UploadAsync(f, token));
```

Unbounded `Task.WhenAll(ids.Select(FetchAsync))` breaks when 5,000 ids hit a rate-limited API or the connection pool.

## SemaphoreSlim as a lock

```csharp
// ❌ A cancelled WaitAsync still reaches Release: a second caller gets in, or SemaphoreFullException hides the cancellation.
try { await _gate.WaitAsync(ct); await RefreshAsync(ct); } finally { _gate.Release(); }

// ✅
await _gate.WaitAsync(ct);
try { await RefreshAsync(ct); } finally { _gate.Release(); }
```

## GetOrAdd and cached failures

```csharp
// ❌ Two threads missing the same key both call the paid API.
var quote = _quotes.GetOrAdd(sku, s => _pricingApi.FetchQuote(s));

// ✅ Only the stored Lazy runs, so the fetch happens once per key.
var quote = _quotes.GetOrAdd(sku, s => new Lazy<Quote>(() => _pricingApi.FetchQuote(s))).Value;
```

A faulted `Lazy<T>` or cached `Task` replays its exception to every caller. Breaks when: the
first fetch times out and that key fails until restart. Remove the entry on failure.

## Nullable reference types

```csharp
// ❌ `!` silences the compiler: FirstOrDefault returns null for an unknown id.
var user = users.FirstOrDefault(u => u.Id == id)!;

// ❌ Added to silence CS8602: when _audit is null the record is skipped and nobody knows.
_audit?.Record(change);

// ✅
var user = users.FirstOrDefault(u => u.Id == id);
if (user is null) return Results.NotFound();
```

Each new `!` needs a reason the value cannot be null; if you cannot state it, it is a finding.

## Invariants and exposed state

```csharp
// ❌ Any caller can set Paid without a payment, or add a line without updating Total.
public class Order { public OrderStatus Status { get; set; } public List<OrderLine> Lines { get; set; } = []; public decimal Total { get; set; } }

// ✅ State changes go through methods that keep the invariants.
public sealed class Order
{
    private readonly List<OrderLine> _lines = [];
    public IReadOnlyList<OrderLine> Lines => _lines;
    public decimal Total => _lines.Sum(l => l.Amount);
    public OrderStatus Status { get; private set; }
}
```

Flag when the diff adds the setter or the exposure and a caller can break the invariant.
EF Core maps private setters and backing fields, so persistence is no excuse.

## Validation that `with` skips

```csharp
// ❌ The check runs in the constructor only; `price with { Amount = -5 }` keeps -5.
public sealed record Price(decimal Amount)
{
    public decimal Amount { get; init; } = Amount >= 0 ? Amount : throw new ArgumentOutOfRangeException(nameof(Amount));
}

// ✅ `with` calls the init accessor, so validate there.
public sealed record Price
{
    private readonly decimal _amount;
    public required decimal Amount { get => _amount; init => _amount = value >= 0 ? value : throw new ArgumentOutOfRangeException(nameof(value)); }
}
```

## Disposal

```csharp
// ❌ Disposing the reader closes the caller's stream.
using var reader = new StreamReader(stream);
// ✅
using var reader = new StreamReader(stream, leaveOpen: true);

// ❌ Each call registers on the app-lifetime token and never unregisters: memory grows per request.
var cts = CancellationTokenSource.CreateLinkedTokenSource(ct, _lifetime.ApplicationStopping);
// ✅
using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct, _lifetime.ApplicationStopping);
```

## Exceptions

```csharp
// ❌ Resets the stack trace.
catch (Exception ex) { _log.LogError(ex, "x"); throw ex; }
// ✅
catch (Exception ex) { _log.LogError(ex, "x"); throw; }

// ❌ A client disconnect logs an error and returns 500 to nobody.
catch (Exception ex) { _log.LogError(ex, "Export failed"); return Results.Problem(); }
// ✅
catch (Exception ex) when (ex is not OperationCanceledException) { _log.LogError(ex, "Export failed"); return Results.Problem(); }
```

```csharp
// ❌ Also catches "a second operation was started on this context" and reports it as not found.
try { return await _db.Users.FirstAsync(u => u.Id == id, ct); } catch (InvalidOperationException) { return null; }
// ✅
return await _db.Users.FirstOrDefaultAsync(u => u.Id == id, ct);
```

## Wire format

```csharp
// ❌ Lets the payload pick any loadable type (gadget chains), and a class rename breaks stored messages.
JsonConvert.DeserializeObject<Event>(body, new JsonSerializerSettings { TypeNameHandling = TypeNameHandling.Auto });

// ✅ A closed set of discriminators that survive renames.
[JsonDerivedType(typeof(OrderPlaced), "order-placed")]
[JsonDerivedType(typeof(OrderCancelled), "order-cancelled")]
public abstract record Event;
```

## Culture and rounding

```csharp
// ❌ Under tr-TR, "admin".ToUpper() is "ADMİN" (dotted İ): the check fails.
if (role.ToUpper() == "ADMIN") ...
// ✅
if (string.Equals(role, "admin", StringComparison.OrdinalIgnoreCase)) ...

// ❌ "1.5" parses as 15 under de-DE; banker's rounding turns 2.345m into 2.34.
var rate = decimal.Parse(header);
var vat = Math.Round(net * 0.25m, 2);
// ✅
var rate = decimal.Parse(header, NumberStyles.Number, CultureInfo.InvariantCulture);
var vat = Math.Round(net * 0.25m, 2, MidpointRounding.AwayFromZero);
```

Breaks when: `UseRequestLocalization` sets the thread culture from the caller's `Accept-Language`.

## Regex on user input

```csharp
// ❌ No timeout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!" pins a core per request.
var ok = Regex.IsMatch(input, @"^(\w+\s?)*$");
// ✅ Linear time.
var ok = Regex.IsMatch(input, @"^(\w+\s?)*$", RegexOptions.NonBacktracking);
```

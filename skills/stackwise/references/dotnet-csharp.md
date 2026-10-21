# C# / .NET

## Checklist

- [ ] No `.Result`, `.Wait()`, `.GetAwaiter().GetResult()` on a request or UI path (sync-over-async).
- [ ] No `async void` outside event handlers; exceptions there crash the process.
- [ ] `async` methods return `Task`/`ValueTask`; a `ValueTask` is awaited exactly once.
- [ ] `CancellationToken` is accepted and forwarded through every awaited I/O call, not swallowed by `CancellationToken.None`.
- [ ] `ConfigureAwait(false)` in library code that may run under a sync context; not required in ASP.NET Core app code.
- [ ] Fire-and-forget (`_ = DoAsync()`, `Task.Run` without await) has an owner that logs failures and a scope that outlives the request.
- [ ] Nullable reference types: no new `!` that hides a real null; public inputs checked (`ArgumentNullException.ThrowIfNull`); `#nullable disable` not added to dodge warnings.
- [ ] `IDisposable` / `IAsyncDisposable` values are disposed (`using` / `await using`); types that own disposables implement disposal.
- [ ] `IEnumerable<T>` from a query or `yield` is not enumerated twice (`Count()` then `foreach`).
- [ ] `Any()` instead of `Count() > 0`; `First()` only where an empty sequence is impossible.
- [ ] Records: value equality is intended; a `record` with a collection property compares by reference, not content.
- [ ] Mutable structs, `static` mutable fields, or `lock` on `this`/strings in shared code.
- [ ] Exceptions: `catch (Exception)` that swallows or loses the original (`throw ex;` instead of `throw;`).
- [ ] `DateTime.Now` in server logic (use `DateTimeOffset.UtcNow` or an injected `TimeProvider`).
- [ ] Money as `decimal`, not `double`; integer overflow on counters that come from input (`checked` where it matters).

## Sync over async

```csharp
// ❌ Blocks a thread-pool thread per request; deadlocks under a sync context.
public IActionResult Get(int id) => Ok(_service.GetAsync(id).Result);

// ✅
public async Task<IActionResult> Get(int id, CancellationToken ct)
    => Ok(await _service.GetAsync(id, ct));
```

Breaks when: traffic spikes and the pool starves; every request waits on the pool injection rate.

## async void

```csharp
// ❌ An exception here tears down the process; callers cannot await it.
public async void Handle(OrderPlaced e) => await _mailer.SendAsync(e.Email);

// ✅
public async Task HandleAsync(OrderPlaced e, CancellationToken ct) => await _mailer.SendAsync(e.Email, ct);
```

## CancellationToken propagation

```csharp
// ❌ The client disconnects but the query keeps running.
public async Task<List<Report>> Build(CancellationToken ct)
    => await _db.Reports.Where(r => r.Big).ToListAsync();

// ✅
    => await _db.Reports.Where(r => r.Big).ToListAsync(ct);
```

## Fire-and-forget

```csharp
// ❌ Unobserved exception; the scoped service is disposed when the request ends.
_ = _audit.WriteAsync(entry);

// ✅ Hand it to a queue drained by a BackgroundService that creates its own scope.
await _auditQueue.EnqueueAsync(entry, ct);
```

## Nullable reference types

```csharp
// ❌ `!` silences the compiler; FirstOrDefault returns null for an unknown id.
var user = users.FirstOrDefault(u => u.Id == id)!;
return user.Email;

// ✅
var user = users.FirstOrDefault(u => u.Id == id);
if (user is null) return Results.NotFound();
return user.Email;
```

Each new `!` in the diff needs a reason the value cannot be null; if you cannot state it, it is a finding.

## Disposal

```csharp
// ❌ Leaks a file handle per call.
var stream = File.OpenRead(path);
return await JsonSerializer.DeserializeAsync<Config>(stream, cancellationToken: ct);

// ✅
await using var stream = File.OpenRead(path);
return await JsonSerializer.DeserializeAsync<Config>(stream, cancellationToken: ct);
```

`new HttpClient()` per call is a disposal bug of a different kind; see aspnetcore.md.

## Multiple enumeration

```csharp
// ❌ Two database round trips (or two runs of an expensive iterator).
IEnumerable<Order> orders = _repo.Query(filter);
if (!orders.Any()) return [];
foreach (var o in orders) { ... }

// ✅ Materialize once.
var orders = await _repo.Query(filter).ToListAsync(ct);
```

## Records and equality

```csharp
// ❌ Two carts with the same items are "different": List<T> compares by reference.
public record Cart(string UserId, List<Item> Items);

// ✅ Override equality deliberately. ImmutableArray<T> and IReadOnlyList<T> do not fix
//    this on their own: they compare by reference too.
public record Cart(string UserId, IReadOnlyList<Item> Items)
{
    public virtual bool Equals(Cart? other) =>
        other is not null && UserId == other.UserId && Items.SequenceEqual(other.Items);
    public override int GetHashCode() => HashCode.Combine(UserId, Items.Count);
}
```

Flag only when the code relies on equality (dictionary keys, `Distinct`, change detection, test assertions).

## Exceptions

```csharp
// ❌ Resets the stack trace.
catch (Exception ex) { _log.LogError(ex, "x"); throw ex; }

// ✅
catch (Exception ex) { _log.LogError(ex, "x"); throw; }
```

```csharp
// ❌ Hides every failure, including bugs.
try { await Sync(ct); } catch { }

// ✅ Catch what you expect; let the rest reach the global handler.
try { await Sync(ct); } catch (HttpRequestException ex) { _log.LogWarning(ex, "Sync skipped"); }
```

# Error handling and silent failures

A silent failure turns an error into a wrong result that nobody sees. For each candidate, name
the error that gets hidden and what the caller or user gets instead: that pair is the breaking input.

## Checklist

### Swallowed errors
- [ ] Empty or comment-only catch: `catch { }`, `catch (Exception) { }`, `.catch(() => {})`, `catch (_) {}`, `onError: () => {}`.
- [ ] Catch, log, carry on where the caller needs to know: the function logs, then returns `null`, `[]`, `false` or a default, and the caller treats that as success.
- [ ] Broad catch around more than the expected failure: `catch (Exception)` / `catch (e)` over code that can also throw a bug (`NullReferenceException`, `TypeError`). Name the bug it would hide.
- [ ] Fallbacks that mask a failure: `?? []`, `|| 0`, `?? new Config()`, the default after a failed `TryParse`, `Number(x) || 0`, a `JSON.parse` wrapper that returns `{}`.
- [ ] Optional chaining that skips required work: `order?.payment?.capture()` yields `undefined` and the flow continues as if it ran.
- [ ] Unobserved async work: a floating promise, `void doWork()`, `_ = DoAsync()`, `forEach(async …)` (see nodejs.md, dotnet-csharp.md).
- [ ] HTTP status unchecked: `fetch` resolves on 404/500 (`res.ok` never read); `HttpClient` content read without `EnsureSuccessStatusCode()`; axios `validateStatus: () => true`.
- [ ] Outcome ignored: `Promise.allSettled` results never checked for `rejected`; `TryAdd`/`TryUpdate` return dropped; a `Result`/`OneOf`/`ErrorOr` discarded; rows affected unchecked (`ExecuteUpdateAsync` → 0, `rowCount` 0, Mongo `matchedCount` 0).
- [ ] A JS `finally` that `return`s or `throw`s, replacing the original exception (C# forbids `return` in `finally`).

### Lost information
- [ ] Stack or cause dropped: C# `throw ex;` or a new exception without the inner one; JS `throw new Error('failed')` in a catch without `{ cause: err }`.
- [ ] Errors logged as nothing: `JSON.stringify(err)` prints `{}` (Error fields are not enumerable); `err.message` only; `$"{ex.Message}"` instead of passing `ex` to the logger.
- [ ] Log-and-rethrow at every layer (one failure, five error lines), or the one log that matters has no id or operation name.
- [ ] Wrong level: an expected outcome (404, validation failure, cancelled request) logged as Error, or a real failure logged at Debug/Info, where no alert sees it.
- [ ] Wrong status: every exception mapped to 400 or 404 (a database outage shows as "not found"), a 200 with `{ error }` in the body, validation failures returned as 500.

### Fail-open
- [ ] A catch or fallback on an auth, permission, signature, validation, rate-limit or entitlement path that ends in "allow" (`catch { return true; }`, `catch { next(); }`).
- [ ] A failing security dependency (policy service, feature-flag client, token introspection) treated as "no restriction". It should deny, or fail with 503.

### Retries, timeouts and background work
- [ ] Retries have a cap and backoff with jitter, and retry only transient failures (timeouts, 429, 503), never 400, 401 or validation errors.
- [ ] A retried operation that is not idempotent (charge, email, insert) carries an idempotency key. `AddStandardResilienceHandler()` retries POST too unless `Retry.DisableForUnsafeHttpMethods()` is set.
- [ ] Exhausted retries end in an error the caller sees, not a `return null` or a log line.
- [ ] Queue consumers do not ack a message whose handler failed unless it is dead-lettered or stored; loops in a `BackgroundService` catch per iteration.
- [ ] Timeouts cancel the work they give up on: `Promise.race` leaves the loser running, so pass an `AbortSignal` or `CancellationToken`.

### UI (React)
- [ ] The error state renders: the query's `isError`/`error` is used, and a failed load does not show the empty state ("No orders yet").
- [ ] Error boundaries and `error.tsx` render a fallback and report the error; one that returns `null` blanks the page silently.
- [ ] Async event handlers catch their own errors (error boundaries never see them) and reset `loading` in `finally`.
- [ ] Mutations surface failure (`onError`, rollback), and a success toast fires only after the request succeeds.

### Do not flag
- A catch that rethrows, wraps with the cause, or maps to a typed error or HTTP status at a boundary.
- The global handler (exception middleware, Express error middleware, Nest exception filter) logging and returning 500/ProblemDetails. That is the design.
- Best-effort side work (metrics, cache warm-up, analytics) that logs a warning and continues, when no caller depends on its result.
- Cancellation: `catch (OperationCanceledException) when (ct.IsCancellationRequested)`, and an ignored `AbortError` in effect cleanup.
- A documented business default (`TryParse` → 0 where the spec says so).

## Catch, log, carry on

```csharp
// ❌ A gateway timeout is logged, then the caller marks the order paid.
public async Task<bool> ChargeAsync(Order order, CancellationToken ct)
{
    try { await _gateway.ChargeAsync(order.Total, order.CardToken, ct); }
    catch (Exception ex) { _log.LogError(ex, "Charge failed for {OrderId}", order.Id); }
    return true;
}

// ✅ Let it propagate, or return a result type the caller has to branch on.
```

Breaks when: the gateway times out; the order ships unpaid.

## Broad catch hides a bug

```ts
// ❌ A TypeError from a renamed field is reported as "Invalid coupon".
try { discount = computeDiscount(cart, coupon); }
catch { return res.status(400).json({ error: 'Invalid coupon' }); }

// ✅ Catch the error you expect and rethrow the rest.
catch (err) {
  if (err instanceof CouponError) return res.status(400).json({ error: err.message });
  throw err;
}
```

## Fallback that hides a failure

```ts
// ❌ A failed settings load becomes "all notifications off".
const prefs = (await loadPrefs(userId).catch(() => null)) ?? { email: false, sms: false };

// ✅ Tell "no row" apart from "could not load".
const prefs = (await loadPrefs(userId)) ?? DEFAULT_PREFS; // loadPrefs throws on I/O errors
```

## Status not checked

```ts
// ❌ A 404 JSON body is rendered as an order; a 502 HTML page throws in r.json() far away.
const order = await fetch(`/api/orders/${id}`).then((r) => r.json());

// ✅
const r = await fetch(`/api/orders/${id}`);
if (!r.ok) throw new HttpError(r.status, await r.text());
const order = OrderSchema.parse(await r.json());
```

```csharp
// ❌ A 401 ProblemDetails body deserializes into a Rate whose Value is 0.
var res = await _http.GetAsync(url, ct);
var rate = await res.Content.ReadFromJsonAsync<Rate>(ct);

// ✅ GetFromJsonAsync checks the status; otherwise call res.EnsureSuccessStatusCode() first.
var rate = await _http.GetFromJsonAsync<Rate>(url, ct);
```

## Rows affected ignored

```csharp
// ❌ A stale version or an unknown id changes 0 rows, and the API still returns 204.
await _db.Tickets.Where(t => t.Id == id && t.Version == version)
    .ExecuteUpdateAsync(s => s.SetProperty(t => t.Status, status), ct);
return Results.NoContent();

// ✅
var changed = await _db.Tickets.Where(t => t.Id == id && t.Version == version)
    .ExecuteUpdateAsync(s => s.SetProperty(t => t.Status, status), ct);
return changed == 1 ? Results.NoContent() : Results.Conflict();
```

## Lost cause

```ts
// ❌ The log says "{}" and the original stack is gone.
catch (err) {
  logger.error(`sync failed ${JSON.stringify(err)}`);
  throw new Error('Sync failed');
}

// ✅
catch (err) {
  throw new SyncError(`Sync failed for tenant ${tenantId}`, { cause: err });
}
```

## Fail-open on an auth path

```ts
// ❌ When the policy service is down, every request is allowed.
async function requirePermission(req, res, next) {
  try {
    if (!(await policy.allows(req.user, req.params.id))) return res.sendStatus(403);
  } catch (err) {
    logger.warn({ err }, 'policy check failed');
  }
  next();
}

// ✅ The catch denies: `catch (err) { return next(err); }`, so the error middleware answers 503.
```

## Retries

```ts
// ❌ Retries a 400 forever; a timeout after the charge succeeded charges twice.
for (;;) {
  try { return await payments.charge(params); } catch { await sleep(1000); }
}

// ✅ Cap, back off with jitter, retry only transient errors, and send an idempotency key.
return withRetry(() => payments.charge(params, { idempotencyKey: order.id }),
  { attempts: 3, baseMs: 200, jitter: true, retryIf: isTransient });
```

## Background work that drops failures

```ts
// ❌ A failed message is acknowledged and lost.
channel.consume(QUEUE, async (msg) => {
  try { await handle(parse(msg)); } catch (err) { logger.error({ err }, 'handler failed'); }
  channel.ack(msg);
});

// ✅ Ack on success; on failure, nack without requeue so the dead-letter queue keeps it.
try { await handle(parse(msg)); channel.ack(msg); }
catch (err) { logger.error({ err }, 'handler failed'); channel.nack(msg, false, false); }
```

```csharp
// ❌ One bad batch ends the loop. Since .NET 6 the host stops too; with
//    BackgroundServiceExceptionBehavior.Ignore the worker just dies quietly.
protected override async Task ExecuteAsync(CancellationToken ct)
{
    while (!ct.IsCancellationRequested) { await ProcessBatchAsync(ct); await Task.Delay(5_000, ct); }
}

// ✅ try/catch inside the loop body, logging with the batch id, then continue.
```

## Error shown as empty

```tsx
// ❌ A 500 renders "No orders yet".
const { data = [] } = useQuery({ queryKey: ['orders', customerId], queryFn: fetchOrders });
return data.length === 0 ? <EmptyState /> : <OrderList orders={data} />;

// ✅
const { data, isPending, isError, refetch } = useQuery({ queryKey: ['orders', customerId], queryFn: fetchOrders });
if (isPending) return <Spinner />;
if (isError) return <ErrorState onRetry={refetch} />;
```

```tsx
// ❌ A rejected save leaves the button disabled for good, and the rejection is unhandled.
async function onSave() { setSaving(true); await api.save(form); setSaving(false); }

// ✅
async function onSave() {
  setSaving(true);
  try { await api.save(form); toast.success('Saved'); }
  catch (err) { setError(toMessage(err)); }
  finally { setSaving(false); }
}
```

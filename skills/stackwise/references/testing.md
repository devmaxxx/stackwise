# Testing

A test is worth having when it fails for the bug it names and passes for the fix.

Grading: a test that cannot fail, or fails for the wrong reason, is a finding on the test.
A missing test is a **should** only when sibling code of the same kind is tested in this
repo; otherwise, or when no test tree is in view (a bare diff), it goes under Notes. A
missing test is never a **must** on its own.

## Checklist

### Coverage of the change
- [ ] Every changed behaviour (new `if`, guard, validation rule, error path, status code, boundary, state transition, access rule) has a test that goes red when it is reverted. Map them with the procedure below.
- [ ] A bug-fix PR has a regression test that reproduces the bug: red on the base commit, green on the head.
- [ ] Validation or authorization code changed but its tests did not. Cue: the production file is in the diff, its `*.test.*` / `*Tests.cs` is not. Old tests can stay green against a new rule; read what they assert.
- [ ] Error paths are tested, not only the happy path: a dependency that rejects, an empty result, a 4xx input. Cue: every new test uses valid input.
- [ ] Boundaries are pinned at the edge: for `count >= limit`, cases at `limit - 1` and `limit`. Cue: tests use only far-away values.
- [ ] Deleted, skipped or loosened tests (`.skip`, `xit`, `[Fact(Skip=...)]`, `[Ignore]`, a removed assertion, an expected value edited to match new output) are explained. An expectation changed to match the code must match the intended behaviour.

### Assertions
- [ ] The test asserts something: no assertion-free tests, no commented-out `expect` / `Assert`.
- [ ] Assertions pin a value a caller relies on (returned value, HTTP status and body, persisted row, rendered text). `Assert.NotNull(x)`, `Assert.True(x != null)`, `toBeDefined()` (which `null` passes) or `toBeTruthy()` alone pass for wrong values. Name one wrong value that would still pass.
- [ ] Expected values are written out, not recomputed with the code's formula (tautology) or taken from the actual value (`Assert.Equal(dto.Name, dto.Name)`, a round trip through an identity).
- [ ] Transformation tests use input that needs transforming. A `normalizeEmail` test fed an already-lowercase address passes for a no-op.
- [ ] Exception assertions name the type, plus the message or `ParamName` where it matters. `ThrowsAnyAsync<Exception>` or a bare `toThrow()` also passes for a `TypeError` from a typo.
- [ ] No assertion that can be skipped: inside `catch`, inside `if`, inside `forEach` over a possibly empty array, inside a `.then` that is not returned or awaited.
- [ ] Async assertions are awaited or returned: `expect(p).rejects...` or `Assert.ThrowsAsync(...)` without `await` finishes after the test does.
- [ ] Negative cases assert absence. An "other tenant cannot see it" test checks that the row is absent, not just that the status is 200.

### Mocks and doubles
- [ ] Mocks stand in for boundaries (network, clock, queue, third-party SDK), not for the unit under test or a type the test owns. A test that mocks the repository and asserts the mock was called proves nothing about the query.
- [ ] The test does not mock what it claims to test. Cue: `vi.spyOn(sut, 'method').mockReturnValue(...)` followed by `expect(sut.method())`.
- [ ] `Verify` / `toHaveBeenCalledWith` appears only where the call is the contract (an email sent, an event published). Otherwise assert the outcome.
- [ ] Mock setups are reachable. A setup for a call after the guard the test triggers is dead: the test is not exercising what its name says.
- [ ] Deleting the feature would fail the test. If the code under test returned `default`, would a test go red? Not if every dependency is mocked to return the expected value.

### Determinism and isolation
- [ ] No sleeps for synchronization: `Thread.Sleep`, `Task.Delay`, `setTimeout` in a test, Playwright `waitForTimeout`. Use fake timers, `findBy*` / `waitFor`, or await the signal.
- [ ] Time, randomness and ids are injected (`TimeProvider` + `FakeTimeProvider`, `vi.setSystemTime`, seeded generators). A test that reads `DateTime.Now` or `new Date()` fails near midnight, month-end or a DST switch.
- [ ] No time-zone or locale dependence: `toLocaleString()` in an expected value, a date-only string parsed as local time. Pin `TZ=UTC` and the locale in the test setup.
- [ ] Tests are isolated: no shared mutable static or module state, no fixture mutated by one test and read by another, no leftover DB rows. Each test passes alone and in random order.
- [ ] No conditional logic or loops computing expected values in a test. A branch means one case goes untested.
- [ ] No focused tests committed: `.only`, `fit`, `fdescribe`. CI then runs one test and reports green.
- [ ] Flaky-test signals in the diff: retries added (`retry: 3`, `jest.retryTimes`, NUnit `[Retry]`), widened timeouts, Jest `--forceExit` (hides open handles). Each one hides a race; ask for the cause.

### Data and infrastructure
- [ ] EF Core query behaviour is tested against a real provider (Testcontainers with the production engine, or SQLite in-memory as a compromise), not `UseInMemoryDatabase`, which ignores relational semantics, constraints, transactions and raw SQL.
- [ ] A migration that moves or reshapes data has a test that applies it to a database seeded with old-shape rows.
- [ ] Database state is reset between tests (transaction rollback, Respawn, a schema per test), not by test order.
- [ ] Snapshots are small and intentional. Volatile fields (timestamps, generated ids, ports) are scrubbed. A large snapshot update in the diff was reviewed, not just accepted. Verify's `*.received.*` files are not committed.

### Endpoints, auth and contracts
- [ ] Endpoint changes are tested through the HTTP pipeline (`WebApplicationFactory<Program>`, `supertest`, Fastify `app.inject`, Nest `createNestApplication`), so middleware, auth, binding and serialization are covered.
- [ ] A new protected endpoint has auth tests: anonymous gets 401, the wrong role gets 403, another tenant's id gets 404 (or 403, matching the siblings).
- [ ] The test host is configured like production: the same global `ValidationPipe`, filters, JSON options and auth scheme as `main.ts` / `Program.cs`. Without them the tests accept requests production rejects, or the reverse.
- [ ] A changed C# DTO or enum that a TS client consumes is pinned by a contract check: a committed OpenAPI document or JSON sample the test compares against, with the client regenerated from it (see cross-stack-contract.md).

### Front end and runners
- [ ] Tests query by role, label or text (`getByRole('button', { name })`), act through `userEvent`, and assert what the user sees. They do not check component state, class names or a snapshot of the whole tree.
- [ ] Async UI uses `findBy*` / `waitFor`, and a `waitFor` callback holds assertions only, never side effects (it re-runs).
- [ ] The network is faked at the boundary with MSW, not by stubbing `fetch` in each test, and unhandled requests fail the run (`onUnhandledRequest: 'error'`).
- [ ] A race or stale-data fix has a test that resolves responses out of order: hold the first response on a deferred promise, let the second render, release the first, and assert the screen still shows the second.
- [ ] New test files match the runner's include glob. A `*.spec.mts` under a folder the Vitest/Jest config skips never runs. No `async void` tests in xUnit.
- [ ] Exported generic types changed in the diff have a type-level test (`expectTypeOf`, `tsd`, or a `@ts-expect-error` case) when the repo already has them.

## Coverage map for the changed code

1. Split the changed files into production and test. Test paths include `*.test.*`, `*.spec.*`, `__tests__/`, `tests/`, `test/`, `e2e/`, `*Tests.cs`, and the `*.Tests` / `*.IntegrationTests` projects.
2. List each changed behaviour in the production files: a branch or guard, a validation rule, an error path or status code, a boundary, a state transition, an access rule.
3. For each one, find the test that goes red if it is reverted. Mutate it in your head: flip `<` to `<=`, drop one side of an `&&`, delete the guard, return the default, swallow the error. If no test notices, that is a gap.
4. Rank the gaps by what the untested behaviour protects: access control, money and data writes first, then user-visible results, then edge cases. Report the top few, one per behaviour, each phrased as "test: <input> → <expected outcome>".
5. Grade with the rule at the top of this file.

## Assertions that cannot fail

```ts
// ❌ Green when createOrder resolves: the assertion sits in a catch that never runs.
it('rejects qty 0', async () => {
  try { await createOrder({ qty: 0 }); } catch (e) { expect(e).toBeInstanceOf(ValidationError); }
});

// ✅
it('rejects qty 0', async () => {
  await expect(createOrder({ qty: 0 })).rejects.toThrow(ValidationError);
});
```

```ts
// ❌ Green for an empty list, for a no-op normalizer, and when no rows come back.
result.items.forEach((i) => expect(i.price).toBeGreaterThan(0));
expect(normalizeEmail('ann@example.com')).toBe('ann@example.com');
if (res.body.length > 0) expect(res.body[0].ownerId).toBe(user.id);

// ✅ Pin the count and the values, and give the code input it must change.
expect(result.items.map((i) => i.price)).toEqual([10, 25, 40]);
expect(normalizeEmail('  Ann@Example.COM ')).toBe('ann@example.com');
expect(res.body.map((r) => r.ownerId)).toEqual([user.id, user.id]);
```

```csharp
// ❌ ThrowsAnyAsync<Exception> passes for a NullReferenceException; NotNull passes for a wrong balance.
await Assert.ThrowsAnyAsync<Exception>(() => svc.WithdrawAsync(acct, -5m, ct));
Assert.NotNull(await svc.GetAsync(acct, ct));

// ✅
var ex = await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => svc.WithdrawAsync(acct, -5m, ct));
Assert.Equal("amount", ex.ParamName);
Assert.Equal(95.00m, (await svc.GetAsync(acct, ct)).Balance);
```

```csharp
// ❌ Tautology
Assert.Equal(price * qty * (1 - discount), calc.Total(price, qty, discount));
// ✅
Assert.Equal(90.00m, calc.Total(price: 50m, qty: 2, discount: 0.10m));
```

## Mocks

```csharp
// ❌ Proves the mock was called, not that the right orders come back.
repo.Verify(r => r.GetOrders(It.IsAny<int>()), Times.Once);

// ✅ Integration test through the API with a real database.
var res = await client.GetAsync("/api/customers/7/orders");
res.StatusCode.Should().Be(HttpStatusCode.OK);
(await res.Content.ReadFromJsonAsync<List<OrderDto>>()).Should().ContainSingle(o => o.Id == 42);
```

```ts
// ❌ The unit under test is mocked; the test checks the mock's own return value.
vi.spyOn(pricing, 'total').mockResolvedValue(90);
expect(await pricing.total(cart)).toBe(90);

// ✅ Fake the boundary (the tax API) and run the real code.
server.use(http.get('https://tax.example.test/rate', () => HttpResponse.json({ rate: 0.25 })));
expect(await pricing.total(cart)).toBe(112.5);
```

## Time and flakiness

```ts
// ❌ A sleep, the real clock and the runner's time zone: flaky on slow CI, wrong outside one zone.
await new Promise((r) => setTimeout(r, 500));
expect(formatDue(new Date())).toBe('21/10/2026');

// ✅ Fake timers, a pinned clock, and TZ=UTC in the test script.
vi.useFakeTimers();
vi.setSystemTime(new Date('2026-10-21T09:00:00Z'));
await vi.advanceTimersByTimeAsync(500);
expect(formatDue(new Date())).toBe('2026-10-21');
```

In .NET, inject `TimeProvider` and drive a `FakeTimeProvider` with `Advance(...)` instead of `Task.Delay`.

## Real database

```csharp
// ❌ InMemory provider: no SQL, no constraints. The unique index on Email never fires.
var opts = new DbContextOptionsBuilder<AppDbContext>().UseInMemoryDatabase("t").Options;

// ✅ The production engine in a container (Testcontainers.PostgreSql).
var pg = new PostgreSqlBuilder("postgres:16").Build();
await pg.StartAsync();
var opts = new DbContextOptionsBuilder<AppDbContext>().UseNpgsql(pg.GetConnectionString()).Options;
await using var db = new AppDbContext(opts);
await db.Database.MigrateAsync();
```

## Endpoints and auth

`WebApplicationFactory<Program>` plus Testcontainers covers middleware, auth and
serialization in one test, so prefer it for endpoint changes.

```csharp
// ✅ One test per access rule of a new endpoint. AsTenant is the suite's sign-in helper.
[Fact] public async Task Anonymous_gets_401() =>
    Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateClient().GetAsync("/api/invoices/42")).StatusCode);

[Fact] public async Task Other_tenant_gets_404() =>
    Assert.Equal(HttpStatusCode.NotFound, (await _factory.AsTenant("t2").GetAsync("/api/invoices/42")).StatusCode);
```

```ts
// ❌ Never fails: the assertion runs after the test ends.
it('rejects bad input', () => { api.post('/orders').send({}).then(r => expect(r.status).toBe(400)); });

// ✅
it('rejects bad input', async () => {
  const r = await request(app).post('/orders').send({});
  expect(r.status).toBe(400);
});
```

Test the error path of an Express handler: make the dependency reject and assert the
error middleware's status. That test catches a missing `next(err)`.

```ts
// ❌ The e2e app skips main.ts's global pipe, so unknown fields pass here and fail in production.
const app = moduleRef.createNestApplication();
await app.init();

// ✅ main.ts and the tests share one bootstrap.
const app = moduleRef.createNestApplication();
configureApp(app); // global ValidationPipe({ whitelist: true, ... }), filters, prefix
await app.init();
```

```csharp
// ✅ Contract check: CI fails when the API changes but the committed spec (and the TS client built from it) did not.
[Fact] public async Task OpenApi_matches_committed_spec() =>
    Assert.Equal(await File.ReadAllTextAsync("openapi.v1.json"),
                 await _factory.CreateClient().GetStringAsync("/openapi/v1.json"));
```

## React (React Testing Library)

```tsx
// ❌ Tests internals; breaks on refactor, passes on broken UI.
expect(wrapper.state('open')).toBe(true);

// ✅ Query by role, act like a user.
await user.click(screen.getByRole('button', { name: /open/i }));
expect(screen.getByRole('dialog')).toBeVisible();
```

Prefer `findBy*` for async UI, `userEvent` over `fireEvent`, and MSW over mocking `fetch` by hand.

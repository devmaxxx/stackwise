# Testing

A test is worth having when it fails for the bug it names and passes for the fix.

## Checklist

- [ ] Every changed branch of logic (new `if`, new error path, new status code, new edge case the PR fixes) has a test that would fail without the change.
- [ ] A bug-fix PR has a regression test that reproduces the bug.
- [ ] Assertions check behaviour a caller relies on (returned value, HTTP status and body, persisted row, rendered text), not implementation details (private calls, internal state, call counts on mocks that are not the contract).
- [ ] Expected values are written out, not recomputed with the same formula as the code (tautology).
- [ ] Mocks stand in for boundaries (network, clock, queue), not for the unit under test; a test that mocks the repository and asserts the mock was called proves nothing about the query.
- [ ] EF Core: query behaviour is tested against a real provider (SQLite in-memory or Testcontainers), not `UseInMemoryDatabase`, which ignores relational semantics, transactions and raw SQL.
- [ ] Time, randomness and ids are injected (`TimeProvider`, fake timers) so tests are deterministic.
- [ ] Async tests await what they start; no `async void` tests; no `setTimeout` sleeps where a `waitFor`/`findBy` fits.
- [ ] Snapshots are small and intentional; a 500-line snapshot update in the diff was reviewed, not just accepted.
- [ ] Tests are isolated: no order dependence, shared static state, or leftover DB rows.
- [ ] Deleted or skipped tests (`[Fact(Skip=...)]`, `.skip`, `xit`) are explained.

## .NET (xUnit / NUnit)

```csharp
// ❌ Proves the mock was called, not that the right orders come back.
repo.Verify(r => r.GetOrders(It.IsAny<int>()), Times.Once);

// ✅ Integration test through the API with a real database.
var res = await client.GetAsync("/api/customers/7/orders");
res.StatusCode.Should().Be(HttpStatusCode.OK);
(await res.Content.ReadFromJsonAsync<List<OrderDto>>()).Should().ContainSingle(o => o.Id == 42);
```

`WebApplicationFactory<Program>` plus Testcontainers covers middleware, auth and serialization in one test; prefer it for endpoint changes. Add an auth test for a new protected endpoint: anonymous → 401, other tenant → 403/404.

```csharp
// ❌ Tautology
Assert.Equal(price * qty * (1 - discount), calc.Total(price, qty, discount));
// ✅
Assert.Equal(90.00m, calc.Total(price: 50m, qty: 2, discount: 0.10m));
```

## Node (Vitest / Jest + supertest)

```ts
// ❌ Never fails: the assertion runs after the test ends.
it('rejects bad input', () => { api.post('/orders').send({}).then(r => expect(r.status).toBe(400)); });

// ✅
it('rejects bad input', async () => {
  const r = await request(app).post('/orders').send({});
  expect(r.status).toBe(400);
});
```

Test the error path of an Express handler: make the dependency reject and assert the error middleware's status, so the missing `next(err)` would be caught.

## React (React Testing Library)

```tsx
// ❌ Tests internals; breaks on refactor, passes on broken UI.
expect(wrapper.state('open')).toBe(true);

// ✅ Query by role, act like a user.
await user.click(screen.getByRole('button', { name: /open/i }));
expect(screen.getByRole('dialog')).toBeVisible();
```

```tsx
// ✅ Race test: resolve the second request before the first, expect the second's data.
```

Prefer `findBy*` for async UI, `userEvent` over `fireEvent`, and MSW over mocking `fetch` by hand.

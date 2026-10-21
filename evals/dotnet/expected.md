# Expected findings: dotnet

Stacks the skill should detect: .NET, ASP.NET Core, EF Core. References: dotnet-csharp, aspnetcore, efcore, security, testing.

## must

1. **Captive scoped DbContext** — `src/Shop.Api/Program.cs:14` registers `CustomerSummaryCache` as a singleton, and `src/Shop.Api/Customers/CustomerSummaryCache.cs:15` takes `ShopDbContext` (scoped) in its constructor.
   - Breaks when: two requests hit `/api/customers/{id}/summary` at the same time. Both use one `DbContext` instance, which is not thread-safe, so one throws `InvalidOperationException` ("A second operation was started on this context"). In Development, `ValidateScopes` fails at startup instead.
   - Fix: inject `IServiceScopeFactory` (or `IDbContextFactory<ShopDbContext>`) and create a context per call, or make the cache scoped and move the cached data into `IMemoryCache`.

## should

2. **N+1 query** — `src/Shop.Api/Customers/CustomerSummaryCache.cs:32` queries `OrderLines` once per order inside the loop.
   - Breaks when: a customer has 300 orders. That is 301 round trips for one request.
   - Fix: run one projected query, `_db.Orders.AsNoTracking().Where(o => o.CustomerId == customerId).Select(o => new OrderSummary(o.Id, o.Lines.Sum(l => l.Price * l.Quantity), o.Lines.Count)).ToListAsync(ct)`.

## Acceptable extra findings (not required)

- The cache never expires or invalidates, so a customer's new orders never show (should). It also grows without bound.
- `CustomerSummaryCache.cs:25` loads tracked entities for a read-only path (nit, and moot once the projection fix lands).
- The endpoint does not check that the caller may see customer `id` (IDOR). Report it only if sibling endpoints check ownership; otherwise put it under Questions.

## Must not be reported

- Style: the primary-constructor suggestion and `var` usage.
- Missing XML docs.

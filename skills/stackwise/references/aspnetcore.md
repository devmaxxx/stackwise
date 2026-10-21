# ASP.NET Core

Controllers, minimal APIs, middleware, DI and hosting. Language items are in dotnet-csharp.md,
data access in efcore.md.

## Checklist

### Pipeline, DI and hosting
- [ ] Middleware order: exception handler first; `UseRouting` → `UseCors` → `UseAuthentication` → `UseAuthorization` → endpoints. A new middleware placed after the endpoint it guards does nothing.
- [ ] DI lifetimes: no scoped service (`DbContext`, anything taking one, `IOptionsSnapshot<T>`) injected into a singleton or a hosted service constructor (captive dependency).
- [ ] Background work (`BackgroundService`, `Task.Run`, timers, channel consumers) creates a scope via `IServiceScopeFactory` per work item, not once before the loop.
- [ ] `ExecuteAsync` loops catch per iteration: an unhandled exception in a `BackgroundService` stops the whole host (default `StopHost`).
- [ ] Startup code does not resolve scoped services from `app.Services` (the root provider); seeding and migrations create a scope.
- [ ] A singleton that must see reloaded settings uses `IOptionsMonitor<T>`; the `IDisposable` returned by `OnChange` is kept and disposed.
- [ ] Library or shared registrations use `TryAdd*`; a second `Add*` of the same service silently replaces the one earlier code resolves (last wins).

### Authentication and authorization
- [ ] Every new controller/action or minimal endpoint is covered by `[Authorize]`, a fallback policy, or `RequireAuthorization()`; `[AllowAnonymous]` additions are intentional.
- [ ] Do not flag `AllowAnonymous()` on a webhook or callback that verifies a signature; review the signature check instead (fails closed, constant-time).
- [ ] Minimal-API groups: `MapGroup(...).RequireAuthorization()` covers the group; an endpoint mapped on `app` directly bypasses it.
- [ ] Resource-level authorization: the handler checks that the caller owns the id in the route (IDOR), not just that they are logged in.
- [ ] JWT setup keeps `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime` and `RequireHttpsMetadata` on outside Development.
- [ ] Cookie-authenticated state-changing endpoints keep antiforgery: `DisableAntiforgery()` or `[IgnoreAntiforgeryToken]` there is CSRF. Do not flag it on bearer-token-only APIs.
- [ ] Output/response caching never shares per-user responses: `UseOutputCache` comes after `UseAuthorization`; a custom `IOutputCachePolicy` loses the default skip for authenticated requests; `[ResponseCache(Location = Any)]` lets proxies cache them.

### Input, binding and contracts
- [ ] Model binding: entities are not bound from the body (over-posting of `IsAdmin`, `OwnerId`, `Price`); use a request DTO.
- [ ] Entities are not returned as responses either: every new column (`PasswordHash`, `InternalNotes`) ships to clients, and navigation cycles fail serialization.
- [ ] Validation runs: `[ApiController]` or explicit validation for minimal APIs (`AddValidation()` / FluentValidation / endpoint filter); range checks on paging and sizes.
- [ ] Do not flag a missing `if (!ModelState.IsValid)` under `[ApiController]`: it returns 400 ProblemDetails before the action runs.
- [ ] Enabling NRT makes non-nullable DTO properties implicitly `[Required]` in MVC and non-nullable minimal-API parameters required: requests that omitted them now get 400.
- [ ] A global `JsonOptions` change (naming policy, enum converter, `DefaultIgnoreCondition`) rewrites the contract of every endpoint, not only the new one.
- [ ] The body is read asynchronously: `await Request.ReadFormAsync(ct)`, not `Request.Form` (sync over async); sync `Request.Body` reads throw under Kestrel.
- [ ] Status codes: 201 + Location on create, 404 vs 403 consistent with siblings, 409 on concurrency conflicts.

### Outbound calls and request lifetime
- [ ] `HttpClient` comes from `IHttpClientFactory` or a typed client; no `new HttpClient()` per call; timeouts and resilience set for outbound calls.
- [ ] A typed client is not captured by a singleton (its handler never rotates, DNS changes are missed) and not registered again with `AddScoped<T>()`, which drops its configuration.
- [ ] `HttpContext` / `IHttpContextAccessor` is not used after the request ends or from a background thread.
- [ ] Headers and status are set before the body starts; after `await next()` or a write, setting them throws. Use `Response.OnStarting`.

### Errors, logging and exposure
- [ ] Errors return ProblemDetails (`AddProblemDetails`, `Results.Problem`); stack traces and `exception.Message` are not returned to clients outside Development, custom `IExceptionHandler`s included.
- [ ] `UseDeveloperExceptionPage()`, Swagger UI and detailed health-check writers are gated by environment or auth, not exposed on a public host.
- [ ] Logging: no tokens, passwords, full request bodies or PII in log messages; structured templates (`{UserId}`) instead of interpolation.

### Configuration and abuse limits
- [ ] Options: `ValidateDataAnnotations().ValidateOnStart()` for new required settings; no secrets in `appsettings.json`.
- [ ] CORS: no `AllowAnyOrigin()` together with credentials; origins from config.
- [ ] Rate limiting and request size limits on new upload or expensive endpoints; limits are partitioned per user or IP (a named `AddFixedWindowLimiter` policy is one bucket for all callers).
- [ ] Client IPs come from `UseForwardedHeaders` with known proxies, not a raw `X-Forwarded-For` read, and `KnownProxies`/`KnownNetworks` are not cleared to "make it work".

## Middleware order

```csharp
// ❌ Authorization runs before the user is authenticated: every [Authorize] endpoint returns 401.
app.UseAuthorization();
app.UseAuthentication();

// ✅
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
```

## Captive dependency

```csharp
// ❌ Registered with AddSingleton: keeps the first request's DbContext forever (stale data, shared across threads).
public sealed class PriceCache(AppDbContext db) { ... }

// ✅ Resolve per operation.
public sealed class PriceCache(IServiceScopeFactory scopes)
{
    public async Task<decimal> GetAsync(int id, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<AppDbContext>().Prices.Where(p => p.Id == id).Select(p => p.Value).SingleAsync(ct);
    }
}
```

`ValidateScopes` catches this only in Development; review it anyway. `IOptionsSnapshot<T>`
is scoped too: a singleton reading live config takes `IOptionsMonitor<T>`.

## Background workers

```csharp
// ❌ One scope for the service's lifetime: one DbContext tracks every message, and the first poison message stops the host.
using var scope = _scopes.CreateScope();
var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
await foreach (var msg in _channel.Reader.ReadAllAsync(ct)) await HandleAsync(db, msg, ct);

// ✅ A scope and a catch per item.
await foreach (var msg in _channel.Reader.ReadAllAsync(ct))
{
    await using var scope = _scopes.CreateAsyncScope();
    try { await HandleAsync(scope.ServiceProvider.GetRequiredService<AppDbContext>(), msg, ct); }
    catch (Exception ex) when (ex is not OperationCanceledException) { _log.LogError(ex, "Message {Id} failed", msg.Id); }
}
```

## Authorization holes in minimal APIs

```csharp
// ❌ /admin/export is outside the protected group.
var admin = app.MapGroup("/admin").RequireAuthorization("Admin");
admin.MapGet("/users", ListUsers);
app.MapGet("/admin/export", Export);

// ✅
admin.MapGet("/export", Export);
```

A fallback policy (`AddAuthorizationBuilder().SetFallbackPolicy(...)`) makes new endpoints deny by default; if the repo has one, check new `[AllowAnonymous]` instead.

## IDOR

```csharp
// ❌ Any logged-in user can read any invoice.
app.MapGet("/invoices/{id}", (int id, AppDbContext db) => db.Invoices.FindAsync(id));

// ✅
app.MapGet("/invoices/{id}", async (int id, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
    await db.Invoices.Where(i => i.Id == id && i.TenantId == user.GetTenantId()).SingleOrDefaultAsync(ct)
        is { } inv ? Results.Ok(inv.ToDto()) : Results.NotFound());
```

## Over-posting and entity responses

```csharp
// ❌ Client can send {"role":"Admin"}; the response returns PasswordHash.
[HttpPut("{id}")] public async Task<User> Update(int id, User user) { _db.Update(user); ...; return user; }

// ✅ Separate request and response shapes.
public sealed record UpdateUserRequest(string DisplayName, string? Phone);
public sealed record UserResponse(int Id, string DisplayName);
```

## NRT changes the API contract

```csharp
// Before <Nullable>enable</Nullable>, clients could omit Phone. After it, MVC treats it as [Required]
// and [ApiController] rejects those requests with 400.
public sealed class UpdateUserRequest { public string DisplayName { get; set; } = ""; public string Phone { get; set; } = ""; }

// ✅ Say what is optional.
public sealed class UpdateUserRequest { public required string DisplayName { get; set; } public string? Phone { get; set; } }
```

Breaks when: a mobile client released before the change keeps sending the old shape.

## HttpClient

```csharp
// ❌ Socket exhaustion under load; DNS changes ignored.
using var http = new HttpClient();

// ✅
builder.Services.AddHttpClient<GeoClient>(c => { c.BaseAddress = new(cfg["Geo:Url"]!); c.Timeout = TimeSpan.FromSeconds(10); });
```

## HttpContext off the request thread

```csharp
// ❌ HttpContext is recycled after the response; this reads another request's data or throws.
_ = Task.Run(() => _audit.Log(_accessor.HttpContext!.User.Identity!.Name));

// ✅ Capture values first.
var name = User.Identity?.Name;
await _auditQueue.EnqueueAsync(new AuditEntry(name), ct);
```

## Headers after the response started

```csharp
// ❌ Throws "Headers are read-only, response has already started" once the endpoint has written.
app.Use(async (ctx, next) => { await next(); ctx.Response.Headers["X-Request-Id"] = ctx.TraceIdentifier; });

// ✅
app.Use(async (ctx, next) =>
{
    ctx.Response.OnStarting(() => { ctx.Response.Headers["X-Request-Id"] = ctx.TraceIdentifier; return Task.CompletedTask; });
    await next();
});
```

## ProblemDetails and leakage

```csharp
// ❌ Leaks internals: SQL text, hostnames, file paths.
catch (Exception ex) { return StatusCode(500, ex.ToString()); }
// ❌ The same leak inside a global handler.
await ctx.Response.WriteAsJsonAsync(new ProblemDetails { Status = 500, Detail = exception.Message }, ct);

// ✅ Generic detail for clients; the exception goes to the log with the trace id.
builder.Services.AddProblemDetails();
app.UseExceptionHandler();
```

## Rate limits and client IPs

```csharp
// ❌ One shared bucket: a single client exhausts it and everyone gets rejected.
builder.Services.AddRateLimiter(o => o.AddFixedWindowLimiter("login", w => { w.PermitLimit = 10; w.Window = TimeSpan.FromMinutes(1); }));

// ✅ One bucket per caller; 429 instead of the default 503.
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy("login", ctx => RateLimitPartition.GetFixedWindowLimiter(ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(1) }));
});
```

Partitioning on a raw `X-Forwarded-For` header lets a client pick a new bucket per request.

## Logging

```csharp
// ❌ Interpolation defeats structured logging and writes the token.
_log.LogInformation($"Login {email} token {token}");

// ✅
_log.LogInformation("Login succeeded for {UserId}", user.Id);
```

## Options validation

```csharp
// ❌ A missing setting surfaces as a NullReferenceException on first use.
builder.Services.Configure<SmtpOptions>(cfg.GetSection("Smtp"));

// ✅ Fail at startup.
builder.Services.AddOptions<SmtpOptions>().Bind(cfg.GetSection("Smtp")).ValidateDataAnnotations().ValidateOnStart();
```

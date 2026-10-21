# ASP.NET Core

## Checklist

- [ ] Middleware order: exception handler first; `UseRouting` → `UseCors` → `UseAuthentication` → `UseAuthorization` → endpoints. A new middleware placed after the endpoint it guards does nothing.
- [ ] DI lifetimes: no scoped service (`DbContext`, anything taking one) injected into a singleton or a hosted service constructor (captive dependency).
- [ ] Background work (`BackgroundService`, `Task.Run`, timers) creates its own scope via `IServiceScopeFactory`.
- [ ] Every new controller/action or minimal endpoint is covered by `[Authorize]`, a fallback policy, or `RequireAuthorization()`; `[AllowAnonymous]` additions are intentional.
- [ ] Minimal-API groups: `MapGroup(...).RequireAuthorization()` covers the group; an endpoint mapped on `app` directly bypasses it.
- [ ] Resource-level authorization: the handler checks that the caller owns the id in the route (IDOR), not just that they are logged in.
- [ ] Model binding: entities are not bound directly from the body (over-posting of `IsAdmin`, `OwnerId`, `Price`); use a request DTO.
- [ ] Validation runs: `[ApiController]` or explicit validation for minimal APIs (`AddValidation()` / FluentValidation / endpoint filter); range checks on paging and sizes.
- [ ] `HttpClient` comes from `IHttpClientFactory` or a typed client; no `new HttpClient()` per call; timeouts and resilience set for outbound calls.
- [ ] `HttpContext` / `IHttpContextAccessor` is not used after the request ends or from a background thread.
- [ ] Errors return ProblemDetails (`AddProblemDetails`, `Results.Problem`); stack traces and exception messages are not returned to clients outside Development.
- [ ] Logging: no tokens, passwords, full request bodies or PII in log messages; structured templates (`{UserId}`) instead of interpolation.
- [ ] Options: `ValidateDataAnnotations().ValidateOnStart()` for new required settings; no secrets in `appsettings.json`.
- [ ] Status codes: 201 + Location on create, 404 vs 403 consistent with siblings, 409 on concurrency conflicts.
- [ ] CORS: no `AllowAnyOrigin()` together with credentials; origins from config.
- [ ] Rate limiting / request size limits on new upload or expensive endpoints.

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
// ❌ The singleton keeps the first request's DbContext forever: stale data, and
//    concurrent requests share one non-thread-safe context.
builder.Services.AddSingleton<PriceCache>();
public sealed class PriceCache(AppDbContext db) { ... }

// ✅ Resolve per operation.
public sealed class PriceCache(IServiceScopeFactory scopes)
{
    public async Task<decimal> GetAsync(int id, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.Prices.Where(p => p.Id == id).Select(p => p.Value).SingleAsync(ct);
    }
}
```

`ValidateScopes` catches this only in Development; review it anyway.

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

## Over-posting

```csharp
// ❌ Client can send {"role":"Admin"}.
[HttpPut("{id}")] public async Task<IActionResult> Update(int id, User user) { _db.Update(user); ... }

// ✅
public sealed record UpdateUserRequest(string DisplayName, string? Phone);
```

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

## ProblemDetails and leakage

```csharp
// ❌ Leaks internals.
catch (Exception ex) { return StatusCode(500, ex.ToString()); }

// ✅ Let the exception handler produce ProblemDetails.
builder.Services.AddProblemDetails();
app.UseExceptionHandler();
```

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

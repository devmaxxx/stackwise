# Security (cross-stack, changed lines only)

Walk this list over the changed lines. For each hit, name the attacker, the request
they send, and what they get. No attacker story, no finding.

## Checklist

### Access control (OWASP A01)
- [ ] New endpoint, route, server action, GraphQL resolver or SignalR hub method requires authentication, or is deliberately public.
- [ ] The handler checks ownership/tenant of every id it receives (route, query, body) — IDOR.
- [ ] Role and policy checks happen on the server; a hidden button is not authorization.
- [ ] Mass assignment: request bodies bind to DTOs, not entities/ORM models.
- [ ] CORS does not reflect arbitrary origins with credentials.

### Fail-open and insecure defaults
- [ ] Security settings do not default to off when config is missing (`REQUIRE_AUTH ?? false`, `if (!cfg.Enabled) return next()`).
- [ ] No fallback secret, key or password in code (`?? "dev-secret"`, `|| 'changeme'`).
- [ ] Debug or diagnostics features (developer exception page, Swagger UI, GraphQL introspection, verbose errors) are gated to development.
- [ ] A catch block on an auth/validation path does not end in "allow".

### Injection (A03)
- [ ] SQL: parameterized everywhere (`FromSql`, Dapper params, `$1`/`?`); identifiers from an allow-list.
- [ ] NoSQL: query objects not built from raw body (`{ $ne: null }` login bypass).
- [ ] OS command: no shell with interpolated input (`exec`, `Process.Start("cmd", "/c " + x)`).
- [ ] Path: user-controlled paths are canonicalized and confined to a base directory.
- [ ] Templates/HTML: output is encoded; `dangerouslySetInnerHTML`, `Html.Raw`, `v-html` only with sanitized input.
- [ ] Logs: user input is not written as raw log lines that can forge entries (newline injection) — structured logging avoids it.

### SSRF
- [ ] Server-side fetches of user-supplied URLs use an allow-list of hosts and block internal ranges (169.254.169.254, 10/8, localhost); redirects are not followed blindly.

### Authentication and sessions (A07)
- [ ] JWT validation checks issuer, audience, lifetime and signing key; `alg: none` impossible; no `ValidateLifetime = false`.
- [ ] Cookies carrying sessions are `HttpOnly`, `Secure`, `SameSite` appropriate; state-changing cookie-auth endpoints have CSRF protection.
- [ ] Password reset, email change and invite tokens are single-use, expiring, and compared in constant time.
- [ ] Rate limiting on login, reset, OTP and other enumeration-prone endpoints.

### Crypto and secrets (A02)
- [ ] No MD5/SHA1 for passwords or signatures; passwords use a KDF (ASP.NET Identity hasher, bcrypt, argon2, scrypt).
- [ ] Random tokens from a CSPRNG (`RandomNumberGenerator`, `crypto.randomBytes`/`randomUUID`), not `Random`/`Math.random`.
- [ ] No secrets in committed files, `appsettings.json`, `.env` checked in, client bundles (`NEXT_PUBLIC_*`, `VITE_*`).

### Data exposure
- [ ] Responses do not include fields the caller should not see (password hash, internal notes, other tenants' data) — check the serialized DTO, not just the type name.
- [ ] PII and tokens stay out of logs, URLs (query strings end up in logs), and analytics events.
- [ ] Error responses do not echo stack traces or SQL.

### Uploads and deserialization
- [ ] Uploads: size limit, content-type and extension checked server-side, stored outside the web root with a generated name, never executed.
- [ ] No `BinaryFormatter`, `TypeNameHandling.All`/`Auto` (Newtonsoft), `node-serialize`, or `eval` on input.
- [ ] XML parsing disables DTD/external entities.

### Webhooks and integrations
- [ ] Incoming webhooks verify the signature over the raw body with a constant-time compare and reject stale timestamps.
- [ ] Idempotency on payment/quota-affecting handlers (replayed webhook, double click).

### Dependencies (A06)
- [ ] New or bumped packages (NuGet, npm) have no known advisory (`dotnet list package --vulnerable`, `npm audit`), and are the intended package (typosquats).

### Security regressions
- [ ] The diff does not delete or weaken an existing check (`[Authorize]`, a validation rule, an `if (!owner) return 403`). Use `git log -S '<removed line>'` to see why it was added.

## Snippets

```csharp
// ❌ Fail-open: missing config disables the check in production.
if (!_opts.Value.EnforceTenantIsolation) return await next(ctx);
// ✅ Secure default; turning it off is an explicit, validated setting.
```

```ts
// ❌ NoSQL operator injection: body { "email": "a@b.c", "password": { "$ne": "" } }
const user = await users.findOne({ email: req.body.email, password: req.body.password });
// ✅ Validate types first, then compare a hash.
const { email, password } = LoginSchema.parse(req.body);
```

```ts
// ❌ SSRF
const img = await fetch(req.query.url as string);
// ✅
const u = new URL(String(req.query.url));
if (!ALLOWED_HOSTS.has(u.hostname)) return res.sendStatus(400);
```

```csharp
// ❌ Timing leak on the webhook signature.
if (computed == header) ...
// ✅
if (CryptographicOperations.FixedTimeEquals(computedBytes, headerBytes)) ...
```

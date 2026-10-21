# Expected findings: dotnet-webhook

Stacks the skill should detect: .NET, ASP.NET Core, EF Core. Required references: dotnet-csharp, aspnetcore, efcore, error-handling, security, testing. Optional: api-design. Must not load: nodejs, nestjs, typescript, react, nextjs.

## must

1. **Swallowed exception acknowledges a failed payment** — `src/Billing.Api/Payments/PaymentWebhookHandler.cs:35`. The `catch (Exception)` logs a warning and falls through to `return true` (line 40), so the endpoint answers 200 for every failure.
   - Breaks when: `SaveChangesAsync` hits a transient SQL error, a deadlock or a `DbUpdateConcurrencyException`, or the event arrives before the invoice row exists (`SingleAsync` throws). The provider gets 200, marks the event delivered and never retries, so the customer has paid but the invoice stays unpaid.
   - Fix: catch only what is known to be permanent (malformed payload → 400, unknown invoice → whatever the provider contract says), and let everything else reach the exception handler so the response is 5xx and the provider retries. Make the handler idempotent on `EventId` so the retry is safe.

2. **Signature check fails open when the secret is missing** — `src/Billing.Api/Payments/PaymentWebhookHandler.cs:46`. `IsSigned` returns `true` when `WebhookSecret` is null or empty.
   - Breaks when: an environment is deployed without `Payments:WebhookSecret` (a renamed key, a missing secret mount). Anyone can then `POST /webhooks/payments` with `{"invoiceId":42,"amount":0.01,...}` and no signature, and invoice 42 is marked paid.
   - Fix: return `false` when the secret is missing, and fail at startup instead: `AddOptions<WebhookOptions>().Bind(...).Validate(o => !string.IsNullOrEmpty(o.WebhookSecret)).ValidateOnStart()`.

## Acceptable extra findings (not required)

- `src/Billing.Api/Payments/PaymentWebhookHandler.cs:50` compares the signature with `string.Equals`, which is not constant-time; use `CryptographicOperations.FixedTimeEquals` on the decoded bytes (should).
- No replay protection: no timestamp in the signed payload and no record of processed `EventId`s, so a captured request can be replayed (should).
- `JsonSerializer.Deserialize(...)!` turns a `null` payload into a `NullReferenceException`; fold this into finding 1.
- The webhook body is read with no size limit.
- No test for the failure path (a should only if sibling endpoints are tested, otherwise a note).

## Must not be reported

- `AllowAnonymous()` on the webhook as "missing authorization": a webhook is authenticated by its signature, by design.
- Style: the primary constructor, `var`, or the expression layout.
- "Use the payment provider's SDK" or other lectures without a concrete failure.
- Missing XML docs.

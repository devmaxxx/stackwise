---
name: stackwise
description: Reviews a pull request, branch diff or staged change in a .NET + Node.js + React codebase and returns only verified findings graded must / should / nit, each with file:line, the defect, an input that breaks it and the fix. Detects the stacks in the diff (C#, ASP.NET Core, EF Core and migrations; Node.js with Express, Fastify or NestJS; TypeScript; React and Next.js) and loads only the matching checklists, then runs a vertical pass (one feature from the database through the API to the client) and a horizontal pass (sibling endpoints, handlers and components for drift), plus the C#-to-TypeScript API contract. Use when asked to "review this PR", "review the diff", "review my branch", "code review", "check this change before merge", "look for bugs in this PR", or for a review of .cs, .csproj, EF migrations, package.json, Express/Fastify routes, .ts, .tsx or .jsx changes.
---

# Code review for .NET + Node.js + React

Review the change, not the codebase. A finding counts only when you can show the
line, the input that breaks it, and the fix. Ten real findings beat forty plausible ones.

## 1. Get the diff

Pick the first source that applies:

| Target | Commands |
|--------|----------|
| PR number or URL | `gh pr view <n> --json title,body,baseRefName,headRefName,files` then `gh pr diff <n>` |
| Branch | `git fetch origin <base>` then `git diff origin/<base>...<branch>` (three dots: changes since the merge base) |
| Path | `git diff origin/<base>...HEAD -- <path>` |
| Nothing given | staged + unstaged: `git diff HEAD`; if empty, the current branch against its base |

Base defaults to the PR's base, else `main`. Read the PR title and body: the author's
intent tells you what "correct" means. For large diffs, list files first
(`--name-only`) and review in groups; skip lockfile bodies and generated code but
note that they changed.

## 2. Detect the stacks and load only those references

Classify every changed path. A file may match more than one stack.

| Stack | Signals in the changed paths | Load |
|-------|------------------------------|------|
| .NET | `*.cs`, `*.csproj`, `*.sln`, `Directory.Build.*`, `appsettings*.json` | [dotnet-csharp.md](references/dotnet-csharp.md) |
| ASP.NET Core | `.cs` under `Controllers/`, `Endpoints/`, `Program.cs`, `Startup.cs`, `Middleware/`, files using `Map(Get\|Post\|...)` | [aspnetcore.md](references/aspnetcore.md) |
| EF Core | `Migrations/`, `*DbContext.cs`, `*Configuration.cs` with `IEntityTypeConfiguration`, LINQ over `DbSet` | [efcore.md](references/efcore.md) |
| Node backend | `package.json` without `react`/`next`, `server/`, `api/`, `routes/`, `src/` of a service, `*.ts`/`*.js` importing `express`, `fastify`, `@nestjs/*`, `node:*` | [nodejs.md](references/nodejs.md) |
| TypeScript | any `*.ts`, `*.tsx`, `tsconfig*.json` | [typescript.md](references/typescript.md) |
| React | `*.tsx`, `*.jsx`, `package.json` with `react`/`next`, `app/` or `pages/` of a Next.js app | [react.md](references/react.md) |

Always load [security.md](references/security.md) and [testing.md](references/testing.md).
Load [cross-stack-contract.md](references/cross-stack-contract.md) when the diff touches
both a C# DTO, controller or endpoint and TypeScript client code or a generated client
(`openapi*`, `nswag*`, `orval*`, `*.gen.ts`, `api-client/`) — or when it touches only
one side of an API whose other side lives in this repo.

Do not load a reference whose stack is absent. Each reference opens with a checklist:
walk it against the changed lines, then read the snippets only for items that hit.

## 3. Vertical pass: one feature, every layer

Pick the feature the PR is about (the PR title usually names it). Trace it through
each layer it touches, in order:

1. **Schema** — migration, entity, configuration, indexes, constraints.
2. **Data access** — the query or repository: shape, tracking, bounds, transactions.
3. **Domain / service** — invariants, authorization, concurrency, error paths.
4. **API** — route, binding, validation, auth attribute or policy, status codes, DTO.
5. **Contract** — what the JSON looks like on the wire vs what the client type says.
6. **Client** — fetch, cache, loading/error states, the component that renders it.

At each hop ask: does the value that leaves this layer match what the next layer
expects (nullability, units, casing, time zone, error shape)? Most cross-stack bugs
live at a hop, not inside a layer. Name any layer the change should have touched but
did not (a new column with no migration, a new field the client never sends).

## 4. Horizontal pass: siblings drift

For each kind of thing the diff adds or changes — an endpoint, a handler, a hook, a
component, a migration, a DTO — find two or three existing siblings of the same kind
(`grep` the route prefix, the base class, the hook name pattern). Compare:

- auth attribute / policy / `RequireAuthorization` present on siblings but missing here;
- validation, paging limits, `CancellationToken`, error mapping, logging the siblings do;
- naming, response shape and status codes the client already relies on;
- a fix applied here that the siblings still need (report once, list the siblings).

Drift is a finding only when it breaks something or opens a hole; a different but
valid style is not.

## 5. Verify every finding

Before a candidate goes in the report, it must have all four:

1. **Where** — `path:line` in the new version of the file, on or next to a changed line.
2. **Defect** — one sentence: what goes wrong.
3. **Breaking input** — a concrete request, value, interleaving or state that triggers it
   ("two requests within 5 ms", "`?page=-1`", "`user.middleName` is null", "unmount during fetch").
4. **Fix** — the change, in a sentence or a short snippet.

Then try to disprove it: read the surrounding code, the caller, the framework default
(e.g. `[ApiController]` already returns 400 on invalid model state; Express 5 already
forwards rejected promises). If the code is guarded elsewhere, drop it. If you cannot
produce the breaking input, drop it or move it to "Questions" — never pad the report.

Pre-existing problems on untouched lines are out of scope unless the change makes
them reachable or worse; mention at most one under "Notes".

## 6. Severity

| Grade | Meaning | Examples |
|-------|---------|----------|
| **must** | Wrong result, data loss, security hole, crash, or outage under realistic use. Blocks merge. | missing auth on an endpoint, SQL built from input, migration that drops data, `.Result` deadlock on a request path, captive scoped `DbContext` |
| **should** | Real defect with narrower reach, or a cost that grows with data/traffic. Fix in this PR unless argued. | N+1 on a list endpoint, fetch race showing stale data, missing `CancellationToken` on a long query, missing test for the changed branch |
| **nit** | Correct but worth a one-line change; never blocks. Cap at five. | misleading name, redundant `ToList()`, a `key={index}` on a static list |

## 7. Output

```
## Review: <PR title or branch> (<base>...<head>)
Stacks: .NET, EF Core, React · References loaded: dotnet-csharp, efcore, react, security, testing, cross-stack-contract
Verdict: request changes | approve with comments | approve

### must
1. `src/Api/Orders/OrdersController.cs:42` — <defect>.
   Breaks when: <input>. Fix: <fix>.

### should
...

### nit
...

### Questions
- <thing you could not verify, and what would settle it>

Checked and fine: <one line naming the risky areas you inspected and cleared>
```

Number findings so the author can reply by number. Put the most severe first. If
there are no findings, say so and list what you checked. Do not praise, summarize the
PR back, or restate the diff.

When posting to GitHub (only when asked, e.g. the command's `--comment`), post one
inline comment per finding on the exact line, prefixed with its grade, and a summary
comment with the verdict. Use a suggestion block only when applying it fully fixes
the issue.

## 8. What not to flag

- Formatting, import order, quotes, semicolons, line length — the formatter and linter own them.
- Anything a configured analyzer or ESLint rule already reports in CI.
- Naming or structure that is a matter of taste and consistent with the file.
- "Consider adding a comment / docs / logging" without a concrete failure.
- Speculative performance work without evidence the path is hot or the data large.
- `useMemo`/`useCallback`/`React.memo` additions without a measured or obvious re-render cost.
- Missing indexes when the migrations or model config that would prove it are not in view.
- Generic best-practice lectures; framework version upgrades unrelated to the change.
- Issues on lines the PR did not touch (see section 5).
- Anything silenced deliberately in the code with a reason (`#pragma warning disable`, `eslint-disable-next-line` with a comment).

## References

- [references/dotnet-csharp.md](references/dotnet-csharp.md) — async, nullability, disposal, LINQ, records
- [references/aspnetcore.md](references/aspnetcore.md) — middleware, DI lifetimes, auth, binding, HttpClient, options
- [references/efcore.md](references/efcore.md) — query shape, tracking, DbContext lifetime, raw SQL, migration safety
- [references/nodejs.md](references/nodejs.md) — event loop, promises, Express/Fastify errors, streams, shutdown, injection
- [references/typescript.md](references/typescript.md) — casts, boundary validation, narrowing, exhaustiveness
- [references/react.md](references/react.md) — hooks, effects, races, RSC boundaries, a11y, XSS, bundle
- [references/security.md](references/security.md) — cross-stack OWASP checklist for changed lines
- [references/cross-stack-contract.md](references/cross-stack-contract.md) — C# DTO vs TS types on the wire
- [references/testing.md](references/testing.md) — tests that pin behaviour, missing branch tests

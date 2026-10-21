---
name: stackwise
description: Reviews a pull request, branch diff, patch file or staged change in a .NET + Node.js + React codebase and returns only verified findings graded must / should / nit, each with file:line, the defect, an input that breaks it and the fix. Detects the stacks in the diff (C#, ASP.NET Core, EF Core and migrations; Node.js with Express, Fastify or NestJS; TypeScript; React and Next.js) and loads only the matching checklists, scales its depth to the risk (auth, money, migrations, concurrency, public contracts), then runs a vertical pass (one feature from the database through the API to the client), a horizontal pass (sibling endpoints, handlers and components for drift) and four lenses (silent failures, test coverage, type design, comment accuracy). Large or risky diffs fan out to parallel lens agents. Use when asked to "review this PR", "review the diff", "review my branch", "code review", "check this change before merge", "look for bugs in this PR", or for a review of .cs, .csproj, EF migrations, package.json, Express/Fastify/NestJS code, .ts, .tsx or .jsx changes.
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
| `.diff` or `.patch` file | Read it: it is the change. Its files may not exist locally, so review from the hunks and say so under Notes |
| Path | `git diff origin/<base>...HEAD -- <path>` |
| Nothing given | staged + unstaged: `git diff HEAD`; if empty, the current branch against its base |

Base defaults to the PR's base, else the default branch, else `main`; with no remote, use the
local branch. Read the PR title and body: the author's intent tells you what "correct" means.
Note the size (`--shortstat`, without lockfiles and generated code); §3 and §7 use it. For
large diffs, list files first (`--name-only`) and review in groups; skip lockfile bodies and
generated code but note that they changed.

## 2. Detect the stacks and load only those references

Classify every changed path, and the imports and calls on changed lines. A file may match more than one row.

| Stack | Signals | Load |
|-------|---------|------|
| .NET | `*.cs`, `*.csproj`, `*.sln`, `Directory.Build.*`, `appsettings*.json` | [dotnet-csharp.md](references/dotnet-csharp.md) |
| ASP.NET Core | `Program.cs`, `Startup.cs`, `Controllers/`, `Endpoints/`, `Middleware/`, `[ApiController]`, `Map(Get\|Post\|...)`, `BackgroundService`, `AddAuthentication` | [aspnetcore.md](references/aspnetcore.md) |
| EF Core / SQL | `Migrations/`, `*ModelSnapshot.cs`, `*DbContext.cs`, `IEntityTypeConfiguration`, LINQ over `DbSet`, `FromSql*`, `ExecuteUpdate*`, Dapper `Query*Async` | [efcore.md](references/efcore.md) |
| Node backend | `package.json` without `react`/`next`, `server/`, `api/`, `routes/`, files importing `express`, `fastify`, `pg`, `prisma`, `node:*` | [nodejs.md](references/nodejs.md) |
| NestJS | `@nestjs/*` imports, `nest-cli.json`, `NestFactory`, `*.module\|controller\|service\|guard\|pipe\|dto.ts` | [nestjs.md](references/nestjs.md), plus nodejs.md |
| TypeScript | any `*.ts`, `*.tsx`, `tsconfig*.json` | [typescript.md](references/typescript.md) |
| React | `*.tsx`, `*.jsx`, `package.json` with `react` | [react.md](references/react.md) |
| Next.js | `next` in `package.json`, `next.config.*`, `app/**/{page,layout,route}.*`, `middleware.ts`, `proxy.ts`, `'use server'`, `next/*` imports, `pages/api/` | [nextjs.md](references/nextjs.md), plus react.md |
| API surface | new or changed routes (`[Http*]`, `Map*(`, Express/Fastify verbs, `@Get`-style decorators, `route.ts`), DTOs, status codes, `openapi*`, paging, `ETag`, `Idempotency-Key` | [api-design.md](references/api-design.md) |
| Hot path | list endpoints, `await` or a query inside a loop, `Promise.all`/`Task.WhenAll`, caches, `*Sync(`, `.Result`, a new client dependency | [performance.md](references/performance.md) |

Always load [security.md](references/security.md) and [testing.md](references/testing.md),
and [error-handling.md](references/error-handling.md) unless the diff is docs-only.
Load [cross-stack-contract.md](references/cross-stack-contract.md) when the diff touches
both a C# DTO, controller or endpoint and TypeScript client code or a generated client
(`openapi*`, `nswag*`, `orval*`, `*.gen.ts`, `api-client/`), or only one side of an API
whose other side lives in this repo.

Do not load a reference whose stack is absent. Each reference opens with a checklist that
ends within its first 100 lines, "do not flag" notes included: read those lines, walk the
checklist against the changed lines, then read only the snippet sections for items that hit.

## 3. Depth scales with risk, not size

| Risk area | Signals in the diff | Deeper pass |
|-----------|---------------------|-------------|
| Auth, sessions, permissions | `[Authorize]`/`[AllowAnonymous]`, policies, guards, `@Public()`, JWT or cookie options, login, reset, invite, server actions | every entry point the change opens or reroutes; record-level checks; removed checks in the `-` lines |
| Money, billing, quotas | prices, payments, invoices, balances, credits, limits, payment webhooks | check-then-act across an `await`, idempotency, rounding, failures acknowledged as success |
| Migrations, data deletion | `Migrations/`, `DROP`/`ALTER`, `ExecuteDelete*`, bulk updates, retention jobs | data loss, lock time, deploy order, rollback, backfill |
| Concurrency, background work | `BackgroundService`, queues, cron, locks, shared caches, fan-out | shared state, at-least-once delivery, retries, cancellation |
| Public API contract | DTOs, routes, status codes, error shapes, events, generated clients | every consumer in the repo, versioning, cross-stack-contract.md |

- **deep**: any row hits (a refactor in a risk area counts). Trace every layer, sweep all
  siblings, read the removed lines and every caller of a changed security function, and
  run `git log -S '<removed check>'` when a guard disappears.
- **standard**: a code change with no risk row. Run §4 to §6 as written.
- **light**: docs, copy, styling or tests only. Check that claims, links and assertions are
  true; skip the vertical pass.

## 4. Vertical pass: one feature, every layer

Pick the feature the PR is about (the PR title usually names it). Trace it through
each layer it touches, in order:

1. **Schema**: migration, entity, configuration, indexes, constraints.
2. **Data access**: the query or repository: shape, tracking, bounds, transactions.
3. **Domain / service**: invariants, authorization, concurrency, error paths.
4. **API**: route, binding, validation, auth attribute or policy, status codes, DTO.
5. **Contract**: what the JSON looks like on the wire vs what the client type says.
6. **Client**: fetch, cache, loading/error states, the component that renders it.

At each hop ask: does the value that leaves this layer match what the next layer
expects (nullability, units, casing, time zone, error shape)? Most cross-stack bugs
live at a hop, not inside a layer. Name any layer the change should have touched but
did not (a new column with no migration, a new field the client never sends).

## 5. Horizontal pass: siblings drift

For each kind of thing the diff adds or changes (an endpoint, a handler, a hook, a
component, a migration, a DTO), find two or three existing siblings of the same kind
(`grep` the route prefix, the base class, the hook name pattern). Compare:

- auth attribute / policy / guard present on siblings but missing here;
- validation, paging limits, `CancellationToken`, error mapping, logging the siblings do;
- naming, response shape and status codes the client already relies on;
- a fix applied here that the siblings still need (report once, list the siblings).

Drift is a finding only when it breaks something or opens a hole; a different but
valid style is not.

## 6. Lenses over the changed lines

Run each lens over the added and changed lines after the two passes:

- **Silent failures** ([error-handling.md](references/error-handling.md)): every added
  `catch`, fallback (`?? []`, `|| 0`, `?.` before a call), fire-and-forget call and status
  check. Ask what the caller sees when it fails; "a 200 and a wrong result" is the finding.
- **Test coverage** ([testing.md](references/testing.md)): map each changed branch to a
  test. Validation or auth that changed while its tests did not is a strong cue. A missing
  test is a should only when sibling code is tested, otherwise a Note, never a must.
- **Type design** (the Type design groups in typescript.md and dotnet-csharp.md): only for
  types the diff adds or widens: illegal states that compile, optional-field soup, bare
  ids or units, invariants not enforced where the value is built.
- **Comment accuracy**: a comment, doc comment or README line in the diff that the code
  contradicts (wrong unit, stale parameter, "never null" on a nullable). A should on a
  public contract, otherwise a nit. A missing comment is never a finding.

## 7. Parallel lens agents for large or risky diffs

Dispatch when the diff has more than 400 changed lines, or when §3 found auth, a migration
or a public contract, however small the diff; the agents have no edit tools, so plan mode allows
them. Otherwise stay single-pass.

| Agent | Dispatch when | Pass these references |
|-------|---------------|-----------------------|
| `stackwise:stackwise-contract` | a C# DTO or endpoint and TS client code, or one side of an in-repo API | cross-stack-contract.md, api-design.md |
| `stackwise:stackwise-data` | migrations, a DbContext, SQL or ORM queries | efcore.md, performance.md, nodejs.md for Node ORMs |
| `stackwise:stackwise-auth` | the auth risk row, or new or rerouted entry points | security.md, plus aspnetcore.md, nestjs.md or nextjs.md as detected |
| `stackwise:stackwise-react-effects` | `.tsx`/`.jsx` with hooks or effects | react.md, typescript.md, nextjs.md if loaded |
| `stackwise:stackwise-silent-failure` | every dispatch | error-handling.md, testing.md |

Launch the matching agents in one message so they run in parallel. Give each one the diff
source from §1 (command or file), base and head, the detected stacks, the PR intent in one
line, and absolute reference paths (`${CLAUDE_SKILL_DIR}/references/<file>`). Do the vertical
and horizontal passes yourself while they run. Then merge: one finding per defect (same
line ±3 and the same cause: keep the clearer breaking input and the higher grade), drop
anything outside the diff, and put every candidate through §8 yourself. An agent's finding
is a lead, not a verdict. If the agents are not available (the skill was installed without
the plugin, or you are already a subagent), run the lenses inline.

## 8. Verify every finding

Before a candidate goes in the report, it must have all four:

1. **Where**: `path:line` in the new version of the file, on or next to a changed line.
2. **Defect**: one sentence: what goes wrong.
3. **Breaking input**: a concrete request, value, interleaving or state that triggers it
   ("two requests within 5 ms", "`?page=-1`", "`user.middleName` is null", "unmount during fetch").
4. **Fix**: the change, in a sentence or a short snippet.

Then try to disprove it: read the surrounding code, the caller, the framework default
(e.g. `[ApiController]` already returns 400 on invalid model state; Express 5 already
forwards rejected promises; EF Core `FromSql` parameterises its interpolations). If the
code is guarded elsewhere, drop it. If you cannot produce the breaking input, drop it or
move it to "Questions"; never pad the report.

Label what survives. **confirmed**: the code in view proves it. **likely**: it holds unless
something out of view prevents it; name that assumption. Anything weaker goes to Questions.
A must needs confirmed, after a second read of the lines.

Pre-existing problems on untouched lines are out of scope unless the change makes
them reachable or worse; mention at most one under "Notes".

## 9. Severity

| Grade | Meaning | Examples |
|-------|---------|----------|
| **must** | Wrong result, data loss, security hole, crash, or outage under realistic use. Blocks merge. | missing auth on an endpoint, SQL built from input, migration that drops data, `.Result` deadlock on a request path, captive scoped `DbContext`, a webhook that acknowledges a failed write |
| **should** | Real defect with narrower reach, or a cost that grows with data/traffic. Fix in this PR unless argued. | N+1 on a list endpoint, fetch race showing stale data, missing `CancellationToken` on a long query, missing test for a changed branch whose siblings are tested |
| **nit** | Correct but worth a one-line change; never blocks. Cap at five. | misleading name, redundant `ToList()`, a `key={index}` on a static list, a stale comment |

## 10. Output

```
## Review: <PR title or branch> (<base>...<head>)
Stacks: .NET, EF Core, React · References loaded: dotnet-csharp, efcore, react, security, testing, error-handling
Risk: auth, migration · Depth: deep · Lens agents: data, auth, silent-failure (or: single pass)
Verdict: request changes | approve with comments | approve

### must
1. `src/Api/Orders/OrdersController.cs:42` — <defect>.
   Breaks when: <input>. Fix: <fix>.

### should
2. `src/web/useOrders.ts:18` — <defect>. (likely: assumes <out-of-view fact>)
   Breaks when: <input>. Fix: <fix>.

### nit
...

### Questions
- <thing you could not verify, and what would settle it>

### Notes
- <worth knowing but not a defect in this diff, e.g. a dependency bump with no lockfile in the repo>

Checked and fine: <one line naming the risky areas you inspected and cleared>
```

Number findings so the author can reply by number. Put the most severe first. If
there are no findings, say so and list what you checked. Do not praise, summarize the
PR back, or restate the diff.

When posting to GitHub (only when asked, e.g. the command's `--comment`), post one
inline comment per finding on the exact line, prefixed with its grade, and a summary
comment with the verdict. Use a suggestion block only when applying it fully fixes
the issue.

## 11. What not to flag

- Formatting, import order, quotes, semicolons, line length: the formatter and linter own them.
- Anything a configured analyzer or ESLint rule already reports in CI.
- Naming or structure that is a matter of taste and consistent with the file.
- "Consider adding a comment / docs / logging" without a concrete failure; a missing or terse comment.
- Speculative performance work without evidence the path is hot or the data large.
- `useMemo`/`useCallback`/`React.memo` additions without a measured or obvious re-render cost.
- Missing indexes when the migrations or model config that would prove it are not in view.
- Missing tests for logic-free code (wiring, DTOs, re-exports), or a coverage percentage.
- Type-design advice for types the diff neither adds nor widens.
- A log-and-continue `catch` on a path documented as best effort (telemetry, cache warm-up).
- Generic best-practice lectures; framework version upgrades unrelated to the change.
- Issues on lines the PR did not touch (see §8).
- Anything silenced deliberately in the code with a reason (`#pragma warning disable`, `eslint-disable-next-line` with a comment).

After the report, the companion skills take over when asked: `stackwise-fix` applies the
must and should fixes, `stackwise-tests` pins them with failing-first tests,
`stackwise-respond` answers review threads, and `stackwise-describe` writes the PR body.

## References

- [references/dotnet-csharp.md](references/dotnet-csharp.md): async, concurrency, nullability, type design, disposal, LINQ, wire format
- [references/aspnetcore.md](references/aspnetcore.md): DI lifetimes, background workers, auth, binding, HttpClient, exposure, rate limits
- [references/efcore.md](references/efcore.md): query shape, tracking, saving, Dapper, raw SQL, migration safety
- [references/nodejs.md](references/nodejs.md): event loop, promises, Express/Fastify errors, pg, streams, shutdown, injection
- [references/nestjs.md](references/nestjs.md): DI scopes, pipe and guard order, DTO validation, serialization, filters, transactions
- [references/typescript.md](references/typescript.md): casts, boundary validation, narrowing, async pitfalls, type design
- [references/react.md](references/react.md): hooks, effects, races, async UI, a11y, XSS, client performance
- [references/nextjs.md](references/nextjs.md): server/client boundary, server actions, route handlers, proxy, caching
- [references/api-design.md](references/api-design.md): idempotency, PATCH, status codes, paging, ETag and caching, 202, rate limits
- [references/performance.md](references/performance.md): N+1, unbounded data, waterfalls, blocking, caching, payload, bundle, re-renders
- [references/error-handling.md](references/error-handling.md): swallowed errors, lost context, fail-open, retries, background work, UI errors
- [references/security.md](references/security.md): access control, tenants, injection, SSRF, auth, crypto, uploads, money and races
- [references/cross-stack-contract.md](references/cross-stack-contract.md): C# DTO vs TS types on the wire
- [references/testing.md](references/testing.md): tests that pin behaviour, assertion quality, mocks, coverage of the change

# stackwise

This is a Claude Code plugin for reviewing pull requests in **.NET + Node.js + React**
codebases. It reads the diff, works out which stacks the diff touches, and loads only
those checklists. It traces one feature from the database to the UI, then compares
the new code with its siblings. It reports only findings it can back up: each one
has a file:line, the defect, an input that breaks it, and the fix.

## Install

```
/plugin marketplace add devmaxxx/stackwise
/plugin install stackwise@stackwise
```

To work on it locally, run `claude --plugin-dir /path/to/stackwise`, or
`/plugin marketplace add /path/to/stackwise`.

## Usage

```
/stackwise:review              # open PR for the current branch, else local changes vs base
/stackwise:review 123          # PR #123
/stackwise:review feat/orders  # a branch vs its base
/stackwise:review src/Api      # the branch diff limited to a path
/stackwise:review 123 --comment  # also post the findings as one review with inline comments
```

By default nothing is posted. `--comment` posts a single `COMMENT` review through
`gh api`. It never approves or requests changes. The skill also fires on its own when
you ask Claude to "review this PR" or "review my branch" in a repo with these stacks.

Needs: `git`, and the [GitHub CLI](https://cli.github.com/) (authenticated) for PR targets.

## How stack detection works

The skill sorts every changed path. It loads a reference only when that path's
stack is present:

| Changed paths | References loaded |
|---------------|-------------------|
| `*.cs`, `*.csproj`, `*.sln`, `appsettings*.json` | `dotnet-csharp` |
| Controllers, endpoints, `Program.cs`, middleware | `aspnetcore` |
| `Migrations/`, `*DbContext.cs`, entity configurations, LINQ over `DbSet` | `efcore` |
| `package.json` without `react`/`next`; `server/`, `api/`, `routes/`; files importing `express`, `fastify`, `@nestjs/*` | `nodejs` |
| `*.ts`, `*.tsx`, `tsconfig*.json` | `typescript` |
| `*.tsx`, `*.jsx`, `package.json` with `react`/`next` | `react` |
| C# DTOs/endpoints together with TS clients or generated clients | `cross-stack-contract` |
| always | `security`, `testing` |

A pure React PR never loads the EF Core checklist, so a review spends its context
on the code that changed.

## What it covers

- **C# / .NET**: sync-over-async, `async void`, CancellationToken flow, nullable reference types and `!`, disposal, multiple enumeration, record equality.
- **ASP.NET Core**: middleware order, DI lifetimes and captive dependencies, `[Authorize]` and `RequireAuthorization` gaps, IDOR, over-posting, validation, `IHttpClientFactory`, HttpContext used off-thread, ProblemDetails, PII in logs, options validation.
- **EF Core**: N+1, tracking, cartesian explosion and split queries, paging, projection, DbContext lifetime and concurrent use, `FromSqlRaw` injection. For migrations: data loss, rename vs drop, non-nullable columns without a default, locking, and deploy order.
- **Node.js**: event-loop blocking (sync fs/crypto, ReDoS), floating promises, Express 4 vs 5 async errors, error-middleware arity, Fastify hooks and schemas, streams and backpressure, SIGTERM shutdown, env validation, `child_process` injection, path traversal, and dependency/lockfile drift.
- **TypeScript**: `any` and `as` casts, runtime validation at boundaries, narrowing, exhaustive switches, `noUncheckedIndexedAccess`.
- **React / Next.js**: hooks rules and deps, effect misuse, stale closures, keys, re-render cost (without memo by reflex), `'use client'` boundaries and server-only leaks, Suspense and error boundaries, waterfalls and fetch races, forms, a11y, XSS, bundle size.
- **Cross-stack contract**: nullability, enums as int vs string, DateTime and time zones, casing, `decimal`/`long` precision, pagination shape, breaking changes, and stale generated clients (NSwag, orval, openapi-typescript).
- **Security**: an OWASP-style pass over the changed lines, covering fail-open defaults and removed checks.
- **Testing**: whether the changed branch is tested, and whether the tests pin behaviour rather than the implementation.

## Review method

1. Get the diff (`gh pr diff`, or `git diff base...HEAD`).
2. Detect the stacks and load the matching references.
3. **Vertical pass**: follow one feature through schema → query → service → API → wire format → client.
4. **Horizontal pass**: compare new endpoints, handlers and components with their siblings, looking for drift in auth, validation, paging and error shape.
5. **Verify**: every finding needs file:line, a defect, a breaking input and a fix. Anything that cannot be backed up is dropped or listed as a question.
6. **Grade** each finding as `must`, `should` or `nit`, then report.

## Repository layout

```
.claude-plugin/        plugin.json, marketplace.json
skills/stackwise/      SKILL.md and references/
commands/review.md     /stackwise:review
evals/                 three seeded-bug fixtures and their expected findings
tests/validate.mjs     structure checks (npm test)
ANALYSIS.md            what was taken from which source, and why
```

## Development

```sh
npm test
```

This checks the manifests, the skill's frontmatter and length, that every linked
reference exists, and the eval fixtures. To run the evals, see [evals/README.md](evals/README.md).

## License

MIT. See [LICENSE](LICENSE) and [ATTRIBUTION.md](ATTRIBUTION.md).

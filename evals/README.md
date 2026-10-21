# Evals

Each fixture is a diff with seeded bugs, plus the findings a correct review must
report. The skill's output is free text, so a run is scored by reading the report
against `expected.md`, not by string matching.

| Fixture | Seeded bugs |
|---------|-------------|
| `dotnet/` | A scoped `DbContext` captured by a singleton, and an N+1 over order lines |
| `dotnet-webhook/` | A payment webhook whose `catch (Exception)` returns 200 for every failure, and a signature check that passes when the secret is missing |
| `node/` | An Express 4 async handler that never calls `next(err)`, and `readFileSync` on every request |
| `nestjs/` | A global `ValidationPipe` without `whitelist` feeding a whole DTO to `repo.update` (mass assignment), and a nested DTO with no `@ValidateNested` |
| `react/` | A polling effect missing `query`/`customerId` deps (stale closure), and a search fetch with no abort (race) |
| `fix-node/` | A static asset server with a path traversal and a malformed escape that crashes the process; also scored as a fix run (see [Fix eval](#fix-eval)) |

## Run

Start one headless session per fixture from the repo root, with `--plugin-dir` so
the run uses the working copy: it replaces an installed stackwise for that session,
while an installed copy keeps whatever version it cached. The fixtures are independent,
so run them in parallel. macOS has no `timeout`; a perl alarm does the same job.

```sh
out="${TMPDIR:-/tmp}/stackwise-evals" && mkdir -p "$out"
for x in dotnet dotnet-webhook node nestjs react fix-node; do
  perl -e 'alarm shift; exec @ARGV' 900 \
    claude --plugin-dir "$PWD" -p "/stackwise:review evals/$x/pr.diff" --permission-mode plan > "$out/$x.md" 2>&1 &
done
wait
```

`--permission-mode plan` keeps each session read-only. Each session starts fresh, so
a fixture's report never sees another's.

## Score

For each fixture, compare the report with `expected.md`:

| Result | Meaning |
|--------|---------|
| **hit** | A seeded `must` or `should` is reported at the stated file:line (±1 line, or any alternative the item names), with a breaking input and a fix, at the stated severity or higher. |
| **partial** | Found, but graded lower than stated, at the wrong line, or without a breaking input or fix. |
| **miss** | Not reported, or only under Questions. |
| **false positive** | Anything under "Must not be reported", or a finding that is wrong on the facts. Items under "Acceptable extra findings" count neither way. |

Stack detection passes when every reference in "Required references" was loaded and
none in "Must not load" was.

A run passes when every seeded bug is a hit, stack detection passes, and there are no
false positives. Record failures alongside the skill change that fixes them.

`npm test` checks that each fixture's hunk headers match their bodies, and that every
`path:line` cited in `expected.md` is a line the diff shows. Those checks keep the
expected locations trustworthy.

## Fix eval

`fix-node/repo/` is the project after the change in `fix-node/pr.diff`. The fix run
needs a real working tree, so build a throwaway repo from it: the base commit on
`main`, the change on `feat/assets`. There is no remote, so the base is the local
`main`. Run it from the stackwise repo root:

```sh
stackwise="$PWD"
out="${TMPDIR:-/tmp}/stackwise-evals" && mkdir -p "$out"
dir="$(mktemp -d)" && cp -R evals/fix-node/repo/. "$dir" && cd "$dir"
git init -q -b main
git apply -R "$stackwise/evals/fix-node/pr.diff"
git add -A && git -c user.name=stackwise-eval -c user.email=eval@localhost commit -qm "chore: base"
git switch -qc feat/assets
git apply "$stackwise/evals/fix-node/pr.diff"
git add -A && git -c user.name=stackwise-eval -c user.email=eval@localhost commit -qm "feat: serve static assets"
count="$(git rev-list --count HEAD)"
perl -e 'alarm shift; exec @ARGV' 900 \
  claude --plugin-dir "$stackwise" -p "/stackwise:stackwise-fix" --permission-mode acceptEdits \
    --allowedTools "Bash(npm test:*)" "Bash(node:*)" "Bash(git diff:*)" "Bash(git status:*)" \
      "Bash(git log:*)" "Bash(cp -p:*)" > "$out/fix-node-fix.md" 2>&1
node "$stackwise/evals/fix-node/check.mjs" "$dir" "$count"
npm test
git diff --stat
cd "$stackwise"
```

`check.mjs` exercises `src/assets.js` directly and also starts `src/server.js` on a free
port, because the crash can be fixed in either file. It prints one PASS or FAIL line
per check and exits 1 on any FAIL. On the unfixed tree it fails six checks, and that
is the baseline a run has to clear.

| Result | Meaning |
|--------|---------|
| **pass** | Both musts in `fix-node/expected.md` fixed, every `check.mjs` line PASS, `npm test` green, no new commit, and the diff limited to `src/` (a new test file is allowed). |
| **partial** | One must fixed, or both fixed with edits outside `src/`. |
| **fail** | Neither fixed, `npm test` red, an existing test edited or deleted, or a commit made without being asked. |

The run's own report (`$out/fix-node-fix.md`) should list each finding as fixed or
reverted, with the check it used to confirm the breaking input no longer breaks.

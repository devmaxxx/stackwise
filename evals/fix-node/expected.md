# Expected findings: fix-node

Stacks the skill should detect: Node backend (`node:http`, from the `node:*` imports). Required references: nodejs, security, error-handling, testing. Optional: performance. Must not load: typescript, react, nextjs, nestjs, or any .NET reference.

## must

1. **Path traversal out of the asset root** — `src/assets.js:12`. `resolveAsset` decodes the URL path and `join`s it onto `root` with no check that the result stays inside it.
   - Breaks when: `GET /assets/..%2fpackage.json` returns the project's `package.json`, and `GET /assets/..%2f..%2f..%2fetc%2fpasswd` (or `curl --path-as-is http://host/assets/../../.env`) reads any file the process can read. Node's `http` does not normalise `req.url`, and `%2f` survives until `decodeURIComponent`.
   - Fix: `const base = resolve(root); const file = resolve(base, rel);` and answer 404 (or 403) unless `file.startsWith(base + sep)`. A bare `startsWith(base)` still lets `..%2fpublic-private%2fsecret.txt` through.

2. **A malformed escape crashes the server** — `src/assets.js:11` (or `src/server.js:12`; one finding). `decodeURIComponent` runs outside the `try`, so `serveAsset` rejects with `URIError`, and the `async` request handler awaits it with no `catch`.
   - Breaks when: one `GET /assets/%E0%A4%A`. The rejection is unhandled, Node 15+ exits under the default `--unhandled-rejections=throw`, and every other client loses the server until something restarts it.
   - Fix: decode inside a `try` and answer 400 (or 404) on `URIError`, and wrap the handler body in a `try/catch` that answers 500, so no later rejection takes the process down.

## Acceptable extra findings (not required)

- `req.url` keeps the query string, so a cache-busting `/assets/app.css?v=3` looks for a file named `app.css?v=3` and answers 404 (should).
- No test covers traversal or a malformed escape; the new tests pin only the happy path (testing.md; a should only if sibling code is tested, otherwise a note).
- No `X-Content-Type-Options: nosniff`, and any method (`POST`, `DELETE`) gets the file. Nits at most.

## Must not be reported

- Style: `slice` vs a regex, the `TYPES` map, ESM vs CommonJS.
- "Use Express, `express.static` or helmet", or other framework advice.
- `readFile` instead of a stream: these are small static assets.

## Fix outcome

What a correct `/stackwise:stackwise-fix` run on this fixture leaves behind (see the Fix eval in `../README.md`):

- Both musts fixed by minimal patches in `src/`: a containment check after `resolve`, a guarded decode, and a `catch` in the handler, or equivalents. No unrelated edits.
- `npm test` green, with the two existing tests unchanged.
- The breaking inputs no longer break: `check.mjs` prints only PASS lines, against both the module and the running server.
- No new commit (committing was not asked) and nothing pushed.
- Tests not weakened: `test/assets.test.js` is untouched. A new regression test is allowed but not required.

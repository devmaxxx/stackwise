# Expected findings: node

Stacks the skill should detect: Node backend (Express 4, from `package.json`). References: nodejs, security, testing. Do not load TypeScript or React.

## must

1. **Express 4 async handler does not forward errors** — `server/routes/invoices.js:18`. The new `async (req, res)` handler has no `try/catch`/`next(err)`, and Express 4 ignores the returned promise.
   - Breaks when: `db.query` rejects (database restart, `req.params.id = "abc"` against an integer column). The request hangs until the client times out, and Node logs an unhandled rejection (on Node 15+ with default settings it crashes the process).
   - Fix: wrap the body in `try { ... } catch (err) { next(err); }` like the sibling `GET /` handler, or upgrade to Express 5 / add `express-async-errors`.

## should

2. **Synchronous file read on every request** — `server/routes/invoices.js:26`. `fs.readFileSync` blocks the event loop on each call.
   - Breaks when: a burst of invoice views. Each read stalls every other in-flight request.
   - Fix: read the template once at module load, or use `await fs.promises.readFile(...)` and cache the result.

## Acceptable extra findings (not required)

- `customer_name` goes into HTML unescaped, so a customer named `<script>...` gives stored XSS (must if the name is user-controlled). Fix: HTML-escape values or use a template engine with auto-escaping.
- `String.prototype.replace` with a string pattern replaces only the first occurrence of each placeholder.
- Horizontal: the sibling `GET /` uses `try/catch` + `next(err)`, and the new handler drifts from it. Fold this into finding 1.

## Must not be reported

- The patch bump of `express` in `package.json` (no lockfile in the fixture). Report it only as a note.
- `require` vs `import` style.

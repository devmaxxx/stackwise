# Expected findings: react

Stacks the skill should detect: React, TypeScript. References: react, typescript, security, testing. Do not load the .NET or Node references.

## must

1. **Stale closure from a missing effect dependency** — `web/src/features/orders/OrderSearch.tsx:23`. The polling effect reads `customerId` and `query`, but its dependency array is `[pollMs]`.
   - Breaks when: the user types "1042". The next poll fetches with the original empty `query` and overwrites the filtered results with the unfiltered list. When `customerId` changes, the poll keeps loading the previous customer's orders, which shows another customer's data on screen.
   - Fix: add `[pollMs, customerId, query]` to the dependency array, or read the latest values from a ref. Better, drop the hand-written polling and use TanStack Query with `refetchInterval`.

## should

2. **Fetch race without abort** — `web/src/features/orders/OrderSearch.tsx:11`. Each keystroke starts a fetch, and nothing cancels or ignores the earlier ones.
   - Breaks when: the user types "ab" quickly and the response for "a" arrives after the one for "ab". The list then shows results for "a" while the input says "ab".
   - Fix: create an `AbortController` in the effect, pass `signal`, and call `ctrl.abort()` in the cleanup, ignoring `AbortError`. The interval fetch needs the same guard.

## Acceptable extra findings (not required)

- There is no error handling. A non-2xx response or a network error gives an unhandled rejection and leaves results stale with no error state (should).
- `r.json()` is trusted as `Order[]` with no runtime validation (typescript.md, should if the API is external).
- There are no loading or empty states.
- There is no test for the race or the stale poll (testing.md).

## Must not be reported

- The en dash in the list item text, and other formatting.
- A request to memoize `results.map`, since there is no evidence of cost.

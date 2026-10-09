# Independent prototype review (2026-10-09)

## Scope

Read the repository tree, package scripts, CI workflow, ACAN baseline, competitive landscape, unsolved problems, candidate ranking, red-team review, final recommendation, and the isolated TypeScript/Soroban prototype sources. This was a source review through GitHub; the local test suites were not executed by this review session.

## Finding: provenance labels can be trusted while the plan is wrong

In `research/prototype/src/plan.ts`, a `catalog` value is labelled `pinned`; selecting an item from that list preserves the label. In `research/prototype/src/cosigner.ts`, the co-signer re-executes the caller-supplied plan and verifies that the payment's recipient and amount match the plan, then checks those values' labels. The code did not independently verify that a plan selecting an item from the catalog followed the product the user signed.

### Concrete attack

1. User signs a structured request for `product=ledger-report` and a maximum amount.
2. A compromised planner submits a plan that ignores the `product` field and chooses the cheapest entry in the whole guardian-pinned catalog.
3. The plan selects `news-digest` at 0.003 USDC.
4. Its recipient and price derive from the trusted catalog, so their labels are `pinned`; no tool output is needed.
5. The authorization entry matches the plan and is under the budget. Provenance-only checks could therefore cosign a payment for a different product.

This is distinct from prompt injection: the planner itself can be malicious, even if all its data inputs are clean. The original threat model explicitly lists a malicious planner on clean inputs as a residual risk, which weakens the broad positioning claim.

## Narrow prototype mitigation added

Branch: https://github.com/phoenix-2203/acan/tree/research/provenance-intent-binding

- The test fixture now signs an explicit `selection: cheapest` policy by default.
- A malicious `ignoreRequest` plan selects the cheapest item from the whole catalog.
- Before signing a clean payment, the co-signer independently finds the cheapest pinned offer for the signed product and compares the actual transfer's recipient and amount.
- A regression test expects the unrelated product to be escalated.

The change is intentionally narrow. It does not solve arbitrary task intent, prove service quality, or make a caller-supplied plan trustworthy. Production needs a constrained typed plan/intent schema and independently recomputed semantics, plus nonce persistence and concurrency-safe budget accounting in a durable service.

## Verification state

The branch contains the patch and regression test. GitHub Actions CI passed for code commit `8b94c8fd6b441fef84a036db4509f843b6005ee7`: TypeScript typecheck, offline tests, dashboard/site builds, Rust contract tests and Soroban WASM build all succeeded. No deployed contracts, live product code, or `master` files were changed. Passing tests do not prove the full security claim; see the limitations above.
# Final recommendation (2026-10-09)

## The chosen innovation: provenance-gated payments

The smart account accepts an agent's payment only if a second, independent signer has co-signed it. That signer is a deterministic **provenance co-signer** with no AI. It re-runs the agent's plan and confirms that three things trace back only to trusted sources:
- the recipient;
- the amount;
- the decision to pay at all.

The trusted sources are the user's signed request and the guardian's pinned price book. Payments influenced by tool, merchant or web content are not co-signed. They go to the guardian's passkey, with an explanation of where the influence came from.

**Positioning sentence:** *ACAN is the agent wallet where a payment the AI was tricked into making is refused by the account itself, even when it is inside every limit, because each payment must be co-signed by a verifier that traces its recipient, amount and decision back to the user.*

## The ten questions

1. **What problem will ACAN own?** In-policy misuse. A manipulated agent pays an allowed recipient an allowed amount for the wrong reason. A second, closely related problem: a leaked agent key spends up to the limits.
2. **What does ACAN do that the closest verified competitors do not demonstrate?**
   - The account refuses a manipulated payment inside all limits.
   - The agent key alone cannot spend anything.

   No reviewed wallet, payment protocol or Stellar project does this (`COMPETITIVE_LANDSCAPE.md` §5).
3. **Mechanism.**
   - CaMeL-style data-flow labels, re-executed by an independent co-signer.
   - The co-signature is bound to the exact Soroban auth entry and the exact rule.
   - The account enforces it with OZ `weighted_threshold`, alongside ACAN's existing limits.
4. **Why it is hard to reproduce.** The on-chain part is simple. The hard part is sound label propagation: through lookups, arithmetic, strings and control flow, with no abort channel. It must also be bound to the decoded transaction, and be correct against adversarial tests. Each of those is a place where a naive copy leaks.
5. **Why Stellar and Soroban.**
   - Context rules with several independent signers and policies that must all pass come from audited OZ code, so no new contract is needed.
   - Soroban auth entries are explicit XDR that a verifier can decode and hash itself.
6. **What the user or developer gains.**
   - Autonomy for clean tasks, with no click per purchase.
   - A hard stop for manipulated ones.
   - A stolen agent key is worthless on its own.
   - Every decision is a case file that anyone can re-run.
7. **Smallest credible implementation.** The prototype in `research/prototype/`. It is built (see results below).
8. **What can be demonstrated live.**
   - "Buy the cheapest ledger report" is co-signed and paid.
   - "Buy what today's market note recommends" contains an injection steering to the full dataset at an allowlisted merchant, inside every cap. The co-signer escalates it, the agent's signature alone is refused by the account, and the guardian sees the reason.
   - This is built offline today. The live testnet version still needs to be built.
9. **What cannot yet be claimed.**
   - Not tested on testnet.
   - Not wired into the agent, MCP or site.
   - The co-signer is trusted: the chain checks that it signed, not what it checked.
   - It does not catch a malicious planner given clean inputs (A9), or persuasion of the human (A10).
   - Data-dependent purchases always escalate, which has a utility cost.
   - Not "intent" or "correctness" in general: only where the values came from.
10. **What would prove the differentiation claim wrong.**
   - A shipped wallet or protocol whose account or signer refuses payments based on the data-flow provenance of their arguments.
   - A paper describing that.
   - A bypass of the label propagation that the tests do not cover.

## Comparison

- **Eunomia:** a separate treasury contract holds the funds. It enforces payee allowlist or reputation, a per-payment cap, a rolling 24-hour window, one session cap, admin-released escrow, and after-the-fact ZK proofs of daily totals. In-policy misuse is acknowledged as unaddressed.
- **ACAN today:** funds stay in an OZ smart account controlled by a passkey. On-chain it enforces the allowlist, per-merchant caps, per-payment and count limits, the rolling limit, and expiry. It also has guardian approve-once, x402 from the smart account, a private mode, signed receipts and MCP. A leaked agent key or a manipulated agent can still spend up to the limits on allowed merchants.
- **ACAN with provenance gating:** the same limits, plus:
  - the account refuses any agent payment that the provenance co-signer has not traced to the user's request and the guardian's price book;
  - the agent key alone authorizes nothing.

## Prototype results (run 2026-10-09)

| Suite | Result |
|---|---|
| TypeScript co-signer adversarial tests (`research/prototype/test/cosigner.test.ts`) | **19 / 19 pass** |
| Encoding and fixture tests (`payload.test.ts`): two-signer payload byte-identical to smart-account-kit; Rust fixture matches | **4 / 4 pass** |
| Soroban host tests (`research/prototype/soroban`, real ed25519 signatures, OZ `do_check_auth` 0.7.2, ACAN merchant policy v0.3) | **8 / 8 pass** |
| Mutation check: 7 deliberate weakenings of the co-signer, each re-run against the TypeScript suite | **7 of 7 caught** |
| Existing product tests (before the prototype; unchanged code) | TypeScript 62 / 62, Rust 10 / 10 |

**What the Soroban tests show:**
- Signatures made by the TypeScript agent and co-signer are accepted together.
- Either one alone is refused (3213).
- The steered payment is accepted by today's agent-only rule but refused by the gated rule.
- Signatures do not transfer to another payment: the ed25519 check fails.
- The allowlist (3401), per-payment limit (3408) and spending limit (3221) still apply when both have signed.

**Red-team finding A6, confirmed:**
- `simple_threshold(2)` is bypassed by two agent keys.
- `weighted_threshold` with co-signer weight W ≥ number of agent keys fixes it.
- With too many agent keys for the chosen W it is bypassable again, which is shown in a test. The guardian must keep W ≥ the number of agent keys.

**Demo output** (`npm run research:demo`):
- Clean and no-abort plans are co-signed.
- Every steered, laundered, implicit-flow and planner-literal plan is escalated, with the specific source named.

## Feasibility and the integration path (needs your approval)

1. Co-signer service.
2. Two-signer support in `SmartAccountAgentSigner`.
3. Device-signed requests in the chat.
4. A dashboard option to create a "provenance-gated" rule (adds the co-signer signer plus `weighted_threshold`; all existing policies unchanged).
5. The two-prompt demo on testnet.

Estimate: about 3–4 days. Nothing in today's flow changes unless the guardian creates a gated rule.

## What would make us abandon it

- A verified prior implementation at the signer or account layer.
- A label bypass that cannot be fixed without making every payment escalate.
- On testnet, the facilitator or smart-account-kit cannot carry two signers.
- The escalation rate on realistic tasks is so high that it becomes an approval screen in disguise.

---

## Status update (2026-10-09, evening): approved, built, verified on testnet

The direction was approved and moved from the isolated prototype into the product.
`research/prototype/src/*` now re-exports `packages/core/src/provenance/*`, so the
prototype's adversarial tests run against the product code.

| What | Where | Testnet evidence |
|---|---|---|
| Gate in the browser (Autopilot): planner, signed request, labelled plan, co-signer, OZ weighted threshold | `apps/site`, `packages/core/src/provenance` | Clean task co-signed and paid ([`c7356335…`](https://stellar.expert/explorer/testnet/tx/c73563358346d9464145afe3e416cdf2a76ab0aea2dfb36ee792d9d922ff0e5a)). Injected task held. The agent's key alone was refused on-chain (#3213) |
| Gate for any AI client (MCP / command line): co-signer service, gated x402 signer, tasks signed in the dashboard | `apps/cosigner`, `apps/mcp`, `apps/web`, `scripts/demo-gate.ts` | Matching purchase paid ([`35cf78c6…`](https://stellar.expert/explorer/testnet/tx/35cf78c654596891cba2df9936e404c2d0302eba421298b875720d3eb743290f)). The pricier merchant and the uncovered item were refused by the co-signer. The agent alone was refused (#3213) |
| Explainable receipts | `packages/core/src/provenance/explain.ts`, site Receipts | Run on the site: every decision, including the hold, was re-run and verified |
| Agents hiring agents (candidate C12, previously deferred) | `packages/core/src/provenance/delegation.ts`, site Agent team | Run on the site: narrowing, budgets charged up the chain, and cascading cancellation all behaved as specified |
| On-chain gate policy | `contracts/cosigner-gate-policy` (OZ `weighted_threshold`, unchanged) | Deployed at `CDFMTQUF…RIOLP` |

**What changed against the plan above.**
- The prototype's "Not run on testnet" limitation is resolved. Two-signer payloads go
  through ACAN's facilitator; it now also ignores bookkeeping events from ACAN's own
  policies, while still checking token events.
- C12 is implemented with the co-signer as the enforcer. Sub-agents hold no key on the
  account, and the chain checks only the co-signature. The limits in "What cannot yet
  be claimed" still apply.

# ACAN video: fact inventory

Every claim the film makes, with its status and where it is proven. Only rows marked
**Allowed** may appear in the film. Paths are in this repository; transactions are on
Stellar testnet and linked in the README.

Status key: **IMPLEMENTED** (exists and was demonstrated), **PARTIAL** (exists with a
stated limit), **DEMO** (works, but only in a demo setting), **ROADMAP** (not built),
**UNKNOWN** (not verified; kept out of the film).

## Authority and enforcement

| # | Claim | Status | Evidence | Video |
|---|---|---|---|---|
| F1 | The money sits in an OpenZeppelin smart account on Stellar, controlled by the guardian's passkey | IMPLEMENTED | `contracts/Cargo.toml` (stellar-accounts 0.7.2), `apps/web/src/acan.ts`, `apps/site/src/sandbox.ts` (smart-account-kit 0.8.0, passkey wallet) | Allowed |
| F2 | The agent has its own ed25519 key, honoured only under a context rule on the smart account | IMPLEMENTED | `packages/core/src/agent-signer.ts`, `apps/web/src/acan.ts` `grantAgent` | Allowed |
| F3 | A rolling spending limit per period is enforced on-chain (OpenZeppelin spending-limit policy) | IMPLEMENTED | `apps/web/src/acan.ts`; README "Public mode": 5 payments settled, the 6th refused `SpendingLimitExceeded` | Allowed |
| F4 | Only listed recipients can be paid (ACAN merchant budget policy, Soroban/Rust); otherwise `RecipientNotAllowed` (#3401) | IMPLEMENTED | `contracts/merchant-allowlist-policy/src/lib.rs` (error 3401), README "Merchant allowlist"; live demo site run, user-confirmed 8 Oct 2026 | Allowed |
| F5 | Per-merchant caps per period (`RecipientCapExceeded` #3406) | IMPLEMENTED | `lib.rs` 3406; README "Per-merchant caps" (`npm run demo:caps`) | Allowed |
| F6 | Largest single payment (`PaymentTooLarge` #3408), policy v0.3 | IMPLEMENTED | `lib.rs` 3408, 10 Rust tests in `contracts/merchant-allowlist-policy/src/test.rs`; rule #12 status output | Allowed |
| F7 | Maximum number of payments per period (`TooManyPayments` #3407) | IMPLEMENTED | `lib.rs` 3407 | Allowed (mention only) |
| F8 | Rules expire on their own (`valid_until`, enforced by the smart account) | IMPLEMENTED | `apps/web/src/acan.ts` lines ~106-128 | Allowed |
| F9 | The guardian revokes a rule with one passkey approval; the agent's key then authorizes nothing | IMPLEMENTED | `apps/site/src/sandbox.ts` `revoke`, README "In the browser" (every payment after revoke refused) | Allowed |
| F10 | Approve once: a blocked payment can be approved by the guardian's passkey; the agent's allowance is unchanged | IMPLEMENTED | README "Guardian approval" (tx `faf52259…`), `apps/site/src/SandboxSection.tsx` `approveOnce` | Allowed |
| F11 | Emergency stop revokes every live agent rule | IMPLEMENTED | `apps/web/src/App.tsx` "Emergency stop" | Allowed (mention only) |
| F12 | The AI drafts an allowance from plain English; only the guardian's passkey creates it | IMPLEMENTED | `apps/agent/src/policy-draft.ts`, `apps/web/src/PolicyComposer.tsx` | Allowed |
| F13 | Current rule #12: 0.2 USDC per 17,280 ledgers (about a day), Northwind cap 0.05, Southgate cap 0.02, largest single payment 0.05 USDC, 7-day expiry | IMPLEMENTED | `npm run status` output, 8 Oct 2026 (README); `deployments/testnet.json` `agentRuleId: 12` | Allowed (verbatim numbers only) |

## The AI agent

| # | Claim | Status | Evidence | Video |
|---|---|---|---|---|
| A1 | An AI agent (Groq `openai/gpt-oss-120b`, or Claude, or a local model) compares merchants and proposes; the user picks | IMPLEMENTED | `apps/agent/src/chat-engine.ts`, `llm.ts`, `apps/agent/test/chat-engine.test.ts` | Allowed |
| A2 | Prices on the options come from the merchant catalog, never from the model | IMPLEMENTED | `chat-engine.ts` `priceOf`; test "price comes from the catalog" | Allowed |
| A3 | A prompt-injected transfer is offered by the AI, picked, and refused by the smart account with #3401; no funds move | IMPLEMENTED | dashboard: README notes + user-confirmed run; demo site: `apps/site/src/ai-agent.ts`, user-confirmed 8 Oct 2026 ("Blocked by your smart account: Recipient is not approved (#3401). No funds moved.") | Allowed |
| A4 | The demo site's AI pays from each visitor's own sandbox wallet, in XLM, to the shops' addresses directly (not over x402) | DEMO | `apps/site/src/SandboxSection.tsx`, `apps/relay/server.mjs`; user-confirmed "PAID 0.8 XLM to Southgate Data" | Allowed, labelled testnet demo |
| A5 | Merchant data is passed to the model as untrusted data | IMPLEMENTED | `chat-engine.ts` `untrustedData` | Allowed (mention only) |

## Payments and Stellar

| # | Claim | Status | Evidence | Video |
|---|---|---|---|---|
| P1 | The agent pays merchants over x402 (v2, `@x402/*` 2.28.0) in USDC, straight from the smart account | IMPLEMENTED | `packages/core/package.json`, `packages/core/src/x402-smart-account-scheme.ts`; tx `4394246d…` (0.01 USDC to Northwind) | Allowed |
| P2 | The merchant delivers only after settlement; if settlement fails the response is withheld | IMPLEMENTED | `packages/core/test/attacks.test.ts` "[I1]" | Allowed |
| P3 | Merchant side hardened against published x402 attacks: request binding, exactly-once delivery, payTo pinning, private caching | IMPLEMENTED | `packages/core/src/merchant-guards.ts`, `attacks.test.ts` [I3] [I4] [II] [III] | Allowed |
| P4 | Private mode: per-request signed vouchers, settled in confidential transfers whose amounts are hidden on-chain; the guardian's auditor key decrypts | IMPLEMENTED | `packages/core/src/tab/*`, `packages/confidential/src/audit.ts`; README "Private mode": 7 paid requests, 0 per-request transactions, 3 confidential settlements, audit matched 0.07 USDC | Allowed (verbatim numbers only) |
| P5 | MCP server: any MCP client can use the guarded wallet (5 tools: list merchants, check budget, buy, request approval, settle tabs) | IMPLEMENTED | `apps/mcp/src/server.ts`, `apps/mcp/test/mcp.test.ts` | Allowed |
| P6 | Signed task receipts; anyone can check them against the chain (CLI and demo site) | IMPLEMENTED | `packages/core/src/receipt.ts`, `receipt-check.ts`, `scripts/verify-receipt.ts`, `apps/site/src/ReceiptSection.tsx`; verified output for tx `4394246d…` | Allowed |
| P7 | Everything runs on Stellar testnet | IMPLEMENTED | `packages/core/src/config.ts` `TESTNET` | Must be stated |

## Context

| # | Claim | Status | Evidence | Video |
|---|---|---|---|---|
| C1 | May 2026: an instruction hidden in Morse code led an AI agent with wallet access to send roughly $150,000-200,000; no key was stolen | External, cited | `apps/site/src/App.tsx` "Why this matters" (dev.to analysis, OECD AI incident 2026-05-04) | Allowed, with "roughly" |

## Roadmap (VISION only, clearly labelled)

| # | Idea | Status | Video |
|---|---|---|---|
| R1 | Delegated authority: an agent passes a narrower allowance to another agent | ROADMAP | VISION label only |
| R2 | Mandates bound to a stated task and its outcome; pay only on verified delivery | ROADMAP | VISION label only |
| R3 | Backup signer for recovery | ROADMAP | Not shown |
| R4 | Mainnet, audits | ROADMAP / none | Never claimed |

## Kept out of the film

- Any user counts, volumes, performance numbers or partnerships: none exist.
- "Audited", "secure", "safe" as guarantees: not claimed.
- Transaction hashes other than those linked in the README.

## Film v2 (2:35, 9 Oct 2026)

| # | Claim | Status | Evidence | Video |
|---|---|---|---|---|
| V1 | In May 2026 a Morse-code prompt led Grok to issue a command a trading bot (Bankr) executed, sending 3 billion DRB to the attacker, worth over $150,000 | External, reported | OECD.AI incident record 2026-05-04; The Crypto Times 4 May 2026; Giskard 7 May 2026. Value range $150,000–200,000 across reports; recovery left out (reports differ). "In seconds" not used (no source times it) | Allowed, retold in recreated text, sources on screen |
| V2 | Paying an unlisted address is refused by the smart account (#3401) | IMPLEMENTED | F4 | Allowed |
| V3 | A payment steered by fetched content to an allowed shop, inside every limit, is not co-signed | IMPLEMENTED | README "Verified on testnet" (Tidewire task held); `packages/core/src/provenance/cosigner.ts`; 19 adversarial tests | Allowed |
| V4 | The agent's key alone is refused on a gated rule (#3213, OZ weighted threshold) | IMPLEMENTED | README "Verified on testnet"; research Soroban tests | Allowed |
| V5 | The clean task was co-signed and paid | IMPLEMENTED | tx `c7356335…` | Allowed |
| V6 | The planner never sees fetched content; the co-signer has no AI and re-runs the plan | IMPLEMENTED | `apps/relay/server.mjs` PLANNER_PROMPT and `/plan`; `cosigner.ts` | Allowed |
| V7 | The gate works for MCP clients; tasks are signed in the dashboard; matching purchase paid, others refused | IMPLEMENTED | `npm run demo:gate` output in README, tx `35cf78c6…` | Allowed |
| V8 | Agents hiring agents: hand-offs only narrow, spend counts up the chain, cancelling cascades | IMPLEMENTED (co-signer enforced) | `delegation.ts`, 7 tests; site run 9 Oct 2026 | Allowed |
| V9 | Private mode hides amounts on-chain; the auditor key reads them | IMPLEMENTED | README "Private mode"; replay of the recorded run | Allowed |
| V10 | Receipts re-run why each payment was allowed or held | IMPLEMENTED | `explain.ts`, 3 tests; site run 9 Oct 2026 | Allowed |

**What the v2 captures stage** (`renderer/capture-v2.mjs`, `apps/site/src/harness-film.tsx`):
the real site and dashboard components, with the network replaced. The co-signer, the plan
runner, request signing and the receipt's offline checks run for real in the page. The
planner's replies are the two example plans in its own system prompt (temperature 0). The
chain's answers are the outcomes observed on testnet: paid (`c7356335…` for the clean
task), #3213 for the agent alone, #3401 for an unlisted address. Clock times, account and
key strings in the captures belong to the harness's own deterministic keys.

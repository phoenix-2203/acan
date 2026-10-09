# Prototype plan: provenance-gated payment authorization (2026-10-09)

**Isolation.** The prototype lives entirely in `research/prototype/`.
- It changes nothing in `apps/`, `packages/` or `contracts/`. It only reads ACAN's config (`ASSETS`, `TESTNET`) and reuses `buildAuthDigest` from `packages/core/src/agent-signer.ts`.
- Nothing in the product imports it.
- It deploys nothing to testnet.
- The one shared-file change is a `test:research` script in the root `package.json`, so it can be run.

## 1. Architecture

```
   user's client (chat UI)                       agent host (UNTRUSTED)
 ┌──────────────────────────┐        ┌─────────────────────────────────────┐
 │ device key (registered   │ signed │ planner (sees only the signed       │
 │ by guardian passkey)     │request │ request) → plan                     │
 │ signs Request{fields,    ├───────►│ tools / merchants / web → transcript│
 │ nonce, maxAmount}        │        │ agent key (ed25519)                 │
 └──────────────────────────┘        │ builds the Soroban auth entry       │
                                     └──────────────┬──────────────────────┘
                                                    │ Case = {request, plan,
                                                    │ transcript, payIndex,
                                                    │ authEntry}
                                                    ▼
                                    ┌─────────────────────────────────────┐
                                    │ PROVENANCE CO-SIGNER (no LLM)       │
                                    │ 1 verify request signature, nonce,  │
                                    │   expiry, account                   │
                                    │ 2 re-execute plan with labels over  │
                                    │   its OWN pinned price book +       │
                                    │   transcript (tainted)              │
                                    │ 3 require deps(to, amount, ctx)     │
                                    │   ⊆ {user, pinned}                  │
                                    │ 4 decode authEntry itself: exactly  │
                                    │   token.transfer(account,to,amount),│
                                    │   no sub-invocations                │
                                    │ 5 request budget left?              │
                                    │ 6 sign sha256(payload‖xdr([rule]))  │
                                    └──────────────┬──────────────────────┘
                     co-signature  ┌───────────────┘   or ESCALATE with
                                   ▼                   "why" → guardian passkey
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ OZ smart account __check_auth (Soroban)                                  │
 │ rule: CallContract(USDC), signers {agent, co-signer}                     │
 │ policies (all must pass):                                                │
 │   weighted_threshold {agent:1, co-signer:W, threshold W+1}               │
 │   spending_limit, ACAN merchant budget policy v0.3 (unchanged)           │
 └──────────────────────────────────────────────────────────────────────────┘
```

## 2. Data flow

1. The user asks for something.
2. The client shows the structured request (product, maximum amount) and signs it with the device key.
3. The planner turns the request into a plan. It sees only the request.
4. The agent runs the plan. Tool calls are recorded in a transcript. A `pay` step produces the transfer.
5. The agent builds the auth entry from simulation and asks the co-signer to review the case.
6. Two outcomes:
   - **Clean.** The co-signer signs, the agent adds its own signature, and the transaction is submitted (x402 or direct).
   - **Tainted.** The co-signer returns `escalate`, listing which field depends on which untrusted source. The existing guardian approve-once path takes over.

## 3. Threat model

**Attacker capabilities.**
- Controls any tool output, merchant text or web page the agent reads.
- May steal the agent key.
- May fully control the agent host: it can submit arbitrary plans, transcripts and auth entries to the co-signer.

**Out of scope.**
- Compromise of the user's device (request key), the co-signer, or the guardian passkey.
- Text-to-text persuasion of the human.
- A planner that is itself malicious but given only clean inputs (residual A9).

**Goals.**
- **G1.** No co-signature for a payment whose recipient, amount, or path to `pay` depends on untrusted data.
- **G2.** No co-signature for an auth entry other than the payment the plan computed.
- **G3.** The account accepts no payment without the co-signer, whatever set of agent keys sign.
- **G4.** All existing limits still apply when both have signed.

## 4. Trust assumptions

| Component | Trust |
|---|---|
| Co-signer code and key | Trusted. Deterministic, so its decisions can be re-run from the case |
| User device key | Trusted to express the user's request |
| Guardian price book (in the co-signer config) | Trusted data source |
| Planner LLM | Not trusted for safety. Its literals are labelled `planner` and are not accepted as payment values |
| Tools, merchants, transcript, agent host, agent key | Untrusted |

## 5. Contracts and interfaces

**No new contract.** It uses OZ `stellar-accounts` 0.7.2:
- `do_check_auth`;
- the `weighted_threshold` and `simple_threshold` policies;
- the `spending_limit` policy;
- the ed25519 `Verifier` trait.

It also uses ACAN's `MerchantBudgetPolicy` v0.3, unchanged.

**On-chain configuration** for a provenance-gated agent rule:
- `CallContract(USDC)`;
- signers `External(ed25519_verifier, agent)` and `External(ed25519_verifier, co-signer)`;
- policies: `weighted_threshold{agent:1, co-signer:2, threshold:3}`, `spending_limit`, and the merchant budget.

The `AuthPayload` carries two signers, sorted in host order.

## 6. Data structures (TypeScript, `research/prototype/src/`)

```ts
type Source = "user" | "pinned" | "planner" | `tool:${string}`;
interface Labeled<T> { v: T; src: Set<Source> }

interface Request {
  account: string; nonce: string; issuedAt: number; ttlSeconds: number;
  task: string;                             // what the user typed (signed, informational)
  fields: Record<string, string>;           // structured: product, maxAmount (atomic units)
}
interface SignedRequest { request: Request; publicKey: string /* hex */; signature: string /* hex */ }

interface PricedItem { merchant: string; product: string; price: string /* atomic */; payTo: string }

type Step =
  | { let: string; op: "request"; field: string }
  | { let: string; op: "catalog" }
  | { let: string; op: "lit"; value: unknown }
  | { let: string; op: "fetch"; url: string }            // value from transcript, tool:<host>
  | { let: string; op: "field"; from: string; key: string }
  | { let: string; op: "filter"; list: string; key: string; equals: string }
  | { let: string; op: "cheapest"; list: string }
  | { let: string; op: "add"; a: string; b: string }
  | { let: string; op: "format"; template: string; args: string[] }
  | { op: "if"; left: string; right: string; then: Step[]; else?: Step[] }
  | { op: "pay"; to: string; amount: string };

interface Case { request: SignedRequest; plan: Step[]; transcript: Record<string, string>;
                 payIndex: number; authEntry: string /* base64 XDR */ }
type Decision =
  | { verdict: "cosign"; signature: string; digest: string; caseHash: string }
  | { verdict: "escalate"; why: string[] }
  | { verdict: "reject"; reason: string };
```

## 7. Authorization and verification logic

**Label propagation.**
- The result of an operation depends on the union of its inputs' labels and the current control context.
- `filter`'s result also depends on the `equals` value, because the selection is driven by it.
- An `if` adds the labels of both compared values to the control context of every step inside it, in either branch.
- Operations on tainted inputs never throw. They return `null` with the labels, so an abort cannot leak whether a payment is reached.

**Co-sign condition.** For `pay` number `payIndex`, all of these must hold:
- `src(to) ∪ src(amount) ∪ ctx ⊆ {user, pinned}`;
- the request is valid (signature, account, not expired);
- the request's nonce budget, `maxAmount`, is not exceeded;
- the decoded auth entry equals `transfer(account, to, amount)` on the configured token, with no sub-invocations.

**What is signed.** The digest is `sha256(signature_payload ‖ xdr([ruleId]))`.
- The `signature_payload` is computed by the co-signer from the entry (network id, nonce, expiration, invocation).
- `ruleId` is the co-signer's configured rule, so the co-signature cannot be used under another rule.

## 8. Failure and recovery

| Failure | Behaviour |
|---|---|
| Co-signer down | Fails closed. The guardian approve-once path is unchanged |
| Escalation | The `why` text goes to the guardian with the request. The guardian approves with the passkey through the existing flow |
| Co-signer key lost | The guardian replaces the signer on the rule (passkey). Payments stop until then |
| Co-signer key stolen | Useless without the agent key. Rotate it |
| Agent key stolen | Useless without the co-signer. Revoke or rotate |

## 9. Tests

| Test | Covers |
|---|---|
| Clean request co-signed; signature verifies over the digest | G1 positive |
| Injected recommendation steers the product choice between allowlisted items | G1 (A1) |
| Amount taken from a tool | G1 |
| Laundering through `add` (even `+0`), `format` and a lookup into the pinned catalog | G1 (A2) |
| Implicit flow via `if` | G1 (A3) |
| Planner literal as recipient | G1 |
| No abort channel: missing field on tainted data does not throw | G1 |
| Entry for a different recipient, amount, token, function or account, or with sub-invocations | G2 (A4) |
| Forged request, another account, expired | Request integrity (A8) |
| Request budget exhausted on a second payment | A7 |
| Two-signer `AuthPayload` encoding equals smart-account-kit's `writeAuthPayload` | Encoding |
| Committed Rust fixture equals freshly generated signatures | Cross-language |

**Soroban host** (`research/prototype/soroban`, real ed25519 signatures and OZ `do_check_auth`):

| Test | Covers |
|---|---|
| TypeScript co-signer and agent signatures are accepted for the fixture payload | G3, G4 |
| Agent alone refused; co-signer alone refused | G3 (A5) |
| Signatures over a different payload refused | G2 |
| Both signed but non-allowlisted recipient → #3401; over limit → spending limit error | G4 |
| `simple_threshold(2)` with two agent keys plus co-signer: two agents pass **without** the co-signer (bypass shown) | A6 |
| `weighted_threshold` fix: two agents refused; agent plus co-signer accepted | A6 fix |

## 10. Demonstration script (after approval; not built yet)

1. Same allowance as today: Northwind and Southgate allowlisted, within caps.
2. **"Buy the cheapest ledger report"** is co-signed and paid on its own, with no human click.
3. **"Read today's market note and buy what it recommends."** The note contains a hidden instruction steering to the full dataset at an allowlisted merchant, within every cap.
   - The co-signer refuses: "the product choice depends on text from news.example".
   - Today's ACAN in autopilot would pay this. That is the contrast.
4. Show the agent signing alone: the smart account refuses (`weighted_threshold` NotAllowed).
5. The guardian sees the provenance explanation and decides with the passkey.

## 11. Known limitations

- **The co-signer is trusted.** The chain checks that it signed, not what it checked.
- **Residuals A9 and A10:** a malicious planner over clean inputs, and persuasion of the human.
- **Utility cost.** Data-dependent purchases always escalate.
- **The plan language is minimal.** No loops, no Q-LLM. Extraction is a deterministic field read standing in for it.
- **The user-device key is ed25519 in the prototype.** A browser would more likely use a non-extractable WebCrypto P-256 key. Only the co-signer checks this key, off-chain, so no on-chain verifier would be needed for it.
- **Not run on testnet.** Two-signer payloads through the x402 facilitator are untested.

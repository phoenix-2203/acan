# Red-team review of the top three candidates (2026-10-09)

The three candidates with the highest scores in `INNOVATION_CANDIDATES.md` are reviewed here:
- C1, provenance-gated authorization (77)
- C12, provenance across delegation (64)
- C2, attenuating sub-delegation (60)

Each one is tested against seven questions:
1. Does an existing project already implement it?
2. Does a paper already describe it?
3. Is there an attack that defeats the guarantee?
4. Is there an architectural reason it cannot work?
5. Is there a simpler solution?
6. Is there a hidden trust assumption?
7. Is it not meaningfully better than Eunomia?

---

## C1. Provenance-gated payment authorization

### 1. Existing implementation?

These searches were run on 2026-10-09:
- "information flow control" with agent wallet, co-signer and payment provenance
- CaMeL with crypto wallet, signer and enforce
- taint tracking with AI agent payments, policy co-signer and smart account

These are the closest systems found:

| System | What it does | Why it is not C1 |
|---|---|---|
| CaMeL / FIDES / multi-CaMeL (2503.18813, 2505.23643, 2610.05640) | Same provenance policy | Enforced inside the agent runtime. Multi-CaMeL does not mention payments at all |
| OpenClaw RFC #39160 | TypeScript port of CaMeL taint tracking | Covers messaging, exec and file tools. Not wallets |
| Sentient #127 / IncarnaMind #64 (GitHub issues) | "Ask before sending once untrusted content is in play" | Context-level taint, inside the app |
| "Signed Words Only" (undated post) | Signs content fragments with their trust tier. A gateway requires a trusted instruction or step-up for `transfer_funds` | Closest in spirit. Off-chain gateway, tracks where the *instruction* came from but not the *data flow* of recipient and amount, no account enforcement, no implementation seen |
| ERC-8273 | On-chain gating by an attestor's per-transaction attestation | Same structural shape as the on-chain half. Semantics explicitly left undefined |
| ERC-8354 | ZK verdict that an interpreter allowed an action | Same shape. The interpreter judges the action, not where its arguments came from |
| PolicyLayer two-gate, Turnkey-style policy engines, Soneso HMAC approvals | Co-signing or approvals on parameters | Parameters only |

**Verdict.** No implementation was found that has the account refuse a payment unless an independent verifier re-derived recipient, amount and decision from trusted sources. This is an absence of evidence, not proof.

The *parts* all exist: IFC labels, co-signers, and on-chain gating on attestations. C1 must therefore be described as an **architectural contribution: a new placement and binding of known techniques**, not as a new primitive.

### 2. Paper describing it?

None found. The nearest is CaMeL's banking policy, which is the same rule, enforced in the interpreter. The x402 #2641 proof of concept and Proof-Gated Signing (2610.00354) enforce, respectively, user-signed values and post-conditions at the wallet. Neither is provenance.

### 3. Attacks

| # | Attack | Outcome | Status |
|---|---|---|---|
| A1 | Injected text steers the choice between allowlisted products | Refused: the choice depends on `tool:` | Must be shown in a test |
| A2 | An untrusted value is laundered through arithmetic, string building or a lookup into the trusted price book | Refused if labels propagate through every operation, including the lookup index | Must be shown in a test |
| A3 | Implicit flow: `if (untrusted) pay(clean)` | Refused only if branch conditions taint everything in the branch (CaMeL STRICT mode) | Must be shown in a test |
| A4 | Agent sends the co-signer a plan for X but asks it to sign an auth entry for Y | Refused only if the co-signer decodes and builds the signature payload itself, never signing a digest it is handed | Must be shown in a test |
| A5 | Stolen agent key | Refused by the chain: no co-signature | Must be shown in the Soroban host |
| A6 | **Threshold bypass.** With OZ `simple_threshold(2)`, if the guardian later adds a second agent key to the rule, two agent keys meet the threshold *without the co-signer*. `simple_threshold` counts signers; it does not name them (`stellar-accounts-0.7.2/src/policies/simple_threshold.rs` `enforce`: `authenticated_signers.len() >= threshold`) | **Real weakness of the naive design.** Fix: `weighted_threshold` with the co-signer weighted so that no set of agent keys reaches the threshold without it, or a policy that requires the named co-signer | Must be shown in a test |
| A7 | User request replayed to obtain more co-signatures | Refused only if the co-signer records spend per request (single-use nonce plus a budget) | Must be shown in a test |
| A8 | Forged user request | Refused: device-key signature | Must be shown in a test |
| A9 | **Compromised planner** writes a malicious plan over clean inputs, for example picking the priciest item that matches | **Not caught by provenance.** Bounded by the request's structured fields and the on-chain limits | Residual; must be stated |
| A10 | **Text-to-text attack.** Untrusted content shown to the user persuades the *user*, who then signs the request | **Not caught.** CaMeL also scopes this out | Residual; must be stated |
| A11 | Over-tainting leads to approval fatigue and the guardian approving blindly | A utility risk, not a bypass. CaMeL reports 77% vs 84% task success | Measure on demo tasks; state |
| A12 | Co-signer down or DoS'd | Fails closed. The guardian approve-once path still works | Acceptable |
| A13 | Co-signer key *and* agent key both stolen | Bounded by on-chain limits, as today | Same as baseline |

### 4. Architectural blockers?

**OZ accepts two independent External signers on one rule, each signing the same digest.** This is confirmed by reading the code.
- In `do_check_auth`, every signer in `AuthPayload.signers` must belong to a selected rule, and each one is authenticated against `auth_digest = sha256(payload ‖ xdr(rule_ids))`.
- The rule's policies then receive the list of matched signers.

**The x402 facilitator treats the account's signature value as opaque**, so a two-signer payload needs no facilitator change. This is inferred from the facilitator's reliance on simulation, and is to be confirmed on testnet in the integration phase.

**A transfer's arguments are only `(from, to, amount)`, so the chain cannot see which product was bought.** This supports C1, because the decision is visible only off-chain. It also means the on-chain half can only require that the verifier signed. It cannot re-check the verifier's reasoning.

### 5. Simpler solution?

- **A human picks every payment.** This is ACAN's default today. It solves P1 at the cost of all autonomy, and it gives no protection in autopilot or MCP use. C1 keeps autonomy for clean cases and escalates the rest.
- **Tighter limits** reduce damage but do not distinguish a good payment from a manipulated one.
- **A pinned set of allowed amounts (C8)** narrows it, but an allowed price for the wrong product still passes.
- **A runtime-only CaMeL** is the simpler alternative. It is good, but it is useless once the agent process or its key is compromised. C1 strictly adds to it: the same check, enforced where the money is.

### 6. Hidden trust

**The co-signer is trusted.** This is the central caveat, and it is mitigated as follows:
- It runs no LLM.
- Its decision is a deterministic function of a case file that can be published and re-run by anyone.
- It can run on the user's own device, beside the request key, so there is no third-party trust.
- Its key alone cannot spend.

**The user's device key is trusted for intent.** Compromising that device is equivalent to compromising the user's intent channel. The guardian passkey still controls the rules.

### 7. Better than Eunomia?

Yes, on a specific axis.
- Eunomia (and ACAN today) stop payments to the wrong *recipient*.
- C1 stops manipulated payments to the *right* recipient, and makes a leaked agent key unable to spend on its own.

Eunomia could add a co-signer quickly. Its agent could be a multisig account. The defensible part is not that signature. It is the provenance semantics: label propagation, plan re-execution, and binding the decision to the exact auth entry. These are also what the tests must demonstrate.

### Result: C1 survives, revised

- **R1.** Use `weighted_threshold` with these weights, or name the co-signer in a policy:
  - each agent key: weight 1;
  - co-signer: weight W, with W ≥ the number of agent keys;
  - threshold: W + 1.

  Then the co-signer plus any one agent key reaches the threshold. All agent keys together reach at most W, and the co-signer alone reaches W, so neither meets it. Do not use `simple_threshold`. Demonstrate both the bypass (A6) and the fix.
- **R2.** Claim *parameter and decision provenance*, not "intent" or "correctness". State A9 and A10 as residuals.
- **R3.** The co-signer must build the signature payload from the auth entry itself (A4), and must be stateful per request (A7).

---

## C12. Provenance across delegation

1. **Existing implementation?** Multi-CaMeL (2610.05640, 2026-10-05) does provenance across agent-to-agent calls in the runtime, without payments. No payment system was found.
2. **Paper?** Multi-CaMeL covers the runtime half.
3. **Attack.** Colluding sub-agents that legitimately hold clean labels can coordinate choices. This reduces to C1's A9 residual, multiplied by the number of agents.
4. **Architecture.** It needs C1, plus a delegation structure (C2), plus labelled inter-agent messages. Three moving parts.
5. **Simpler?** Forbidding sub-delegation, as Verifiable Intent does.
6. **Hidden trust.** One co-signer per hop, or one shared co-signer that sees every hop.
7. **Better than Eunomia?** Yes, but it cannot be demonstrated credibly in this project's time frame.

**Result: deferred.** It becomes a natural phase 3 once C1 exists. It is not the primary direction.

---

## C2. Attenuating sub-delegation on Soroban

1. **Existing implementation?** MetaMask ERC-7710 does it on EVM, verified in code. Not found on Stellar.
2. **Paper?** UCAN, Biscuit and CAPMAS cover the token-level design.
3. **Attack.** Sibling collusion is bounded only by the parent. Deep chains exhaust the CPU budget, so depth needs a cap.
4. **Architecture.** OZ already allows a `Delegated(Address)` signer to be another smart account. Its `authenticate` calls `addr.require_auth_for_args((auth_digest,))` (`stellar-accounts-0.7.2/src/smart_account/storage.rs` L353-356). So:
   - **Native nesting gives cascading revocation.** Remove the parent rule, and the child account can no longer authorize through it.
   - **Native nesting does not give attenuation.** The child account sees only the digest, not the transfer, so its own `spending_limit` (which needs `transfer` arguments) cannot cap the delegated amount.
   - Attenuation therefore needs a new parent-side policy.
   - This reading of the code was not run in a test.
5. **Simpler?** Partly. Native nesting covers revocation.
6. **Hidden trust.** None beyond the contracts.
7. **Better than Eunomia?** Eunomia has no delegation. But the idea itself is a port of an EVM feature, so it does not give ACAN a distinct identity.

**Result: survives as a solid engineering roadmap item, not as the defining innovation.**

---

## Conclusion

**C1 is the only candidate that meets all three of these conditions:**
- It addresses the problem competitors themselves list as open.
- It has no implementation found at the authorization layer.
- It can be demonstrated honestly with real signatures and the real OZ authorization code.

It is selected with revisions R1–R3. If the prototype cannot show the following, the claim must be withdrawn (see `FINAL_RECOMMENDATION.md`, "What would make us abandon it"):
- A1–A8 refused;
- A6 fixed;
- the TypeScript co-signer's signatures accepted by the actual OZ `do_check_auth`.


## Additional adversarial finding: provenance is not intent binding (2026-10-09)

During an independent source review, I found a gap not covered by the existing candidate tests. The co-signer re-executes the submitted plan and labels the provenance of values, but it does not independently require that a clean payment satisfies the signed product-selection policy. A malicious planner can ignore the user's requested product, select another item directly from the guardian's pinned catalog, and produce a recipient and price labelled only `pinned`. Those labels look trusted even though the plan violates the user's request.

A minimal attack was added on the isolated branch `research/provenance-intent-binding`: a signed request asks for `ledger-report`, while the submitted plan selects the cheapest item across the entire catalog (the unrelated `news-digest`). The prototype co-signer now independently checks that a clean payment matches the signed `product` and `selection: cheapest` fields and the cheapest pinned offer for that product. An adversarial regression test covers this case.

**Verification status:** the patch is committed on the isolated research branch. GitHub Actions CI passed on code commit `8b94c8fd6b441fef84a036db4509f843b6005ee7`: TypeScript typecheck, offline tests, dashboard/site builds, Rust contract tests and Soroban WASM build all succeeded. This confirms the regression is accepted by the current suite, not that the security claim is complete. The check is a narrow prototype safeguard, not a general proof of user intent. A production version must use a typed, signed task schema and independently recompute every permitted choice; it must not trust arbitrary planner-authored plan structure or free-text task interpretation.

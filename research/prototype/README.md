# Provenance co-signer prototype (research only)

This prototype is isolated from the product. Nothing in `apps/`, `packages/` or `contracts/` imports it, and it deploys nothing. Design, threat model and limits: `../PROTOTYPE_PLAN.md`. Results: `../FINAL_RECOMMENDATION.md`.

```sh
npm run test:research    # TypeScript adversarial tests + Soroban host tests
npm run research:demo    # what the co-signer decides for each scenario
node --import tsx research/prototype/scripts/gen-fixture.ts   # regenerate soroban/src/fixture.rs
```

| Path | What |
|---|---|
| `src/plan.ts` | Plan language with data-flow labels |
| `src/cosigner.ts` | The co-signer: request check, plan re-execution, entry decoding, budget, signing |
| `src/auth.ts` | Signature payload, transfer decoding, two-signer `AuthPayload` |
| `src/request.ts` | Device-signed user request |
| `src/scenario.ts` | Synthetic keys, the price book, and honest and adversarial plans |
| `soroban/` | Soroban host tests with OZ `do_check_auth` and ACAN's merchant policy |

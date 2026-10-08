# What the film shows, and why those

The film demonstrates the capabilities a judge must see to believe the claim, in this order. IDs refer to `FACTS.md`.

| Shown as | Capability | IDs |
|---|---|---|
| The cold open and the climax | A prompt-injected payment is agreed to by the AI and refused by the smart account (#3401), no funds moved | A3, F4 |
| The authority card | Plain-English allowance drafted by the AI, created only by the guardian's passkey | F12, F13 |
| The five questions | Who (agent key under a rule), what (USDC only), how much (rolling limit, per-payment max), where (allowed merchants with caps), when (expiry) | F2, F3, F4, F5, F6, F8 |
| The approved payment | AI proposes, user picks, the account checks every policy, payment settles | A1, A2, A4, P1 |
| The Stellar flow | x402 request → agent signs under its rule → smart account `__check_auth` → Soroban policies → USDC transfer → merchant delivers | P1, P2 |
| Beyond a spending limit | Private payments with hidden amounts; signed receipts anyone can check; MCP for any agent client; hardened merchant side | P3, P4, P5, P6 |
| Control | Approve once, revoke, expiry | F8, F9, F10 |
| Vision (labelled) | Delegated and task-bound mandates | R1, R2 |

Left out on purpose: the confidential-token internals, the relay, deployment details. They are real, but they don't change what a judge needs to understand.

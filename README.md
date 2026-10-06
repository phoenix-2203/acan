# ACAN — allowances for autonomous agents on Stellar

> Work in progress for the Find Your Way hackathon. Full write-up coming.

ACAN lets a person give an AI agent a **capped, revocable spending key** for paid
APIs. The funds sit in an OpenZeppelin smart account controlled by the person's
passkey. The agent's key is honoured only under a context rule scoped to USDC and
limited by an on-chain spending-limit policy. Payments use the standard **x402**
protocol, so any x402 merchant works unchanged.

## Quick start (testnet)

```bash
npm install
npm run setup          # creates + funds testnet accounts, writes .env
npm run web            # guardian dashboard on http://localhost:5173
npm run merchant       # demo x402 merchant on http://localhost:4021
npm run agent          # the agent buys until its allowance runs out
npm run status         # balances and allowance state
```

## License

MIT

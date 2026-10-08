# ACAN merchant budget policy

A [policy](https://github.com/OpenZeppelin/stellar-contracts/tree/v0.7.2/packages/accounts/src/policies)
for OpenZeppelin smart accounts on Stellar (`stellar-accounts` 0.7.2,
`soroban-sdk` 26.1). ACAN attaches it, next to OpenZeppelin's spending-limit
policy, to the `CallContract(USDC)` rule that authorizes an AI agent's key.
Every agent payment must then satisfy both policies:

| Control | Who provides it | What it stops |
| --- | --- | --- |
| Total per period | OpenZeppelin spending-limit policy | Overspending in general |
| Allowlist of recipients | this policy | Paying anyone the guardian did not approve |
| Cap per recipient per period | this policy | One misbehaving or compromised merchant draining the whole allowance |
| Payments per period | this policy | Runaway loops of small payments |
| Largest single payment (v0.3) | this policy | One large payment without the guardian: anything bigger needs a one-off passkey approval |

Periods are fixed windows of `period_ledgers` ledgers (17,280 is about a day)
that restart with the first payment after a window ends.

## Interface

| Function | Who calls it | What it does |
| --- | --- | --- |
| `install(params, context_rule, smart_account)` | the smart account, when the policy is added to a rule | stores the settings for this account and rule |
| `enforce(context, signers, context_rule, smart_account)` | the smart account's `__check_auth`, for every authorization under the rule | allows a `transfer` that fits the allowlist, the per-payment limit, the recipient's cap and the payment count; refuses anything else |
| `uninstall(context_rule, smart_account)` | the smart account, when the policy is removed | deletes settings and usage |
| `get_params(context_rule_id, smart_account)` | anyone (read-only) | the installed settings |
| `get_recipients(context_rule_id, smart_account)` | anyone (read-only) | the allowlist |
| `get_state(context_rule_id, smart_account)` | anyone (read-only) | payments and amount per recipient in the current period |

Install parameters:

```rust
MerchantPolicyParams {
    recipients: Vec<Recipient { address: Address, cap: i128 }>, // cap 0 = allowlist only
    period_ledgers: u32,
    max_payments: u32,                                          // 0 = no limit
    max_per_payment: i128,                                      // 0 = no limit (v0.3)
}
```

The shared encoder (`packages/core/src/merchant-policy.ts`) is tested against
XDR produced by this contract's own types, for both v0.3 and v0.2, so the two
cannot drift apart. v0.2 has the same interface without `max_per_payment`.

## Errors

| Code | Name | Meaning |
| --- | --- | --- |
| 3400 | `NotInstalled` | no settings for this account and rule |
| 3401 | `RecipientNotAllowed` | the transfer's recipient is not listed |
| 3402 | `NotAllowed` | not a `transfer`, or no authenticated signer |
| 3403 | `AlreadyInstalled` | settings already exist for this account and rule |
| 3404 | `InvalidParams` | empty, longer than 20 or duplicate recipients, a negative cap, limit or amount, or a zero period |
| 3405 | `OnlyCallContractAllowed` | the rule is not a `CallContract` rule |
| 3406 | `RecipientCapExceeded` | the payment would exceed the recipient's cap for the period |
| 3407 | `TooManyPayments` | the period's payment count is used up |
| 3408 | `PaymentTooLarge` | the single payment is above `max_per_payment` (v0.3) |

## Build, test, deploy

```bash
cargo test --manifest-path contracts/Cargo.toml   # 10 tests, incl. a real smart-account auth flow
npm run allowlist:deploy                          # stellar contract build + deploy to testnet
npm run demo:allowlist                            # testnet: a recipient off the list is refused
npm run demo:caps                                 # testnet: paying past a merchant's cap is refused
```

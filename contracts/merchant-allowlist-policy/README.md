# ACAN merchant allowlist policy

A [policy](https://github.com/OpenZeppelin/stellar-contracts/tree/v0.7.2/packages/accounts/src/policies)
for OpenZeppelin smart accounts on Stellar (`stellar-accounts` 0.7.2,
`soroban-sdk` 26.1). Attached to a `CallContract(token)` context rule, it lets
that rule authorize only `transfer(from, to, amount)` calls whose `to` is on an
allowlist. ACAN installs it next to the spending-limit policy on the rule that
authorizes an AI agent's key, so every agent payment must satisfy both.

## Interface

| Function | Who calls it | What it does |
| --- | --- | --- |
| `install(params, context_rule, smart_account)` | the smart account, when the policy is added to a rule | stores `params.recipients` (1–20 unique addresses) for this account and rule |
| `enforce(context, signers, context_rule, smart_account)` | the smart account's `__check_auth`, for every authorization under the rule | allows a `transfer` to a listed recipient; refuses anything else |
| `uninstall(context_rule, smart_account)` | the smart account, when the policy is removed | deletes the list |
| `get_recipients(context_rule_id, smart_account)` | anyone (read-only) | the stored list |

Install parameters: `AllowlistParams { recipients: Vec<Address> }`.

## Errors

| Code | Name | Meaning |
| --- | --- | --- |
| 3400 | `NotInstalled` | no list for this account and rule |
| 3401 | `RecipientNotAllowed` | the transfer's recipient is not listed |
| 3402 | `NotAllowed` | not a `transfer`, or no authenticated signer |
| 3403 | `AlreadyInstalled` | a list already exists for this account and rule |
| 3404 | `InvalidParams` | empty, longer than 20, or duplicate recipients |
| 3405 | `OnlyCallContractAllowed` | the rule is not a `CallContract` rule |

## Build, test, deploy

```bash
cargo test --manifest-path contracts/Cargo.toml   # 5 tests, incl. a real smart-account auth flow
npm run allowlist:deploy                          # stellar contract build + deploy to testnet
```

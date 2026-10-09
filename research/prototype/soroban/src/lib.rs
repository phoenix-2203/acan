//! Research prototype (test-only): checks in the Soroban test host, with real
//! ed25519 signatures and OpenZeppelin's own `do_check_auth`, that an agent
//! rule gated by a provenance co-signer refuses the agent's signature alone,
//! accepts it with the co-signer's, and still applies every ACAN limit.
//!
//! Nothing here is deployed. See `research/PROTOTYPE_PLAN.md`.
#![no_std]

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod fixture;
#[cfg(test)]
mod test;

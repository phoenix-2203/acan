// Writes research/prototype/soroban/src/fixture.rs from the TypeScript co-signer.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixtureRust } from "../src/fixture.js";

const out = fileURLToPath(new URL("../soroban/src/fixture.rs", import.meta.url));
writeFileSync(out, fixtureRust());
console.log("wrote", out);

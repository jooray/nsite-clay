// Imported first by bin/artifact.mjs, before anything that signs or seals.
// Node 18 has Web Crypto only as require("node:crypto").webcrypto, not as the
// global the Nostr and hashing libraries read when they load. Newer Node has
// both, and this does nothing there.
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true, writable: true });

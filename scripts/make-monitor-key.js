// Makes the signing key for AI1 Monitor sign-in. Run once: node scripts/make-monitor-key.js
// It prints the private key. Paste it into Vercel as MONITOR_SIGNING_KEY (Project → Settings → Environment
// Variables) and don't save it anywhere else. AI1 Monitor only needs the public key, from /sso/monitor/keys.
import { webcrypto } from "node:crypto";

const { privateKey } = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = await webcrypto.subtle.exportKey("jwk", privateKey);
console.log(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d, kid: "ai1-monitor-" + new Date().toISOString().slice(0, 10) }));

// Copies the Microsoft sign-in library (MSAL) into public/ so the site serves it itself
// instead of loading it from another domain.
import { copyFileSync, mkdirSync } from "node:fs";

const from = "node_modules/@azure/msal-browser/lib/msal-browser.min.js";
const to = "public/assets/vendor/msal-browser.min.js";
mkdirSync("public/assets/vendor", { recursive: true });
copyFileSync(from, to);
console.log("copied", from, "->", to);

// Encrypts src/app.html into public/assets/locked.json for the emails in src/team.json.
// The password comes from the TEAM_PASSWORD environment variable (a GitHub secret when deployed),
// so it never appears in the repository or on the site.
import { readFileSync, writeFileSync } from "node:fs";
import { seal } from "../public/assets/lock.js";

const password = process.env.TEAM_PASSWORD;
if (!password) {
  console.error("TEAM_PASSWORD is not set. Add it under GitHub > Settings > Secrets and variables > Actions.");
  process.exit(1);
}

const { emails } = JSON.parse(readFileSync("src/team.json", "utf8"));
const html = readFileSync("src/app.html", "utf8");
const locked = await seal(html, emails.map((email) => ({ email, password })));
writeFileSync("public/assets/locked.json", JSON.stringify(locked));
console.log("locked src/app.html for", emails.length, "people -> public/assets/locked.json");

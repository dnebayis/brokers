#!/usr/bin/env node
// CI dependency gate. Fails on any critical advisory anywhere, and on any high advisory in a
// package that ships with the site (production dependencies). High advisories in build-only
// tooling (eslint, tailwind's file watcher) are printed but do not fail the build: they never
// reach a visitor, and their fixes are major-version jumps we take on our own schedule.
//
// An advisory can be accepted only by listing it below with the reason it cannot hit us.
import { execSync } from "node:child_process";

const ACCEPTED = {
  // node-forge: RSA PKCS#1 v1.5 signature VERIFICATION accepts malformed DigestInfo. No fixed
  // release exists. We only SIGN (Wallet Pass manifests, via passkit-generator); the site never
  // verifies a third-party RSA signature with node-forge.
  "GHSA-86w9-cpqp-85rv": "node-forge signature verification; we only sign",
};

function audit(args) {
  // npm audit exits non-zero when it finds anything; the JSON is on stdout either way
  try {
    return JSON.parse(execSync(`npm audit --json ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch (e) {
    return JSON.parse(e.stdout);
  }
}

/** The advisory ids behind a package, following `via` through other packages. */
function advisories(vulns, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  return (vulns[name]?.via ?? []).flatMap((v) =>
    typeof v === "string" ? advisories(vulns, v, seen) : [{ id: v.url.split("/").pop(), severity: v.severity, title: v.title }],
  );
}

const all = audit("").vulnerabilities ?? {};
const prod = audit("--omit=dev").vulnerabilities ?? {};
const failures = [];
const warnings = [];

for (const name of Object.keys(all)) {
  for (const a of advisories(all, name)) {
    if (ACCEPTED[a.id]) continue;
    const line = `${a.severity} ${name}: ${a.title} (${a.id})`;
    if (a.severity === "critical" || (a.severity === "high" && prod[name])) failures.push(line);
    else if (a.severity === "high") warnings.push(line);
  }
}

for (const w of new Set(warnings)) console.log(`build-only, not shipped: ${w}`);
for (const [id, why] of Object.entries(ACCEPTED)) console.log(`accepted ${id}: ${why}`);
if (failures.length) {
  for (const f of new Set(failures)) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("dependency gate passed: no critical advisories, no unaccepted high advisories in shipped packages");

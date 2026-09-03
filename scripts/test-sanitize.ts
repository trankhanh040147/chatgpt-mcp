#!/usr/bin/env npx tsx
/**
 * Secret detector registry tests (ADR-005).
 *   npm run test:sanitize
 */
import {
  containsKnownSecrets,
  isBearerTokenLike,
  isCredentialAssignRhs,
  isStructuralJwt,
  redactSecretsInText,
} from "../src/tasks/sanitize.js";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed += 1;
    console.error(`FAIL: ${msg}`);
  } else {
    passed += 1;
    console.log(`ok — ${msg}`);
  }
}

function main(): void {
  assert(!isBearerTokenLike("field"), "bearer: prose field not token-like");
  assert(
    isBearerTokenLike("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadseg.signatureseg"),
    "bearer: jwt-ish rhs token-like"
  );
  assert(
    isBearerTokenLike("ya29.a0AfH6SMB_abcdefghijklmnopqrstuvwxyz012345"),
    "bearer: long opaque token-like"
  );

  assert(!isCredentialAssignRhs("<value>"), "assign: placeholder skipped");
  assert(!isCredentialAssignRhs("example"), "assign: example skipped");
  assert(isCredentialAssignRhs("hunter2xx"), "assign: credential-like kept");

  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGVzdHNpZ25hdHVyZQ";
  assert(isStructuralJwt(jwt), "jwt: structural validate");

  const fp = redactSecretsInText(
    'custom connectors may only support OAuth / No Auth (no static Bearer field in UI)'
  );
  assert(fp.disclosure.redactionCount === 0, "fp: Bearer field not redacted");
  assert(fp.text.includes("Bearer field"), "fp: prose preserved");

  const sk = redactSecretsInText("key=sk-abcdefghijklmnopqrstuv");
  assert(sk.disclosure.detectorIds.includes("sk"), "tp: sk detector");
  assert(sk.text.includes("[REDACTED]"), "tp: sk redacted");

  const bearerTp = redactSecretsInText(
    `Authorization: Bearer ${jwt}`
  );
  assert(
    bearerTp.disclosure.detectorIds.includes("bearer_tokenlike") ||
      bearerTp.disclosure.detectorIds.includes("jwt"),
    "tp: bearer/jwt fires"
  );
  assert(bearerTp.text.includes("[REDACTED]"), "tp: bearer redacted");

  const passFp = redactSecretsInText("docs list password=<value> and secret=<value>");
  assert(passFp.disclosure.redactionCount === 0, "fp: password=<value> not redacted");

  const passTp = redactSecretsInText("password=hunter2secret");
  assert(passTp.disclosure.detectorIds.includes("password_assign"), "tp: password_assign");
  assert(passTp.text.includes("[REDACTED]"), "tp: password redacted");

  assert(containsKnownSecrets("sk-1234567890abcdef"), "compat: containsKnownSecrets");
  assert(!containsKnownSecrets("Bearer field"), "compat: Bearer field not known secret");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();

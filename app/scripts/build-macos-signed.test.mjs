import assert from "node:assert/strict";
import { test } from "node:test";
import { selectSigningIdentity } from "./build-macos-signed.mjs";

const fingerprint = "A".repeat(40);
const name = "Developer ID Application: Synthetic Builder (TESTTEAM01)";
const valid = `  1) ${fingerprint} "${name}"\n     1 valid identities found`;

test("accepts a sole valid Developer ID and exact selection", () => {
  assert.deepEqual(selectSigningIdentity(valid), { fingerprint, name });
  assert.equal(selectSigningIdentity(valid, name).name, name);
  assert.equal(
    selectSigningIdentity(valid, fingerprint.toLowerCase()).name,
    name,
  );
});
test("rejects missing identities and ad-hoc signing", () => {
  assert.throws(
    () => selectSigningIdentity("0 valid identities found"),
    /No valid/,
  );
  assert.throws(() => selectSigningIdentity(valid, "-"), /Ad-hoc/);
});
test("rejects ambiguity, partial names and unrelated certificates", () => {
  const multiple = `${valid}\n  2) ${"B".repeat(40)} "Developer ID Application: Other Synthetic (TESTTEAM02)"`;
  assert.throws(() => selectSigningIdentity(multiple), /Multiple/);
  assert.throws(
    () => selectSigningIdentity(valid, "Synthetic"),
    /does not match/,
  );
  assert.throws(
    () =>
      selectSigningIdentity(
        `  1) ${fingerprint} "Apple Development: Synthetic"`,
      ),
    /No valid/,
  );
});
test("rejects expired identity rows", () => {
  assert.throws(
    () =>
      selectSigningIdentity(
        `  1) ${fingerprint} "${name}" (CSSMERR_TP_CERT_EXPIRED)`,
      ),
    /No valid/,
  );
});

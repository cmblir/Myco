import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Require one unambiguous, valid Developer ID from the local keychain. */
export function selectSigningIdentity(listing, requested) {
  const identities = [
    ...listing.matchAll(
      /^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"(Developer ID Application: [^"]+)"\s*$/gm,
    ),
  ].map((match) => ({ fingerprint: match[1].toUpperCase(), name: match[2] }));
  if (requested === "-")
    throw new Error(
      "Ad-hoc signing cannot preserve folder permissions across builds.",
    );
  if (requested) {
    const selected = identities.filter(
      ({ name, fingerprint }) =>
        name === requested || fingerprint === requested.toUpperCase(),
    );
    if (selected.length === 1) return selected[0];
    throw new Error(
      "APPLE_SIGNING_IDENTITY does not match one valid local Developer ID Application identity.",
    );
  }
  if (identities.length !== 1) {
    throw new Error(
      identities.length === 0
        ? "No valid Developer ID Application identity. Add the certificate and its private key to Keychain Access; see docs/SIGNING.md."
        : "Multiple Developer ID identities. Set APPLE_SIGNING_IDENTITY to the intended certificate name or fingerprint.",
    );
  }
  return identities[0];
}

function main() {
  if (process.platform !== "darwin")
    throw new Error("This command requires macOS.");
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check"))
    throw new Error("Usage: npm run build:macos:signed -- [--check]");
  // Only inspect identity metadata: no key export, keychain changes or app launch.
  const listing = execFileSync(
    "/usr/bin/security",
    ["find-identity", "-v", "-p", "codesigning"],
    { encoding: "utf8" },
  );
  const identity = selectSigningIdentity(
    listing,
    process.env.APPLE_SIGNING_IDENTITY,
  );
  console.log(
    "Valid local signing identity found. Ad-hoc fallback is disabled for this build.",
  );
  if (args.includes("--check")) return;
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = spawnSync(
    process.execPath,
    [
      resolve(appRoot, "node_modules/@tauri-apps/cli/tauri.js"),
      "build",
      "--bundles",
      "app",
    ],
    {
      cwd: appRoot,
      stdio: "inherit",
      env: { ...process.env, APPLE_SIGNING_IDENTITY: identity.name },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Signed build failed (${result.status ?? result.signal}).`);
  console.log(
    "Signed build completed. Verify the bundle before installing; this command does not install or launch it.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

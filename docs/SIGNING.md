# Code Signing — Releasing a Trusted myco Build

This guide shows you, step by step, how to **code-sign myco** so the installers
stop tripping macOS Gatekeeper and Windows SmartScreen. It wires signing into the
existing release pipeline (`.github/workflows/release.yml`), which builds the app
on real macOS + Windows runners with
[`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action) and
publishes the `.dmg` / `.exe` to a GitHub Release.

> [!important] Current state as of v0.4.0: nothing is signed until you add the secrets.
> The pipeline is **wired but idle**. `.github/workflows/release.yml` reads every
> signing credential from GitHub secrets and turns each feature on only for the
> secrets that exist — with none set it builds an unsigned `.dmg`, no updater
> artifacts, and still goes green (so does a fork). Adding the secrets is the
> whole switch; no workflow edit is needed.
>
> The Windows job stays manual-dispatch and its `.exe`
> (`myco_x.y.z_x64-setup.exe`) is unsigned; users unblock it once (see the
> [README](../README.md)).

> [!warning] Secrets are NEVER committed.
> Every value below is a **GitHub Actions secret**, added only in
> **repo Settings → Secrets and variables → Actions → New repository secret**.
> Nothing in this guide — no `.p12`, no password, no API key — ever lands in a
> file that is tracked by Git. `tauri-action` reads them from `secrets.*` at run
> time. If a private key or password appears in a committed file or a log, treat
> it as compromised and revoke it.

---

## The checklist

Follow this top to bottom. Steps 1–12 are **once, ever**. Steps 13–18 are **each
release**. Every step links to the section that explains it.

**One-time — macOS signing (steps 1–8)**

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/)
   — $99 / year. Nothing below is issuable without it. ([1.1](#11-prerequisites))
2. Create a **Developer ID Application** certificate at
   <https://developer.apple.com/account> → Certificates, IDs & Profiles →
   Certificates → **+**. Download the `.cer` and double-click it to import into
   Keychain Access. ([1.2](#12-create-the-developer-id-application-certificate))
3. Read back your identity and Team ID:
   ```bash
   security find-identity -v -p codesigning
   ```
   Copy the whole string — `Developer ID Application: Your Name (ABCDE12345)`.
   The 10 characters in parentheses are the Team ID. ([1.4](#14-find-your-signing-identity-and-team-id))
4. In Keychain Access, right-click the certificate → **Export** → *Personal
   Information Exchange (.p12)*, expanded so the **private key** is included.
   Set a strong password. ([1.3](#13-export-the-certificate-as-a-p12))
5. Base64 the `.p12` onto one line:
   ```bash
   openssl base64 -A -in certificate.p12 -out certificate-base64.txt
   ```
6. Create an **app-specific password** at <https://account.apple.com> → Sign-In
   and Security → App-Specific Passwords. This is *not* your Apple ID password.
   ([1.6](#16-get-an-app-specific-password-for-the-apple-id-notarization-method))
7. Set the six macOS secrets (names are exact — the bundler reads these env var
   names, see [1.7](#17-macos-secrets-to-add-settings--secrets-and-variables--actions)):
   ```bash
   gh secret set APPLE_CERTIFICATE < certificate-base64.txt
   gh secret set APPLE_CERTIFICATE_PASSWORD    # the .p12 password from step 4
   gh secret set APPLE_SIGNING_IDENTITY        # the full string from step 3
   gh secret set APPLE_ID                      # your Apple account email
   gh secret set APPLE_PASSWORD                # the app-specific password from step 6
   gh secret set APPLE_TEAM_ID                 # the 10-character team ID
   ```
8. **Delete the local key material** — it is now in GitHub and nowhere else:
   ```bash
   rm certificate.p12 certificate-base64.txt
   ```

**One-time — the updater key (steps 9–12). Different key, different job — see
[Part 4](#part-4--updater-signing-key-in-app-updates). Skip if you do not want
in-app updates yet; everything above still works.**

9. Generate the minisign keypair:
   ```bash
   cd app && npm run tauri -- signer generate -w ~/.tauri/myco.key
   ```
10. Store the private half:
    ```bash
    gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/myco.key
    gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD   # only if you chose a password
    ```
11. Paste the single base64 line from `~/.tauri/myco.key.pub` into
    `app/src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (currently `""`).
    The public half is safe to commit; the private half never is.
12. Commit that config change.

**Each release (steps 13–18)**

13. Bump `version` in `app/src-tauri/tauri.conf.json` and `app/package.json`,
    commit.
14. Tag and push — this is the only trigger:
    ```bash
    git tag v0.4.1 && git push origin v0.4.1
    ```
    The `macos-updater` job builds, signs, notarizes, and opens a **draft**
    release. Its log line `code signing: … | notarization: … | updater
    artifacts: …` tells you which secrets it found.
15. Download the draft's `.dmg` and verify it before anyone else can:
    ```bash
    gh release download v0.4.1 --pattern '*.dmg' --dir /tmp/myco-release
    ./scripts/verify-macos-release.sh /tmp/myco-release/myco_0.4.1_aarch64.dmg
    ```
    It must print **OK — safe to publish**. What each check means and what a
    failure implies: [Part 3](#part-3--verify-the-signature).
16. If step 14 reported `code signing: false` (no secrets yet), build and sign
    locally instead and swap the `.dmg` into the draft
    ([Part 1b](#part-1b--signing-locally-no-secrets-leave-your-machine)).
17. Publish the draft. Only now does
    `releases/latest/download/latest.json` resolve, so no user is ever offered
    an update built from an artifact nobody verified.
18. Optionally run the `release` workflow's **workflow_dispatch** with the same
    tag to attach the (unsigned) Windows `.exe`.

---

## What signing buys you

| Platform | Without signing | With signing |
|----------|-----------------|--------------|
| macOS | Gatekeeper: *"myco can't be opened because it is from an unidentified developer."* User must right-click → Open, or `xattr -dr com.apple.quarantine`. | App opens normally. Notarization makes Gatekeeper trust it on a machine that has never seen it. |
| Windows | SmartScreen: *"Windows protected your PC."* User must click **More info → Run anyway**. | Publisher name shows in the UAC prompt. With an OV cert the warning fades as reputation builds; with EV / Azure Trusted Signing it is suppressed sooner. |

You can sign **one platform at a time** — macOS and Windows are independent. Ship
macOS signing first if that is where most users are.

---

## Part 1 — macOS: Developer ID + notarization

To distribute a Mac app **outside the App Store**, Apple requires two things:

1. **Code signing** with a **Developer ID Application** certificate.
2. **Notarization** — Apple scans the signed app and issues a ticket that
   Gatekeeper checks at launch.

`tauri-action` does both for you **when the right environment variables are
present**. You do not call `codesign` or `notarytool` yourself.

### 1.1 Prerequisites

- An **Apple Developer Program** membership — **$99 / year**
  (<https://developer.apple.com/programs/>). The certificate type below is only
  issuable to enrolled accounts.
- A Mac (or the GitHub macOS runner) to export the certificate. Exporting the
  `.p12` is easiest from **Keychain Access** on a Mac.

### 1.2 Create the Developer ID Application certificate

1. Go to <https://developer.apple.com/account> → **Certificates, IDs & Profiles**
   → **Certificates** → **+**.
2. Choose certificate type **Developer ID Application**. (Not "Apple
   Development", not "Developer ID Installer" — those are for other purposes.)

   > [!note] Only the Account Holder can create the first Developer ID cert.
   > Team members with the right role can use it once it exists.
3. Follow the prompts to upload a Certificate Signing Request (CSR), then
   download the resulting `.cer` and double-click it to import into Keychain
   Access.

### 1.3 Export the certificate as a `.p12`

1. In **Keychain Access**, find your **Developer ID Application** certificate,
   expand it so the private key is included, right-click → **Export**.
2. Save as **Personal Information Exchange (.p12)** and set a strong password —
   you will store this password as a secret.

### 1.4 Find your signing identity and Team ID

- **Signing identity** — the full string, e.g.
  `Developer ID Application: Your Name (ABCDE12345)`. From a Mac that imported
  the cert:

  ```bash
  security find-identity -v -p codesigning
  ```

- **Team ID** — the 10-character code in the parentheses above. Also shown at
  <https://developer.apple.com/account> → **Membership details**.

### 1.5 Base64-encode the `.p12`

GitHub secrets are plain text, so the binary `.p12` must be base64-encoded into a
single line:

```bash
openssl base64 -A -in /path/to/certificate.p12 -out certificate-base64.txt
```

`-A` keeps it on one line. Copy the **entire** contents of
`certificate-base64.txt` into the secret value.

> [!warning] Delete the local artifacts after uploading.
> Once the secrets are saved in GitHub, delete `certificate.p12` and
> `certificate-base64.txt` from your machine. They are private keys.

### 1.6 Get an app-specific password (for the Apple ID notarization method)

Notarization needs Apple credentials. The **Apple ID method** (used below) needs
an **app-specific password**, *not* your normal Apple password:

1. <https://account.apple.com> → **Sign-In and Security** → **App-Specific
   Passwords** → generate one.
2. Use that generated value as `APPLE_PASSWORD`.

> [!note] Alternative: App Store Connect API key.
> Instead of Apple ID + app-specific password, `tauri-action` also accepts an
> **App Store Connect API key**, exposed as `APPLE_API_ISSUER`, `APPLE_API_KEY`,
> and `APPLE_API_KEY_PATH`. Pick **one** notarization method — Apple ID *or* API
> key. This guide uses the Apple ID method because it needs no key file on the
> runner. The wired secret list below reflects that choice.

### 1.7 macOS secrets to add (Settings → Secrets and variables → Actions)

These are the exact environment variable names `tauri-action` consumes. Add each
as a repository secret with the **same name**:

| Secret name | Value |
|-------------|-------|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` (the one-line contents of `certificate-base64.txt`). |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12`. |
| `APPLE_SIGNING_IDENTITY` | The full identity string, e.g. `Developer ID Application: Your Name (ABCDE12345)`. |
| `APPLE_ID` | The Apple account email enrolled in the Developer Program. |
| `APPLE_PASSWORD` | The **app-specific password** from step 1.6 (not your login password). |
| `APPLE_TEAM_ID` | Your 10-character Team ID, e.g. `ABCDE12345`. |

### 1.8 How the workflow consumes them (already wired — nothing to edit)

`.github/workflows/release.yml` has a `configure signing from secrets` step
before the build. It exports each credential through `$GITHUB_ENV` **only when
the secret is non-empty**, and reports what it turned on:

```
code signing: true | notarization: true | updater artifacts: false
```

Adding the secrets from step 7 is the entire switch. With none set, the APPLE_\*
variables stay unset, tauri skips signing, and the job still succeeds with an
unsigned `.dmg`.

> [!warning] Why the secrets are not simply listed in the step's `env:` block.
> A GitHub expression for a **missing** secret still *defines* the variable — as
> an empty string — and every consumer tests presence, not emptiness:
>
> - `tauri-bundler` `macos/sign.rs` reads `var_os("APPLE_CERTIFICATE")`, so `""`
>   means "import this certificate" and `security import` of zero bytes fails
>   the whole bundle.
> - `notarize_auth()` returns a **hard error** (`NotarizeAuthError::MissingTeamId`)
>   when `APPLE_ID` + `APPLE_PASSWORD` are present without `APPLE_TEAM_ID` — so
>   the notarization trio is all-or-nothing.
> - `tauri-cli` `bundle.rs` reads `TAURI_SIGNING_PRIVATE_KEY` with `var()`, and
>   an empty value survives to "failed to decode secret key".
>
> Unset and empty are different states, and only unset means "skip".

`APPLE_SIGNING_IDENTITY` is the one optional member of the six: the imported
certificate already carries its identity. When you do set it, the bundler checks
the two agree and fails loudly if they do not — which is why it is worth setting.

> [!note] Notarization credentials — the other accepted form.
> Instead of `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`, `tauri-bundler`
> also accepts an App Store Connect API key via `APPLE_API_KEY`,
> `APPLE_API_ISSUER` and `APPLE_API_KEY_PATH` (falling back to
> `./private_keys`, `~/private_keys`, `~/.private_keys`,
> `~/.appstoreconnect/private_keys` for an `AuthKey_<key-id>.p8`). The Apple ID
> trio is checked first. This guide uses it because it needs no key file on the
> runner; taking the API-key route means adding those three to the gate step.

### 1.9 What `tauri.conf.json` contributes

`bundle.macOS` in [`app/src-tauri/tauri.conf.json`](../app/src-tauri/tauri.conf.json)
carries the two signing-relevant keys. **That block cannot hold explanatory
comments** — Tauri deserializes it with `deny_unknown_fields`, so a `"//"` key
(the trick used in `plugins.updater`) makes the build fail. The explanation
lives here instead:

| Key | Value now | What you may change |
|-----|-----------|---------------------|
| `hardenedRuntime` | `true` | Leave it. Notarization **requires** the hardened runtime; `true` is also tauri's default, and it is spelled out so nobody silently flips it. |
| `signingIdentity` | `null` | Fill in only if you want **every local `tauri build`** to sign with a fixed identity. Leaving it `null` keeps `APPLE_SIGNING_IDENTITY` (env / secret) in charge. Never set it to `""` — an empty identity is not "off", it is `codesign -s ""` and fails. |

There is deliberately **no `entitlements` file**. myco needs none: it is not
sandboxed, loads no unsigned libraries, and asks for no JIT, so the default
hardened runtime is enough — and claiming entitlements you are not entitled to
is a notarization rejection. Add one (`"entitlements": "entitlements.plist"`)
only if a future feature actually needs a specific `com.apple.security.cs.*`
exception.

---

## Part 1b — Signing locally (no secrets leave your machine)

With the Developer ID certificate already in your login keychain, no secret ever
leaves the machine. Use this when you do not want the certificate in GitHub at
all, or when step 14 reported `code signing: false`.

v0.3.0 ships **Apple Silicon only**. Every recorded download of a `universal`
bundle across v0.1.0-v0.2.2 came from the single v0.1.0 release, so there is no
measured Intel demand — and universal costs a rustup toolchain plus a second
full compile of the bundled llama.cpp. To add Intel back later, run
`rustup target add x86_64-apple-darwin` and build
`--target universal-apple-darwin` instead.

From the repo root:

```bash

# Notarization credentials. Set them in the shell, never in a tracked file.
# APPLE_PASSWORD is the app-specific password from step 1.6, not your login one.
export APPLE_SIGNING_IDENTITY="Developer ID Application: <name> (<TEAMID>)"
export APPLE_ID="<apple-account-email>"
export APPLE_PASSWORD="<app-specific-password>"
export APPLE_TEAM_ID="<TEAMID>"

cd app && npm run tauri build -- --target aarch64-apple-darwin
```

Tauri signs the bundle and submits it to Apple for notarization as part of the
build. Verify before shipping — the script runs every check in
[Part 3](#part-3--verify-the-signature) and defaults to exactly this target dir:

```bash
./scripts/verify-macos-release.sh
```

It must print **OK — safe to publish**. Then attach the `.dmg` to the release:

```bash
gh release upload v0.4.1 \
  app/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/myco_*.dmg --clobber
```

---

## Part 2 — Windows: Authenticode signing

Windows trust comes from an **Authenticode** signature backed by a code-signing
certificate. For Tauri v2 there are two practical routes. **Pick one.**

### Route A — Certificate thumbprint via `signtool` (traditional)

If you hold a code-signing certificate **installed in the Windows certificate
store of the build machine**, Tauri signs the NSIS `.exe` using the built-in
`signtool` path. Configure it in
[`app/src-tauri/tauri.conf.json`](../app/src-tauri/tauri.conf.json) under
`bundle.windows`:

```json
"bundle": {
  "windows": {
    "certificateThumbprint": "A1B2C3D4E5F6...<your cert thumbprint, no spaces>",
    "digestAlgorithm": "sha256",
    "timestampUrl": "http://timestamp.digicert.com"
  }
}
```

- `certificateThumbprint` — the SHA-1 thumbprint of the cert in the machine's
  store, **uppercase, no spaces**.
- `digestAlgorithm` — use `"sha256"`.
- `timestampUrl` — an RFC 3161 timestamp server (e.g.
  `http://timestamp.digicert.com`). Timestamping keeps the signature valid after
  the certificate itself expires.

> [!warning] Hosted runners don't have your cert in their store.
> `certificateThumbprint` assumes the cert is already in the build machine's
> certificate store. On the ephemeral GitHub `windows-latest` runner you would
> have to **import the `.pfx` first** (decode a base64 secret, `Import-PfxCertificate`,
> then read back the thumbprint). This is workable but couples the secret to a
> physical `.pfx`. For CI, Route B is usually cleaner.

### Route B — Azure Trusted Signing via `signCommand` (recommended for CI)

Microsoft **Azure Trusted Signing** (formerly Azure Code Signing) issues
short-lived certificates from a cloud key vault — no `.pfx` ever touches the
runner. Tauri's custom `signCommand` invokes
[`trusted-signing-cli`](https://github.com/Levminer/trusted-signing-cli), which
authenticates to Azure with environment variables.

`tauri.conf.json` → `bundle.windows`:

```json
"bundle": {
  "windows": {
    "signCommand": "trusted-signing-cli -e https://<region>.codesigning.azure.net -a <AccountName> -c <CertificateProfileName> -d myco %1"
  }
}
```

- `-e` — your Trusted Signing **endpoint** URL (region-specific, e.g.
  `https://wus2.codesigning.azure.net`).
- `-a` — the Trusted Signing **account name**.
- `-c` — the **certificate profile name**.
- `-d` — a description (the product name, `myco`).
- `%1` — placeholder Tauri replaces with the path of the file to sign.

The workflow must install `trusted-signing-cli` on the runner (e.g.
`cargo install trusted-signing-cli` or a download step) **before** the
`tauri-action` step, and pass the Azure credentials as env vars.

> [!note] Verify the exact `trusted-signing-cli` flags and install method
> against its current README before relying on this. The flag names (`-e`/`-a`/
> `-c`/`-d`) and the endpoint host format are the documented form as of writing,
> but the CLI is third-party and can change between versions — pin a version and
> re-check rather than assuming.

### 2.1 Windows secrets to add (Route B / Azure Trusted Signing)

`trusted-signing-cli` authenticates via the standard Azure service-principal
environment variables. Add these as repository secrets with the **same names**:

| Secret name | Value |
|-------------|-------|
| `AZURE_TENANT_ID` | Azure AD (Entra) directory **tenant ID**. |
| `AZURE_CLIENT_ID` | The App Registration / service principal **client ID**. |
| `AZURE_CLIENT_SECRET` | The App Registration **client secret**. |

Wire them into the same `tauri-action` step `env:` block:

```yaml
- uses: tauri-apps/tauri-action@action-v0.6.2
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    # ... macOS vars from Part 1 ...
    # Windows — Azure Trusted Signing (only consumed on the Windows runner).
    AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
    AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
    AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
```

> [!note] Route A uses no secrets of this shape.
> If you instead go with **Route A** (`certificateThumbprint`), the secret you
> need is the **base64-encoded `.pfx`** plus its **password**, consumed by a
> custom import step you add — not by `tauri-action` directly. There are no
> Tauri-defined env-var names for that path; you choose the secret names in your
> import step. Document them there if you take Route A.

### 2.2 Windows certificate cost

| Option | Cost (approx.) | SmartScreen behavior |
|--------|----------------|----------------------|
| **OV (Organization Validation)** cert | ~$100–300 / year from a CA | Cheaper, available to individuals/orgs, but may still show SmartScreen warnings until the cert builds reputation. |
| **EV (Extended Validation)** cert | ~$250–700 / year, requires hardware token | Immediate SmartScreen reputation; no warning. |
| **Azure Trusted Signing** | ~$10 / month (subscription-based; eligibility requirements apply) | EV-class trust without managing a `.pfx` or token; the modern recommendation for CI. |

> [!note] Pricing is indicative, not a quote.
> Certificate prices vary by CA and term, and Azure Trusted Signing pricing /
> eligibility can change. Confirm current figures with the CA or Azure before
> committing.

---

## Part 3 — Verify the signature

Never publish a release you have not run this against.

### macOS — `scripts/verify-macos-release.sh`

```bash
./scripts/verify-macos-release.sh                      # the local signed build
./scripts/verify-macos-release.sh /tmp/myco_0.4.1.dmg  # a draft release's .dmg
./scripts/verify-macos-release.sh --dry-run            # print the checks, run nothing
```

It exits **0** only when every required check passes. `bundle.targets` is
`["dmg", "nsis"]`, so a normal build leaves no loose `.app` — the script mounts
the `.dmg` read-only and checks the copy inside, which is the one users run.

| Check | Required | Meaning of a failure |
|-------|----------|----------------------|
| `codesign --verify --deep --strict` on the `.app` | yes | The signature is missing or a nested binary/resource was modified after signing. |
| `codesign -dv` authority | info | Prints who signed it — confirm it is your Developer ID, not `adhoc`. |
| `spctl --assess --type execute` on the `.app` | yes | Must say **accepted / source=Notarized Developer ID**. `source=Unnotarized Developer ID` means signing worked but notarization did not — re-check `APPLE_ID`, `APPLE_PASSWORD` (app-specific!) and `APPLE_TEAM_ID`. |
| `xcrun stapler validate` on the `.app` | yes | No ticket attached, so a machine that has never seen the app and is offline will block it. |
| `codesign --verify --strict` on the `.dmg` | yes | The disk image itself is unsigned — Tauri signs it right after building it. |
| `spctl --assess --type open` on the `.dmg` | info | Tauri notarizes and staples the **`.app`**, then wraps it; the `.dmg` has no ticket of its own, so this can read `rejected` on a perfectly good release. Judge it together with the `.app` rows. |
| `*.app.tar.gz` has a matching `.sig` | yes, when present | The updater tarball is unsigned and every installed myco will refuse it. |

### Windows

`signtool` ships with the Windows SDK (in the SDK `\bin` folder). The `/pa` flag
validates against the Authenticode policy:

```powershell
signtool verify /pa /v "myco_x.y.z_x64-setup.exe"
```

A valid result shows the certificate chain and a timestamp. "Successfully
verified" with no errors means the Authenticode signature is good.

---

## Part 4 — Updater signing key (in-app updates)

This is a **different key from everything above**. Apple's Developer ID proves
*who built the app* to macOS. The updater key proves *that an update came from
you* to the already-installed app: `tauri-plugin-updater` refuses any download
whose minisign signature does not match the public key baked into the running
build. You need both; neither substitutes for the other.

Until this key exists, the app is honest about it rather than broken:
`plugins.updater.pubkey` in `app/src-tauri/tauri.conf.json` is an empty string,
so **Settings → About → Check for updates** reports *"No update channel
configured"* and never contacts the network. Nothing else changes, and a local
`tauri build` needs no key at all — CI switches updater artifacts on with a
`--config` flag, and only when it finds `TAURI_SIGNING_PRIVATE_KEY`. Without the
secret it drops `createUpdaterArtifacts` and `includeUpdaterJson` entirely, so a
keyless build (a fork's, or yours before step 9) produces a `.dmg` and nothing
else instead of failing at "A public key has been found, but no private key."

### The two commands (checklist steps 9–10)

**1. Generate the keypair — once, on your machine.**

```bash
cd app
npm run tauri -- signer generate -w ~/.tauri/myco.key
```

Choose a password when prompted (or leave it empty). This writes
`~/.tauri/myco.key` (**private — never commit, never paste into a file in this
repo**) and `~/.tauri/myco.key.pub` (public, safe to commit).

**2. Put the private key in a GitHub secret.**

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/myco.key
# Only if you chose a password in step 1:
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

(Equivalently: **repo Settings → Secrets and variables → Actions → New
repository secret**, name `TAURI_SIGNING_PRIVATE_KEY`, body = the whole contents
of `~/.tauri/myco.key`.)

### Then commit the public half (checklist steps 11–12)

Paste the single base64 line from `~/.tauri/myco.key.pub` into
`app/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`, replacing the empty
string. That is the switch that turns the feature on: the About page starts
checking, and `.github/workflows/release.yml`'s `macos-updater` job starts
signing on every `v*` tag push.

> [!important] Commit the pubkey before the first tag after setting the secret.
> The secret alone makes CI build updater artifacts, and signing them needs the
> matching public key from the config — a tag pushed between step 10 and step 12
> fails with "failed to decode pubkey". Steps 11–12 exist to be done first.

> [!warning] The private key is the whole channel.
> Anyone holding it can ship an "update" that every myco install accepts and
> runs. Keep the only copies in your password manager and the GitHub secret. If
> it leaks, generate a new pair, commit the new pubkey, and cut a release — old
> installs will need a manual reinstall to move to the new key.

### Release flow once it is wired

That is checklist steps 13–18: tag → the `macos-updater` job builds the `.app`,
`.dmg`, `.app.tar.gz` + `.sig` and `latest.json` into a **draft** →
`scripts/verify-macos-release.sh` the `.dmg` → publish → optionally dispatch the
Windows `.exe`. Leave `latest.json` and the `.app.tar.gz`/`.sig` pair alone if
you swap the `.dmg`; they are the channel, and they are signed with the updater
key, not the Apple one.

The updater channel is macOS-aarch64 only for now: `latest.json` carries just the
`darwin-aarch64` platform, and any other OS/arch shows *"No update channel for
this platform yet"* instead of an error. Adding Windows means splitting the
frontend's `downloadAndInstall()` into `download()` now / install-on-quit first —
the NSIS updater restarts the app from `install()`, which would break the
never-force-a-restart rule (see `app/src/stores/updateStore.ts`).

---

## Quick reference — secret names to wire

**macOS (6 secrets):**

```
APPLE_CERTIFICATE
APPLE_CERTIFICATE_PASSWORD
APPLE_SIGNING_IDENTITY
APPLE_ID
APPLE_PASSWORD
APPLE_TEAM_ID
```

**Windows — Azure Trusted Signing / Route B (3 secrets):**

```
AZURE_TENANT_ID
AZURE_CLIENT_ID
AZURE_CLIENT_SECRET
```

**In-app updater ([Part 4](#part-4--updater-signing-key-in-app-updates), 1–2 secrets):**

```
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD   # only if the key has a password
```

All added only in **repo Settings → Secrets and variables → Actions**. Never in
a tracked file.

Every macOS and updater name above was read out of the pinned toolchain, not
from memory — `tauri-bundler 2.9.4` `src/bundle/macos/sign.rs`, `tauri-cli
2.11.1` `src/interface/rust.rs` and `src/bundle.rs`, and the `MacConfig` struct
in `tauri-utils 2.9.x` `src/config.rs`. If you bump the Tauri toolchain, re-read
those four files before trusting this table.

---

## Sources

- `tauri-bundler` 2.9.4 — `src/bundle/macos/sign.rs` (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_API_*`, the `MissingTeamId` hard error)
- `tauri-cli` 2.11.1 — `src/interface/rust.rs` (`APPLE_SIGNING_IDENTITY`, `APPLE_PROVIDER_SHORT_NAME`), `src/bundle.rs` (`TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]`)
- `tauri-utils` 2.9.x — `src/config.rs` `MacConfig` (`signingIdentity`, `hardenedRuntime` default `true`, `entitlements`, `deny_unknown_fields`)
- Tauri v2 — macOS Code Signing: <https://v2.tauri.app/distribute/sign/macos/>
- Tauri v2 — Windows Code Signing: <https://v2.tauri.app/distribute/sign/windows/>
- `tauri-apps/tauri-action` (signing example + inputs): <https://github.com/tauri-apps/tauri-action>
- "Ship Your Tauri v2 App Like a Pro: Code Signing for macOS and Windows": <https://dev.to/tomtomdu73/ship-your-tauri-v2-app-like-a-pro-code-signing-for-macos-and-windows-part-12-3o9n>
- Microsoft Learn — SignTool: <https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool>

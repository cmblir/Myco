# Code Signing — Releasing a Trusted Memex Build

This guide shows you, step by step, how to **code-sign Memex** so the installers
stop tripping macOS Gatekeeper and Windows SmartScreen. It wires signing into the
existing release pipeline (`.github/workflows/release.yml`), which builds the app
on real macOS + Windows runners with
[`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action) and
publishes the `.dmg` / `.exe` to a GitHub Release.

> [!important] v0.1.0 is UNSIGNED — this is the upgrade path, not the current state.
> Today both installers (`Memex_x.y.z_universal.dmg`, `Memex_x.y.z_x64-setup.exe`)
> are unsigned. On first launch users must manually unblock them (see the
> [README](../README.md)). Signing removes that friction. **No code changes are
> required to keep shipping unsigned** — everything below is additive.

> [!warning] Secrets are NEVER committed.
> Every value below is a **GitHub Actions secret**, added only in
> **repo Settings → Secrets and variables → Actions → New repository secret**.
> Nothing in this guide — no `.p12`, no password, no API key — ever lands in a
> file that is tracked by Git. `tauri-action` reads them from `secrets.*` at run
> time. If a private key or password appears in a committed file or a log, treat
> it as compromised and revoke it.

---

## What signing buys you

| Platform | Without signing | With signing |
|----------|-----------------|--------------|
| macOS | Gatekeeper: *"Memex can't be opened because it is from an unidentified developer."* User must right-click → Open, or `xattr -dr com.apple.quarantine`. | App opens normally. Notarization makes Gatekeeper trust it on a machine that has never seen it. |
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

### 1.8 Wire them into the workflow

In `.github/workflows/release.yml`, add the secrets to the **`env:` block of the
`tauri-apps/tauri-action` step** (the existing step already passes
`GITHUB_TOKEN`). `tauri-action` imports the certificate into a temporary keychain
and runs notarization automatically when these are set:

```yaml
- uses: tauri-apps/tauri-action@action-v0.6.2
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    # macOS signing + notarization — only consumed on the macOS runner.
    APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
    APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
    APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  with:
    # ... existing inputs unchanged ...
```

These variables are harmless on the Windows runner — it ignores them — so the
single shared `env:` block is fine for the current matrix.

> [!note] Manual-keychain variant.
> Some setups add an explicit "import Apple Developer Certificate" step (using
> `security create-keychain` / `security import`) plus a `KEYCHAIN_PASSWORD`
> secret, and only pass `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` to
> `tauri-action`. That is equivalent but more verbose. The `env:`-block approach
> above is the documented, lower-maintenance path for `tauri-action` and is what
> Memex should use unless a future need forces the manual variant.

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
    "signCommand": "trusted-signing-cli -e https://<region>.codesigning.azure.net -a <AccountName> -c <CertificateProfileName> -d Memex %1"
  }
}
```

- `-e` — your Trusted Signing **endpoint** URL (region-specific, e.g.
  `https://wus2.codesigning.azure.net`).
- `-a` — the Trusted Signing **account name**.
- `-c` — the **certificate profile name**.
- `-d` — a description (the product name, `Memex`).
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

After a signed build, verify the artifacts locally before you trust the release.

### macOS

```bash
# Inspect the signature and the signing identity (Authority lines).
codesign -dv --verbose=4 /Applications/Memex.app

# Assess against Gatekeeper policy — this is the real test users experience.
# A notarized, correctly signed app prints: "accepted" and "source=Notarized Developer ID".
spctl -a -vvv /Applications/Memex.app
```

If `spctl` says `rejected` or `source=Unnotarized Developer ID`, signing
succeeded but notarization did not — re-check `APPLE_ID`, `APPLE_PASSWORD`
(app-specific!), and `APPLE_TEAM_ID`.

### Windows

`signtool` ships with the Windows SDK (in the SDK `\bin` folder). The `/pa` flag
validates against the Authenticode policy:

```powershell
signtool verify /pa /v "Memex_x.y.z_x64-setup.exe"
```

A valid result shows the certificate chain and a timestamp. "Successfully
verified" with no errors means the Authenticode signature is good.

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

All added only in **repo Settings → Secrets and variables → Actions**. Never in
a tracked file.

---

## Sources

- Tauri v2 — macOS Code Signing: <https://v2.tauri.app/distribute/sign/macos/>
- Tauri v2 — Windows Code Signing: <https://v2.tauri.app/distribute/sign/windows/>
- `tauri-apps/tauri-action` (signing example + inputs): <https://github.com/tauri-apps/tauri-action>
- "Ship Your Tauri v2 App Like a Pro: Code Signing for macOS and Windows": <https://dev.to/tomtomdu73/ship-your-tauri-v2-app-like-a-pro-code-signing-for-macos-and-windows-part-12-3o9n>
- Microsoft Learn — SignTool: <https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool>

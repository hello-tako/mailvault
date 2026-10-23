# mailauth 7.1.1 workerd foundation

This is the runtime foundation for DKIM verification. It shows that the pinned, patched `mailauth`
DKIM verifier runs inside workerd with the production compatibility settings, and that it agrees
with Node. The ingest consumer is described in `docs/sender-auth/SENDER_AUTH_V1.md`. Nothing here
certifies DMARC, SPF, ARC, or a deployment.

## Pin and provenance

- Package: `mailauth` **7.1.1**, pinned exactly in `apps/worker/package.json` (no range).
- License: MIT (upstream `package.json`).
- Integrity, from `pnpm-lock.yaml`: `sha512-IJKBJgdxVT5pgahdVSWxum3yLlI25SSlIbEXiJAVYICc7rNuTQ9ZklZkArNvx/8bcc5N3cKcQz+AAKrcRNj7kw==`.
- Engine: upstream requires Node `>=22.19.0`, so the root `engines.node` now says the same, and
  `.npmrc` sets pnpm `engine-strict=true`, so `pnpm install` refuses an older Node. The earlier key
  `engine=strict` is not a pnpm setting and enforced nothing. This describes the developer and CI
  toolchain. CI and deploy run Node 24, and Wrangler 4.136.3 already requires `>=22.0.0`. The
  Worker itself runs on workerd, which is a separate concern covered by the compatibility date and
  flags below.

## Patch

- File: `patches/mailauth@7.1.1.patch`, registered through pnpm `patchedDependencies` in
  `pnpm-workspace.yaml` and recorded in `pnpm-lock.yaml`. A frozen install reproduces it.
- Change: one line in `lib/dkim/dkim-verifier.js`. For `rsa-*` signatures the `crypto.verify`
  digest argument changes from `signatureHeader.algorithm` (`rsa-sha256`) to
  `signatureHeader.hashAlgo` (`sha256`).
- Why: Node accepts `rsa-sha256` as a digest alias. workerd rejects it with
  `Unknown digest: rsa-sha256`, so every RSA DKIM signature comes back `neutral`. Changing the
  compatibility date does not fix this.
- Unchanged: the DKIM parser, canonicalization, `h=` handling, body hash, DNS lookups, signature
  bytes, PKCS#1 v1.5 padding, the Ed25519 path, result semantics, and error classification.

## Upstream tracking

- Searches of `postalsys/mailauth` issues for "Unknown digest" and for "workerd" found nothing on
  2026-10-08. Draft report, not filed: `crypto.verify` receives the DKIM identifier `rsa-sha256`;
  Node accepts it and workerd rejects it. The call needs the digest value `hashAlgo` (`sha256`).
- This does not block the foundation. Remove the patch once upstream ships an equivalent fix.

## Upgrade policy

- Do not move `mailauth` past 7.1.1 while the patch is active. First check whether upstream fixed
  the call, then remove or regenerate the patch, then rerun `test/compat/mailauth-workerd.test.ts`.
- Dependabot covers only GitHub Actions, so npm dependencies are not updated automatically. If npm
  is ever added, `mailauth` must be ignored above 7.1.1.
- The compat test guards the pin, the patch entry, the installed version and source, and an RSA
  valid signature passing under workerd.

## nodejs_compat review

- Change: `compatibility_flags: ["nodejs_compat"]` in `apps/worker/wrangler.jsonc`.
  `compatibility_date` stays at `2026-07-02`.
- Why: `mailauth` imports `node:dns`, `node:crypto`, `node:buffer`, `node:stream`, `node:net`,
  `node:tls`, `node:https`, `node:fs`, and `node:os`. Without the flag workerd does not provide them.
- Bundle, at the foundation stage: the production dry-run output was byte-identical with and
  without the flag, at 1497.96 KiB upload and 313.18 KiB gzip, because no production code imported
  `mailauth` yet. The DKIM ingest bundle is measured in `SENDER_AUTH_V1.md`.
- Globals: with the flag, `Buffer` is defined. The only bundled code that checks for it is
  `@peculiar/utils` base64, which prefers `Buffer` and falls back to `atob`/`btoa`. Both paths return
  the same bytes for input its validator accepts.
- Existing suites: the Vitest suites run application code in Node and never read wrangler flags.
  `wrangler.dev.jsonc`, which serves the Playwright suite, already runs with `nodejs_compat`
  (date 2025-07-18).

## Verification

- `apps/worker/test/compat/mailauth-workerd.test.ts` runs the installed package with
  `wrangler dev`, the same workerd that Wrangler 4.136.3 bundles, using the production date and
  flag. Nine DKIM cases run in workerd and must match Node:
  - RSA-SHA256 valid passes.
  - RSA-SHA256 signature bit flip, body tamper, From tamper, and wrong public key do not pass.
  - RSA-SHA256 with the wrong selector returns `neutral` with `no key`, which is mailauth's
    classification for a missing key record.
  - RSA-SHA1 is refused with `policy`.
  - Ed25519-SHA256 valid passes, and a bit flip fails.
- Negative control, run once: with the patch removed, the RSA valid case fails with
  `Unknown digest: rsa-sha256`, and the guard fails. This shows the test detects a dropped patch.
- Upstream DKIM suite: the 347 `test/dkim` tests from the 7.1.1 source tree pass 347/347 on the
  unpatched package and 347/347 on the installed patched package, with identical test titles.
- Ingest: `test/integration/sender-auth.integration.test.ts` checks that a forged
  `Authentication-Results` header stays `UNVERIFIED`, and that a valid DKIM signature is `TRUSTED`
  only with a published, aligned key.

## Not certified

SPF, DMARC, ARC, and production deployment. DKIM ingest is certified only as described in
`docs/sender-auth/SENDER_AUTH_V1.md`.

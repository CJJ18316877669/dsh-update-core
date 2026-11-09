# Security Policy

## Reporting

Do not open a public issue for a vulnerability that could cause code execution, credential disclosure, profile corruption or an unsafe update.

Use GitHub Security Advisories in the repository:

https://github.com/CJJ18316877669/dsh-update-core/security/advisories/new

Include affected version, platform, reproduction steps, impact and any suggested mitigation. Do not include real registry tokens, `$DSH_HOME` contents, plugin credentials or personal paths. We aim to acknowledge within 3 business days and coordinate disclosure after a fix is available.

## Supported versions

| Version | Security support |
|---|---|
| 0.2.x | Yes |
| 0.1.x | No |

## Security invariants

- Registry URLs must use HTTPS; only loopback may use HTTP. URLs with embedded credentials are rejected.
- Tarballs must have npm SRI integrity and are verified before staging.
- Install scripts are disabled. Builds run only for exact package names listed in `allowBuilds`.
- `cordis.patch.yml` is the source of truth for plugin state; node_modules is never deleted to “disable” a plugin.
- Staging verification runs before the journal enters `applying`. If no specific optional plugin can be identified from evidence, the update fails safely rather than guessing.
- Profile activation uses rename with bounded retry. Cross-volume fallback copies, verifies a full SHA-256 tree hash, then renames into place.
- Rollback never swallows the initial rename error. A failed recovery keeps a `.failed-*` path and enters safe mode.
- Live prototype endpoints bind only to `127.0.0.1`, validate exact Host and Origin, require a per-process token, accept only bounded JSON and expose no arbitrary file, command, URL or home parameter.
- Telemetry is disabled by default. Any configured endpoint must be HTTPS, contains no credentials, exposes no plugin names or paths, and drops a failed batch without affecting an update.

## Out of scope

- Malicious plugins already executing inside the Harness process.
- A compromised local account or `$DSH_HOME`.
- Electron installer signing, notarization and native OS recovery, which belong to the desktop host.
- Vulnerabilities in npm, pnpm, Electron or DeepSeek Harness itself.

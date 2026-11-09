# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

## [0.2.2] - 2026-11-09

### Fixed

- Staging command failures now name the failing action (`dsh version`, `dsh dump-config`, `installer`, or a rebuild target) instead of reporting every failure as an installer error.
- Retain the failed command's public error code and stderr tail in staging evidence, making a real invalid `cordis.patch.yml` diagnosable.
- Add a regression test for a real `--dump-config` failure and a command-label assertion for `runCommand`.

## [0.2.1] - 2026-11-09

### Fixed

- Raise the default staging install timeout from 3 to 10 minutes. A real cold install of `@deepseek-ai/dsh@0.2.2-rc.1` with its 652 dependencies took 4–7 minutes, so the previous default could abort a valid update.

### Added

- Expose `installTimeoutMs` on `NpmBackend`.
- Add `scripts/acceptance-dsh.mjs` for a real Node 24 + official-registry staging acceptance run and machine-readable evidence.

## [0.2.0] - 2026-11-09

### Added

- Real `cordis.patch.yml` plugin disable/enable through `ProfileStore`, preserving comments, line endings, indentation and exact pre-disable bytes.
- Staging health gate before `applying`: version check, config dump, bounded boot probe, 30-second timeout, evidence in the journal, optional-plugin disable and core-plugin block.
- Detached watchdog helper with four constrained arguments and journal-driven recovery.
- `HttpSink` telemetry: opt-in, HTTPS, batching, timeout, queue bounds and failure discard.
- pnpm support and explicit `allowBuilds` rebuild allowlist; install scripts stay disabled by default.
- Cross-platform process-tree termination, npm/pnpm CLI resolution, bounded rename retries, EXDEV copy verification, fsync atomic writes and stale-lock token confirmation.
- Official `$DSH_HOME` resolution, lowercase profile-name enforcement, Windows path-length checks and path-root confinement.
- Local live prototype server over loopback HTTP/SSE with strict Host/Origin/token/JSON checks; `prototype.html` now switches between live and offline modes.
- Real registry/SRI smoke script, Edge-driven preview capture script, GitHub issue/PR templates, security/privacy/contribution docs and tag release workflow.
- CI matrix across Ubuntu, Windows, macOS 13/14 and Node.js 20/22/24.

### Changed

- Desktop delegated health no longer commits the journal; the restarted Coordinator must verify before commit.
- npm release checks now enforce target `engines.node`, `os` and `cpu` before download.
- Snapshot, staging, failed-directory and journal-history retention are bounded.
- Semver partial comparator and hyphen-range behavior now matches npm semantics; numeric leading zeros are rejected.
- Package version advanced to `0.2.0` with public subpath exports.

### Fixed

- Rollback no longer swallows the first rename failure and preserves the `.failed-*` recovery path.
- Snapshot restore and profile copy avoid Windows symlink privilege failures by dereferencing.
- SSE state envelopes and live UI terminal-error presentation.
- Test runner no longer executes fixture scripts as tests.
- Cross-platform tests use a Node file-list launcher and platform-native absolute paths, fixing Node 20 and POSIX CI runs.

## [0.1.0] - 2026-11-08

- Initial reference implementation: orchestrator, journal, watchdog state machine, plugin gate, fake/npm/electron-updater backends, i18n, telemetry, CLI and 61 tests.

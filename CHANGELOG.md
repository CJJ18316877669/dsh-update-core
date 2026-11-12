# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

## [0.3.15] - 2026-11-12

### Fixed

- Startup health now fails when dsh refuses a profile bundle. `dsh: skipping profile bundle …` and `… is incompatible with dsh <version>` are treated as fatal, so a core update that leaves an exact-pinned bundle like `dsh-workbuddy-connect@0.7.9` unloadable is rolled back instead of being recorded as a success. dsh skips such a bundle while loading the profile, and the Desktop host then exits with code 1, so the app is unusable.
- The captured startup log is now watched for up to 45 seconds after the settled heartbeat instead of being read once, one second after it. In the `0.2.2-rc.2` run the rejection was printed only after the remaining bundles finished loading, roughly 20 seconds after the heartbeat, and the single read missed it.
- Bumped the Desktop plugin to `0.2.14` for the startup-health behavior.

### Tests

- Added a regression test that replays the real `app-start.log` signature of a skipped bundle and asserts healthy startup logs still pass; **160/160** pass.

## [0.3.14] - 2026-11-12

### Fixed

- Captured the real Desktop stdout/stderr during launch and added startup-log health checks for `entry did not activate` and `pending (waiting for service: …)`. A host-side activation warning can now prevent a false “updated successfully” result.
- Added real launch evidence that the Desktop GUI logs `dsh web`, mounts routes and produces a settled plugin heartbeat without being misclassified by the new gate.
- Bumped the Desktop plugin to `0.2.13` for the startup-health behavior.

### Tests

- Added startup-log false-positive/true-positive tests; **159/159** pass.

## [0.3.13] - 2026-11-11

### Fixed

- Run locks now track a live owner, transfer ownership to a detached supervisor, heartbeat their lease, and reclaim dead owners without waiting for the old two-hour TTL. A short recovery grace window still prevents a second process from racing a supervisor that is recovering.
- Added a detached supervisor around the Desktop helper. If the helper exits without a terminal result, the supervisor starts one recovery pass from persisted core/profile mutation flags, writes a terminal failure if recovery also fails, and relaunches Desktop.
- Helper command timeouts now wait for `taskkill /T` / POSIX termination before resolving, so rollback cannot start while a timed-out installer or pnpm process tree is still writing.
- New plugin versions without a DSH compatibility contract are no longer auto-updated by the Desktop updater; they are listed as `unverifiedTargets` and kept until a staging/runtime gate exists.
- Desktop core checks are channel-aware: prerelease cores use nightly, stable cores never fall back to nightly, and a missing official stable feed keeps the core unchanged instead of crossing channels.
- Profile backups now include `cordis.patch.yml`, `cordis.yml`, `compatibility.json`, `pnpm-workspace.yaml`, `.npmrc` and `settings.json`, and restore removes known config files created by a failed update. Rollback first attempts frozen offline pnpm install, then falls back to online.
- Added safe retention reporting that keeps history and the active rollback point while identifying obsolete installers, shared rollback artifacts and old profile backups. It writes `cleanup-report.json` and is report-only by default; deletion requires explicit `pruneOldArtifacts: true`.
- Startup health now requires a run-bound `settled` heartbeat written after ten seconds of plugin stability, rather than a single immediate `loaded` heartbeat.
- Centralised the plugin version/user-agent values and added a package-version regression check.
- `plugin:install` now passes an explicit `--home` as `DSH_HOME` to the bundled CLI and supports `--allow-running` only for isolated homes, enabling end-to-end tests without closing a running Desktop. It also recovers and cleans the backup when pnpm relocates it into `node_modules/.ignored`.

### Tests

- Added orphan-lock/PID liveness, supervisor crash recovery, helper timeout tree termination, settled heartbeat, profile config restore, retention dry-run, unknown-contract, `.ignored` recovery and version consistency tests; **158/158** pass.

## [0.3.12] - 2026-11-11

### Fixed

- Blocked plugin installation path traversal: `install-plugin` now requires the exact expected package name, validates the profile name, confines the destination to `node_modules`, backs up the previous plugin/profile, and restores them on failure.
- Made update/rollback single-flight synchronous and durable across Desktop restarts via `active-run.json`; malformed or duplicate requests can no longer clear a running lock.
- Rollback now succeeds only when every mutated layer is restored and the restarted app passes the run-bound heartbeat check. A missing core installer or failed profile install is reported as incomplete instead of “rolled back”.
- Added per-run immutable profile backups and exact lockfile restoration; pnpm failures and missing dependencies now fail the health gate.
- Serialised progress writes and replaced direct result writes with atomic JSON writes.
- Registry/GitHub lookup failures are surfaced per plugin instead of silently producing an empty update plan; affected plugins keep their installed version and `autoApply` is disabled for that plan.
- Installed plugins incompatible with the target core are listed as a confirmation risk; `autoApply` skips them and manual updates require explicit `acceptIncompatible` confirmation.
- Settings API now enforces loopback Host/remote-address checks, Origin validation, JSON content type and a per-mount CSRF token.
- Installer downloads require HTTPS, official-host initial URLs, feed `sha512`, a valid Authenticode signature and the official DeepSeek signer subject.
- Exact prerelease version checks no longer strip `-rc.*`; Desktop discovery maps versions to the matching executable path.
- Desktop shutdown targets only the configured executable, tries graceful close first, and bounds installer/pnpm/process operations with timeouts.
- Fixed stable-first semver sorting when prerelease identifiers have different lengths.
- CI now syntax-checks `plugin/` as well as `src/`, `test/`, and `scripts/`. The Windows release workflow also packages the Desktop plugin tarball and publishes both artifacts.

### Tests

- Added route security, synchronous gate, cross-process run lock, serial state writer, rollback outcome, exact version, installer path, feed hash, registry failure and semver regression tests; **146/146** pass.

## [0.3.11] - 2026-11-11

### Added

- Transactional core rollback: pre-downloads the currently installed official installer, verifies its signature, and restores the previous profile manifest on failure.
- Manual “rollback previous version” action and `/api/rollback`.
- Scheduled status checks (`autoCheckHours`, default 6) with last-check metadata.
- Optional scheduled auto-apply (`autoApply`, default off).
- Per-plugin exact-version ignore/clear (`/api/ignore`).
- GitHub API ETag + persistent disk cache and token support to avoid rate-limit failures.
- `npm run plugin:install` force-refreshes a stale `file:` plugin directory.
- Helper now runs from the bundled `node.exe`, so the official NSIS installer no longer mistakes the helper image for a running Harness process.
- Desktop shutdown now uses per-PID `taskkill`, avoiding PowerShell `Path` access failures.
- Core rollback was validated end-to-end through `/api/rollback`: `coreRolledBack: true`, `coreVersion: 0.2.1.0`, `appHealthy: true`; the machine was then restored to `0.2.2-rc.1`.
- Desktop discovery now uses the running process path, wildcard uninstall entries, `InstallLocation` and `DisplayIcon`, so custom install paths such as `C:\Users\<user>\Desktop\hao` are supported.
- `npm run plugin:install` also derives the CLI path from the discovered Desktop installation.
- Update progress is now built into the Settings UI: the update request returns immediately and the page polls live download percentage, transferred size and stages.
- An `active-run.json` marker restores the in-progress view after the Desktop restarts; no external browser progress window is used.
- Update history UI and `/api/history` (last 30 runs).
- GitHub release/tag resolution for `git+https`, `github:` and `owner/repo` dependencies.
- Repository consistency guard for registry and GitHub updates (`repository-mismatch`).
- Static package health checks after install and startup heartbeat verification before marking a run successful.

### Tests

- Added plan ignore/repository/GitHub tests plus store/history tests; **123/123** pass.

## [0.3.0] - 2026-11-10

### Added

- DSH Desktop settings plugin: real one-click core + plugin update.
- Official Desktop feed check, installer download, Authenticode verification and detached helper.
- Plugin plan updates only plugins with a higher version compatible with the target core; incompatible latest releases keep the installed version and are never disabled.
- Helper closes Desktop, installs the core update, runs pnpm in the profile, and restarts Desktop with a clean environment.
- Real-run result: 6 plugins updated, 9 kept, 0 disabled; Desktop restarted after the helper.

### Tests

- Added plugin plan tests; **117/117** pass.

## [0.2.4] - 2026-11-09

### Fixed

- Run the real web staging probe with `--port 0 --no-open`: staging no longer conflicts with the running Desktop port or opens the user's default browser.

## [0.2.3] - 2026-11-09

### Fixed

- Staging now fails when dsh reports `entry did not activate`, even though the Host process remains alive. Previously a broken plugin could be committed because only process liveness was checked.
- Wait up to 15 seconds for real dsh startup and settle for one second after the Web UI URL appears, so plugin activation errors are observable on slower Windows hosts.
- Report `one or more plugins did not activate` instead of the misleading `staging boot exited with null`.

### Changed

- Windows-only product scope: package metadata restricts installation to `win32`, CI runs Windows only, and macOS targets were removed from docs, contracts and acceptance scope.

### Verified

- Real dsh `0.2.2-rc.1` rejects a plugin that throws during `apply`, identifies it as the failed candidate, and starts successfully after `ProfileStore` disables it.
- A detached watchdog helper process restored a real snapshot, transitioned the journal to `rolled-back`, disarmed itself and exited with code 2.

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
- CI matrix across Windows and Node.js 20/22/24. (macOS target removed in 0.2.3.)

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

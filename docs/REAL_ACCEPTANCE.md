# Real environment acceptance — 2026-11-09

This record separates evidence gathered on the real host from platform work that cannot be executed here. Temporary homes and tools are kept outside the source tree under ignored `.acceptance/` and `.tools/` directories.

## Node.js and real dsh

| Item | Result |
|---|---|
| Node.js | `v24.22.2` (Krypton), Windows x64 |
| Distribution | Official `nodejs.org` zip; SHA-256 verified against `SHASUMS256.txt` |
| npm | `11.19.1`, official `registry.npmjs.org` |
| dsh | `@deepseek-ai/dsh@0.2.2-rc.1` |
| dsh integrity | `sha512-ijR9UEVYkG15Q/Q79JzvzLBzQOQfc63VLr9n6flpwHPhr5IKn2UxthnSoto/P9l7qGd7pPvI1Ra6TW7LH3oKpg==` |
| Dependency install | 652 packages; cold run about 7 minutes, warm-cache staging about 2–3 minutes |
| CLI | `dsh --version` → `0.2.2-rc.1`; `--help` and `--profile web --dump-config` exit 0 |

The isolated profile was created with the shipped `web` template and contains `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` bundle layers. No existing `~/.dsh` profile was used for CLI or staging acceptance.

## Real staging gate

Command:

```bash
ACCEPTANCE_HOME="$PWD/.acceptance/home" \
  .tools/node24/node.exe scripts/acceptance-dsh.mjs
```

Result: **PASS**

```json
{
  "node": "24.22.2",
  "release": "0.2.2-rc.1",
  "checks": ["version", "dump-config", "boot"],
  "ok": true,
  "dumpConfigBytes": 8001,
  "bootLog": "process remained alive through the readiness window"
}
```

`NpmBackend.prepare()` downloaded the official tarball, verified SRI, copied the profile into an isolated staging home, installed all dependencies, and `stagingHealth()` verified the real binary. Full evidence is written to `.acceptance/real-staging-result.json`.

This run revealed that the previous 3-minute install timeout was too short for a cold 652-package install. The default is now 10 minutes and can be overridden with `installTimeoutMs`.

### Real failure path

An intentionally invalid `cordis.patch.yml` was added to the isolated real profile and `stagingHealth()` was invoked again.

```json
{
  "ok": false,
  "reason": "dsh dump-config exited with 1",
  "errorCode": "UPD-501",
  "stderr": "YAMLException: unexpected end of the stream within a flow collection"
}
```

The gate refused the profile, preserved the error code and stderr evidence, and the invalid patch was removed immediately. The restored profile then passed `--dump-config` again. This exposed and fixed the previous misleading `installer exited with 1` diagnostic.

A post-fix `stagingHealth()` run on the restored real profile returned `ok: true`; the boot log contained no `opening the default browser` line after staging moved to `--port 0 --no-open`.

### Real failed plugin

A local `dsh-plugin-crash` was installed into the isolated profile and inserted through a real profile patch. Its Cordis `apply()` threw during boot. The Host stayed alive and printed:

```text
dsh: warning: 1 entry did not activate
dsh-plugin-crash (dsh-plugin-crash): Error: UPD-ACCEPTANCE plugin exploded during apply
```

This proved that process liveness alone gave a false PASS. Staging now treats that warning as failure, returns the failed plugin name, and the real `ProfileStore.disable()` wrote the profile patch so the next boot passed. The temporary plugin and all profile changes were then removed and `--dump-config` passed again.

### Real watchdog process

A separate helper process was started against a real journal, real snapshot and non-listening port. The owner never committed. At the deadline the helper restored the original profile, transitioned the journal to `rolled-back`, disarmed the watchdog and exited with code 2. Sentinel content, journal and watchdog state all matched the expected rollback.

### Windows Desktop upgrade limitation

The official previous installer `deepseek-harness-0.2.1-rc.5-win-x64.exe` and current `nightly.yml` (`0.2.2-rc.1`) were downloaded and verified; the installer has a valid EV signature. A portable extraction starts only after installer registration, and running the older installer over the working installation would downgrade the active application. The official installed-update qualification requires two independently signed test-identity packages plus a disposable installed environment. This cannot be safely substituted on the working host, so no upgrade result is claimed.

## Windows Desktop

| Item | Result |
|---|---|
| Installed version | `0.2.2-rc.1` |
| Install location | `C:\DeepSeek Harness` |
| Authenticode | `Valid` |
| Signer | `CN=Hangzhou DeepSeek Artificial Intelligence Co., Ltd.` |
| Issuer | GlobalSign GCC R45 EV CodeSigning CA 2020 |
| Desktop runtime | Node.js `24.21.0`, pnpm `11.28.5` |
| Built-in CLI | `resources/runtime/cli/bin/dsh.cmd --version` → `0.2.2-rc.1` |
| Launch | Electron main, GPU, network, renderer and Host processes stable |
| Host health | Process responding; Host loaded `profiles/desktop` from the installed runtime |

The installed application already equals the latest fixed download. Windows-only scope is enforced in package metadata and CI; the official previous installer `0.2.1-rc.5` is available for the cross-version upgrade check. Unit and integration coverage for delegated Coordinator health remains in `test/electron-backend.test.mjs`.

## npm publication

- Official registry name check: `dsh-update-core` returns HTTP 404, so the unscoped name is available.
- `npm whoami --registry https://registry.npmjs.org`: `ENEEDAUTH`.
- No `NODE_AUTH_TOKEN`, `NPM_TOKEN`, or npm auth token in user/global npm configuration.
- Package contents and `npm publish --dry-run` pass for `0.2.4`.
- The repository owner reviewed the authorization request on 2026-11-09 and chose **not to publish at this time**. No token was requested or stored.

When publication is approved later, after `npm login --registry https://registry.npmjs.org`, run:

```bash
npm publish --access public --registry https://registry.npmjs.org
```

## Remaining external work

1. Actual Windows Desktop upgrade from `0.2.1-rc.5` to `0.2.2-rc.1`, including Coordinator restart health and rollback.
2. npm account authorization and final registry publication.

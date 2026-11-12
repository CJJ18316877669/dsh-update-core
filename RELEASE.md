# Release Guide

## Release scope

This repository currently ships two related artifacts:

| Artifact | Version source | Audience |
|---|---|---|
| `dsh-update-core` | root `package.json` | Library/CLI consumers on Windows |
| `dsh-update-core-plugin` | `plugin/package.json` | DeepSeek Harness Desktop nightly users |

The Desktop plugin is a **Windows x64 nightly early preview**, not a stable-channel
updater. A stable-version Harness core never falls back to the nightly feed.

## Before tagging

1. Run on a clean checkout:

   ```bash
   npm test
   npm run smoke:registry
   node --check src/cli.mjs
   npm pack --dry-run
   npm pack ./plugin --dry-run
   ```

2. Confirm the real-profile acceptance record in
   [`docs/PLUGIN_ACCEPTANCE.md`](docs/PLUGIN_ACCEPTANCE.md), including a real
   core update and a successful core/profile rollback.

3. Confirm `CHANGELOG.md`, root version, plugin version and release notes agree.

4. Confirm no tracked document contains local user paths, proxy settings,
   credentials or machine-specific handover notes.

5. Confirm the CI matrix is the intended one: Windows × Node 20/22/24.

## Tag and GitHub release

```bash
git tag v0.3.13
git push origin main
git push origin v0.3.13
```

The release workflow packs both the root library and the Desktop plugin. Mark the
release as **pre-release** while the scope remains Windows nightly preview.

## Do not publish as stable when

- the real update/rollback acceptance record is missing or older than the
  current transaction/supervisor implementation;
- a stable Harness feed is not implemented and the audience includes stable users;
- the release notes cannot state the all-plugin health limitation honestly;
- the worktree or CI is not clean.

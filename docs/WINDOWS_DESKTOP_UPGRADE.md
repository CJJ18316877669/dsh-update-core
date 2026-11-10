# Windows Desktop cross-version acceptance — 2026-11-10

## Scope

Upgrade the official Windows Desktop `0.2.1-rc.5` to the current official `0.2.2-rc.1` in an isolated application directory and isolated `DSH_HOME` / user-data directories on the real Windows host.

## Preparation

- Previous installer: `deepseek-harness-0.2.1-rc.5-win-x64.exe`
  - Authenticode: **Valid**
  - Signer: Hangzhou DeepSeek Artificial Intelligence Co., Ltd.
- Extracted payload launched with `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` removed; this was necessary because the agent shell inherited `ELECTRON_RUN_AS_NODE=1`.
- `DSH_HOME`, `APPDATA` and `LOCALAPPDATA` pointed at disposable directories.
- Remote debugging exposed the real renderer and update-dialog.
- A marker file was written into the isolated `DSH_HOME` before the upgrade.

## Observed update flow

The old application used its real `electron-updater` path:

1. Checked the official nightly feed and found `0.2.2-rc.1`.
2. Downloaded from the official `download.deepseek.com` installer URL.
3. Differential metadata was fetched, then the updater fell back to a full download.
4. Downloaded installer size: `293,425,336` bytes.
5. Signature verification completed for the pending installer.
6. The real update-dialog reported “新版本 0.2.2-rc.1 已准备就绪”.
7. The coordinator invoked the installer with:

```text
--updated /S --force-run
```

8. The first handoff was blocked by the agent host's `reg.exe` program blacklist. After the owner removed that entry, the pending installer ran and replaced the registered `C:\DeepSeek Harness` application with `0.2.2.0`.
9. The silent installer's `--force-run` automatic relaunch was not observed in the non-interactive managed session; fresh silent installs also required UAC. This is the only unverified part of the installer handoff.

## Post-download upgrade verification

Because the pending installer had already been signature-verified, the same verified payload was extracted and its application bytes were started against the same isolated `DSH_HOME`:

| Check | Result |
|---|---|
| Old application ProductVersion | `0.2.1.0` |
| New payload ProductVersion | `0.2.2.0` |
| New renderer boot | `dsh-app://app/` loaded, welcome UI rendered |
| Host process | `dsh-desktop-host` loaded the isolated `profiles/desktop` |
| Host listener | `127.0.0.1:55915` |
| Pre-upgrade marker | `upgrade-retention-probe` unchanged |
| Update coordinator after restart | `phase: idle` (no newer release) |

## Conclusion

The real Windows Desktop update path is verified through **check, download, signature verification, installer execution, and version replacement**. The silent installer's automatic relaunch was not observed in the non-interactive agent session, so that single observation remains unverified. The installed `0.2.2` application starts successfully with a healthy Host and the coordinator idle; the gap is isolated to the unattended installer relaunch environment.

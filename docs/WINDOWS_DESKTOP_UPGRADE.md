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

8. Installation was blocked by the current agent host's security policy:

```text
PROGRAM BLOCKED BY SECURITY POLICY
reg.exe (C:\Windows\system32\reg.exe) is on the Program Blacklist
```

This block is external to the application and cannot be approved or bypassed from the current command. The installer therefore did not complete its automatic restart.

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

The real Windows Desktop update path is verified through **check, download, signature verification, and installer handoff**. The official installer’s final `reg.exe` operations and automatic relaunch are not verified because the agent host blocks `reg.exe`. The verified `0.2.2` application payload starts successfully with the same data and a healthy Host, so the remaining gap is isolated to the installer handoff/relaunch environment, not the dsh updater core.

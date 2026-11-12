# Desktop Plugin Acceptance — 2026-11-12

## Scope

End-to-end acceptance of the Desktop DSH plugin against a real installed Windows
Desktop and its real profile. Paths in this record are intentionally generic.

| Item | Value |
|---|---|
| Host | Windows x64 |
| Desktop before | `0.2.2-rc.1` |
| Desktop after update | `0.2.2-rc.2` |
| Desktop after rollback | `0.2.2-rc.1` |
| Plugin | `dsh-update-core-plugin@0.2.12` |
| Channel | `nightly` |
| Plan before | 0 plugin updates, 15 kept, 1 compatibility risk, 1 unverified target |
| Known risk | `dsh-workbuddy-connect@0.7.9` is incompatible with the current core |

## Update run

The update was started through the authenticated local API with explicit
compatibility-risk confirmation.

| Check | Result |
|---|---|
| Run | `2026-11-12T00-43-02-811Z` |
| Downloaded installer | sha512 + Authenticode verified |
| Downloaded rollback installer | Authenticode verified |
| Final state | `succeeded` |
| Core version | `0.2.2-rc.2` |
| App health | `appHealthy: true` |
| Profile dependencies | `profileDependencies: ok` |
| Plugin updates | 0 |
| Plugins kept | 15 |

The compatibility risk and unknown-contract candidate were both held as designed:
`dsh-workbuddy-connect@0.7.9` remained installed with a warning, and
`dsh-plugin@2.3.6 → 2.3.9` was not auto-updated because the target contract is
unknown.

## Rollback run

Immediately after the successful update, the plugin's authenticated rollback API
was invoked.

| Check | Result |
|---|---|
| Run | `2026-11-12T01-01-10-591Z` |
| Final state | `rolled-back` |
| Core version | `0.2.2-rc.1` |
| `coreRolledBack` | `true` |
| `profileRestored` | `true` |
| `appHealthy` | `true` |
| Final status | core `0.2.2-rc.1`, channel `nightly` |

## Evidence handling

Raw run records contain machine-specific paths and are intentionally not committed
to the public repository. This document keeps the reproducible summary: exact
versions, run IDs, terminal states, rollback flags and health results.

# Contributing

## Requirements

- Node.js 20 or newer for the library.
- No runtime dependencies. Do not add one without an explicit design decision.
- Tests and local demo use only OS temporary directories. Never point tests at a real `$DSH_HOME`.
- Real dsh releases may require a newer Node.js; that is checked per release and must not be bypassed.

## Development

```bash
npm test
npm run smoke:registry
npm run ui
npm run previews
for f in $(find src test scripts -type f -name '*.mjs'); do node --check "$f"; done
```

`npm run previews` requires Edge on Windows, or set `EDGE_PATH`. It starts a loopback live server and writes the six tracked screenshots.

## Change rules

- Preserve the public contracts: 17 orchestrator states, `ALLOWED_TRANSITIONS`, `UPD-*` codes and CLI exit codes 0/1/2/3.
- `PluginGate.verify()` stays in the staging phase. It must never run during `check()`.
- Do not weaken or delete existing assertions. Add regression coverage for every bug fix.
- Any write to the formal profile must have a tested recovery path. Never use “delete then replace” for a profile.
- Any rollback rename must surface errors; cleanup may ignore only paths that cannot affect correctness.
- Do not log or transmit plugin configuration, prompts, paths, tokens or session content.
- Keep live-server routes on the explicit allowlist. Never add a generic file, shell, URL or path endpoint.
- Update `CHANGELOG.md` and relevant contract cards with behavior changes.

## Pull requests

1. Explain the invariant being changed or protected.
2. Include the failing case before the fix when possible.
3. Run `npm test`, syntax checks and relevant smoke tests.
4. List unresolved risks and anything not verified on a real platform.
5. Keep a pull request focused; do not mix refactoring with behavior changes.

Use the issue and pull-request templates. Security reports follow `SECURITY.md`, not public issues.

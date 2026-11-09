# Privacy

## Default

Telemetry is **off by default**. The library uses an in-memory sink only; no update event leaves the machine unless a host explicitly enables `HttpSink` with its own endpoint.

## Data allowed when explicitly enabled

Aggregate update lifecycle fields only:

- event name and timestamp
- from/to version
- channel
- backend kind
- duration in milliseconds
- public error code and stage
- plugin update/disable counts
- aggregate stage and percentage sample

Sampling defaults to 5% for stage events; terminal events are not sampled by default.

## Never sent

- plugin names or package identifiers
- profile names, file paths, `$DSH_HOME`, logs or configuration values
- prompts, sessions, messages or model data
- registry tokens, authorization headers, cookies or credentials
- email addresses or usernames

Before writing, `Telemetry` applies recursive redaction for home paths, common user-directory paths, emails, bearer tokens, URL credentials and secret-like keys. Payload depth, array length and queue size are bounded.

## Transport and failure behavior

- HTTPS is mandatory; only loopback development endpoints may use HTTP.
- Endpoints containing credentials are rejected.
- Requests time out (default 3 seconds).
- A failed batch is discarded, not retried in a loop.
- Telemetry failure never fails, delays or rolls back an update.
- Hosts can disable telemetry with `new Telemetry({ enabled: false })`, which is the default for the CLI and live prototype.

## Local data

Journal, watchdog and lock files live under `$DSH_HOME/updates`. They contain versions, state transitions, snapshot paths, plugin counts, process IDs and bounded startup evidence, but no prompts, credentials or session content. Logs and backups follow the retention policy in `README.md` and `HANDOVER.md`.

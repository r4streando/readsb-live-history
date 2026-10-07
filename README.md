# readsb-live-history

Persistent SQLite history for live [readsb](https://github.com/wiedehopf/readsb) aircraft state and receiver statistics.

`readsb-live-history` polls readsb's live JSON output and records durable encounter history, including aircraft that never produce a usable position trace. It is intended to complement readsb/tar1090 history rather than replace it.

## What it records

- Every fresh six-digit ICAO address present in `aircraft.json`, including minimal ICAO-only contacts.
- Encounter lifecycle: first/last seen, positioned and positionless poll counts, callsigns, message deltas, RSSI aggregates, and close reason.
- Sparse aircraft samples on first sighting, meaningful state change, or periodic baseline.
- Receiver statistics from `stats.json`, sampled independently at a configurable interval.
- readsb `dbFlags` military classification when available, with explicit provenance.
- Source timestamps so duplicate or stale `aircraft.json` snapshots do not inflate history.

A **positionless** observation means readsb did not provide a fresh usable latitude/longitude for that poll. It does not, by itself, prove that the transmission was Mode S rather than another readsb source/type.

## Requirements

- Linux host running readsb or another service producing compatible `aircraft.json` and `stats.json` files.
- Node.js 22.5.0 or newer installed system-wide; the collector uses the built-in `node:sqlite` module.
- systemd if you want to use the supplied service unit.

There are no third-party runtime dependencies.

## Quick install

The repository is public. A normal HTTPS clone works without a GitHub account, token, SSH key, or deploy key.

First verify the Node.js prerequisite:

```bash
command -v node
node --version
```

The version must be `v22.5.0` or newer. Node must be installed system-wide in `/usr/local/bin` or `/usr/bin`; a per-user nvm installation is not suitable for the supplied service. If Node is missing, see [the deployment guide](deploy/README.md#install-nodejs-22).

Then install the collector:

```bash
sudo git clone --depth 1 https://github.com/r4streando/readsb-live-history.git /opt/readsb-live-history

sudo install -m 0644 \
  /opt/readsb-live-history/deploy/readsb-live-history.service \
  /etc/systemd/system/readsb-live-history.service

sudo systemctl daemon-reload
sudo systemctl enable --now readsb-live-history.service
```

Verify it:

```bash
systemctl status readsb-live-history.service
journalctl -u readsb-live-history.service -n 100 --no-pager
sudo node /opt/readsb-live-history/bin/readsb-live-history.js active
```

For fresh installs, upgrades, converting an older private-repository checkout, Node.js installation, custom paths/users, backup, and uninstall instructions, see [`deploy/README.md`](deploy/README.md).

## Default paths and intervals

| Item | Default |
| --- | --- |
| aircraft JSON | `/run/readsb/aircraft.json` |
| stats JSON | `/run/readsb/stats.json` |
| SQLite database | `/var/lib/readsb-live-history/readsb-live-history.sqlite3` |
| poll interval | 10 seconds |
| maximum `seen` age | 30 seconds |
| encounter close timeout | 60 seconds |
| periodic aircraft sample | 60 seconds |
| receiver stats sample | 60 seconds |

All can be overridden from the command line.

## CLI

```text
readsb-live-history collect [options]
readsb-live-history active [--hex A1B2C3] [options]
readsb-live-history encounters [--hex A1B2C3] [options]
readsb-live-history samples [--hex A1B2C3] [options]
readsb-live-history stats [options]
```

Options:

```text
--aircraft-json PATH
--stats-json PATH
--database PATH
--poll-seconds N
--max-seen-seconds N
--encounter-close-seconds N
--periodic-snapshot-seconds N
--stats-snapshot-seconds N
--hex HEX
```

The legacy `readsb` prefix is also accepted, so `readsb-live-history readsb collect ...` remains valid during migration from the original report-repository implementation.

Because the standalone deployment calls the script directly with Node, you can inspect a deployed database without globally installing anything:

```bash
sudo node /opt/readsb-live-history/bin/readsb-live-history.js active
sudo node /opt/readsb-live-history/bin/readsb-live-history.js encounters --hex A1B2C3
sudo node /opt/readsb-live-history/bin/readsb-live-history.js samples --hex A1B2C3
sudo node /opt/readsb-live-history/bin/readsb-live-history.js stats
```

## systemd

The supplied unit:

- runs as `readsb`;
- starts after and wants `readsb.service`;
- resolves `node` through a controlled system PATH containing `/usr/local/bin` and `/usr/bin`;
- reads `/run/readsb/aircraft.json` and `/run/readsb/stats.json`;
- stores state under `/var/lib/readsb-live-history` via `StateDirectory=readsb-live-history`;
- restarts on failure;
- uses systemd hardening including `NoNewPrivileges`, `ProtectSystem=strict`, and `ProtectHome=true`.

If your readsb installation uses a different service user, JSON paths, or a nonstandard Node installation path, adjust the unit or use a systemd override before enabling it.

## SQLite model

The database currently uses schema version 2 and contains:

- `readsb_encounters`
- `readsb_samples`
- `readsb_receiver_stats`
- `readsb_ingestion_state`

File databases use WAL mode, `synchronous=NORMAL`, a 5-second busy timeout, and a WAL autocheckpoint of 1000 pages.

No automatic retention or deletion is currently performed.

## Encounter behavior

- A fresh valid six-digit ICAO contact opens an encounter immediately.
- A contact with no fresh usable position is stored as `positionless`.
- A contact with a fresh valid position is stored as `positioned`.
- Successful polls update lifecycle counters even when no sparse sample is inserted.
- Missing contacts close after the configured absence timeout.
- A malformed or unavailable input file does **not** close encounters.
- Open encounters left by a prior collector process are closed as `collector_restart` at startup.
- A clean shutdown closes open encounters as `collector_shutdown`.

## Development

```bash
npm test
npm run check
```

The test suite uses Node's built-in test runner and an in-memory or temporary SQLite database.

## Origin

This collector was originally developed inside `r4streando/globe-history-report` to capture live readsb state that tar1090 `globe_history` traces cannot reliably reconstruct. This repository is the standalone deployment version.

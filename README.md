# readsb-live-history

Persistent history recorder for live [readsb](https://github.com/wiedehopf/readsb) aircraft state and receiver statistics.

The collector reads `aircraft.json` and `stats.json` on a short interval and stores durable SQLite history that remains useful even for aircraft that never produce a position trace.

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
- Node.js 22.5 or newer (`node:sqlite` is used directly).

There are no third-party runtime dependencies.

## Default paths

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

All of these can be overridden from the command line.

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

The legacy `readsb` prefix is also accepted, so `readsb-live-history readsb collect ...` works during migration from the original report-repository implementation.

## Install on a readsb host

A typical standalone installation uses `/opt/readsb-live-history` for the code and `/var/lib/readsb-live-history` for persistent state.

```bash
sudo git clone https://github.com/r4streando/readsb-live-history.git /opt/readsb-live-history
cd /opt/readsb-live-history
sudo npm install --omit=dev
sudo cp deploy/readsb-live-history.service /etc/systemd/system/readsb-live-history.service
sudo systemctl daemon-reload
sudo systemctl enable --now readsb-live-history.service
```

For a private repository, clone using an authenticated GitHub method instead of the unauthenticated URL above.

Check operation with:

```bash
systemctl status readsb-live-history.service
journalctl -u readsb-live-history.service -f
sudo node /opt/readsb-live-history/bin/readsb-live-history.js active
```

## systemd

The supplied unit uses systemd's `StateDirectory=readsb-live-history`, which creates and manages `/var/lib/readsb-live-history`. It runs as the `readsb` user by default and expects that user to be able to read `/run/readsb/aircraft.json` and `/run/readsb/stats.json`.

If your readsb installation uses a different user or different JSON paths, copy the unit and adjust `User=` and/or the command-line arguments before enabling it.

## SQLite model

The database currently uses schema version 2 and contains:

- `readsb_encounters`
- `readsb_samples`
- `readsb_receiver_stats`
- `readsb_ingestion_state`

File databases use WAL mode, `synchronous=NORMAL`, a 5-second busy timeout, and a WAL autocheckpoint of 1000 pages.

No automatic retention/deletion is currently performed.

## Encounter behavior

- A fresh valid six-digit ICAO contact opens an encounter immediately.
- A contact with no fresh usable position is stored as `positionless`.
- A contact with a fresh valid position is stored as `positioned`.
- Successful polls update lifecycle counters even when no sparse sample is inserted.
- Missing contacts close after the configured absence timeout.
- A malformed/unavailable input file does **not** close encounters.
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
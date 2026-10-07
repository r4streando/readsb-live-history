# Deployment

`readsb-live-history` is designed to run on the same Linux host as readsb. The repository is public, so deployment uses a normal unauthenticated HTTPS clone; no GitHub token, SSH key, or deploy key is required.

## Requirements

- A Linux host running readsb, with readable `aircraft.json` and `stats.json` files.
- Git.
- Node.js 22.5.0 or newer.
- The Node executable at `/usr/bin/node`, which is the path used by the supplied systemd unit.
- systemd for the supplied service unit.

The collector uses Node's built-in `node:sqlite` module. There are no third-party runtime dependencies, so a production deployment does not need `npm install`.

Check the exact executable used by systemd:

```bash
/usr/bin/node --version
```

The reported version must be `v22.5.0` or newer. A `node` command provided only by nvm or another per-user shell setup is not sufficient for the supplied service unit.

## Install Node.js 22

First determine the Debian package architecture:

```bash
dpkg --print-architecture
```

### amd64 or arm64

NodeSource publishes Node.js 22 packages for both architectures. Install them with:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs

/usr/bin/node --version
```

Do not continue unless `/usr/bin/node` exists and reports `v22.5.0` or newer.

### armhf / 32-bit ARM

Current NodeSource DEB packages do not support `armhf`. Official Node.js 22 releases do publish Linux ARMv7 binaries, so use an official Node.js ARMv7 build or migrate the host to a 64-bit OS.

After installing Node manually, make sure the executable used by systemd is actually available at:

```text
/usr/bin/node
```

If you intentionally install Node elsewhere, change `ExecStart=` in the service unit to that absolute path.

## Fresh install

The standard layout is:

- code: `/opt/readsb-live-history`
- database/state: `/var/lib/readsb-live-history`
- service: `/etc/systemd/system/readsb-live-history.service`

Verify Node before installing the service:

```bash
test -x /usr/bin/node
/usr/bin/node --version
```

Then install from the public repository:

```bash
sudo git clone --depth 1 https://github.com/r4streando/readsb-live-history.git /opt/readsb-live-history

sudo install -m 0644 \
  /opt/readsb-live-history/deploy/readsb-live-history.service \
  /etc/systemd/system/readsb-live-history.service

sudo systemctl daemon-reload
sudo systemctl enable --now readsb-live-history.service
```

The supplied unit runs as the `readsb` user and reads:

```text
/run/readsb/aircraft.json
/run/readsb/stats.json
```

Before troubleshooting the collector itself, confirm that the service user can read those files:

```bash
sudo -u readsb test -r /run/readsb/aircraft.json && echo 'aircraft.json readable'
sudo -u readsb test -r /run/readsb/stats.json && echo 'stats.json readable'
```

If your readsb installation uses another user or JSON path, edit the installed systemd unit before enabling it.

## Verify

```bash
systemctl status readsb-live-history.service
journalctl -u readsb-live-history.service -n 100 --no-pager

sudo /usr/bin/node /opt/readsb-live-history/bin/readsb-live-history.js active
sudo /usr/bin/node /opt/readsb-live-history/bin/readsb-live-history.js encounters
sudo /usr/bin/node /opt/readsb-live-history/bin/readsb-live-history.js stats
```

The database should appear at:

```text
/var/lib/readsb-live-history/readsb-live-history.sqlite3
```

systemd creates `/var/lib/readsb-live-history` through `StateDirectory=readsb-live-history` and makes it writable by the service.

## Troubleshooting: status=203/EXEC

If the journal contains:

```text
Failed to locate executable /usr/bin/node: No such file or directory
Failed at step EXEC spawning /usr/bin/node
status=203/EXEC
```

the collector has not started yet. systemd cannot find the Node executable named by `ExecStart=`.

Check:

```bash
command -v node || true
ls -l /usr/bin/node 2>/dev/null || true
dpkg --print-architecture
cat /etc/os-release
```

If `/usr/bin/node` is missing, install Node.js 22 as described above. Then clear the failure and restart:

```bash
sudo systemctl reset-failed readsb-live-history.service
sudo systemctl restart readsb-live-history.service
systemctl status readsb-live-history.service --no-pager
journalctl -u readsb-live-history.service -n 50 --no-pager
```

## Convert an existing private-repository checkout

If `/opt/readsb-live-history` was originally cloned while the repository was private, there is no reason to reclone it. Point the existing checkout at the public HTTPS remote and update normally:

```bash
sudo git -C /opt/readsb-live-history remote set-url origin \
  https://github.com/r4streando/readsb-live-history.git

sudo git -C /opt/readsb-live-history remote -v
sudo git -C /opt/readsb-live-history fetch --prune origin
sudo git -C /opt/readsb-live-history pull --ff-only
```

After that, GitHub authentication is no longer required for normal pulls.

## Upgrade

Stop the collector, fast-forward the public checkout, reinstall the shipped unit in case it changed, and restart:

```bash
sudo systemctl stop readsb-live-history.service

sudo git -C /opt/readsb-live-history pull --ff-only

sudo install -m 0644 \
  /opt/readsb-live-history/deploy/readsb-live-history.service \
  /etc/systemd/system/readsb-live-history.service

sudo systemctl daemon-reload
sudo systemctl start readsb-live-history.service

systemctl status readsb-live-history.service --no-pager
```

Updating the code does not replace the SQLite database under `/var/lib/readsb-live-history`.

## Custom configuration

The shipped service starts the collector with:

```text
--aircraft-json /run/readsb/aircraft.json
--stats-json /run/readsb/stats.json
--database /var/lib/readsb-live-history/readsb-live-history.sqlite3
--poll-seconds 10
--max-seen-seconds 30
--encounter-close-seconds 60
--periodic-snapshot-seconds 60
--stats-snapshot-seconds 60
```

For local changes, edit `/etc/systemd/system/readsb-live-history.service`, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl restart readsb-live-history.service
```

Be aware that a later upgrade command that reinstalls the repository's service file will overwrite local edits. If you maintain local overrides, a systemd drop-in is safer:

```bash
sudo systemctl edit readsb-live-history.service
```

## Back up the database

For a simple consistent backup, stop the collector before copying the SQLite database:

```bash
sudo systemctl stop readsb-live-history.service
sudo cp -a \
  /var/lib/readsb-live-history/readsb-live-history.sqlite3 \
  /path/to/backup/
sudo systemctl start readsb-live-history.service
```

## Uninstall

Remove the service and code while preserving history:

```bash
sudo systemctl disable --now readsb-live-history.service
sudo rm -f /etc/systemd/system/readsb-live-history.service
sudo systemctl daemon-reload
sudo rm -rf /opt/readsb-live-history
```

The historical database remains under `/var/lib/readsb-live-history`.

To delete the recorded history too, remove that directory separately:

```bash
sudo rm -rf /var/lib/readsb-live-history
```

That last command is destructive and cannot be undone unless you have a backup.

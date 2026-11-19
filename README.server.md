# report.ppsspp.org on www@main

The report server runs as a systemd service, as the user `unknown`. It starts at boot and restarts by itself if it exits;
nothing has to be done by hand after a reboot.

    sudo systemctl status ppsspp-report      # is it running?
    sudo systemctl restart ppsspp-report     # after changing code or config
    sudo systemctl stop ppsspp-report
    sudo systemctl start ppsspp-report
    sudo journalctl -u ppsspp-report -n 50   # systemd's view (start/stop/crash)
    tail -f ~/ppsspp-report/server.log       # the app's own log (as unknown)

- Unit file: `/etc/systemd/system/ppsspp-report.service` (master copy on ZEN: `/home/hrydg/server/ppsspp-report/`).
  After editing it: `sudo systemctl daemon-reload && sudo systemctl restart ppsspp-report`.
- It runs `source ./config && exec node server.js` in this folder, using `/home/unknown/node-v26.13.0-linux-x64/bin/node`
  (node 14 until 2026-11-08; the old node folder is still there for rollback).
  `config` holds the listen address (127.0.0.1:9900), the public URL and the MySQL login.
- nginx (`/etc/nginx/sites-available/default`, `server_name report.ppsspp.org`) proxies to 127.0.0.1:9900.
- `server.log` is rotated daily by `/etc/logrotate.d/ppsspp-report` (14 days, copytruncate).

The old start/stop scripts (`start.sh`, `stop.sh`, `run.sh`, `startblock.sh`, `upstart.conf`, the old unit copy) were removed
on 2026-11-08; don't start the server by hand, or a second copy runs outside systemd. Copies are on ZEN in
`/home/hrydg/server/ppsspp-report/old/`.

## Code and updates

This folder is a git checkout of https://github.com/hrydgard/ppsspp-report (our fork; unknownbrackets' original is
no longer maintained). `config`, `server.log*` and `uploads/` are not in git. To deploy a new version (as `unknown`):

    cd ~/ppsspp-report && git pull
    PATH=~/node-v26.13.0-linux-x64/bin:$PATH npm ci --omit=dev   # only if package-lock.json changed
    # then, as a sudoer: sudo systemctl restart ppsspp-report

`~/ppsspp-report-old` is the pre-2026-11-08 tree (node 14 code, `backups/` from 2022, old one-off scripts).

## Blocking noisy message kinds

Every log message belongs to a kind (its format string; the "Kind #" column on /logs/kinds). A blocked kind's incoming messages
are accepted but dropped; what's already stored stays visible. Takes effect within a minute, no restart:

    sudo -u unknown ~unknown/ppsspp-report/tools/kind list            # blocked kinds
    sudo -u unknown ~unknown/ppsspp-report/tools/kind show 455 808    # text, flag, message count
    sudo -u unknown ~unknown/ppsspp-report/tools/kind block 455 808
    sudo -u unknown ~unknown/ppsspp-report/tools/kind unblock 455

Messages from PPSSPP older than `settings.min_version_value` (now 12000000 = v1.20.0) are dropped the same way, for compat
reports too: `UPDATE settings SET min_version_value=...` in the ppsspp_report DB (picked up within 30 minutes).

## JSON API and log pages

- `https://report.ppsspp.org/api/v1` is a read-only JSON API over the log data (kinds, grouped texts, full messages with
  GPU/driver/version details). Documented in `API.md` in this folder; `GET /api/v1` describes itself.
- The `/logs` pages have Hits, paging (`?before=`), `/logs/kind/<id>/grouped` (by message text) and `?min_version=v1.20.4`
  filters, also on `/logs/kinds`.
- MySQL tuning for this server is in `/etc/mysql/mysql.conf.d/ppsspp-tuning.cnf` (buffer pool, temp table and sort sizes,
  redo log), with the reasons in comments.

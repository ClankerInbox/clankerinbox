# clankerinbox.com on the `apps` server

The landing page is the `site/` folder of this repo. It runs on the `apps` server
(`ssh apps`) and deploys itself: a timer checks `main` every
minute. When `main` moves, the server pulls it, makes a release and switches to it.
Merge to `main` = live in about a minute. Nothing pushes to the server.

## Layout on the server

| Path | What |
| --- | --- |
| `/srv/clankerinbox/repo.git` | Mirror of this repo (public, read over HTTPS) |
| `/srv/clankerinbox/releases/<sha>` | One folder per deployed commit (last 5 kept) |
| `/srv/clankerinbox/current` | Symlink to the live release; Caddy serves `current/site` |
| `/srv/clankerinbox/held/<sha>` | Commits that failed under the timer (not retried) |
| `/etc/caddy/sites/clankerinbox.caddy` | Copy of `clankerinbox.caddy` |

Everything runs as the `clankerinbox` user, which has no sudo.

## Check and operate

```bash
ssh apps 'cat /srv/clankerinbox/current/REVISION'      # live commit
curl -s https://clankerinbox.com/health.json           # same, from outside
ssh apps 'journalctl -u clankerinbox-deploy -n 50'     # deploy log
ssh apps 'sudo -u clankerinbox node /srv/clankerinbox/current/deploy/apps-server/deploy.mjs --ref=<sha>'  # roll back
```

A change to a unit file or the Caddy file must be copied to the server again; the timer
deploys only the site and `deploy.mjs`.

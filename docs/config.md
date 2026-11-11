# Config, env vars and state

## Config

`~/.config/clankerinbox/config.json` (mode 600), as setup writes it:

```json
{
  "teamId": "TeamX1",
  "from": "Clanker Inbox <clankerinbox@inbox.example.com>",
  "domain": "inbox.example.com",
  "sendKeyEnv": "POSTSHIBA_SEND_API_KEY",
  "readKeyEnv": "POSTSHIBA_FULL_API_KEY",
  "caps": { "sendPerHour": 30, "receivePerSenderPerHour": 20 },
  "inboxes": {
    "agent":  { "id": "ib8c04ca", "address": "agent@inbox.example.com", "mode": "answers",
                "allow": ["you@example.org"], "send": ["you@example.org"] },
    "signup": { "id": "ib3495d7", "address": "signup@inbox.example.com", "mode": "codes",
                "allow": "*", "send": [] }
  }
}
```

- `allow`: who may write in. `"*"` is only valid on a `codes` inbox; DMARC is still required. An `answers` or `requests` inbox needs a list.
- `send`: who the inbox may send to. The first entry is the default `--to`.
- `allowAutomated` (optional, default `false`): accept all automated mail from allow-listed senders (auto-replies and list mail too), and the mail this machine sent itself. Only for tests in which the tool answers its own question. Another agent's mail needs no switch (see [Two agents](two-agents.md)).
- `sendKeyEnv` and `readKeyEnv`: the names of the env vars with the send key and the full-access key (`readKeyEnv` is the env var that `CLANKERINBOX_SETUP_KEY_ENV` named at setup, if it named one).
- Optional: `apiUrl` (another PostShiba API; setup writes it when it used one), `tenant`, `retentionHours` (how long the provider keeps mail, default 168), `caps.maxBodyBytes` (default 1 MB), `domain` (the domain of setup, where `create` adds addresses; without it, the domain of `from`).
- `provider`: `postshiba` (the default when it is missing) or `cloudflare`. A Cloudflare config has `cloudflare {url, tokenEnv}` (and `trustedAuthservId`, and `worker`, the name of the Worker, when it is not `clankerinbox`), and each inbox's `id` is its address. `teamId`, `sendKeyEnv` and `readKeyEnv` are PostShiba only.

`config.secrets.json` next to the config (mode 600) holds the keys and tokens that setup saved, by env var name. An env var with the same name always wins.

## Env vars

| Env var | What it does |
| --- | --- |
| `POSTSHIBA_SEND_API_KEY` | The PostShiba send key (`sendKeyEnv` in the config names another). |
| `POSTSHIBA_FULL_API_KEY` | The PostShiba full-access key (`readKeyEnv` names another). |
| `CLANKERINBOX_CF_TOKEN` | The Worker token (`cloudflare.tokenEnv` or `--token-env` names another). |
| `CLANKERINBOX_SETUP_KEY_ENV` | The name of another env var with the full-access key, for `setup` and `create`. The config then reads mail with that env var too. |
| `CLANKERINBOX_CONFIG` | The config file (default `~/.config/clankerinbox/config.json`). |
| `CLANKERINBOX_STATE` | The state folder (default `~/.local/state/clankerinbox`). |
| `CLANKERINBOX_POSTSHIBA_API` | Another PostShiba API (https, or http to this machine), for example a test server; used where the config has no `apiUrl`, and setup writes it into the config. |
| `CLANKERINBOX_CLOUDFLARE_API` | Another Cloudflare API for `setup`, `create` and `check` (for tests). |
| `CLANKERINBOX_WRANGLER` | Another wrangler: a path (`/usr/local/bin/wrangler`), or a command line in which a path with spaces is in quotes (`'"/opt/my tools/wrangler"'`). Without it, setup runs wrangler through `npx`. |
| `NO_COLOR`, `TERM=dumb` | No colour; with `TERM=dumb` also no cursor codes (numbered menus, a spinner as one plain line). |
| `AGENTMAIL_CONFIG`, `AGENTMAIL_STATE`, `AGENTMAIL_SETUP_KEY_ENV` | The old names (see [Renamed from agentmail](#renamed-from-agentmail)). |

## State

The state folder (`~/.local/state/clankerinbox`, or `CLANKERINBOX_STATE`) holds what this machine knows. Many processes can share it (a poll service, agents that ask and wait, parallel sends): each change runs under a lock file and replaces the file whole.

| File | What it holds |
| --- | --- |
| `questions.json` | The questions this machine asked, and their answers. Answered questions are dropped 30 days after the answer. |
| `processed.json` | The ids of the mail that was handled, so each mail is read once. Kept as long as the provider keeps mail (`retentionHours`, or what the Worker reports) plus 24 hours. |
| `codes.json` | The sign-up mails whose code was handed out, so `code --wait` waits for a new one. |
| `cursors.json` | Cloudflare: the place in the mail of each address up to which the CLI read. |
| `sending.json` | Sends in progress, for the hourly send cap. |
| `waiters.json` | The `ask --wait` and `wait` processes that wait now, so `poll` leaves their answers to them. |
| `log.jsonl` | The mail log: each sent and received mail, as threads (`clankerinbox log`). For sign-up mail it keeps only the subject, with each code-shaped number and the path and query of each link masked; questions, answers and requests are kept as written, the first 64 KB of each body. PostShiba and the Worker keep mail for 168 hours; the log is the long-term history. |
| `state.lock` | The lock. A lock left by a process that died is taken over. |

A state file that cannot be read as JSON is never taken as empty: it is moved to `<name>.corrupt-<time>` and the command fails with the path. Repair it and move it back, or run the command again to start that file empty.

## Renamed from agentmail

The tool was called `agentmail`. A machine set up under that name keeps working: when `~/.config/clankerinbox/` or `~/.local/state/clankerinbox/` does not exist, the tool reads `~/.config/agentmail/` and `~/.local/state/agentmail/`, and `AGENTMAIL_CONFIG`, `AGENTMAIL_STATE`, `AGENTMAIL_SETUP_KEY_ENV` and the `AgentMail` class still work. The config and the state fall back each on their own, so `setup` and `check` say once when either one still uses an old folder, with the command to move it:

```sh
mv ~/.config/agentmail ~/.config/clankerinbox && mv ~/.local/state/agentmail ~/.local/state/clankerinbox
```

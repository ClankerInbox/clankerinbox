# Setup

## The command

The command is `bin/clankerinbox.js`, a small launcher. It checks the Node version (an older Node gets a clear message), then runs the TypeScript entry `bin/clankerinbox.ts`. Node strips TypeScript types by itself, but not under `node_modules`, where npm installs the tool; there the launcher strips the types of the tool's own files with Node's `stripTypeScriptTypes`. A real command on PATH (not a shell alias) also works for agents, whose shells do not read aliases. In a clone, `node bin/clankerinbox.ts …` works too.

## Setup in a terminal

Run setup in a terminal and answer its questions:

```sh
clankerinbox setup
```

```
clankerinbox setup
Give your agent its own email address, so it can ask you questions, read your replies and receive verification codes.
Press Ctrl+C to stop at any time.

Cloudflare's free plan only sends to addresses you verify, which is enough for questions to yourself. Sending to anyone needs Workers Paid ($5 a month).
Which mail service? PostShiba

No account yet? Sign up at https://app.postshiba.com/users/sign_up
In PostShiba: API keys → Create API key → Access: Full access. Copy the token.
Setup uses it to create the agent's inboxes and read replies. Help: https://www.postshiba.com/docs/create-an-api-key
PostShiba full-access key: *************

Optional but safer: a Send only key (API keys → Create API key → Send only). It can send mail but not read it.
PostShiba send-only key (Enter to use the full-access key): *************

✓ Team: Test team

Your agent's addresses go on this domain, e.g. agent@<domain>.
Which domain? inbox.example.com

The agent's address will be <name>@inbox.example.com. Verification codes go to signup@inbox.example.com.
Add more addresses later (e.g. one per agent) with: clankerinbox create <name>
Agent name: (agent)

The agent sends its questions here and only accepts replies from here. Separate several addresses with commas.
Your email address: you@example.org
  Only replies from you@example.org count.

Keys are saved next to the config, never in it. If you skip this, set them in your shell yourself.

Save the keys in a file only you can read? (Y/n)

✓ Saved the config to /home/you/.config/clankerinbox/config.json
✓ Saved the keys to /home/you/.config/clankerinbox/config.secrets.json

✓ Send key (POSTSHIBA_SEND_API_KEY in /home/you/.config/clankerinbox/config.secrets.json)
✓ Read mail from PostShiba (POSTSHIBA_FULL_API_KEY in /home/you/.config/clankerinbox/config.secrets.json)
✓ Mail for inbox.example.com reaches PostShiba
✓ PostShiba lets inbox.example.com send

Last step: a real test. Your agent emails you@example.org, and you reply from that address.
Ctrl+C stops setup here. Your config is already saved.

Send the test question? (Y/n)

✓ Sent to you@example.org
✓ Got your reply from you@example.org: "ok"
✓ Everything works.

Setup is complete. Your agent's addresses:
    agent@inbox.example.com    asks you questions and gets your replies
    signup@inbox.example.com   receives verification codes

Try it:       clankerinbox ask "Ship it?" --option Yes --option No --wait
All commands: clankerinbox --help
```

Menus take the arrow keys and Enter, or a number key, which picks at once in a menu of at most 9 choices (no Enter), and then show the choice as above; long lists show a page and take typed letters as a filter. With `TERM=dumb`, setup uses numbered lists and plain lines; `NO_COLOR` turns the colours off.

Setup finds what it can by itself, so you mostly pick and confirm:

- **PostShiba:** links to sign up and to the key page. The team and the domains come from the full-access key; "Add a new domain" adds one in PostShiba, prints every DNS record it needs (MX, DKIM, return path, DMARC) and runs PostShiba's DNS check until it passes, or goes on when you select "Continue, check later" (setup then ends unfinished until the records pass; `clankerinbox check` tells you). Before it asks for the MX record, setup looks up the MX records of the domain: when the domain gets mail from another service now (Google Workspace, Microsoft 365, Fastmail, Proton or another server), it names the service, says that the mail to all other addresses on the domain would go to PostShiba, and offers a subdomain (`inbox.<domain>`); the default answer is No. A send-only key typed where the full-access key belongs is named as such.
- **Cloudflare:** logs in with wrangler, lists your domains, and deploys the Worker (see [Cloudflare Worker](cloudflare.md)). On the free plan the Worker sends only to addresses that you verify, which is enough for questions to you; to send to any address it needs Workers Paid ($5 a month).
- **Your email address** defaults to your `git config user.email`. Separate more addresses with commas, semicolons or spaces; setup refuses what is not an address and shows the list it keeps.
- **Domains** are cleaned as `--domain` is: a scheme (`https://`), a path and a dot at the end are removed, and the name is lowercase. Setup shows the cleaned name.

A key or token is asked for only when it is not already in the environment or in `config.secrets.json`. When you agree, setup saves it in `config.secrets.json` next to the config (mode 600), never in the config itself. An env var with the same name always wins (for CI and agents). The send key prompt takes Enter for "use the full-access key", and says so.

Then setup checks everything (the same steps as [`clankerinbox check`](commands.md#check)). When a step fails, setup says what that most likely means (a key PostShiba refuses, a DNS record that is missing, with the record to add), where the key comes from (the environment, or `config.secrets.json` with its path), and offers to type the key again or check again. A key from the environment cannot be typed again: the environment would hide it, so setup says to change it there. A key typed again is saved only if you said yes to saving keys, or after a question.

Last, setup offers a real test: a question to you, and your reply read back through every rule. A mail that arrives but does not count is explained at once: not on the allow list, DMARC failed, an empty reply, or a new mail instead of a reply. When PostShiba refuses the send key on the test mail, setup gives the same advice and offers to type the key again. Setup says "Setup is complete" (exit code 0) only when every step passed; otherwise it lists each step that did not pass and what to do (exit code 1).

Ctrl+C or Ctrl-D (the end of input) stops setup at each question with one line that says what was saved: "Setup stopped. Nothing was saved." before the config is written, or the config path and `clankerinbox check` after it. While setup waits for the test reply, the line gives the `clankerinbox wait <tag>` command. Ctrl+C exits with 130, Ctrl-D with 1.

Run `clankerinbox setup` on a machine that already has a setup to check it ("Check it": the checks and the test, no changes), set it up again (the old config is kept as `config.json.bak`, and an older `.bak` as `config.json.bak-<time>`; setup names both), or leave it. A config that cannot be read is named with its path and the reason, and setup offers to set up again.

In a terminal, `setup --api-url <url>` and `setup --tenant <id>` ask the questions too, for PostShiba. Any other setup flag means the flags path below; when flags are missing there, the message also says that `setup` with no flags asks for each value.

## Setup with flags

Scripts and agents (no terminal) use flags. `setup` without a terminal and without flags says which flags to pass:

```sh
clankerinbox setup --team <team id> --domain inbox.example.com --allow you@example.org
clankerinbox setup --provider cloudflare --url https://clankerinbox.example.com --domain mail.example.com --allow you@example.org
```

The team id is the `id` of your team in `GET https://app.postshiba.com/api/v1/teams` with the full-access key:

```sh
curl -s -H "Authorization: Bearer $POSTSHIBA_FULL_API_KEY" https://app.postshiba.com/api/v1/teams
```

`setup` with flags writes `~/.config/clankerinbox/config.json` (`CLANKERINBOX_CONFIG` changes the path) and refuses to replace it without `--force`. With `--force` the old config is kept as `config.json.bak` (an older `.bak` as `config.json.bak-<time>`), inboxes that `create` added stay unless a new inbox takes their name or address, and an inbox that setup makes again (the same address and mode) keeps the entries that were added to its `allow` and `send` lists by hand (`keptEntries`). "Set up again" in a terminal does the same and says what it kept. Every flag is checked first, and all problems are named in one message: `--allow` and `--from` take `Name <a@b.org>` or `a@b.org` (the address is kept, in lowercase), and `--domain` is cleaned as above. `--url` without `--provider` means Cloudflare, and a flag of the other provider is an error. Keys come from the environment or from `config.secrets.json`, as for every command. The config holds only the names of the env vars with keys and tokens, never a value; `setup` refuses a value where a name belongs (a name is UPPER_SNAKE_CASE, at most 64 characters, for `--token-env` and `CLANKERINBOX_SETUP_KEY_ENV`). `clankerinbox setup --help` lists every option.

```
$ clankerinbox setup --team TeamX1 --domain inbox.example.com --allow you@example.org
{"configPath":"/home/you/.config/clankerinbox/config.json","provider":"postshiba","created":["agent@inbox.example.com","signup@inbox.example.com"],"reused":[],"kept":[],"backup":null,"inboxes":{"agent":{"id":"ib8c04ca","address":"agent@inbox.example.com","mode":"answers","allow":["you@example.org"],"send":["you@example.org"]},"signup":{"id":"ib3495d7","address":"signup@inbox.example.com","mode":"codes","allow":"*","send":[]}}}
```

Then try it:

```sh
clankerinbox send --subject "Hello" --text "clankerinbox works."
clankerinbox ask "Merge?" --option Yes --option No --wait
```

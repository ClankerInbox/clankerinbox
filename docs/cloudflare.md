# Cloudflare Worker

Mail goes to a Worker on your own Cloudflare account: Email Routing hands it inbound mail, it keeps it in D1 for 168 hours (`RETENTION_HOURS`; each new mail and each read removes the older mail, so the Worker needs no cron trigger), and it sends through Cloudflare Email Service. The CLI talks to it over HTTPS with the Worker token. The domain must use Cloudflare DNS.

- **Size limit.** A mail larger than 1 MB (`MAX_STORED_BYTES`, at most 1.4 MB: a D1 row holds 2 MB, and the mail is kept as base64) keeps its headers and its text; each attachment keeps its name and size, not its content. Such a mail is marked `truncated`; a reply with only an attachment is skipped as `the mail was too large`, not as an empty reply.
- **Reading.** The CLI reads the mail of an address oldest first, in pages, from the oldest mail it has not handled yet (it keeps the place in `cursors.json` in the state folder). So a flood of other mail never hides an answer, and a poll does not download again the mail it read before.
- **Sending.** The Worker sends only as its `SENDER` (`clankerinbox@<mail domain>`, also in `allowed_sender_addresses`), only with the headers the CLI sets (Reply-To, In-Reply-To, References, Auto-Submitted, X-Loop), and never with a line break in a header. On the free plan, a mail to an address that is not verified in Email Routing is refused with what to do: verify the address (Email Routing → Destination addresses), or get Workers Paid.
- **When the Worker cannot store a mail** (D1 fails), it refuses the mail with a temporary-failure text, so the sender's server tries again or bounces it. The Worker logs this (Workers Logs, `[observability]` in `wrangler.toml`).
- **One token reads every address of the Worker.** Each machine that uses the Worker has the same Worker token, and with it the machine can read the mail of each address and send to anyone (the send list is in the CLI, not in the Worker). Give the token only to machines that you trust as much as each other; for machines that must be kept apart, deploy a Worker on another Cloudflare account.
- `clankerinbox check` asks the Worker for its health: the database tables, the settings (`RETENTION_HOURS`, `SENDER`), and the version of its code. When the Worker is older than the Worker code of the CLI, `check` says so; run `clankerinbox setup` to deploy the new code.

`clankerinbox setup` → Cloudflare → "Yes, deploy it for me" does all the steps with wrangler (through `npx`, or `CLANKERINBOX_WRANGLER`). Before setup changes your account, it lists each change and asks you. The steps, in the order setup does them:

1. Setup logs you in to Cloudflare (`wrangler login` in your browser; on SSH `--device`, when your wrangler has it). A failed login can be tried again. You select the account and one of its domains; an account without a domain goes back to the account choice, and a domain that is not active yet (its name servers did not change yet) says so. These steps do not change the account.
2. You select where the addresses of the agent go. The default is `mail.<domain>`. On a subdomain, only the subdomain gets MX records, and the mail of the domain does not change. If the name already gets mail from another service (Google Workspace, Microsoft 365, Fastmail, Proton or another MX host), setup names it, says that the mail to all other addresses on that name stops reaching it, and asks before it replaces the MX records.
3. Setup reads the plan of the account. Email Sending to all addresses needs the Workers Paid plan ($5 a month). On the free plan, setup offers to send only to the people who answer (each one verifies the address with a link that Cloudflare mails). A refusal that is not about the plan is a missing permission of the wrangler login: setup says to run `npx wrangler login` again.
4. Setup reads what is on the account and lists every change, each marked `(exists: kept)` or `(new)` where setup can read it: the D1 database `clankerinbox` (new, or used again), the Worker `clankerinbox` on the custom domain `clankerinbox.<domain>` (its DNS record and certificate), Email Sending or the destination addresses, each routing rule, subaddressing, and the MX records that are replaced. When something would be lost that you have not chosen yourself in a menu (MX records, a routing rule of the address that forwards the mail elsewhere), the default answer is No.
   - When `clankerinbox.<domain>` is in use (another Worker or a DNS record), setup offers another name, for example `clankerinbox2.<domain>`.
   - When a Worker `clankerinbox` exists on the account (deployed by another machine, or by an earlier setup), a new token stops each machine that uses it. Setup keeps the token when the one in `config.secrets.json` works; otherwise you select: keep its token (paste it; setup checks it with the Worker), give it a new token, or deploy a second Worker with another name.
5. Setup makes the database and its tables, turns on Email Sending for the mail domain (or adds the destination addresses), deploys the Worker from `~/.config/clankerinbox/worker/` with no workers.dev address (wrangler adds the DNS record and the certificate), and sets a new random `API_TOKEN` (unless you kept the token). The Worker can send only as `clankerinbox@<mail domain>`.
6. Setup saves the config and the Worker token (`config.secrets.json`, as `CLANKERINBOX_CF_TOKEN`) before any long wait, so Ctrl+C from here on loses nothing.
7. Setup waits until the Worker answers (a new certificate can need some minutes), turns on Email Routing for the mail domain, sends each inbox address to the Worker with a routing rule, and turns on subaddressing for the domain, so tagged addresses (`signup+<tag>@`) go to the rule of `signup@`. The catch-all rule does not change.
8. On the free plan, setup waits for the click on the link in each verification mail, all addresses at once. Press Enter to go on and click later.

A shell variable `CLANKERINBOX_CF_TOKEN` with another token hides the saved one: setup names it and says to `unset` it. If a step fails before the config is saved, setup lists what it made on the account. Run setup again: it asks the questions again and reuses what exists (the database, the Worker, the rules).

**One Worker per account.** All machines of an account use the same Worker and the same Worker token. To add a second machine, run setup there, select "It's already deployed", and give the URL of the Worker and the token from `config.secrets.json` (`CLANKERINBOX_CF_TOKEN`) of the first machine. Do not deploy again from the second machine with a new token: the first machine then stops working.

To deploy the Worker yourself, copy `cloudflare/` and do the steps in its `wrangler.toml` (in order: the database, its id, the sender, the tables, the deploy, the token, the routing rules and subaddressing, sending). Then select "It's already deployed" in setup, or use flags:

```sh
clankerinbox setup --provider cloudflare --url https://clankerinbox.example.com \
  --domain mail.example.com --allow you@example.org
```

DMARC counts only from the `Authentication-Results` header Cloudflare puts on top (authserv-id `mx.cloudflare.net`; `--trusted-authserv` names another); the Worker keeps that first header as it came, and only when it is Cloudflare's, and headers further down are never read for it. `--token-env` picks another env var name for the Worker token.

## Remove the Worker

Setup has no remove command. To remove everything from the account (with `npx wrangler login`), in `~/.config/clankerinbox/worker/`:

1. `npx wrangler delete` removes the Worker and its token. Each machine that uses it stops. If the DNS record of `clankerinbox.<domain>` is still there afterwards, delete it.
2. `npx wrangler d1 delete clankerinbox` removes the database and all stored mail.
3. In the dashboard, your domain → Email → Email Routing: delete the routing rules of the inbox addresses, the destination addresses, and (to give the MX records back to another service) the subdomain under Settings, or turn Email Routing off.
4. Email Sending: your domain → Email → Email Sending, if you turned it on only for the agent.
5. Remove `~/.config/clankerinbox/` (config, token) and `~/.local/state/clankerinbox/` (state and mail log).

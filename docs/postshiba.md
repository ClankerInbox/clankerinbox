# PostShiba

The domain needs its MX record at `inbound.postshiba.com`, and its sending records (DKIM, return path, DMARC) verified by PostShiba. Two keys:

| Env var | PostShiba key type | Used by |
| --- | --- | --- |
| `POSTSHIBA_SEND_API_KEY` | Send only | `send`, `ask` |
| `POSTSHIBA_FULL_API_KEY` | Full access | `poll`, `ask --wait`, `wait`, `code`, `setup`, `create` |

PostShiba has no key that only reads inbound mail, so reading needs the full-access key. Keep it on as few processes as you can.

```sh
export POSTSHIBA_SEND_API_KEY=…   # from a password manager, or the macOS keychain:
export POSTSHIBA_FULL_API_KEY="$(security find-generic-password -s postshiba-full -w)"
clankerinbox setup --team <team id> --domain inbox.example.com --allow you@example.org
```

`setup` finds inboxes that already exist on the domain (`agent@` or the `--name` you give, and `signup@`) and creates the missing ones. Give each machine its own keys (and ideally its own inboxes); deleting a machine's key cuts that machine off.

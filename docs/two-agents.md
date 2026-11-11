# Two agents

An agent on one machine can ask an agent on another machine, and get the answer the way it gets a person's. Each machine has its own setup (PostShiba or Cloudflare, the same domain or not). Nothing needs a test switch: the allow list and DMARC aligned stay the gate, and default deny stays.

On each machine, the other machine's sending address goes on the allow list, and its inbox address on the send list. The sending address is `from` in the other machine's config (setup makes it `clankerinbox@<domain>`; on Cloudflare it is the `SENDER` of the Worker). Machine A (`agent@a.example`, sends as `clankerinbox@a.example`):

```json
"agent": { "id": "…", "address": "agent@a.example", "mode": "answers",
           "allow": ["you@example.org", "clankerinbox@b.example"], "send": ["you@example.org", "agent@b.example"] }
```

Machine B (`agent@b.example`, sends as `clankerinbox@b.example`):

```json
"agent": { "id": "…", "address": "agent@b.example", "mode": "answers",
           "allow": ["clankerinbox@a.example"], "send": ["agent@a.example"] }
```

Edit the lists in `config.json`. Or give the other agent an inbox of its own: `clankerinbox create peer --allow clankerinbox@a.example --send agent@a.example` on B makes `peer@b.example`, which A then asks. Then:

```sh
# Machine A
clankerinbox ask "Is the build green on B?" --option Yes --option No --to agent@b.example --wait
# Machine B: the question comes as "unmatched" with "agent": true (as a "request" on a requests inbox)
clankerinbox poll
clankerinbox send --reply <id> --text "Yes"
# Machine A: ask --wait (or wait <tag>, or poll) prints the answer, "from": "clankerinbox@b.example"
```

- **The marks.** Every mail of the tool carries `Auto-Submitted: auto-generated` and `X-Loop: clankerinbox`, and PostShiba adds the first to all it sends. Mail whose only marks are these is read from an allowed sender with DMARC aligned. Auto-replies, list and bulk mail, another tool's `X-Loop` and bounces are still skipped.
- **Who may answer.** B's answer comes from the address B sends as, not from the inbox A asked. It counts when it carries the marks, and its From is on the allow list of the question's inbox and on the domain of an address the question went to. A person's reply keeps the exact rule: only an address the question went to.
- **Where `--reply` sends.** To the Reply-To of A's mail (`agent+<tag>@a.example`, the address of A's question), but only when it is one address on the domain of the checked From; else to the From. B reads that Reply-To when `poll` hands out the mail (PostShiba lists no Reply-To, so B reads that one mail whole) and keeps it in its log; `--reply` uses only that record. The send list still decides: `agent@a.example` must be on it.
- **Own mail.** Mail that this machine sent never counts when it comes back to it (its Message-ID is in the log), also when two machines share one sending address.

What stops loops:

- An answer is handed out as the answer to its question, never as new mail. Another agent's reply to mail of this machine comes as `unmatched` with `"agent": true, "reply": true`, and `send --reply` refuses to answer it. Two agents that answer every mail with `--reply` stop after one round.
- An agent that writes new mail (`send --to`) for every mail it gets is stopped by the caps: each machine sends at most `caps.sendPerHour` mails an hour (default 30), and `poll` hands out at most `caps.receivePerSenderPerHour` mails of one sender an hour (default 20); the rest waits for the next hour. The caps bound the rate (at most 30 mails an hour from each machine), but they do not end such an exchange: write agents that do not answer `"reply": true` mail.

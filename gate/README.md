# Subscriber channel gate (agent #9)

On-chain subscription → Telegram channel membership. The single source of truth is
`PaymentHub.subExpiry(9, wallet)`; this process only mirrors that state into the channel.

## Why there is no "enter your Telegram ID" field

Users do not know their numeric Telegram ID, `@usernames` change, and a typed value cannot be
verified — anyone could type someone else's handle. Instead the paid action `signal.channel`
issues a **single-use invite link whose name carries the wallet address**. When the user joins,
the bot receives a `chat_member` update containing that link, and the wallet↔account binding is
recovered from it. The user types nothing.

Telegram truncates invite link names to 32 characters, so the name holds `0x` + 30 hex digits.
`gate.js` resolves that prefix back to the full address by scanning on-chain
`Subscribed(9, user)` events — the binding is reconstructed from chain state, never from an
off-chain secret mapping.

## Commands

```bash
node gate/gate.js sync              # capture joins/leaves, bind wallets
node gate/gate.js sweep --dry-run   # report subscription status of bound members
node gate/gate.js sweep             # evict members whose subscription lapsed
node gate/gate.js run               # sync + sweep (one cycle, for cron/launchd)
node gate/gate.js status            # current bindings
node gate/gate.js push "<text>"     # post a signal to the channel
```

Config: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID` (falls back to `~/.config/telegram-gupsik.json`).
State (bindings + update offset) lives in `~/.aimenem-gate/state.json`, mode 600.

## Invariants

1. **Only members we invited are managed.** Someone who joined the channel on their own has no
   binding and is never evicted.
2. **Ban is always followed by unban.** A bare ban would block the user permanently, so a lapsed
   subscriber could never return after paying again.
3. Eviction is driven by on-chain expiry only. `cancelSubscription` refunds the unvested amount
   and drops `subExpiry` immediately, so the eviction path can be demonstrated in minutes instead
   of waiting out a 30-day term.
4. The channel is a **delivery convenience, not the entitlement**. `signal.latest` / `signal.history`
   stay available through the marketplace, so a bot outage never means a paid subscriber gets nothing.

## Note on channel visibility

`@aimeenam` is currently a public channel, so anyone can find and join it directly. The gate
manages access for invited members, but enforcing payment for *entry* requires making the channel
private (removing the public username). Until then, treat the gate as subscription-driven
membership management rather than a hard paywall.

## Automatic signal push

`signal-push.js` reads `signal.latest` on a schedule and posts **newly fired** BUY/SELL
signals to the channel — that is what a subscription actually buys: signals arrive without
anyone pressing a button.

```bash
node gate/signal-push.js dry-run   # show what would be posted, send nothing
node gate/signal-push.js run       # post new signals
node gate/tick.js                  # one scheduler tick: membership sweep + signal push
```

Invariants:
1. A fired signal is posted once. The key is `symbol|timeframe|kind|candle-close`.
2. The first run only records a baseline and sends nothing, so historical signals are never
   dumped into the channel at once.
3. State advances only after a successful send, so a failed post is retried next tick.
4. Watched timeframes default to `2H,4H,1D` (`PUSH_TIMEFRAMES` to change). 1H is excluded by
   default — it fires often enough to read as noise in a channel.

`gate/com.bug.aimenem-gate.plist.example` is the macOS launchd job (10-minute interval) that
runs `tick.js`.

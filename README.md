# BUG BTC/ETH Disciplined Signal — remote signal agent (Pabal/BOBOO, GIWA Sepolia)

An **external-creator AI agent** live on the [Pabal/BOBOO marketplace](https://test.pabal.ai) as
**Agent #9**, registered through the marketplace's public creator flow. It productizes BUG's
BTC/ETH trading signal (RSI+VWMA "Disciplined" strategy, same logic as the TradingView indicator)
as a paid HTTP agent with on-chain receipts.

한국어 문서: [README.ko.md](README.ko.md)

- **Live endpoint**: https://pabal-signal-agent.vercel.app (Vercel icn1, stateless)
- **On-chain**: GIWA Sepolia (chainId 91342), owner `0xFA225dDafEd6513DE41b040CB539e94D0F68570C`
  - Registration tx `0x01bd370cf78ccec0b7eca4f71988b25f134d1e07744569a01c9c92ed33a9a972`
  - `manifestVerified: true` (manifest raw bytes hash == on-chain `manifestHash`)
- **Trust tier**: `verified`, subscriptions enabled

## Strategy

- **BUY**: on 1H/2H/4H/1D closed candles — RSI(14) ≤ 35 arms the episode, then close reclaiming VWMA(20) fires
- **SELL**: RSI(14) ≥ 65 with close above VWMA(20), once per episode (re-arms when RSI < 65)
- **Regime**: daily close vs SMA200 with a ±1% hysteresis band (bull/bear)
- **Stateless**: every request replays ~1000 closed candles from Bybit's public API, reproducing
  the exact same state as the original daemon (verified against the live feed across all symbol×TF pairs)

## Try it (no wallet needed)

```bash
# Agent card
curl https://pabal-signal-agent.vercel.app/

# Latest snapshot: price, RSI, VWMA, armed state, last fired signal, regime
curl -X POST https://pabal-signal-agent.vercel.app/ -H 'content-type: application/json' \
  -d '{"action":"signal.latest","symbol":"BTC","timeframe":"4H"}'

# Recent fired signals (replay-based)
curl -X POST https://pabal-signal-agent.vercel.app/ -H 'content-type: application/json' \
  -d '{"action":"signal.history","symbol":"ETH","timeframe":"1D","limit":10}'
```

The handler accepts `{action,...}`, `{request:{action,...}}` and `{input:{action,...}}` shapes
(flexible parsing for broker remote calls).

## Try the paid marketplace flow (your own wallet)

Requires GIWA Sepolia test ETH: https://faucet.giwa.io

```bash
npm install
cp .env.example .env   # put PRIVATE_KEY=0x... (never committed)

node register.js status              # wallet / agent / pricing overview
node register.js credits 5          # mint MockUSDT -> deposit task credits
node register.js task signal.latest BTC 4H   # EIP-712 signed task -> broker -> on-chain receipt
```

## Creator flow (how this agent got on the marketplace)

`register.js` reproduces the browser SDK flow as a CLI:

```bash
node register.js validate  # POST /agents/validate -> freeze manifest.json + hash
node register.js register  # AgentRegistry.registerAgent(endpoint, hash, type) on-chain
node register.js submit    # EIP-712 AgentRegistration -> POST /agents (broker hot-load)
node register.js pricing 10 1   # PaymentHub.setPricing (sub USDT / task USDT)
```

EIP-712 domains:
- Registration: `{name:"BOBOO Agent Registration", version:"1", chainId:91342, verifyingContract:AgentRegistry}`
- Task: `{name:"GIWA Workforce Broker", version:"1", chainId:91342, verifyingContract:ReceiptLog}`

## Disclosure

Informational signals only — not investment advice, no wallet permissions requested.
GIWA Sepolia testnet demo.

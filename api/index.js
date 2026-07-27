// Pabal(BOBOO) remote signal agent — BUG's BTC/ETH RSI+VWMA Disciplined
// 신호 로직 = ~/regime-watch/gupsik_feed.py (파인 v3.x) 동일 이식:
//   BUY:  RSI(14) <= 35 무장(arm) -> 종가 > VWMA(20) 재돌파 시 발화
//   SELL: RSI(14) >= 65 & 종가 > VWMA(20) (에피소드당 1회, RSI<65 복귀 시 재무장)
//   국면: 일봉 종가 vs SMA200 ±1% 밴드 (bull/bear 히스테리시스)
// 상태 없음 — 매 요청 Bybit 공개 API 마감봉 리플레이로 동일 결과를 재현한다.

const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const TIMEFRAMES = [
  ["1H", "60", 3600e3],
  ["2H", "120", 7200e3],
  ["4H", "240", 14400e3],
  ["1D", "D", 86400e3],
];
const TF_ALIAS = { "1H": "1H", "60": "1H", "2H": "2H", "120": "2H", "4H": "4H", "240": "4H", "1D": "1D", D: "1D" };
const BAND = 0.01;
const STRATEGY = "RSI(14) oversold(<=35) arm -> close reclaims VWMA(20) = BUY / RSI(14)>=65 above VWMA(20) = SELL (once per episode). Regime = daily close vs SMA200 +/-1% band.";

async function bybit(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(`https://api.bybit.com${path}`, {
      headers: { "User-Agent": "pabal-signal-agent/1.0" },
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`bybit http ${r.status}`);
    const j = await r.json();
    if (j.retCode !== 0) throw new Error(`bybit retCode ${j.retCode}`);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

async function klines(symbol, interval, limit = 1000) {
  const res = await bybit(`/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const rows = res.list.map((x) => [Number(x[0]), parseFloat(x[4]), parseFloat(x[5])]); // ts, close, vol
  rows.sort((a, b) => a[0] - b[0]);
  return rows;
}

async function lastPrice(symbol) {
  const res = await bybit(`/v5/market/tickers?category=linear&symbol=${symbol}`);
  return parseFloat(res.list?.[0]?.lastPrice);
}

function rsiSeries(close, n = 14) {
  const m = close.length;
  const out = new Array(m).fill(null);
  if (m <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) {
    const d = close[i] - close[i - 1];
    g += Math.max(d, 0); l += Math.max(-d, 0);
  }
  let ag = g / n, al = l / n;
  out[n] = al > 0 ? 100 - 100 / (1 + ag / al) : 100;
  for (let i = n + 1; i < m; i++) {
    const d = close[i] - close[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = al > 0 ? 100 - 100 / (1 + ag / al) : 100;
  }
  return out;
}

function vwmaSeries(close, vol, n = 20) {
  const m = close.length;
  const out = new Array(m).fill(null);
  let pv = 0, v = 0;
  for (let i = 0; i < m; i++) {
    pv += close[i] * vol[i]; v += vol[i];
    if (i >= n) { pv -= close[i - n] * vol[i - n]; v -= vol[i - n]; }
    if (i >= n - 1 && v > 0) out[i] = pv / v;
  }
  return out;
}

// 일봉 종가 vs SMA200 ±1% 밴드 히스테리시스. true=bull, false=bear, null=데이터부족
function dailyRegime(rows, nowMs) {
  const today0 = new Date(nowMs); today0.setUTCHours(0, 0, 0, 0);
  const closes = rows.filter((r) => r[0] < today0.getTime()).map((r) => r[1]);
  if (closes.length < 205) return null;
  let state = null, sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= 200) sum -= closes[i - 200];
    if (i >= 199) {
      const sma = sum / 200, c = closes[i];
      if (c > sma * (1 + BAND)) state = true;
      else if (c < sma * (1 - BAND)) state = false;
    }
  }
  return state;
}

// 마감봉 리플레이 — gupsik_feed.scan_symbol과 동일한 arm/발화 머신
function replay(rows, tfMs, nowMs) {
  const conf = rows.filter((r) => r[0] + tfMs <= nowMs);
  const ts = conf.map((r) => r[0]), close = conf.map((r) => r[1]), vol = conf.map((r) => r[2]);
  const rsi = rsiSeries(close), vw = vwmaSeries(close, vol);
  let rawArm = false, sellArm = true;
  const fired = [];
  for (let i = 0; i < conf.length; i++) {
    if (rsi[i] == null || vw[i] == null) continue;
    if (rsi[i] <= 35) rawArm = true;
    if (rawArm && close[i] > vw[i]) {
      fired.push({ kind: "BUY", price: close[i], ts: ts[i] });
      rawArm = false;
    }
    if (rsi[i] >= 65 && close[i] > vw[i]) {
      if (sellArm) { fired.push({ kind: "SELL", price: close[i], ts: ts[i] }); sellArm = false; }
    } else if (rsi[i] < 65) {
      sellArm = true;
    }
  }
  const i = conf.length - 1;
  if (i < 0) return { fired, snapshot: null };
  return {
    fired,
    snapshot: {
      close: close[i],
      rsi: rsi[i] != null ? Math.round(rsi[i] * 100) / 100 : null,
      vwma: vw[i] != null ? Math.round(vw[i] * 1e4) / 1e4 : null,
      closedAt: new Date(ts[i]).toISOString(),
      armed: { buy: rawArm, sell: sellArm },
    },
  };
}

function pickSymbols(params) {
  const s = String(params.symbol || "").toUpperCase().replace(/USDT$/, "");
  if (s === "BTC") return ["BTCUSDT"];
  if (s === "ETH") return ["ETHUSDT"];
  return SYMBOLS;
}

function pickFrames(params) {
  const tf = TF_ALIAS[String(params.timeframe || "").toUpperCase()];
  return tf ? TIMEFRAMES.filter((t) => t[0] === tf) : TIMEFRAMES;
}

async function scanAll(params) {
  const symbols = pickSymbols(params);
  const frames = pickFrames(params);
  const nowMs = Date.now();
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    const [price, daily, frameRows] = await Promise.all([
      lastPrice(sym).catch(() => null),
      klines(sym, "D").catch(() => null),
      Promise.all(frames.map(async ([label, interval, tfMs]) => {
        try {
          const rows = interval === "D" && false ? null : await klines(sym, interval);
          return [label, tfMs, rows, null];
        } catch (e) {
          return [label, tfMs, null, e.message];
        }
      })),
    ]);
    const regime = daily ? dailyRegime(daily, nowMs) : null;
    const entry = {
      price,
      regime: regime === true ? "bull" : regime === false ? "bear" : "unknown",
      frames: {},
    };
    for (const [label, tfMs, rows, err] of frameRows) {
      if (!rows) { entry.frames[label] = { error: err || "fetch_failed" }; continue; }
      const { fired, snapshot } = replay(rows, tfMs, nowMs);
      const last = fired.length ? fired[fired.length - 1] : null;
      entry.frames[label] = {
        ...snapshot,
        lastSignal: last ? { kind: last.kind, price: last.price, at: new Date(last.ts).toISOString() } : null,
        _fired: fired,
      };
    }
    out[sym] = entry;
  }));
  return out;
}

async function actionLatest(params) {
  const data = await scanAll(params);
  for (const sym of Object.keys(data)) {
    for (const f of Object.values(data[sym].frames)) delete f._fired;
  }
  return {
    agent: "bug-btc-eth-disciplined-signal",
    strategy: STRATEGY,
    asOf: new Date().toISOString(),
    symbols: data,
    disclaimer: "Informational signals only. Not investment advice.",
  };
}

async function actionHistory(params) {
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 100);
  const data = await scanAll(params);
  const all = [];
  for (const [sym, entry] of Object.entries(data)) {
    for (const [label, f] of Object.entries(entry.frames)) {
      for (const s of f._fired || []) {
        all.push({ symbol: sym, timeframe: label, kind: s.kind, price: s.price, at: new Date(s.ts).toISOString() });
      }
    }
  }
  all.sort((a, b) => (a.at < b.at ? 1 : -1));
  return {
    agent: "bug-btc-eth-disciplined-signal",
    strategy: STRATEGY,
    asOf: new Date().toISOString(),
    count: Math.min(all.length, limit),
    signals: all.slice(0, limit),
    disclaimer: "Informational signals only. Not investment advice.",
  };
}

const ACTIONS = {
  "signal.latest": actionLatest,
  "signal.history": actionHistory,
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      agent: "bug-btc-eth-disciplined-signal",
      description: "BUG's BTC/ETH trading signals (RSI+VWMA Disciplined) for the Pabal/BOBOO marketplace.",
      actions: Object.keys(ACTIONS),
      strategy: STRATEGY,
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const body = req.body || {};
  // 브로커 원격 호출 형태를 로그로 관측 (Vercel logs)
  try { console.log("inbound", req.url, JSON.stringify(body).slice(0, 1500)); } catch {}

  // 유연 파싱: {action,...} | {request:{action,...},...} | {input:{action,...}}
  const request = (body.request && typeof body.request === "object") ? body.request
    : (body.input && typeof body.input === "object") ? body.input
    : body;
  const action = request.action || body.action;
  const handler = ACTIONS[action];
  if (!handler) return res.status(400).json({ error: "unknown_action", got: action || null, actions: Object.keys(ACTIONS) });

  try {
    const result = await handler(request);
    return res.status(200).json(result);
  } catch (e) {
    console.error("action_failed", action, e.message);
    return res.status(500).json({ error: "agent_failed", message: e.message });
  }
};

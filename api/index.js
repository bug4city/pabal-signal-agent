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
const SYMBOL_ALIAS = { BTC: "BTCUSDT", BTCUSDT: "BTCUSDT", XBT: "BTCUSDT", ETH: "ETHUSDT", ETHUSDT: "ETHUSDT" };
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
  // conf[i][0] = 봉 시작(open) 시각. 마감 시각 = 시작 + 봉길이.
  const conf = rows.filter((r) => r[0] + tfMs <= nowMs);
  const ts = conf.map((r) => r[0]), close = conf.map((r) => r[1]), vol = conf.map((r) => r[2]);
  const rsi = rsiSeries(close), vw = vwmaSeries(close, vol);
  let rawArm = false, sellArm = true;
  const fired = [];
  for (let i = 0; i < conf.length; i++) {
    if (rsi[i] == null || vw[i] == null) continue;
    if (rsi[i] <= 35) rawArm = true;
    if (rawArm && close[i] > vw[i]) {
      fired.push({ kind: "BUY", price: close[i], ts: ts[i], tfMs });
      rawArm = false;
    }
    if (rsi[i] >= 65 && close[i] > vw[i]) {
      if (sellArm) { fired.push({ kind: "SELL", price: close[i], ts: ts[i], tfMs }); sellArm = false; }
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
      openAt: new Date(ts[i]).toISOString(),          // 기준봉 시작
      closedAt: new Date(ts[i] + tfMs).toISOString(), // 기준봉 마감(= 이 값 이후의 데이터는 반영되지 않음)
      armed: { buy: rawArm, sell: sellArm },
    },
  };
}

// 잘못된 입력은 조용히 전체 반환하지 않고 명시적으로 거절한다(무음 폴백 금지).
class BadRequest extends Error {
  constructor(code, message, extra) { super(message); this.code = code; this.extra = extra || {}; }
}

function pickSymbols(params) {
  if (params.symbol == null || params.symbol === "") return SYMBOLS;
  const raw = String(params.symbol).trim();
  const sym = SYMBOL_ALIAS[raw.toUpperCase()];
  if (!sym) throw new BadRequest("invalid_symbol", `unsupported symbol: ${raw}`, { got: raw, supported: ["BTC", "ETH"] });
  return [sym];
}

function pickFrames(params) {
  if (params.timeframe == null || params.timeframe === "") return TIMEFRAMES;
  const raw = String(params.timeframe).trim();
  const tf = TF_ALIAS[raw.toUpperCase()];
  if (!tf) throw new BadRequest("invalid_timeframe", `unsupported timeframe: ${raw}`, { got: raw, supported: ["1H", "2H", "4H", "1D"] });
  return TIMEFRAMES.filter((t) => t[0] === tf);
}

// limit: 정수만, 1~100 클램프. 숫자가 아니면 거절(조용히 기본값으로 넘어가지 않는다).
function pickLimit(params) {
  if (params.limit == null || params.limit === "") return 20;
  const n = Number(params.limit);
  if (!Number.isFinite(n)) throw new BadRequest("invalid_limit", `limit must be a number: ${params.limit}`, { got: params.limit, min: 1, max: 100 });
  return Math.min(Math.max(Math.floor(n), 1), 100);
}

async function scanAll(params) {
  const symbols = pickSymbols(params);
  const frames = pickFrames(params);
  const nowMs = Date.now();
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    // 일봉은 국면(SMA200) 계산과 1D 프레임이 함께 쓰므로 한 번만 받는다.
    const dailyPromise = klines(sym, "D").then((r) => [r, null]).catch((e) => [null, e.message]);
    const [price, [daily, dailyErr], frameRows] = await Promise.all([
      lastPrice(sym).catch(() => null),
      dailyPromise,
      Promise.all(frames.map(async ([label, interval, tfMs]) => {
        if (interval === "D") {
          const [rows, err] = await dailyPromise;
          return [label, tfMs, rows, err];
        }
        try {
          return [label, tfMs, await klines(sym, interval), null];
        } catch (e) {
          return [label, tfMs, null, e.message];
        }
      })),
    ]);
    void dailyErr;
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
        lastSignal: last ? {
          kind: last.kind,
          price: last.price,
          openAt: new Date(last.ts).toISOString(),
          at: new Date(last.ts + last.tfMs).toISOString(), // 발화 확정 시각 = 해당 봉 마감
        } : null,
        _fired: fired,
      };
    }
    out[sym] = entry;
  }));
  return out;
}

// 사람이 바로 읽는 한 줄 요약 — UI가 응답 JSON을 그대로 노출하므로 최상단에 둔다 (QA 7/28)
function summarize(data) {
  const lines = [];
  for (const [sym, s] of Object.entries(data)) {
    const parts = [];
    for (const [tf, f] of Object.entries(s.frames)) {
      const armed = f.armed?.buy ? "buy-armed" : f.armed?.sell ? "sell-armed" : "idle";
      const last = f.lastSignal ? `last ${f.lastSignal.kind} @${f.lastSignal.price}` : "no signal yet";
      parts.push(`${tf}: RSI ${f.rsi} · ${armed} · ${last}`);
    }
    lines.push(`${sym} $${s.price} (${s.regime} regime) — ${parts.join(" | ")}`);
  }
  return lines;
}

async function actionLatest(params) {
  const data = await scanAll(params);
  for (const sym of Object.keys(data)) {
    for (const f of Object.values(data[sym].frames)) delete f._fired;
  }
  return {
    summary: summarize(data),
    agent: "bug-btc-eth-disciplined-signal",
    strategy: STRATEGY,
    asOf: new Date().toISOString(),
    symbols: data,
    disclaimer: "Informational signals only. Not investment advice.",
  };
}

async function actionHistory(params) {
  const limit = pickLimit(params);
  const data = await scanAll(params);
  const all = [];
  for (const [sym, entry] of Object.entries(data)) {
    for (const [label, f] of Object.entries(entry.frames)) {
      for (const s of f._fired || []) {
        all.push({
          symbol: sym,
          timeframe: label,
          kind: s.kind,
          price: s.price,
          openAt: new Date(s.ts).toISOString(),
          at: new Date(s.ts + s.tfMs).toISOString(), // 발화 확정 시각 = 해당 봉 마감
        });
      }
    }
  }
  all.sort((a, b) => (a.at < b.at ? 1 : -1));
  const signals = all.slice(0, limit);
  return {
    summary: signals.slice(0, 5).map((s) => `${s.at.slice(0, 16)} ${s.symbol} ${s.timeframe} ${s.kind} @${s.price}`),
    agent: "bug-btc-eth-disciplined-signal",
    strategy: STRATEGY,
    asOf: new Date().toISOString(),
    limit,
    total: all.length,
    count: signals.length,
    signals,
    disclaimer: "Informational signals only. Not investment advice.",
  };
}

// ---------- 구독자 전용 텔레그램 채널 게이트 ----------
// 구독(PaymentHub.subExpiry)이 살아있는 지갑에만 1회용 초대링크를 발급한다.
// 지갑↔텔레그램 계정 결합은 "초대링크 이름에 지갑주소를 새겨" 입장 이벤트에서 회수한다.
// (유저에게 텔레그램 ID를 입력받지 않는다 — 본인은 숫자 ID를 모르고, 입력값은 검증도 불가능하다.)
const GIWA_RPC = "https://sepolia-rpc.giwa.io";
const PAYMENT_HUB = "0x11940dd9637f25eC1c675A700E323e6e43a3fda9";
const AGENT_ID = 9;
const INVITE_TTL_SEC = 3600;

async function subscriptionExpiry(user) {
  const { ethers } = require("ethers");
  const provider = new ethers.JsonRpcProvider(GIWA_RPC);
  const hub = new ethers.Contract(
    PAYMENT_HUB,
    ["function subExpiry(uint256 agentId, address user) view returns (uint64)"],
    provider,
  );
  return Number(await hub.subExpiry(AGENT_ID, user));
}

async function telegram(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("channel_not_configured");
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await r.json();
  if (!body.ok) throw new Error(`telegram_${method}_failed: ${body.description || r.status}`);
  return body.result;
}

async function actionChannel(request, ids) {
  const { ethers } = require("ethers");
  const user = ids.user;
  if (!user || !ethers.isAddress(user)) {
    throw new BadRequest("missing_user", "wallet address not found in request");
  }
  const channel = process.env.TELEGRAM_CHANNEL_ID;
  if (!channel) throw new BadRequest("channel_not_configured", "signal channel is not configured");

  // 엔드포인트는 공개다 — 브로커의 결제 게이트를 신뢰하지 않고 온체인을 직접 확인한다.
  const expiry = await subscriptionExpiry(user);
  const now = Math.floor(Date.now() / 1000);
  if (expiry <= now) {
    throw new BadRequest("subscription_required", "an active subscription is required for channel access", {
      agentId: AGENT_ID,
      user,
      subscribedUntil: null,
    });
  }

  const expiresAt = now + INVITE_TTL_SEC;
  const invite = await telegram("createChatInviteLink", {
    chat_id: channel,
    name: user, // 입장 이벤트에서 이 이름으로 지갑을 되찾는다
    member_limit: 1,
    expire_date: expiresAt,
  });

  return {
    summary: [
      `Join the subscriber channel: ${invite.invite_link}`,
      `This link works once, for you only, and expires ${new Date(expiresAt * 1000).toISOString()}.`,
      `Your subscription runs until ${new Date(expiry * 1000).toISOString()}.`,
      "When the subscription lapses, the channel membership is removed. Re-subscribing issues a new link.",
    ],
    inviteLink: invite.invite_link,
    inviteExpiresAt: new Date(expiresAt * 1000).toISOString(),
    subscribedUntil: new Date(expiry * 1000).toISOString(),
    user,
  };
}

const ACTIONS = {
  "signal.latest": actionLatest,
  "signal.history": actionHistory,
  "signal.channel": actionChannel,
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
      params: {
        symbol: ["BTC", "ETH", "(omit = both)"],
        timeframe: ["1H", "2H", "4H", "1D", "(omit = all)"],
        limit: "signal.history only, integer 1-100 (default 20)",
      },
      strategy: STRATEGY,
      disclaimer: "Informational signals only. Not investment advice.",
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  // content-type이 json이 아니어서 문자열로 들어온 본문도 한 번 더 파싱해 준다.
  let body = req.body || {};
  if (typeof body === "string") {
    const raw = body.trim();
    if (!raw) body = {};
    else {
      try { body = JSON.parse(raw); } catch {
        return res.status(400).json({
          error: "invalid_json",
          message: "request body must be valid JSON",
          hint: 'send content-type: application/json with {"action":"signal.latest"}',
        });
      }
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return res.status(400).json({ error: "invalid_body", message: "request body must be a JSON object" });
  }
  // 브로커 원격 호출 형태를 로그로 관측 (Vercel logs)
  try { console.log("inbound", req.url, JSON.stringify(body).slice(0, 1500)); } catch {}

  // 유연 파싱: {action,...} | {request:{action,...},...} | {input:{action,...}}
  const request = (body.request && typeof body.request === "object") ? body.request
    : (body.input && typeof body.input === "object") ? body.input
    : body;
  const ctxObj = (body.ctx && typeof body.ctx === "object") ? body.ctx
    : (body.context && typeof body.context === "object") ? body.context : {};
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== "") ?? null;
  const ids = {
    agentId: pick(body.agentId, request.agentId, ctxObj.agentId),
    user: pick(body.user, request.user, ctxObj.user, body.userAddress, request.userAddress),
  };
  const action = request.action || body.action;
  const handler = ACTIONS[action];
  if (!handler) return res.status(400).json({ error: "unknown_action", got: action || null, actions: Object.keys(ACTIONS) });

  try {
    const result = await handler(request, ids);
    return res.status(200).json(result);
  } catch (e) {
    if (e instanceof BadRequest) {
      return res.status(400).json({ error: e.code, message: e.message, ...e.extra });
    }
    console.error("action_failed", action, e.message);
    return res.status(500).json({ error: "agent_failed", message: e.message });
  }
};

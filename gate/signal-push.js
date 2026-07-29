#!/usr/bin/env node
"use strict";
// 구독자 채널 자동 게시 — 새로 발화한 BUY/SELL만 한 번씩 채널로 보낸다.
//
// 구독의 실물은 "묻지 않아도 오는 시그널"이다. 이 프로세스가 그 역할을 한다:
// 에이전트의 signal.latest를 주기적으로 읽고, 직전에 보낸 것과 다른 발화만 게시한다.
//
// 불변식:
//   1) 같은 발화는 두 번 보내지 않는다 (symbol|timeframe|kind|at 를 키로 기록).
//   2) 첫 실행은 기준선만 잡고 아무것도 보내지 않는다 — 과거 발화가 한꺼번에 쏟아지는 것을 막는다.
//   3) 게시 실패는 상태를 갱신하지 않는다 (다음 주기에 다시 시도).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ENDPOINT = process.env.SIGNAL_ENDPOINT || "https://pabal-signal-agent.vercel.app";
const STATE_DIR = process.env.GATE_STATE_DIR || path.join(os.homedir(), ".aimenem-gate");
const STATE_FILE = path.join(STATE_DIR, "signals.json");
const LOG_FILE = path.join(STATE_DIR, "signal-push.log");
const TIMEFRAMES = (process.env.PUSH_TIMEFRAMES || "2H,4H,1D").split(",").map((s) => s.trim());

function loadLocalConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "telegram-gupsik.json"), "utf8")); }
  catch { return {}; }
}
const localConfig = loadLocalConfig();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || localConfig.bot_token;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID
  || localConfig.extra_chat_ids?.find((c) => c.chat_username === "@aimeenam")?.chat_id;

function log(...parts) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${parts.join(" ")}\n`);
  } catch {}
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { seen: {} }; }
}
function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

async function latest(params = {}) {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "signal.latest", ...params }),
  });
  if (!r.ok) throw new Error(`signal.latest http ${r.status}`);
  return r.json();
}

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// SVG -> PNG. 실패하면 null을 돌려주고 텍스트만 보낸다 (그림 때문에 시그널을 놓치지 않는다).
function svgToPng(dataUri) {
  const { execFileSync } = require("node:child_process");
  const os2 = require("node:os");
  const match = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/.exec(dataUri || "");
  if (!match) return null;
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "sigchart-"));
  const svgPath = path.join(dir, "c.svg"), pngPath = path.join(dir, "c.png");
  try {
    fs.writeFileSync(svgPath, Buffer.from(match[1], "base64"));
    execFileSync(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars",
      `--screenshot=${pngPath}`, "--window-size=760,430", `file://${svgPath}`],
      { stdio: "ignore", timeout: 45000 });
    return fs.existsSync(pngPath) ? fs.readFileSync(pngPath) : null;
  } catch { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

async function sendPhoto(png, caption) {
  const form = new FormData();
  form.append("chat_id", String(CHANNEL_ID));
  form.append("caption", caption);
  form.append("photo", new Blob([png], { type: "image/png" }), "chart.png");
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
  const body = await r.json();
  if (!body.ok) throw new Error(`sendPhoto: ${body.description || r.status}`);
  return body.result;
}

async function send(text) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHANNEL_ID, text, disable_web_page_preview: true }),
  });
  const body = await r.json();
  if (!body.ok) throw new Error(`sendMessage: ${body.description || r.status}`);
  return body.result;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "-");
const when = (iso) => String(iso).replace("T", " ").replace(".000Z", " UTC");

function compose(entry) {
  const mark = entry.kind === "BUY" ? "▲ 매수" : "▼ 매도";
  return [
    `${mark} · ${entry.symbol} ${entry.timeframe}`,
    ``,
    `발화가 ${num(entry.price)}`,
    `현재가 ${num(entry.spot)} · RSI ${num(entry.rsi)} · 국면 ${entry.regime || "-"}`,
    `봉 마감 ${when(entry.at)}`,
    ``,
    `RSI(14)+VWMA(20) Disciplined 전략 · 정보 제공 전용이며 투자자문이 아닙니다.`,
  ].join("\n");
}

async function runOnce({ dryRun = false } = {}) {
  if (!BOT_TOKEN || !CHANNEL_ID) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID not configured");
  const state = loadState();
  const first = Object.keys(state.seen).length === 0;
  const data = await latest();
  const pending = [];

  for (const [symbol, sym] of Object.entries(data.symbols || {})) {
    for (const timeframe of TIMEFRAMES) {
      const frame = sym.frames?.[timeframe];
      const signal = frame?.lastSignal;
      if (!signal?.kind || !signal?.at) continue;
      const stream = `${symbol}|${timeframe}`;
      const key = `${signal.kind}|${signal.at}`;
      if (state.seen[stream] === key) continue;
      pending.push({
        stream, key, symbol, timeframe,
        kind: signal.kind, price: signal.price, at: signal.at,
        rsi: frame.rsi, spot: sym.price, regime: sym.regime,
      });
    }
  }

  // 첫 실행은 기준선만 잡는다 — 오래된 발화를 한꺼번에 쏟지 않기 위해.
  if (first) {
    for (const entry of pending) state.seen[entry.stream] = entry.key;
    saveState(state);
    log("baseline", `${pending.length} streams recorded, nothing sent`);
    return { baseline: true, recorded: pending.length, sent: 0 };
  }

  const sent = [];
  for (const entry of pending) {
    const text = compose(entry);
    if (dryRun) { sent.push({ ...entry, text }); continue; }
    try {
      let result = null;
      try {
        const framed = await latest({ symbol: entry.symbol.replace("USDT", ""), timeframe: entry.timeframe });
        const png = svgToPng(framed?.chart?.dataUri);
        if (png) result = await sendPhoto(png, text);
      } catch (chartError) { log("chart_skipped", entry.stream, chartError.message); }
      if (!result) result = await send(text);
      state.seen[entry.stream] = entry.key;   // 게시 성공에만 기록 — 실패는 다음 주기에 재시도
      saveState(state);
      sent.push({ stream: entry.stream, kind: entry.kind, messageId: result.message_id });
      log("pushed", entry.stream, entry.kind, entry.at);
    } catch (error) {
      log("push_failed", entry.stream, error.message);
    }
  }
  return { baseline: false, candidates: pending.length, sent };
}

const command = process.argv[2] || "run";
runOnce({ dryRun: command === "dry-run" })
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => { log("fatal", error.message); console.error("signal-push:", error.message); process.exit(1); });

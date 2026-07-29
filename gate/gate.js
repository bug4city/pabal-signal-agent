#!/usr/bin/env node
"use strict";
// 구독자 전용 텔레그램 채널 게이트 (agent #9)
//
// 자격의 정본은 온체인 PaymentHub.subExpiry(9, wallet) 하나뿐이다.
// 이 프로세스는 온체인 상태를 텔레그램 멤버십에 반영만 한다:
//   sync  : 입장 이벤트에서 지갑↔텔레그램 계정 결합 (초대링크 이름에 새겨진 지갑주소를 회수)
//   sweep : 구독 만료된 결합 멤버를 퇴장 처리 (ban 후 즉시 unban — 재구독 시 재입장 가능해야 함)
//   push  : 채널에 시그널 게시
//
// 불변식:
//   1) 우리가 초대한(결합된) 멤버만 건드린다. 직접 찾아 들어온 사람은 절대 퇴장시키지 않는다.
//   2) ban 뒤에는 반드시 unban — ban만 걸면 재결제해도 영구 차단된다.
//   3) 토큰은 로그·stdout에 절대 쓰지 않는다.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("ethers");

const GIWA_RPC = process.env.GIWA_RPC || "https://sepolia-rpc.giwa.io";
const PAYMENT_HUB = process.env.PAYMENT_HUB || "0xAe7E3DA7848079fc29566CcD905abBDAfE5F2a57";
const AGENT_ID = Number(process.env.AGENT_ID || 11);
const STATE_DIR = process.env.GATE_STATE_DIR || path.join(os.homedir(), ".aimenem-gate");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LOG_FILE = path.join(STATE_DIR, "gate.log");

function loadLocalConfig() {
  const file = path.join(os.homedir(), ".config", "telegram-gupsik.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}
const localConfig = loadLocalConfig();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || localConfig.bot_token;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID
  || localConfig.extra_chat_ids?.find((c) => c.chat_username === "@aimeenam")?.chat_id
  || null;

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error("gate: TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID not configured");
  process.exit(1);
}

// 파일에만 기록한다 (파이프가 끊겨도 죽지 않게)
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}\n`;
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line); } catch {}
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { offset: 0, members: {} }; } // members: telegramId => { wallet, joinedAt, status }
}
function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

async function telegram(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await r.json();
  if (!body.ok) throw new Error(`${method}: ${body.description || r.status}`);
  return body.result;
}

const provider = new ethers.JsonRpcProvider(GIWA_RPC);
const hub = new ethers.Contract(
  PAYMENT_HUB,
  [
    "function subExpiry(uint256 agentId, address user) view returns (uint64)",
    "event Subscribed(uint256 indexed agentId, address indexed user, uint64 expiry, uint256 paid, address referrer)",
  ],
  provider,
);
const subExpiry = async (wallet) => Number(await hub.subExpiry(AGENT_ID, wallet));

// 텔레그램 초대링크 name은 32자에서 잘린다 → 42자 주소가 통째로 안 들어간다.
// 잘린 접두사(0x + 30 hex = 120비트)는 온체인 Subscribed 이벤트의 구독자 집합에서 되찾는다.
// 오프체인 비밀 매핑을 두지 않고 결합을 온체인 사실로만 복원하기 위한 설계다.
const DEPLOYMENT_BLOCK = Number(process.env.DEPLOYMENT_BLOCK || 31532558);
const LOG_SPAN = 90000;
let _subscriberCache = { at: 0, wallets: [] };

async function subscriberWallets() {
  if (Date.now() - _subscriberCache.at < 60000 && _subscriberCache.wallets.length) return _subscriberCache.wallets;
  const latest = Number(await provider.send("eth_blockNumber", []));
  const topics = hub.interface.encodeFilterTopics("Subscribed", [AGENT_ID]);
  const wallets = new Set();
  for (let start = DEPLOYMENT_BLOCK; start <= latest; start += LOG_SPAN + 1) {
    const logs = await provider.getLogs({
      address: PAYMENT_HUB,
      fromBlock: start,
      toBlock: Math.min(start + LOG_SPAN, latest),
      topics,
    });
    for (const entry of logs) wallets.add(ethers.getAddress(hub.interface.parseLog(entry).args.user));
  }
  _subscriberCache = { at: Date.now(), wallets: [...wallets] };
  return _subscriberCache.wallets;
}

async function resolveWallet(namePrefix) {
  if (!namePrefix || !namePrefix.startsWith("0x")) return null;
  if (ethers.isAddress(namePrefix)) return ethers.getAddress(namePrefix);
  const prefix = namePrefix.toLowerCase();
  const matches = (await subscriberWallets()).filter((w) => w.toLowerCase().startsWith(prefix));
  // 접두사가 여러 지갑에 맞으면(사실상 불가) 결합하지 않는다 — 틀린 지갑에 묶느니 미결합이 낫다.
  return matches.length === 1 ? matches[0] : null;
}

// 입장/퇴장 이벤트를 읽어 지갑 결합을 갱신한다.
async function sync() {
  const state = loadState();
  const updates = await telegram("getUpdates", {
    offset: state.offset || 0,
    timeout: 0,
    allowed_updates: ["chat_member"],
  });
  let bound = 0;
  for (const update of updates) {
    state.offset = update.update_id + 1;
    const change = update.chat_member;
    if (!change || String(change.chat.id) !== String(CHANNEL_ID)) continue;
    const status = change.new_chat_member?.status;
    const telegramId = String(change.new_chat_member?.user?.id ?? "");
    if (!telegramId) continue;

    if (status === "member") {
      // 초대링크 이름에 새겨둔 지갑주소(32자 절단분)가 결합 근거다.
      // 이름이 없으면 우리가 초대한 사람이 아니므로 관리 대상에서 제외한다.
      const wallet = await resolveWallet(change.invite_link?.name);
      if (wallet) {
        state.members[telegramId] = {
          wallet,
          username: change.new_chat_member.user.username || null,
          joinedAt: new Date((change.date || 0) * 1000).toISOString(),
          status: "active",
        };
        bound++;
        log("bound", telegramId, wallet);
      } else {
        log("join_unbound", telegramId, "(organic member, not managed)");
      }
    } else if (status === "left" || status === "kicked") {
      if (state.members[telegramId]) {
        state.members[telegramId].status = "left";
        log("left", telegramId);
      }
    }
  }
  saveState(state);
  return { processed: updates.length, bound };
}

// 만료된 결합 멤버만 퇴장시킨다.
async function sweep({ dryRun = false } = {}) {
  const state = loadState();
  const now = Math.floor(Date.now() / 1000);
  const report = [];
  for (const [telegramId, member] of Object.entries(state.members)) {
    if (member.status !== "active") continue;
    let expiry;
    try { expiry = await subExpiry(member.wallet); }
    catch (error) { log("expiry_read_failed", member.wallet, error.message); continue; }
    const expired = expiry <= now;
    report.push({ telegramId, wallet: member.wallet, expiresAt: new Date(expiry * 1000).toISOString(), expired });
    if (!expired || dryRun) continue;
    try {
      await telegram("banChatMember", { chat_id: CHANNEL_ID, user_id: Number(telegramId) });
      // 재구독하면 다시 들어올 수 있어야 한다 — ban은 퇴장 수단일 뿐이다.
      await telegram("unbanChatMember", { chat_id: CHANNEL_ID, user_id: Number(telegramId), only_if_banned: true });
      state.members[telegramId].status = "evicted";
      state.members[telegramId].evictedAt = new Date().toISOString();
      log("evicted", telegramId, member.wallet, "subscription expired");
    } catch (error) {
      log("evict_failed", telegramId, error.message);
    }
  }
  if (!dryRun) saveState(state);
  return report;
}

// 로컬에서 초대링크를 직접 발급한다 (엔드포인트 배포 없이 임의 채팅으로 게이트를 실증할 때 사용).
// 이름에 지갑주소를 새기는 규칙은 엔드포인트와 동일 — 32자 절단분은 온체인에서 복원된다.
async function invite(wallet, { ttlSec = 3600 } = {}) {
  if (!ethers.isAddress(wallet)) throw new Error(`not an address: ${wallet}`);
  const address = ethers.getAddress(wallet);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  const link = await telegram("createChatInviteLink", {
    chat_id: CHANNEL_ID,
    name: address,
    member_limit: 1,
    expire_date: expiresAt,
  });
  let expiry = 0;
  try { expiry = await subExpiry(address); } catch {}
  log("invited", address, link.invite_link);
  return {
    wallet: address,
    inviteLink: link.invite_link,
    linkName: link.name,
    inviteExpiresAt: new Date(expiresAt * 1000).toISOString(),
    subscribedUntil: expiry ? new Date(expiry * 1000).toISOString() : null,
    subscriptionActive: expiry > Math.floor(Date.now() / 1000),
  };
}

async function push(text) {
  const result = await telegram("sendMessage", { chat_id: CHANNEL_ID, text, disable_web_page_preview: true });
  log("pushed", `message_id=${result.message_id}`);
  return result;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "sync") {
    console.log(JSON.stringify(await sync(), null, 2));
  } else if (command === "sweep") {
    console.log(JSON.stringify(await sweep({ dryRun: args.includes("--dry-run") }), null, 2));
  } else if (command === "run") {
    const synced = await sync();
    const swept = await sweep();
    console.log(JSON.stringify({ synced, swept }, null, 2));
  } else if (command === "invite") {
    if (!args[0]) throw new Error("usage: gate.js invite <wallet>");
    console.log(JSON.stringify(await invite(args[0]), null, 2));
  } else if (command === "watch") {
    // 입장 이벤트를 기다린다 (테스트용). 결합이 잡히면 즉시 종료.
    const deadline = Date.now() + Number(args[0] || 300) * 1000;
    process.stdout.write("waiting for a join event...\n");
    while (Date.now() < deadline) {
      const result = await sync();
      if (result.bound > 0) {
        console.log(JSON.stringify({ bound: result.bound, members: loadState().members }, null, 2));
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log("no join captured before timeout");
  } else if (command === "push") {
    if (!args.length) throw new Error("usage: gate.js push <text>");
    await push(args.join(" "));
    console.log("pushed");
  } else if (command === "status") {
    const state = loadState();
    const members = Object.entries(state.members).map(([id, m]) => ({ telegramId: id, ...m }));
    console.log(JSON.stringify({ channel: String(CHANNEL_ID), offset: state.offset, members }, null, 2));
  } else {
    console.log("usage: gate.js <invite <wallet>|watch [sec]|sync|sweep [--dry-run]|run|push <text>|status>");
    console.log("       TELEGRAM_CHANNEL_ID=<chat_id> to target a different chat (test group)");
  }
}

main().catch((error) => { log("fatal", error.message); console.error("gate:", error.message); process.exit(1); });

#!/usr/bin/env node
// Pabal(BOBOO) 제작자 등록 스크립트 — test.pabal.ai 브로커에 원격 에이전트 등록.
// 브라우저 SDK(vendor/boboo-browser-sdk.js) 플로우와 동일:
//   validate -> registry.registerAgent(tx) -> EIP-712(AgentRegistration) -> POST /agents -> setPricing
// 사용: node register.js <validate|register|submit|pricing|task|status>
// 키: ~/Desktop/giwa-workforce/contracts/.env 의 DEPLOYER_KEY (출력 금지)

require("dotenv").config({ path: require("path").join(process.env.HOME, "Desktop", "giwa-workforce", "contracts", ".env") });
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const BROKER = "https://test.pabal.ai";
const RPC = process.env.GIWA_RPC || "https://sepolia-rpc.giwa.io";
const ENDPOINT = "https://pabal-signal-agent.vercel.app";
const MANIFEST_FILE = path.join(__dirname, "manifest.json");
const STATE_FILE = path.join(__dirname, ".register-state.json");

const REGISTRY_ABI = [
  "function nextAgentId() view returns (uint256)",
  "function agents(uint256) view returns (address owner, string metadataURI, bytes32 manifestHash, uint8 agentType, bool active, uint64 version, uint64 registeredAt)",
  "function registerAgent(string,bytes32,uint8) returns (uint256)",
  "function updateAgent(uint256 agentId, string metadataURI, bytes32 manifestHash)",
  "event AgentRegistered(uint256 indexed agentId,address indexed owner,uint8 agentType,bytes32 manifestHash,string metadataURI)",
  "event AgentUpdated(uint256 indexed agentId, bytes32 manifestHash)",
];
const HUB_ABI = [
  "function setPricing(uint256 agentId,uint128 subPricePerPeriod,uint128 taskPrice)",
  "function pricing(uint256) view returns (uint128 subPricePerPeriod, uint128 taskPrice)",
  "function hasAccess(uint256,address) view returns (bool)",
  "function credits(address) view returns (uint256)",
  "function depositCredits(uint256 amount)",
  "function subExpiry(uint256,address) view returns (uint64)",
];
const USDT_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const AGENT_REGISTRATION_TYPES = { AgentRegistration: [
  { name: "agentId", type: "uint256" },
  { name: "manifestHash", type: "bytes32" },
  { name: "deadline", type: "uint64" },
]};
const TASK_REQUEST_TYPES = { TaskRequest: [
  { name: "broker", type: "address" },
  { name: "user", type: "address" },
  { name: "agentId", type: "uint256" },
  { name: "requestHash", type: "bytes32" },
  { name: "nonce", type: "bytes32" },
  { name: "deadline", type: "uint64" },
]};

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

function buildManifest(agentId) {
  return {
    agentId,
    name: "BUG BTC/ETH Disciplined Signal",
    description: "Live BTC/ETH BUY/SELL signals from BUG's RSI+VWMA Disciplined strategy (1H/2H/4H/1D) with daily SMA200 market regime. HTTP/JSON — no Telegram, no wallet permissions required.",
    type: "T1-signal",
    category: "signal",
    onchainType: 0,
    endpoint: ENDPOINT,
    actions: ["signal.latest", "signal.history"],
    skills: [{
      id: "default",
      name: "BTC/ETH Market Signal",
      description: "Live BTC/ETH BUY/SELL signals from BUG's RSI+VWMA Disciplined strategy (1H/2H/4H/1D) with daily SMA200 market regime.",
      actions: [
        { name: "signal.latest", label: "Get latest signal snapshot" },
        { name: "signal.history", label: "Get recent fired signals" },
      ],
    }],
    tokens: [],
    maxUsdtPerTask: 0,
    maxTasksPerDay: 0,
    display: {
      symbols: ["BTCUSDT", "ETHUSDT"],
      timeframe: "1H · 2H · 4H · 1D",
      connect: "http",
    },
    riskNotice: "This agent only provides information (signals) and is not investment advice or discretionary management. Past performance does not guarantee future returns.",
  };
}

async function api(p, body) {
  const r = await fetch(BROKER + p, body ? {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} http ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

(async () => {
  const cmd = process.argv[2] || "status";
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_KEY, provider);
  const mp = await api("/marketplace");
  const C = mp.contracts;
  const chainId = mp.auth.chainId;
  const registry = new ethers.Contract(C.AgentRegistry, REGISTRY_ABI, wallet);
  const hub = new ethers.Contract(C.PaymentHub, HUB_ABI, wallet);

  if (cmd === "status") {
    console.log("wallet:", wallet.address, "| balance:", ethers.formatEther(await provider.getBalance(wallet.address)));
    console.log("nextAgentId:", (await registry.nextAgentId()).toString());
    if (state.agentId) {
      const a = await registry.agents(state.agentId);
      console.log(`agent #${state.agentId}: owner=${a.owner} active=${a.active} hash=${a.manifestHash}`);
      console.log("pricing:", (await hub.pricing(state.agentId)).toString());
    }
    return;
  }

  if (cmd === "validate") {
    const nextId = Number(await registry.nextAgentId());
    const manifest = buildManifest(nextId);
    const manifestRaw = JSON.stringify(manifest);
    const v = await api("/agents/validate", { manifestRaw });
    console.log("validate response:", JSON.stringify(v, null, 2));
    const hint = Number(v.nextAgentIdHint);
    const finalId = Number.isSafeInteger(hint) && hint >= 1 ? hint : nextId;
    const finalManifest = finalId === nextId ? manifest : buildManifest(finalId);
    const finalRaw = JSON.stringify(finalManifest);
    if (finalId !== nextId) {
      const v2 = await api("/agents/validate", { manifestRaw: finalRaw });
      console.log("re-validate:", JSON.stringify(v2, null, 2));
      state.manifestHash = v2.manifestHash;
    } else {
      state.manifestHash = v.manifestHash;
    }
    const localHash = ethers.keccak256(ethers.toUtf8Bytes(finalRaw));
    console.log("local hash :", localHash);
    console.log("hash match :", String(state.manifestHash).toLowerCase() === localHash.toLowerCase());
    state.agentId = finalId;
    fs.writeFileSync(MANIFEST_FILE, finalRaw); // 원문 바이트 그대로 보존 (해시 = 이 파일)
    saveState();
    console.log(`saved manifest.json (agentId=${finalId}) + state`);
    return;
  }

  if (cmd === "register") {
    if (!state.agentId || !state.manifestHash) throw new Error("run validate first");
    if (state.txHash) { console.log("already registered:", state.txHash); return; }
    const raw = fs.readFileSync(MANIFEST_FILE, "utf8");
    const manifest = JSON.parse(raw);
    const localHash = ethers.keccak256(ethers.toUtf8Bytes(raw));
    if (localHash.toLowerCase() !== String(state.manifestHash).toLowerCase()) throw new Error("hash drift, re-run validate");
    const onchainNext = Number(await registry.nextAgentId());
    if (onchainNext !== state.agentId) throw new Error(`nextAgentId moved: ${onchainNext} != ${state.agentId}, re-run validate`);
    const tx = await registry.registerAgent(manifest.endpoint, state.manifestHash, manifest.onchainType);
    console.log("tx sent:", tx.hash);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "AgentRegistered");
    console.log("AgentRegistered agentId:", ev ? ev.args.agentId.toString() : "?", "owner:", ev ? ev.args.owner : "?");
    if (Number(ev?.args.agentId) !== state.agentId) throw new Error("agentId mismatch on-chain");
    state.txHash = rc.hash;
    saveState();
    console.log("on-chain registration confirmed:", rc.hash);
    return;
  }

  if (cmd === "submit") {
    if (!state.agentId || !state.manifestHash || !state.txHash) throw new Error("run register first");
    const manifestRaw = fs.readFileSync(MANIFEST_FILE, "utf8");
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const domain = { name: "BOBOO Agent Registration", version: "1", chainId, verifyingContract: C.AgentRegistry };
    const signature = await wallet.signTypedData(domain, AGENT_REGISTRATION_TYPES, {
      agentId: state.agentId, manifestHash: state.manifestHash, deadline,
    });
    const res = await api("/agents", { manifestRaw, signature, deadline });
    console.log("broker accepted:", JSON.stringify(res, null, 2));
    state.brokerRegistered = true;
    saveState();
    return;
  }

  // updateManifest: manifest.json의 새 해시를 온체인에 반영 + 브로커에 재제출
  if (cmd === "update") {
    if (!state.agentId) throw new Error("agentId not in state, run status first");
    const manifestRaw = fs.readFileSync(MANIFEST_FILE, "utf8");
    const newHash = ethers.keccak256(ethers.toUtf8Bytes(manifestRaw));
    console.log("new manifest hash:", newHash);
    const onchain = await registry.agents(state.agentId);
    if (onchain.manifestHash.toLowerCase() === newHash.toLowerCase()) {
      console.log("on-chain hash already matches, skipping updateManifest tx");
    } else {
      const onchainAgent = await registry.agents(state.agentId);
      const metadataURI = onchainAgent.metadataURI || ENDPOINT;
      const tx = await registry.updateAgent(state.agentId, metadataURI, newHash);
      console.log("updateAgent tx sent:", tx.hash);
      await tx.wait();
      console.log("updateAgent confirmed");
    }
    // EIP-712 AgentRegistration으로 브로커에 재제출
    state.manifestHash = newHash;
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const domain = { name: "BOBOO Agent Registration", version: "1", chainId, verifyingContract: C.AgentRegistry };
    const signature = await wallet.signTypedData(domain, AGENT_REGISTRATION_TYPES, {
      agentId: state.agentId, manifestHash: newHash, deadline,
    });
    const res = await api("/agents", { manifestRaw, signature, deadline });
    console.log("broker resubmit:", JSON.stringify(res, null, 2));
    state.brokerRegistered = true;
    saveState();
    console.log("done: on-chain + broker both updated");
    return;
  }

  if (cmd === "pricing") {
    if (!state.agentId) throw new Error("run validate first");
    const sub = ethers.parseUnits(process.argv[3] || "10", 6);
    const task = ethers.parseUnits(process.argv[4] || "1", 6);
    const tx = await hub.setPricing(state.agentId, sub, task);
    await tx.wait();
    console.log(`pricing set for #${state.agentId}: sub=${sub} task=${task} tx=${tx.hash}`);
    return;
  }

  if (cmd === "credits") {
    // 테스트 유저(=이 지갑)에 MockUSDT 민트 + 크레딧 충전
    const usdt = new ethers.Contract(C.MockUSDT, USDT_ABI, wallet);
    const amt = ethers.parseUnits(process.argv[3] || "20", 6);
    await (await usdt.mint(wallet.address, amt)).wait();
    await (await usdt.approve(C.PaymentHub, amt)).wait();
    await (await hub.depositCredits(amt)).wait();
    console.log("credits:", (await hub.credits(wallet.address)).toString());
    return;
  }

  if (cmd === "task") {
    if (!state.agentId) throw new Error("run validate first");
    const request = { action: process.argv[3] || "signal.latest", symbol: process.argv[4] || "BTC", timeframe: process.argv[5] || "4H" };
    const requestHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(request)));
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const deadline = Math.floor(Date.now() / 1000) + 120;
    const auth = { broker: mp.auth.broker, user: wallet.address, agentId: state.agentId, requestHash, nonce, deadline };
    const domain = { name: mp.auth.domainName, version: mp.auth.domainVersion, chainId, verifyingContract: mp.auth.verifyingContract };
    const signature = await wallet.signTypedData(domain, TASK_REQUEST_TYPES, auth);
    const res = await api(`/task/${state.agentId}`, { user: wallet.address, request, auth, signature });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  throw new Error(`unknown cmd: ${cmd}`);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });

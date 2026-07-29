#!/usr/bin/env node
"use strict";
// launchd 한 틱: 채널 멤버십 정리 + 새 시그널 게시. 한쪽이 실패해도 다른 쪽은 진행한다.
const { execFileSync } = require("node:child_process");
const path = require("node:path");
for (const script of ["gate.js", "signal-push.js"]) {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, script), "run"], { encoding: "utf8", timeout: 120000 });
    console.log(`[${new Date().toISOString()}] ${script}: ${out.replace(/\s+/g, " ").slice(0, 300)}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${script} failed: ${error.message}`);
  }
}

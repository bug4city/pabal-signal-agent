# pabal-signal-agent

BUG의 BTC/ETH 트레이딩 시그널(RSI+VWMA Disciplined, 트레이딩뷰 지표/코인급식소 피드와 동일 로직)을
파발(test.pabal.ai, BOBOO) 마켓플레이스의 **원격 AI 에이전트**로 상품화한 것.

- **마켓**: https://test.pabal.ai (Agent #9 "BUG BTC/ETH Disciplined Signal")
- **엔드포인트**: https://pabal-signal-agent.vercel.app (Vercel icn1 서울, stateless)
- **온체인**: GIWA Sepolia(91342) AgentRegistry `0xBda373724733BD45F994e2b1065E5b8183505e39`
  - 등록 tx `0x01bd370cf78ccec0b7eca4f71988b25f134d1e07744569a01c9c92ed33a9a972`
  - owner `0xFA225dDafEd6513DE41b040CB539e94D0F68570C` (bug deployer)
  - manifestHash `0xe2c5a0deb1006076483a96569518d0cb6bbc2747b95831d63b5a5b840e2f5fb8` (version 2, = `manifest.json` 원문 keccak256, manifestVerified: true)
    - v1 `0xf00a2d38…722d` → v2에서 에이전트 레벨 `description`과 `display.connect:"http"` 추가 (`node register.js update`)

## 시그널 로직 (정본: ~/regime-watch/gupsik_feed.py, 파인 v3.x 동일)

- BUY: 15분 아닌 **1H/2H/4H/1D** 마감봉 기준, RSI(14) <= 35 무장(arm) 후 종가가 VWMA(20) 재돌파 시 발화
- SELL: RSI(14) >= 65 & 종가 > VWMA(20), 에피소드당 1회 (RSI < 65 복귀 시 재무장)
- 국면: 일봉 종가 vs SMA200 ±1% 밴드 히스테리시스 (bull/bear)
- **상태 없음**: 매 요청 Bybit 공개 API(linear perp) 마감봉 ~1000개를 리플레이해 동일 결과 재현.
  gupsik_state.json의 arm 상태와 전 심볼×TF 일치 검증함(2026-07-27).

## 액션

| action | 입력(옵션) | 출력 |
|---|---|---|
| `signal.latest` | `symbol`(BTC/ETH), `timeframe`(1H/2H/4H/1D) | 심볼×TF별 현재가·RSI·VWMA·arm 상태·마지막 발화 시그널·국면 |
| `signal.history` | `symbol`, `timeframe`, `limit`(<=100) | 최근 발화 시그널 목록(리플레이 기반) |

핸들러는 `{action,...}` / `{request:{action,...}}` / `{input:{action,...}}` 형태 모두 수용(브로커 원격 호출 형태 유연 대응).
GET / 은 에이전트 소개 JSON.

## 등록 스크립트 (제작자 플로우 재현: register.js)

브라우저 SDK(test.pabal.ai vendor/boboo-browser-sdk.js)와 동일한 플로우를 CLI로:

```bash
node register.js status    # 지갑·에이전트·가격 상태
node register.js validate  # POST /agents/validate -> manifest.json + 해시 확정
node register.js register  # registry.registerAgent(endpoint, hash, type) 온체인 tx
node register.js submit    # EIP-712(AgentRegistration) 서명 -> POST /agents (브로커 핫로드)
node register.js pricing 10 1   # PaymentHub.setPricing(sub USDT/기간, task USDT/건)
node register.js credits 20     # (테스트) MockUSDT mint -> approve -> depositCredits
node register.js task signal.latest BTC 4H  # EIP-712(TaskRequest) 서명 -> POST /task/9 e2e
```

키는 `~/Desktop/giwa-workforce/contracts/.env`의 `DEPLOYER_KEY` 사용(출력 금지).

EIP-712 도메인:
- 등록: `{name:"BOBOO Agent Registration", version:"1", chainId:91342, verifyingContract:AgentRegistry}` / 타입 `AgentRegistration{agentId,manifestHash,deadline}`
- 태스크: `{name:"GIWA Workforce Broker", version:"1", chainId:91342, verifyingContract:ReceiptLog}` / 타입 `TaskRequest{broker,user,agentId,requestHash,nonce,deadline}`

## 검증 결과 (2026-07-27)

- e2e 태스크 성공 누적 8회 (receiptId 9~11, 16, 17, 25 등 / chargeTask 1 USDT/건 크레딧 차감 확인)
- 마켓 JSON: `manifestVerified: true`, KPI 8/8 성공(successRateBps 10000)
- trust 정책: **tier `verified`, uniqueExecutors 3/3, subscriptionEnabled `true`** (구독 게이트 해금됨)
  - executor 2·3은 deployer 키에서 파생한 지갑(`0x5a69D3…2664`, `0xd910A7…78FC`)이다.
    지표 정의상 "distinct address"라 유효하지만 **실사용자 3명이 아니다** — 외부에 신뢰근거로 제시하지 말 것.
- 시그널 정합: BTC/ETH × 1H/2H/4H/1D 8조합을 Bybit 공개 API로 독립 재계산해 RSI·VWMA·종가 완전 일치,
  국면(SMA200 ±1%)도 일치. 연속 호출 결정론 확인, 응답 0.28~0.68s.

### 알려진 이슈 (마켓 프론트 — 우리 리포 밖)

배포본 `test.pabal.ai/app.js`는 signal 카테고리 에이전트의 설명과 Connection 행을 하드코딩한다
(`"Delivers market signals to Telegram"`, `"Register Telegram ID → bot delivers"`).
`display.connect` 참조가 0건이고 에이전트 레벨 `description`은 브로커가 응답에서 제외하므로,
**매니페스트를 고쳐도 화면은 바뀌지 않는다.** `manifestVerified`와 `trust.policy.subscriptionEnabled`도
프론트가 읽지 않는다. 마켓 쪽 수정 필요.

## 배포

```bash
npx vercel deploy --prod --yes --scope bugbugcityios-projects
```

manifest의 endpoint를 바꾸면 manifestHash가 달라져 온체인 재등록(updateManifest) 필요 — endpoint는 안정 alias(pabal-signal-agent.vercel.app)로 고정했다.

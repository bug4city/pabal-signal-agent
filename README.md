# pabal-signal-agent

BUG의 BTC/ETH 트레이딩 시그널(RSI+VWMA Disciplined, 트레이딩뷰 지표/코인급식소 피드와 동일 로직)을
파발(test.pabal.ai, BOBOO) 마켓플레이스의 **원격 AI 에이전트**로 상품화한 것.

- **마켓**: https://test.pabal.ai (Agent #9 "BUG BTC/ETH Disciplined Signal")
- **엔드포인트**: https://pabal-signal-agent.vercel.app (Vercel icn1 서울, stateless)
- **온체인**: GIWA Sepolia(91342) AgentRegistry `0xBda373724733BD45F994e2b1065E5b8183505e39`
  - 등록 tx `0x01bd370cf78ccec0b7eca4f71988b25f134d1e07744569a01c9c92ed33a9a972`
  - owner `0xFA225dDafEd6513DE41b040CB539e94D0F68570C` (bug deployer)
  - manifestHash `0xf00a2d38a4305a9ea012fa58c884c24f8c8703693131629230018be8a339722d` (= `manifest.json` 원문 keccak256, manifestVerified: true)

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

- e2e 태스크 3회 성공: 온체인 영수증 receiptId 9, 10, 11 (chargeTask 1 USDT/건 크레딧 차감 확인)
- 마켓 JSON: `manifestVerified: true`, KPI 집계 정상
- trust 정책: successfulExecutions 3/3 충족, **uniqueExecutors 1/3** — 구독(subscribe) 해금은 서로 다른 지갑 3개가 태스크를 성공시켜야 함. 팀원 지갑으로 태스크 2회면 해금.

## 배포

```bash
npx vercel deploy --prod --yes --scope bugbugcityios-projects
```

manifest의 endpoint를 바꾸면 manifestHash가 달라져 온체인 재등록(updateManifest) 필요 — endpoint는 안정 alias(pabal-signal-agent.vercel.app)로 고정했다.

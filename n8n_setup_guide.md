# n8n Cloud 하이브리드 자동화 세팅 가이드

## 구조 요약

```
GitHub Actions (무료, Puppeteer 실행 가능)
  ├─ crawl-featured.mjs  → Apple + GP Puppeteer 크롤링
  ├─ git commit data/    → data/*.json 커밋 (apple + google 필드)
  └─ POST n8n webhook    → 크롤링 결과 JSON 전송
        │
        ▼
n8n Cloud (무료, 서버 불필요)
  ├─ Webhook trigger     → 크롤링 데이터 수신
  ├─ Code node           → NEXON 감지, 장르 통계, 국가별 요약
  ├─ Notion HTTP         → DB 로그 INSERT + 리포트 페이지 생성
  ├─ Slack HTTP          → 일일 요약 알림
  └─ IF → Slack HTTP     → NEXON 피쳐드 알림 (조건부)
```

n8n Cloud에서는 Execute Command가 비활성화되어 있어 Puppeteer를 직접 실행할 수 없습니다.
그래서 크롤링은 기존 GitHub Actions가 담당하고, 리포팅만 n8n Cloud로 위임합니다.

---

## 1단계: n8n Cloud 가입

1. **https://app.n8n.cloud/register** 에서 가입
2. 무료 플랜 선택 (워크플로 5개, 월 실행 제한 있지만 일 1회면 충분)
3. 가입 완료 후 대시보드 진입

---

## 2단계: n8n 워크플로 임포트

1. n8n 대시보드 → **Workflows** → **Import from File**
2. `n8n-workflow.json` 업로드
3. 워크플로가 열리면 아래 3곳을 수정:

### 수정할 곳

| 노드 | 수정 필드 | 입력할 값 |
|------|----------|-----------|
| 📝 Notion DB Log | jsonBody 안 `여기에_NOTION_DB_ID_입력` | Notion DB ID (32자리 hex) |
| 📈 Notion Report Page | jsonBody 안 `여기에_REPORT_PAGE_ID_입력` | Notion 리포트 부모 페이지 ID |
| 📋 Slack Daily + 🔔 Slack NEXON | url 필드 `여기에_SLACK_WEBHOOK_URL_입력` | Slack Webhook 전체 URL |

---

## 3단계: n8n Credential 설정

### Notion API (Header Auth)

1. n8n → **Credentials** → **Add Credential** → **Header Auth**
2. Name: `Notion Token`
3. Header Name: `Authorization`
4. Header Value: `Bearer ntn_xxxxxxxxxx` (Notion Internal Integration Secret)
5. 각 Notion HTTP Request 노드에서 이 credential 선택

### Notion Integration 생성

1. https://www.notion.so/my-integrations → **New integration**
2. 이름: `Store Featured Bot`
3. Capabilities: **Read content**, **Insert content**, **Update content**
4. **Internal Integration Secret** 복사 → n8n credential에 입력
5. Notion 페이지/DB에서 `...` → **Connections** → `Store Featured Bot` 추가

### Notion DB 생성

아래 스키마로 DB 생성 (일일 로그용):

| 속성명 | 타입 | 설명 |
|--------|------|------|
| 제목 | Title | "피쳐드 2026-04-15" |
| 날짜 | Date | 크롤링 날짜 |
| Apple 수 | Number | App Store 피쳐드 수 |
| Google 수 | Number | Google Play 피쳐드 수 |
| NEXON 수 | Number | NEXON 타이틀 수 |
| Top 장르 | Select | 최다 장르 |

DB 생성 후 URL에서 ID 추출:
```
https://notion.so/xxxxx/DB이름-[여기가_DB_ID]?v=xxxxx
                              └──────────────────┘
                              32자리 hex (하이픈 없이)
```

### Slack Incoming Webhook

1. https://api.slack.com/apps → **Create New App** → From scratch
2. 이름: `Store Featured Bot`, 워크스페이스 선택
3. **Incoming Webhooks** → Activate → **Add New Webhook to Workspace**
4. 채널 선택 (예: `#store-featured`)
5. Webhook URL 전체 복사 → n8n 노드 url 필드에 입력

---

## 4단계: Webhook URL 확인

1. n8n에서 워크플로 열기
2. **🔗 Webhook** 노드 클릭 → 우측 패널에서 **Webhook URLs** 확인
3. **Production URL** 복사 (형태: `https://your-instance.app.n8n.cloud/webhook/store-featured-report`)
4. 워크플로 **Active** 토글 ON (이걸 켜야 Webhook이 수신 가능)

---

## 5단계: GitHub Secrets 등록

GitHub 리포지토리 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret 이름 | 값 | 용도 |
|-------------|-----|------|
| `N8N_WEBHOOK_URL` | n8n Production Webhook URL | Actions → n8n 트리거 |

이 Secret이 등록되면 Actions에서 크롤링 후 n8n을 호출합니다.
등록하지 않으면 기존 `report-featured.mjs` 스크립트로 폴백합니다.

### 폴백 모드 (n8n 없이)

n8n 없이도 `report-featured.mjs`로 직접 Notion/Slack 리포팅이 가능합니다.
이 경우 아래 Secrets를 등록하면 됩니다:

| Secret 이름 | 값 |
|-------------|-----|
| `NOTION_TOKEN` | Notion Internal Integration Secret |
| `NOTION_DB_ID` | Notion DB ID |
| `NOTION_REPORT_PAGE_ID` | 리포트 부모 페이지 ID |
| `SLACK_WEBHOOK_URL` | Slack Webhook URL |

---

## 6단계: 테스트

### n8n 테스트

1. n8n에서 워크플로 열고 **🔗 Webhook** 노드의 **Test URL** 복사
2. 터미널에서 테스트 요청 전송:

```bash
curl -X POST https://your-instance.app.n8n.cloud/webhook-test/store-featured-report \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2026-04-15",
    "countries": {
      "KR": {
        "apple": [{"name":"MapleStory","dev":"NEXON","nexon":true,"banner":true,"rank":3,"genre":"RPG","tab":"Games","section":"배너"}],
        "google": [{"name":"MapleStory","dev":"NEXON Korea","nexon":true,"banner":true,"rank":5,"genre":"RPG","tab":"Featured","section":"배너"}]
      }
    }
  }'
```

3. n8n 실행 결과 확인 → Notion + Slack에 데이터가 들어오는지 확인

### GitHub Actions 테스트

1. 리포지토리 → **Actions** → **Crawl & Report Store Featured**
2. **Run workflow** 클릭 (수동 실행)
3. 로그에서 크롤링 → 커밋 → n8n webhook 호출 순서 확인

---

## 데이터 흐름 상세

```
GitHub Actions crawl-featured.mjs
  │
  │  Apple Store: Games탭 hero 배너 + h3 카드
  │              Today탭 게임만 필터 (MapleStory Worlds 예외)
  │              상세페이지 → 개발사, 장르, 아이콘 보강
  │
  │  Google Play: .ULeU3b 배너 (.fkdIre 이름, .bcLwIe 개발사,
  │               .nnW2Md 아이콘, .GnAUad 배지)
  │              Top Charts 페이지
  │
  ▼
data/KR.json = { apple: [...], google: [...] }
  │
  │  POST to n8n webhook (JSON payload)
  │  payload = { date, countries: { KR: {apple,google}, TW: ... } }
  │
  ▼
n8n Code Node
  │  NEXON 감지 (개발사명 14종 매칭)
  │  양쪽 피쳐드 체크 (apple ∩ google)
  │  장르 통계 집계
  │  국가별 요약 생성
  │
  ├─→ Notion DB: 일일 로그 행 INSERT
  ├─→ Notion Page: 트렌드 리포트 (국가별 현황 + NEXON + 장르)
  ├─→ Slack: 일일 요약
  └─→ Slack: NEXON 알림 (있을 때만)
```

---

## Slack 알림 예시

### 일일 요약
```
📊 일일 피쳐드 요약 (2026-04-15)
🍎 App Store: 104개  |  🟢 Google Play: 78개
🎯 NEXON: 5개  |  🏆 Top 장르: RPG

🇰🇷 한국  AS 22 / GP 18 / NX 5
🇹🇼 대만  AS 20 / GP 15 / NX 3
🇯🇵 일본  AS 25 / GP 20 / NX 4
🇺🇸 미국  AS 19 / GP 14 / NX 2
🇹🇭 태국  AS 18 / GP 11 / NX 1

[📊 대시보드]
```

### NEXON 알림
```
🎮 NEXON 피쳐드 알림 (2026-04-15)
5개 NEXON 타이틀 스토어 피쳐드 등장
────────────
MapleStory 🍎 🟢
#3 | RPG | 🇰🇷 🇹🇼 🇯🇵
🔥 배너 · ⚡ 양쪽

The First Descendant 🟢
#7 | 액션 | 🇰🇷 🇺🇸
🔥 배너
────────────
[대시보드 열기]
```

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| n8n webhook 404 | 워크플로 비활성 | Active 토글 ON 확인 |
| n8n webhook timeout | payload 너무 큼 | 5개국 데이터 합치면 ~1MB, n8n Cloud 제한 확인 |
| Notion 401 | Integration 미연결 | 페이지/DB에 Connection 추가 |
| Notion 400 | DB 스키마 불일치 | 속성명 정확히 일치하는지 확인 (한글 주의) |
| Slack 미전송 | Webhook 만료 | Slack App에서 Webhook 재생성 |
| Actions에서 n8n 미호출 | Secret 미등록 | `N8N_WEBHOOK_URL` Secret 확인 |
| GP 배너 0개 | 셀렉터 변경됨 | GP 페이지 소스에서 `.ULeU3b` 확인 |

---

## 파일 구조

```
Store-Featured-Dash/
├── .github/workflows/
│   └── crawl.yml            ← Actions: 크롤링 + n8n 호출
├── scripts/
│   ├── crawl-featured.mjs   ← Puppeteer 크롤러 (Apple + GP)
│   └── report-featured.mjs  ← 직접 리포팅 스크립트 (폴백용)
├── data/                    ← 크롤링 결과 JSON
├── netlify/functions/
│   └── crawl.js             ← Netlify 함수 (대시보드 API)
├── public/
│   └── index.html           ← 대시보드 프론트엔드
├── n8n-workflow.json         ← n8n Cloud 워크플로 (임포트용)
├── N8N_SETUP_GUIDE.md        ← 이 가이드
├── package.json
└── netlify.toml
```

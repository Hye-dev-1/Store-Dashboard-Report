# n8n Cloud 하이브리드 자동화 세팅 가이드

## 구조 요약

```
GitHub Actions (Puppeteer 크롤링)
  ├─ crawl-featured.mjs  → Apple + GP Puppeteer + scraper 보강
  ├─ git commit data/    → data/*.json (apple + google 필드)
  └─ POST n8n webhook    → 크롤링 결과 JSON 전송
        │
        ▼
n8n Cloud (리포팅 전용, 서버 불필요)
  ├─ Webhook trigger     → 데이터 수신
  ├─ Code node           → NEXON 감지, 장르 통계, 리포트 마크다운 생성
  ├─ Notion node         → DB 로그 INSERT
  ├─ Wait 400ms          → Rate Limit 대응
  ├─ Notion node         → 리포트 페이지 생성
  ├─ Slack HTTP          → 일일 요약 알림
  └─ IF → Slack HTTP     → NEXON 피쳐드 알림 (조건부)
```

---

## 운영 주의사항

### ⚠️ Integration 연결 (가장 흔한 실패 원인)

Notion API로 접근하려는 DB나 페이지에 반드시 해당 Integration이 연결되어 있어야 합니다.
미연결 시 Notion 노드 드롭다운에 DB가 표시되지 않거나 404 오류가 발생합니다.

연결 방법: Notion에서 해당 페이지/DB 열기 → 우측 상단 `···` → **Connections** → Integration 선택

일일 로그 DB와 리포트 부모 페이지 **둘 다** 연결해야 합니다.

### ⚠️ Rate Limit (초당 3회)

Notion API는 초당 3회 요청 제한이 있습니다.

- **n8n**: Notion DB Log → **Wait 400ms** → Notion Report 순서로 구성하여 rate limit 회피.
  대량 처리가 필요한 경우 Split In Batches 노드 + Wait 노드 조합 권장.
- **report-featured.mjs**: 429 응답 시 `Retry-After` 헤더를 읽어 exponential backoff로
  최대 3회 재시도. 국가별 INSERT 사이에 350ms 대기.

### ⚠️ Credential 보안

- Integration Secret은 **n8n Credentials에만 저장**하고 워크플로 JSON이나 로그에 노출 금지.
- 워크플로 JSON 내 Slack Webhook URL은 `$credentials.slackWebhookUrl` 표현식으로 참조하여
  JSON 파일 자체에 URL이 포함되지 않도록 처리.
- GitHub Actions의 Secret(`N8N_WEBHOOK_URL`, `NOTION_TOKEN` 등)은 Actions Secrets에만 등록.

### ⚠️ 에러 핸들링

- 모든 Notion/Slack 노드에 **Continue On Fail** (`onError: continueRegularOutput`) 설정.
  한 노드가 실패해도 나머지 리포팅은 계속 진행.
- **Error Workflow** 설정: 어떤 노드에서든 에러 발생 시 `❌ Error → Slack` 노드가 실행되어
  Slack으로 에러 내용 알림.
- report-featured.mjs도 main() catch에서 Slack 에러 알림 후 process.exit(1).

### ⚠️ Notion-Version 헤더

n8n 빌트인 Notion 노드는 적절한 Notion API 버전이 자동 설정되므로 별도 헤더 설정이 불필요합니다.
HTTP Request 노드로 Notion API를 직접 호출할 경우에만 수동으로 `Notion-Version` 헤더를 추가하세요.

report-featured.mjs는 `2026-03-11` 버전을 사용합니다.
2026-03-11 breaking changes (`archived` → `in_trash`, `after` → `position`, `transcription` → `meeting_notes`)는
현재 코드에서 해당 필드를 사용하지 않으므로 영향 없음.

---

## 1단계: n8n Cloud 가입

1. https://app.n8n.cloud/register 에서 가입
2. 무료 플랜 선택 (워크플로 5개, 월 실행 제한 있지만 일 1회면 충분)

---

## 2단계: Credential 등록 (JSON 임포트 전에 먼저)

### Notion Credential

1. n8n → **Credentials** → **Add Credential** → **Notion API**
2. Internal Integration Secret 입력
3. 저장 후 Credential ID 확인 (워크플로 노드에 자동 연결됨)

Notion Integration 생성:
1. https://www.notion.so/my-integrations → **New integration**
2. 이름: `Store Featured Bot`
3. Capabilities: Read content, Insert content, Update content
4. Internal Integration Secret 복사

### Slack Credential

1. n8n → **Credentials** → **Add Credential** → **Header Auth** (또는 직접 변수 사용)
2. Slack Incoming Webhook URL 저장

Slack Webhook 생성:
1. https://api.slack.com/apps → Create New App → From scratch
2. Incoming Webhooks → Activate → Add New Webhook to Workspace
3. 채널 선택 (예: `#store-featured`)

---

## 3단계: Notion DB/페이지 준비

### 일일 로그 DB

아래 스키마로 생성:

| 속성명 | 타입 | 설명 |
|--------|------|------|
| 제목 | Title | "피쳐드 2026-04-15" |
| 날짜 | Date | 크롤링 날짜 |
| Apple 수 | Number | App Store 피쳐드 수 |
| Google 수 | Number | Google Play 피쳐드 수 |
| NEXON 수 | Number | NEXON 타이틀 수 |
| Top 장르 | Select | 최다 장르 |

### 리포트 페이지

빈 페이지 하나 생성 (트렌드 리포트의 부모).

**두 곳 모두 Integration 연결 필수**: DB/페이지 → `···` → Connections → `Store Featured Bot`

---

## 4단계: 워크플로 임포트

1. n8n → **Workflows** → **Import from File** → `n8n-workflow.json` 업로드
2. 수정할 곳:

| 노드 | 수정 | 입력값 |
|------|------|--------|
| 📝 Notion DB Log | databaseId | Notion DB ID (32자리) |
| 📈 Notion Report | parentPageId | 리포트 부모 페이지 ID |
| 📝, 📈 | credentials | 2단계에서 만든 Notion credential 선택 |
| 📋, 🔔, ❌ | url 또는 credential | Slack Webhook URL (credential 참조) |

Notion DB ID 확인법:
```
https://notion.so/xxxxx/DB이름-[여기가_DB_ID]?v=xxxxx
```

3. 워크플로 **Active** 토글 ON

---

## 5단계: Webhook URL 확인 및 GitHub 연결

1. n8n **🔗 Webhook** 노드 → **Production URL** 복사
2. GitHub repo → **Settings** → **Secrets** → `N8N_WEBHOOK_URL` 등록

| GitHub Secret | 값 | 용도 |
|--------------|-----|------|
| `N8N_WEBHOOK_URL` | n8n Production Webhook URL | Actions → n8n 트리거 |

n8n 없이 폴백: `N8N_WEBHOOK_URL` 미등록 시 `report-featured.mjs` 직접 실행.
이 경우 아래 Secrets 필요:

| Secret | 값 |
|--------|-----|
| `NOTION_TOKEN` | Notion Integration Secret |
| `NOTION_DB_ID` | DB ID |
| `NOTION_REPORT_PAGE_ID` | 리포트 페이지 ID |
| `SLACK_WEBHOOK_URL` | Slack Webhook URL |

---

## 6단계: 테스트

### n8n 단독 테스트

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

확인 항목:
- Notion DB에 행 생성 여부
- Notion 리포트 페이지 생성 여부
- Slack 일일 요약 + NEXON 알림 수신 여부

### GitHub Actions E2E 테스트

Actions → **Run workflow** 수동 실행 → 로그에서 크롤링 → 커밋 → n8n 호출 확인.

---

## 워크플로 노드 상세

| 노드 | 타입 | 역할 | 에러 처리 |
|------|------|------|-----------|
| 🔗 Webhook | Webhook | GitHub Actions에서 POST 수신 | — |
| 📊 Parse & Analyze | Code | NEXON 감지, 장르 통계, 마크다운 생성 | — |
| 📝 Notion DB Log | **Notion (native)** | DB에 일일 요약 INSERT | continueOnFail |
| ⏳ Wait 400ms | Wait | Rate Limit 대응 (3 req/sec) | — |
| 📈 Notion Report | **Notion (native)** | 리포트 페이지 생성 | continueOnFail |
| 📋 Slack Daily | HTTP Request | 일일 요약 알림 | continueOnFail |
| 🔍 NEXON? | IF | NEXON 존재 시 분기 | — |
| 🔔 Slack NEXON | HTTP Request | NEXON 알림 | continueOnFail |
| ❌ Error → Slack | HTTP Request | Error Workflow 대상 | — |

Notion 노드는 n8n 빌트인 Notion 노드를 사용하므로 **Notion-Version 헤더가 자동 설정**됩니다.

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| Notion 노드 DB 드롭다운 비어있음 | Integration 미연결 | DB에서 ··· → Connections → 연결 |
| Notion 404 | 페이지/DB에 Integration 미연결 | 위와 동일 |
| Notion 429 | Rate limit 초과 | Wait 노드 시간 증가 (500ms~1s) |
| Notion 401 | Token 만료 또는 잘못됨 | Credential 재확인 |
| n8n webhook 404 | 워크플로 비활성 | Active 토글 ON |
| Slack 미전송 | Webhook URL 만료 | Slack App에서 재생성 |
| Actions에서 n8n 미호출 | Secret 미등록 | `N8N_WEBHOOK_URL` 확인 |
| GP 배너 0개 | 셀렉터 변경 | `.ULeU3b` 확인 후 갱신 |

---

## 파일 구조

```
Store-Featured-Dash/
├── .github/workflows/crawl.yml   ← Actions: 크롤링 + n8n 호출/폴백
├── scripts/
│   ├── crawl-featured.mjs        ← Puppeteer + scraper 보강
│   └── report-featured.mjs       ← 직접 리포팅 (폴백용, 429 retry 포함)
├── data/*.json                   ← {apple: [...], google: [...]}
├── public/index.html             ← GitHub Raw URL fetch (로컬 사용)
├── n8n-workflow.json             ← n8n 워크플로 (native Notion 노드)
├── N8N_SETUP_GUIDE.md            ← 이 가이드
└── package.json
```

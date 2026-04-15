/**
 * report-featured.mjs
 * ─────────────────────────────────────────────────
 * crawl-featured.mjs가 생성한 data/*.json을 읽어서
 *   1) Notion DB에 일일 로그 INSERT   (국가별 1행씩)
 *   2) Notion 리포트 페이지 생성       (전체 요약 + NEXON 현황)
 *   3) Slack 일일 요약 알림
 *   4) Slack NEXON 피쳐드 알림         (NEXON 있을 때만)
 *
 * Notion API: 넥슨 내부 PAT 프록시 경유
 *   Base URL : https://notion-pat-proxy.nexon.co.kr/v1
 *   Auth     : Bearer <PAT>
 *   Version  : 2025-09-03
 * ─────────────────────────────────────────────────
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");

/* ═══ 환경 변수 ═══ */
const NOTION_TOKEN          = process.env.NOTION_TOKEN          || "";
const NOTION_DB_ID          = process.env.NOTION_DB_ID          || "";
const NOTION_REPORT_PAGE_ID = process.env.NOTION_REPORT_PAGE_ID || "";
const SLACK_WEBHOOK_URL     = process.env.SLACK_WEBHOOK_URL     || "";

/* ═══ Notion PAT 프록시 설정 ═══ */
const NOTION_BASE  = "https://notion-pat-proxy.nexon.co.kr/v1";
const NOTION_VER   = "2025-09-03";

const COUNTRIES = ["KR", "TW", "JP", "US", "TH"];
const CC = { KR: "🇰🇷 한국", TW: "🇹🇼 대만", JP: "🇯🇵 일본", US: "🇺🇸 미국", TH: "🇹🇭 태국" };

const NX_DEVS = [
  "nexon","nexon company","nexon corporation","nexon korea","nexon korea corporation",
  "nexon games","neople","neople inc","toben studio","toben studio inc",
  "nexon gt","embark studios","nat games","mintrocket"
];
function isNexon(dev) {
  if (!dev) return false;
  const dl = dev.toLowerCase().trim();
  return NX_DEVS.some(nx => dl.includes(nx));
}

/* ═══════════════════════════════════════
   HTTP 헬퍼
   ═══════════════════════════════════════ */
async function notionAPI(endpoint, body) {
  const url = `${NOTION_BASE}${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VER,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`[Notion ${res.status}] ${endpoint}:`, JSON.stringify(data).slice(0, 300));
  }
  return { ok: res.ok, status: res.status, data };
}

async function notionGET(endpoint) {
  const url = `${NOTION_BASE}${endpoint}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VER
    }
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function slackPost(payload) {
  if (!SLACK_WEBHOOK_URL) { console.log("[Slack] No webhook URL, skipping"); return; }
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) console.error(`[Slack ${res.status}]`, await res.text());
  return res.ok;
}

/* ═══════════════════════════════════════
   1. 데이터 파싱 & 분석
   ═══════════════════════════════════════ */
function loadAndAnalyze() {
  const allNexon = [];
  const genreStats = {};
  const summaries = [];
  let totalApple = 0, totalGoogle = 0;

  for (const cc of COUNTRIES) {
    try {
      const raw = readFileSync(join(DATA_DIR, `${cc}.json`), "utf8");
      const d = JSON.parse(raw);

      const apple  = d.apple  || [];
      const google = d.google || [];
      totalApple  += apple.length;
      totalGoogle += google.length;

      const nxApple  = apple.filter(a => a.nexon || isNexon(a.dev));
      const nxGoogle = google.filter(a => a.nexon || isNexon(a.dev));
      nxApple.forEach(a  => allNexon.push({ ...a, country: cc, store: "apple" }));
      nxGoogle.forEach(a => allNexon.push({ ...a, country: cc, store: "google" }));

      const appleSet  = new Set(apple.map(a => (a.name || "").toLowerCase()));
      const googleSet = new Set(google.map(a => (a.name || "").toLowerCase()));
      const common = [...appleSet].filter(n => n && googleSet.has(n));

      summaries.push({
        cc, name: CC[cc] || cc,
        apple: apple.length, google: google.length,
        nxApple: nxApple.length, nxGoogle: nxGoogle.length,
        common: common.length,
        appleBanners: apple.filter(a => a.banner).length,
        googleBanners: google.filter(a => a.banner).length
      });

      [...apple, ...google].forEach(a => {
        if (a.genre) genreStats[a.genre] = (genreStats[a.genre] || 0) + 1;
      });
    } catch (e) {
      console.warn(`[Load] ${cc}:`, e.message);
      summaries.push({ cc, name: CC[cc] || cc, error: e.message });
    }
  }

  // NEXON 중복 제거
  const nexonMap = {};
  allNexon.forEach(a => {
    const key = (a.name || "").toLowerCase().replace(/[™:：\s]/g, "");
    if (!nexonMap[key]) nexonMap[key] = { ...a, countries: new Set(), stores: new Set() };
    nexonMap[key].countries.add(a.country);
    nexonMap[key].stores.add(a.store);
  });
  const nexonList = Object.values(nexonMap).map(a => ({
    name: a.name, dev: a.dev, rank: a.rank,
    countries: [...a.countries], stores: [...a.stores],
    banner: a.banner, genre: a.genre || "",
    bothStores: a.stores.size >= 2
  }));

  const topGenres = Object.entries(genreStats)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([genre, count]) => ({ genre, count }));

  return {
    date: new Date().toISOString().slice(0, 10),
    totalApple, totalGoogle, summaries, nexonList, topGenres, genreStats
  };
}

/* ═══════════════════════════════════════
   2. Notion DB: 국가별 일일 로그 INSERT
   ═══════════════════════════════════════ */
async function insertNotionDailyLogs(report) {
  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    console.log("[Notion DB] Token or DB ID missing, skipping");
    return;
  }
  console.log("[Notion DB] Inserting daily logs...");

  for (const s of report.summaries) {
    if (s.error) continue;

    const body = {
      parent: { database_id: NOTION_DB_ID },
      properties: {
        "제목": {
          title: [{ text: { content: `${s.name} ${report.date}` } }]
        },
        "날짜": {
          date: { start: report.date }
        },
        "국가": {
          select: { name: s.cc }
        },
        "Apple 수":   { number: s.apple },
        "Google 수":  { number: s.google },
        "NEXON(AS)":  { number: s.nxApple },
        "NEXON(GP)":  { number: s.nxGoogle },
        "공통 앱":    { number: s.common },
        "Apple 배너": { number: s.appleBanners },
        "Google 배너":{ number: s.googleBanners }
      }
    };

    const res = await notionAPI("/pages", body);
    console.log(`  ${res.ok ? "✅" : "❌"} ${s.cc} (${res.status})`);
    await sleep(350);
  }
}

/* ═══════════════════════════════════════
   3. Notion 리포트 페이지 생성
   ═══════════════════════════════════════ */
async function createNotionReport(report) {
  if (!NOTION_TOKEN || !NOTION_REPORT_PAGE_ID) {
    console.log("[Notion Report] Token or Page ID missing, skipping");
    return;
  }
  console.log("[Notion Report] Creating trend report page...");

  const children = [];

  // ── 국가별 현황 ──
  children.push(heading2("📊 국가별 현황"));
  for (const s of report.summaries.filter(s => !s.error)) {
    children.push(paragraph(
      `${s.name}  —  AS ${s.apple}개 (배너 ${s.appleBanners}) / GP ${s.google}개 (배너 ${s.googleBanners}) / 공통 ${s.common} / NX: AS ${s.nxApple} GP ${s.nxGoogle}`
    ));
  }

  // ── NEXON 현황 ──
  children.push(heading2(`🎯 NEXON 피쳐드 현황 (${report.nexonList.length}개)`));
  if (report.nexonList.length > 0) {
    for (const n of report.nexonList) {
      const storeTag = n.stores.map(s => s === "apple" ? "🍎AS" : "🟢GP").join(" ");
      const flags = n.countries.map(c => ({ KR:"🇰🇷",TW:"🇹🇼",JP:"🇯🇵",US:"🇺🇸",TH:"🇹🇭" }[c] || c)).join(" ");
      const tags = [];
      if (n.banner) tags.push("🔥배너");
      if (n.bothStores) tags.push("⚡양쪽");
      children.push(paragraph(`${n.name}  —  ${storeTag} | ${flags} | #${n.rank} ${tags.join(" ")}`));
    }
  } else {
    children.push(paragraph("피쳐드 없음"));
  }

  // ── 장르 분포 ──
  children.push(heading2("📈 장르 분포 Top 5"));
  for (const g of report.topGenres) {
    children.push(paragraph(`${g.genre}: ${g.count}개`));
  }

  // ── 하단 ──
  children.push(divider());
  children.push(paragraph(`전체: Apple ${report.totalApple}개 / Google Play ${report.totalGoogle}개`));
  children.push(
    bookmarkBlock("https://store-featured-dash.netlify.app")
  );

  const body = {
    parent: { page_id: NOTION_REPORT_PAGE_ID },
    properties: {
      title: [{ text: { content: `📈 피쳐드 리포트 ${report.date}` } }]
    },
    icon: { emoji: "📈" },
    children
  };

  const res = await notionAPI("/pages", body);
  console.log(`  ${res.ok ? "✅" : "❌"} Report page (${res.status})`);
}

/* ═══ Notion Block 헬퍼 ═══ */
function heading2(text) {
  return { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: text } }] } };
}
function paragraph(text) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: text } }] } };
}
function divider() {
  return { object: "block", type: "divider", divider: {} };
}
function bookmarkBlock(url) {
  return { object: "block", type: "bookmark", bookmark: { url } };
}

/* ═══════════════════════════════════════
   4. Slack 일일 요약
   ═══════════════════════════════════════ */
async function sendSlackDailySummary(report) {
  console.log("[Slack] Sending daily summary...");

  const topGenre = report.topGenres[0]?.genre || "-";
  const countryLines = report.summaries
    .filter(s => !s.error)
    .map(s => `${s.name}  AS ${s.apple} / GP ${s.google} / NX ${s.nxApple + s.nxGoogle}`)
    .join("\n");

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `📊 일일 피쳐드 요약 (${report.date})`, emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🍎 App Store: *${report.totalApple}*개  |  🟢 Google Play: *${report.totalGoogle}*개\n🎯 NEXON: *${report.nexonList.length}*개  |  🏆 Top 장르: *${topGenre}*\n\n${countryLines}`
      }
    },
    {
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "📊 대시보드 열기", emoji: true },
        url: "https://store-featured-dash.netlify.app"
      }]
    }
  ];

  await slackPost({ blocks });
}

/* ═══════════════════════════════════════
   5. Slack NEXON 피쳐드 알림 (조건부)
   ═══════════════════════════════════════ */
async function sendSlackNexonAlert(report) {
  if (report.nexonList.length === 0) {
    console.log("[Slack NEXON] No NEXON titles, skipping");
    return;
  }

  console.log(`[Slack NEXON] Alerting for ${report.nexonList.length} titles...`);

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `🎮 NEXON 피쳐드 알림 (${report.date})`, emoji: true }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${report.nexonList.length}개 NEXON 타이틀*이 스토어 피쳐드에 등장했습니다` }
    },
    { type: "divider" }
  ];

  for (const n of report.nexonList) {
    const storeEmoji = n.stores.map(s => s === "apple" ? "🍎" : "🟢").join(" ");
    const flags = n.countries.map(c => ({ KR:"🇰🇷",TW:"🇹🇼",JP:"🇯🇵",US:"🇺🇸",TH:"🇹🇭" }[c] || c)).join(" ");
    const tags = [];
    if (n.banner) tags.push("🔥 배너");
    if (n.bothStores) tags.push("⚡ 양쪽 피쳐드");

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${n.name}* ${storeEmoji}\n순위: #${n.rank} | 장르: ${n.genre || "-"} | ${flags}${tags.length ? "\n" + tags.join(" · ") : ""}`
      }
    });
  }

  blocks.push(
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `📊 전체: Apple ${report.totalApple} | Google ${report.totalGoogle}` },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "대시보드 열기", emoji: true },
        url: "https://store-featured-dash.netlify.app"
      }
    }
  );

  await slackPost({ blocks });
}

/* ═══════════════════════════════════════
   Main
   ═══════════════════════════════════════ */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("📋 Store Featured Reporter\n");

  // Notion 연결 테스트
  if (NOTION_TOKEN) {
    console.log("[Notion] Testing PAT proxy connection...");
    const me = await notionGET("/users/me");
    if (me.ok) console.log(`  ✅ Connected as: ${me.data.name || me.data.id}`);
    else console.warn(`  ⚠️ Auth test failed (${me.status}), will try reporting anyway`);
  }

  // 1. 데이터 파싱
  const report = loadAndAnalyze();
  console.log(`\n📅 ${report.date}`);
  console.log(`   Apple: ${report.totalApple}, Google: ${report.totalGoogle}`);
  console.log(`   NEXON: ${report.nexonList.length}개`);
  console.log(`   Top 장르: ${report.topGenres.map(g => g.genre).join(", ")}\n`);

  // 2. Notion DB 일일 로그
  await insertNotionDailyLogs(report);

  // 3. Notion 트렌드 리포트 페이지
  await createNotionReport(report);

  // 4. Slack 일일 요약
  await sendSlackDailySummary(report);

  // 5. Slack NEXON 알림
  await sendSlackNexonAlert(report);

  console.log("\n✅ Report complete!");
}

main().catch(e => {
  console.error("❌ Report failed:", e);
  slackPost({ text: `❌ 피쳐드 리포트 실패: ${e.message}` }).catch(() => {});
  process.exit(1);
});

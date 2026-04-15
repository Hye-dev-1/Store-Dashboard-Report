import puppeteer from "puppeteer";
import gplayPkg from "google-play-scraper";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const gplay = gplayPkg.default || gplayPkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

const COUNTRIES = {
  KR: { cc: "kr", name: "한국", hl: "ko", gl: "KR" },
  TW: { cc: "tw", name: "대만", hl: "zh-TW", gl: "TW" },
  JP: { cc: "jp", name: "일본", hl: "ja", gl: "JP" },
  US: { cc: "us", name: "미국", hl: "en", gl: "US" },
  TH: { cc: "th", name: "태국", hl: "th", gl: "TH" }
};

const GM = {
  "action":"액션","role playing":"RPG","role-playing":"RPG","rpg":"RPG","strategy":"전략",
  "puzzle":"퍼즐","casual":"캐주얼","simulation":"시뮬레이션","adventure":"어드벤처",
  "sports":"스포츠","card":"카드","board":"카드","music":"리듬","racing":"액션","arcade":"액션",
  "trivia":"퍼즐","word":"퍼즐","family":"캐주얼","indie":"어드벤처",
  "롤플레잉":"RPG","전략":"전략","퍼즐":"퍼즐","캐주얼":"캐주얼","액션":"액션",
  "시뮬레이션":"시뮬레이션","어드벤처":"어드벤처","스포츠":"스포츠","카드":"카드","보드":"카드",
  "음악":"리듬","레이싱":"액션","아케이드":"액션",
  "mmorpg":"RPG","action rpg":"RPG","moba":"전략","tower defense":"전략",
  "battle royale":"액션","shooter":"액션","fighting":"액션",
  "match 3":"퍼즐","idle":"캐주얼","merge":"캐주얼",
  "tycoon":"시뮬레이션","sandbox":"시뮬레이션","open world":"어드벤처",
  "survival":"어드벤처","tcg":"카드","rhythm":"리듬",
  "games":"캐주얼","entertainment":"캐주얼"
};
const toG = (r) => {
  if (!r) return "";
  const l = r.toLowerCase().trim();
  return GM[l] || GM[l.split(/[\/,&·\-]/)[0].trim()] || r;
};

const NX_DEVS = [
  "nexon","nexon company","nexon corporation","nexon korea","nexon korea corporation",
  "nexon games","neople","neople inc","toben studio","toben studio inc",
  "nexon gt","embark studios","nat games","mintrocket"
];
const isNexon = (dev) => {
  if (!dev) return false;
  const dl = dev.toLowerCase().trim();
  return NX_DEVS.some(nx => dl.includes(nx));
};

/* ═══ 게임 카테고리 판별 키워드 ═══ */
const GAME_GENRE_KW = [
  "games","game","action","adventure","arcade","board","card","casual","puzzle",
  "racing","role playing","simulation","sports","strategy","trivia","word",
  "게임","액션","어드벤처","퍼즐","캐주얼","전략","rpg","시뮬레이션","스포츠","카드","리듬",
  "アクション","アドベンチャー","パズル","カジュアル","ストラテジー","ロールプレイ","シミュレーション","スポーツ","カード","レーシング","ボード",
  "เกม","กลยุทธ์","ผจญภัย","ปริศนา","จำลอง","กีฬา"
];

/* Today 탭 예외 앱 (게임이 아니어도 포함) */
const TODAY_GAME_EXCEPTIONS = [
  "maplestory worlds","메이플스토리 월드","메이플스토리월드",
  "メイプルストーリーワールド","楓之谷世界"
];
function isTodayException(name) {
  if (!name) return false;
  const nl = name.toLowerCase().trim();
  return TODAY_GAME_EXCEPTIONS.some(ex => nl.includes(ex));
}

/* ═══ App Store 상세 페이지 → 개발사 + 장르 ═══ */
async function getAppDetail(page, url) {
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
    await page.waitForSelector('a[href*="/developer/"]', { timeout: 8000 }).catch(() => {});
    return await page.evaluate(() => {
      let dev = "", genre = "";
      const devLink = document.querySelector('a[href*="/developer/"]');
      if (devLink) dev = devLink.textContent.trim();
      if (!dev) {
        const dl = [...document.querySelectorAll("a")].find(a => (a.href||"").includes("/developer/") && a.textContent.trim().length > 1);
        if (dl) dev = dl.textContent.trim();
      }
      const genreLink = document.querySelector('a[href*="/genre/"]');
      if (genreLink) genre = genreLink.textContent.trim();
      if (!genre) {
        const gl = [...document.querySelectorAll("a")].find(a => (a.href||"").includes("/genre/") && a.textContent.trim().length > 1);
        if (gl) genre = gl.textContent.trim();
      }
      return { dev, genre };
    });
  } catch (e) { return { dev: "", genre: "" }; }
}

/* ═══ 상세 페이지에서 아이콘 보강 ═══ */
async function getAppIcon(page) {
  return await page.evaluate(() => {
    const imgs = document.querySelectorAll('.app-icon img, picture source[srcset*="mzstatic"]');
    for (const el of imgs) {
      const ss = el.getAttribute("srcset") || el.getAttribute("src") || "";
      const m = ss.match(/https:\/\/[^\s]*mzstatic\.com[^\s]*\d+x\d+[^\s]*/);
      if (m) return m[0];
    }
    return "";
  });
}

/* ═══════════════════════════════════════
   App Store Games 탭 추출
   ═══════════════════════════════════════ */
async function extractGamesTab(page) {
  return await page.evaluate(() => {
    const apps = [];
    const seen = new Set();
    function getIcon(container) {
      if (!container) return "";
      const img1 = container.querySelector('img[src*="mzstatic"]');
      if (img1) return img1.getAttribute("src");
      const img2 = container.querySelector("img[srcset]");
      if (img2) { const m = (img2.getAttribute("srcset")||"").match(/https:\/\/[^\s]*mzstatic[^\s]*/); if (m) return m[0]; }
      const src = container.querySelector("source[srcset*='mzstatic']");
      if (src) { const m = (src.getAttribute("srcset")||"").match(/https:\/\/[^\s]*mzstatic[^\s]*/); if (m) return m[0]; }
      return "";
    }
    const heroLinks = document.querySelectorAll('a[href*="/app/"]');
    heroLinks.forEach(el => {
      const href = el.getAttribute("href") || "";
      if (!href.includes("/app/")) return;
      const hero = el.querySelector('[data-test-id="hero"]');
      if (!hero) return;
      let name = "";
      const h2 = el.querySelector("h2");
      if (h2) name = h2.textContent.trim();
      if (!name) name = el.getAttribute("aria-label")?.split(",")[0]?.trim() || "";
      if (!name || name.length < 2 || name.length > 40 || seen.has(name.toLowerCase())) return;
      const icon = getIcon(el.querySelector(".lockup-container, .app-icon"));
      const eyebrowEl = el.querySelector(".eyebrow");
      const eyebrow = eyebrowEl ? eyebrowEl.textContent.trim() : "";
      seen.add(name.toLowerCase());
      apps.push({ name, icon, url: href.startsWith("http") ? href : "https://apps.apple.com" + href, isBanner: true, eyebrow });
    });
    const allLinks = document.querySelectorAll('a[href*="/app/"]');
    allLinks.forEach(el => {
      const href = el.getAttribute("href") || "";
      if (!href.includes("/app/") || href.includes("/story/")) return;
      let name = "";
      const h3 = el.querySelector("h3");
      if (h3) name = h3.textContent.trim();
      if (!name) name = el.getAttribute("aria-label") || "";
      if (!name || name.length < 2 || name.length > 40 || seen.has(name.toLowerCase())) return;
      const icon = getIcon(el);
      seen.add(name.toLowerCase());
      apps.push({ name, icon, url: href.startsWith("http") ? href : "https://apps.apple.com" + href, isBanner: false, eyebrow: "" });
    });
    return apps;
  });
}

/* ═══════════════════════════════════════
   App Store Today 탭 추출
   ═══════════════════════════════════════ */
async function extractTodayTab(page) {
  return await page.evaluate(() => {
    const apps = [];
    const seen = new Set();
    function getIcon(container) {
      if (!container) return "";
      const img1 = container.querySelector('img[src*="mzstatic"]');
      if (img1) return img1.getAttribute("src");
      const img2 = container.querySelector("img[srcset]");
      if (img2) { const m = (img2.getAttribute("srcset")||"").match(/https:\/\/[^\s]*mzstatic[^\s]*/); if (m) return m[0]; }
      const src = container.querySelector("source[srcset*='mzstatic']");
      if (src) { const m = (src.getAttribute("srcset")||"").match(/https:\/\/[^\s]*mzstatic[^\s]*/); if (m) return m[0]; }
      return "";
    }
    const lockupLinks = document.querySelectorAll('.small-lockup-item a[href*="/app/"]');
    lockupLinks.forEach(el => {
      const href = el.getAttribute("href") || "";
      if (!href.includes("/app/")) return;
      const name = el.getAttribute("aria-label") || "";
      if (!name || name.length < 2 || name.length > 40 || seen.has(name.toLowerCase())) return;
      const icon = getIcon(el.closest(".small-lockup-item"));
      seen.add(name.toLowerCase());
      apps.push({ name, icon, url: href.startsWith("http") ? href : "https://apps.apple.com" + href, isBanner: true });
    });
    const allLinks = document.querySelectorAll('a[href*="/app/"]');
    allLinks.forEach(el => {
      const href = el.getAttribute("href") || "";
      if (!href.includes("/app/") || href.includes("/story/")) return;
      let name = "";
      const h3 = el.querySelector("h3");
      if (h3) name = h3.textContent.trim();
      if (!name) name = el.getAttribute("aria-label") || "";
      if (!name || name.length < 2 || name.length > 40 || seen.has(name.toLowerCase())) return;
      const icon = getIcon(el);
      seen.add(name.toLowerCase());
      apps.push({ name, icon, url: href.startsWith("http") ? href : "https://apps.apple.com" + href, isBanner: false });
    });
    return apps;
  });
}

/* ═══════════════════════════════════════
   Google Play 배너 크롤링 (Puppeteer)
   셀렉터: .ULeU3b 컨테이너
     .fkdIre → 앱 이름
     .bcLwIe → 개발사
     .nnW2Md → 아이콘 (img)
     .GnAUad → 배지
   ═══════════════════════════════════════ */
async function extractGPBanner(page) {
  return await page.evaluate(() => {
    const apps = [];
    const seen = new Set();
    const cards = document.querySelectorAll(".ULeU3b");
    cards.forEach(card => {
      const nameEl = card.querySelector(".fkdIre");
      const devEl = card.querySelector(".bcLwIe");
      const iconEl = card.querySelector(".nnW2Md");
      const badgeEl = card.querySelector(".GnAUad");

      const name = nameEl ? nameEl.textContent.trim() : "";
      if (!name || name.length < 2 || name.length > 60 || seen.has(name.toLowerCase())) return;

      const dev = devEl ? devEl.textContent.trim() : "";
      let icon = "";
      if (iconEl) {
        icon = iconEl.getAttribute("src") || "";
        if (!icon) {
          const srcset = iconEl.getAttribute("srcset") || "";
          if (srcset) icon = srcset.split(" ")[0];
        }
      }
      const badge = badgeEl ? badgeEl.textContent.trim() : "";

      let url = "";
      const link = card.closest("a") || card.querySelector("a");
      if (link) {
        const href = link.getAttribute("href") || "";
        if (href.includes("/store/apps/details")) {
          url = href.startsWith("http") ? href : "https://play.google.com" + href;
        }
      }
      // 링크가 없으면 부모 탐색
      if (!url) {
        let parent = card.parentElement;
        for (let depth = 0; depth < 5 && parent; depth++) {
          if (parent.tagName === "A") {
            const href = parent.getAttribute("href") || "";
            if (href.includes("/store/apps/details")) {
              url = href.startsWith("http") ? href : "https://play.google.com" + href;
            }
            break;
          }
          parent = parent.parentElement;
        }
      }

      seen.add(name.toLowerCase());
      apps.push({ name, dev, icon, url, badge, isBanner: true });
    });
    return apps;
  });
}

/* Google Play 일반 피쳐드 앱 추출 */
async function extractGPFeatured(page) {
  return await page.evaluate(() => {
    const apps = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/store/apps/details"]');
    links.forEach(el => {
      const href = el.getAttribute("href") || "";
      if (!href.includes("/store/apps/details")) return;

      let name = "";
      const nameEl = el.querySelector(".WsMG1c") || el.querySelector(".ubGTjb") || el.querySelector(".DdYX5") || el.querySelector(".Epkrse");
      if (nameEl) name = nameEl.textContent.trim();
      if (!name) {
        const ariaLabel = el.getAttribute("aria-label") || "";
        if (ariaLabel) name = ariaLabel;
      }
      if (!name || name.length < 2 || name.length > 60 || seen.has(name.toLowerCase())) return;

      let icon = "";
      const iconEl = el.querySelector("img");
      if (iconEl) icon = iconEl.getAttribute("src") || "";

      let dev = "";
      const devEl = el.querySelector(".b8cIId") || el.querySelector(".KoLSrc");
      if (devEl) dev = devEl.textContent.trim();

      const url = href.startsWith("http") ? href : "https://play.google.com" + href;
      seen.add(name.toLowerCase());
      apps.push({ name, dev, icon, url, isBanner: false });
    });
    return apps;
  });
}

/* ═══════════════════════════════════════
   Google Play 크롤링 메인
   ═══════════════════════════════════════ */
async function crawlGooglePlay(page, cc, hl) {
  const allApps = [];
  const seen = new Set();

  try {
    console.log(`  [GP Games]`);
    const gpUrl = `https://play.google.com/store/games?hl=${hl}&gl=${cc.toUpperCase()}`;
    await page.goto(gpUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await autoScroll(page, 5000);

    const bannerApps = await extractGPBanner(page);
    const featuredApps = await extractGPFeatured(page);
    console.log(`    GP banners: ${bannerApps.length}, featured: ${featuredApps.length}`);

    bannerApps.forEach((app, i) => {
      if (seen.has(app.name.toLowerCase())) return;
      seen.add(app.name.toLowerCase());
      allApps.push({
        name: app.name, dev: app.dev, icon: app.icon, url: app.url,
        tab: "Featured", section: "배너", priority: i + 1,
        genre: "", rating: 0, category: "Games",
        nexon: isNexon(app.dev), banner: true, badge: app.badge || ""
      });
    });

    featuredApps.forEach((app, i) => {
      if (seen.has(app.name.toLowerCase())) return;
      seen.add(app.name.toLowerCase());
      allApps.push({
        name: app.name, dev: app.dev, icon: app.icon, url: app.url,
        tab: "Featured", section: "Featured", priority: 20 + i,
        genre: "", rating: 0, category: "Games",
        nexon: isNexon(app.dev), banner: false
      });
    });
  } catch (e) { console.warn(`  [GP Games Error]`, e.message); }

  try {
    console.log(`  [GP Top Charts]`);
    const topUrl = `https://play.google.com/store/games?hl=${hl}&gl=${cc.toUpperCase()}&tab=topCharts`;
    await page.goto(topUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await autoScroll(page, 3000);
    const topApps = await extractGPFeatured(page);
    console.log(`    GP top charts: ${topApps.length}`);

    topApps.forEach((app, i) => {
      if (seen.has(app.name.toLowerCase())) return;
      seen.add(app.name.toLowerCase());
      allApps.push({
        name: app.name, dev: app.dev, icon: app.icon, url: app.url,
        tab: "Featured", section: "Top Charts", priority: 100 + i,
        genre: "", rating: 0, category: "Games",
        nexon: isNexon(app.dev), banner: false
      });
    });
  } catch (e) { console.warn(`  [GP Top Error]`, e.message); }

  // ─── scraper 폴백: Puppeteer 결과 0개면 scraper로 수집 ───
  if (allApps.length === 0) {
    console.log(`  [GP Scraper Fallback]`);
    try {
      const [topFree, grossing] = await Promise.allSettled([
        gplay.list({ collection: gplay.collection.TOP_FREE, category: gplay.category.GAME, num: 30, country: cc.toUpperCase(), lang: hl, fullDetail: false }),
        gplay.list({ collection: gplay.collection.GROSSING, category: gplay.category.GAME, num: 20, country: cc.toUpperCase(), lang: hl, fullDetail: false })
      ]);
      if (topFree.status === "fulfilled") {
        topFree.value.forEach((app, i) => {
          const name = app.title || "";
          if (!name || name.length < 2 || seen.has(name.toLowerCase())) return;
          seen.add(name.toLowerCase());
          allApps.push({
            name, dev: app.developer || "", icon: app.icon || "",
            url: app.url || `https://play.google.com/store/apps/details?id=${app.appId}&hl=${hl}`,
            tab: "Featured", section: i < 3 ? "배너" : "Top Free Games", priority: i + 1,
            genre: toG(app.genre || ""), rating: app.score ? parseFloat(app.score.toFixed(1)) : 0,
            category: "Games", nexon: isNexon(app.developer), banner: i < 3
          });
        });
      }
      if (grossing.status === "fulfilled") {
        grossing.value.forEach((app, i) => {
          const name = app.title || "";
          if (!name || name.length < 2 || seen.has(name.toLowerCase())) return;
          seen.add(name.toLowerCase());
          allApps.push({
            name, dev: app.developer || "", icon: app.icon || "",
            url: app.url || `https://play.google.com/store/apps/details?id=${app.appId}&hl=${hl}`,
            tab: "Featured", section: "Top Grossing", priority: 100 + i,
            genre: toG(app.genre || ""), rating: app.score ? parseFloat(app.score.toFixed(1)) : 0,
            category: "Games", nexon: isNexon(app.developer), banner: false
          });
        });
      }
      console.log(`    Scraper fallback: ${allApps.length} apps`);
    } catch (e) { console.warn(`  [GP Scraper Fallback Error]`, e.message); }
  }

  // ─── scraper 보강: 장르/평점 누락 앱 보강 ───
  const needEnrich = allApps.filter(a => !a.genre || !a.rating);
  if (needEnrich.length > 0) {
    console.log(`  [GP Enrich] ${needEnrich.length} apps need genre/rating...`);
    for (const app of needEnrich.slice(0, 15)) {
      try {
        const idMatch = (app.url || "").match(/id=([^&]+)/);
        if (!idMatch) continue;
        const detail = await gplay.app({ appId: idMatch[1], lang: hl, country: cc.toUpperCase() });
        if (detail) {
          if (!app.genre && detail.genre) app.genre = toG(detail.genre);
          if (!app.rating && detail.score) app.rating = parseFloat(detail.score.toFixed(1));
          if (!app.dev && detail.developer) { app.dev = detail.developer; app.nexon = isNexon(detail.developer); }
          if (!app.icon && detail.icon) app.icon = detail.icon;
        }
      } catch (e) { /* 개별 실패 무시 */ }
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`    Enriched ${needEnrich.slice(0, 15).filter(a => a.genre).length} apps`);
  }

  allApps.sort((a, b) => a.priority - b.priority);
  allApps.forEach((a, i) => a.rank = i + 1);
  console.log(`  → GP: ${allApps.length} total, ${allApps.filter(a=>a.banner).length} banners, ${allApps.filter(a=>a.nexon).length} NEXON`);
  return allApps;
}

/* ═══ Apple Store 크롤링 메인 ═══ */
async function crawlAppleStore(page, cc) {
  const allApps = [];
  const seen = new Set();

  // ─── Games 탭 ───
  try {
    console.log(`  [Games Tab]`);
    await page.goto(`https://apps.apple.com/${cc}/iphone/games`, { waitUntil: "networkidle2", timeout: 30000 });
    await autoScroll(page, 5000);
    const gamesApps = await extractGamesTab(page);
    const banners = gamesApps.filter(a => a.isBanner);
    const cards = gamesApps.filter(a => !a.isBanner);
    console.log(`    ${banners.length} banners, ${cards.length} cards`);

    banners.forEach((app, i) => {
      if (seen.has(app.name.toLowerCase())) return;
      seen.add(app.name.toLowerCase());
      allApps.push({
        name: app.name, dev: "", icon: app.icon, url: app.url,
        tab: "Games", section: "배너", priority: i + 1,
        genre: "", rating: 0, category: "Games",
        nexon: false, banner: true
      });
    });
    cards.forEach((app, i) => {
      if (seen.has(app.name.toLowerCase())) return;
      seen.add(app.name.toLowerCase());
      allApps.push({
        name: app.name, dev: "", icon: app.icon, url: app.url,
        tab: "Games", section: "Featured", priority: 20 + i,
        genre: "", rating: 0, category: "Games",
        nexon: false, banner: false
      });
    });
  } catch (e) { console.warn(`  [Games Error]`, e.message); }

  // ─── Today 탭 (게임만, MapleStory Worlds 예외) ───
  try {
    console.log(`  [Today Tab]`);
    await page.goto(`https://apps.apple.com/${cc}/iphone/today`, { waitUntil: "networkidle2", timeout: 30000 });
    await autoScroll(page, 5000);
    const todayApps = await extractTodayTab(page);
    const banners = todayApps.filter(a => a.isBanner);
    const cards = todayApps.filter(a => !a.isBanner);
    console.log(`    ${banners.length} banners, ${cards.length} cards (pre-filter)`);

    banners.forEach((app, i) => {
      if (seen.has(app.name.toLowerCase())) return;
      seen.add(app.name.toLowerCase());
      allApps.push({
        name: app.name, dev: "", icon: app.icon, url: app.url,
        tab: "Today", section: "배너", priority: 50 + i,
        genre: "", rating: 0, category: "Games",
        nexon: false, banner: true,
        _todayPending: true
      });
    });
    cards.forEach((app, i) => {
      if (seen.has(app.name.toLowerCase())) return;
      seen.add(app.name.toLowerCase());
      allApps.push({
        name: app.name, dev: "", icon: app.icon, url: app.url,
        tab: "Today", section: "Featured", priority: 70 + i,
        genre: "", rating: 0, category: "Games",
        nexon: false, banner: false,
        _todayPending: true
      });
    });
  } catch (e) { console.warn(`  [Today Error]`, e.message); }

  // ─── 상세 페이지: 개발사 + 장르 + 아이콘 보강 ───
  const n = Math.min(allApps.length, 40);
  console.log(`  [Detail] ${n} apps...`);
  for (let i = 0; i < n; i++) {
    const app = allApps[i];
    if (!app.url) continue;
    const d = await getAppDetail(page, app.url);
    if (d.dev) { app.dev = d.dev; app.nexon = isNexon(d.dev); }
    if (d.genre) app.genre = toG(d.genre);
    if (!app.icon || app.icon.includes("1x1.gif") || !app.icon.includes("mzstatic")) {
      const fallbackIcon = await getAppIcon(page);
      if (fallbackIcon) app.icon = fallbackIcon;
    }
    if (i % 5 === 0 && i > 0) console.log(`    ${i}/${n}`);
    await new Promise(r => setTimeout(r, 300));
  }

  // ─── Today 탭 게임 필터링 ───
  const beforeFilter = allApps.length;
  const filtered = allApps.filter(app => {
    if (!app._todayPending) return true;

    // MapleStory Worlds 예외 허용
    if (isTodayException(app.name)) {
      delete app._todayPending;
      return true;
    }
    // 넥슨 타이틀이면 무조건 포함
    if (app.nexon) {
      delete app._todayPending;
      return true;
    }

    const genre = (app.genre || "").toLowerCase();
    const isGame = GAME_GENRE_KW.some(kw => genre.includes(kw));
    const urlHasGame = (app.url || "").toLowerCase().includes("/game");

    if (isGame || urlHasGame) {
      delete app._todayPending;
      return true;
    }

    console.log(`    [Today Filter] Removed: "${app.name}" (genre: "${app.genre}")`);
    return false;
  });

  filtered.forEach(app => delete app._todayPending);
  console.log(`  [Today Filter] ${beforeFilter} → ${filtered.length} (removed ${beforeFilter - filtered.length} non-game apps)`);

  filtered.sort((a, b) => a.priority - b.priority);
  filtered.forEach((a, i) => a.rank = i + 1);
  console.log(`  → Apple: ${filtered.length} total, ${filtered.filter(a=>a.banner).length} banners, ${filtered.filter(a=>a.nexon).length} NEXON`);
  return filtered;
}

async function autoScroll(page, maxHeight = 3000) {
  await page.evaluate(async (mh) => {
    await new Promise(r => {
      let h = 0;
      const t = setInterval(() => { window.scrollBy(0, 400); h += 400; if (h >= mh) { clearInterval(t); r(); } }, 200);
    });
  }, maxHeight);
  await new Promise(r => setTimeout(r, 2000));
}

async function main() {
  console.log("🚀 Store Featured Crawler (Apple + Google Play)\n");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  for (const [code, cfg] of Object.entries(COUNTRIES)) {
    console.log(`📱 ${code} (${cfg.name})`);

    // ─── Apple Store ───
    let appleApps = [];
    const applePage = await browser.newPage();
    await applePage.setViewport({ width: 1280, height: 900 });
    await applePage.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
    try {
      appleApps = await crawlAppleStore(applePage, cfg.cc);
    } catch (e) { console.error(`  ❌ Apple ${code}:`, e.message); }
    await applePage.close();

    // ─── Google Play ───
    let googleApps = [];
    const gpPage = await browser.newPage();
    await gpPage.setViewport({ width: 1280, height: 900 });
    await gpPage.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
    try {
      googleApps = await crawlGooglePlay(gpPage, cfg.cc, cfg.hl);
    } catch (e) { console.error(`  ❌ GP ${code}:`, e.message); }
    await gpPage.close();

    // ─── 저장: apple + google 필드 ───
    writeFileSync(join(DATA_DIR, `${code}.json`), JSON.stringify({
      country: code,
      date: new Date().toISOString().slice(0, 10),
      updated: new Date().toISOString(),
      apple: appleApps,
      google: googleApps
    }, null, 2));
    console.log(`  ✅ Saved (Apple: ${appleApps.length}, GP: ${googleApps.length})\n`);
  }

  await browser.close();
  console.log("🏁 Done!");
}

main().catch(e => { console.error(e); process.exit(1); });

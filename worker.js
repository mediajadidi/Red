/**
 * ==========================================================================
 *  Livescore API Gateway — Cloudflare Worker
 * ==========================================================================
 *  پروکسی امن جلوی دو سرویس:
 *    1) apiv3.apifootball.com   (نتایج، جدول، لیگ‌ها، اخبار ...)
 *    2) scorebat.com Video API  (هایلایت بازی‌ها — فید رایگان)
 *  کلیدها فقط داخل ورکر (Secret) نگه داشته می‌شوند و به مرورگر نمی‌رسند.
 *
 *  راه‌اندازی پایه:
 *    wrangler login
 *    wrangler secret put API_FOOTBALL_KEY     ← کلید apifootball
 *    wrangler secret put SCOREBAT_TOKEN       ← توکن Scorebat (از تب «دسترسی»)
 *    wrangler deploy
 *
 *  ============================================================
 *  راه‌اندازی فهرست کامل لیگ‌ها/تورنمنت‌ها (مهم — بخوانید)
 *  ============================================================
 *  طبق مستندات رسمی apiv3.apifootball.com:
 *    «GET ?action=get_countries» و «GET ?action=get_leagues» هر دو فقط
 *    چیزهایی را برمی‌گردانند که «در پلن فعلی اشتراک شما» است. یعنی اگر
 *    بوندسلیگا/لالیگا/لیگ برتر انگلیس یا لیگ برتر ایران در خروجی نیست،
 *    یا آن پلن اشتراک apifootball آن‌ها را ندارد (باید از حساب کاربری
 *    apifootball بررسی/ارتقا کنید)، یا (مورد رایج‌تر) فراخوانی بدون
 *    country_id به‌صورت پیش‌فرض فهرست کاملی برنمی‌گرداند.
 *
 *  برای رفع نقص دوم، این ورکر به‌جای یک فراخوانی get_leagues بدون
 *  country_id، «تمام کشورهای پلن» را از get_countries می‌گیرد و برای
 *  هر کدام جداگانه get_leagues&country_id=X را صدا می‌زند و همه را
 *  با هم ادغام می‌کند — این دقیقاً همان روشی است که خود مستندات
 *  apifootball مثال می‌زند (get_leagues&country_id=6 برای اسپانیا و ...).
 *
 *  مشکل: پلن رایگان Cloudflare Workers هر «درخواست» را به ۵۰ ساب‌ریکوئست
 *  محدود می‌کند؛ تعداد کشورهای فعال در apifootball معمولاً بیش از این
 *  عدد است، پس نمی‌شود همه را در یک درخواست HTTP جارو کرد. راه‌حل:
 *
 *    ۱) یک Cron Trigger هر چند دقیقه یک‌بار («scheduled» در پایین فایل)
 *       فقط یک دسته (Batch) از کشورها (پیش‌فرض ۳۵ تا) را می‌خواند و در
 *       Workers KV ذخیره می‌کند؛ در تیک بعدی از همان‌جا ادامه می‌دهد.
 *       بعد از چند تیک، «همهٔ» کشورها یک‌بار پیمایش می‌شوند و یک عکس
 *       نهایی کامل در KV منتشر می‌شود (catalog:leagues / catalog:tournaments).
 *    ۲) اگر KV هنوز وصل نشده باشد، ورکر به‌صورت خودکار یک نسخهٔ «جزئی»
 *       (اولین ۴۰ کشور) را در همان درخواست می‌سازد تا سایت از روز اول کار
 *       کند — ولی برای فهرست کامل و دقیق، باید KV را طبق راهنمای زیر
 *       فعال کنید.
 *
 *  مراحل فعال‌سازی KV + Cron:
 *    wrangler kv namespace create LEAGUES_KV
 *    # آی‌دی خروجی را در wrangler.toml این‌طور اضافه کنید:
 *    #   [[kv_namespaces]]
 *    #   binding = "LEAGUES_KV"
 *    #   id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
 *    #
 *    #   [triggers]
 *    #   crons = ["star/20 star star star star"]   ← الگوی هر ۲۰ دقیقه (کاراکتر ستاره را
 *    #   به‌جای «star» بگذارید؛ اینجا برای این‌که کامنت به‌اشتباه بسته نشود نوشته نشده)
 *    wrangler deploy
 *  بعد از فعال شدن Cron، ظرف حدود ۱ تا ۲ ساعت (بسته به تعداد کشورهای
 *  پلن شما) اولین پیمایش کامل تمام می‌شود و /api/leagues و /api/tournaments
 *  از آن پس فهرست کامل و به‌روز را می‌دهند (هر پیمایش کامل بعدی هم
 *  خودکار دوباره شروع می‌شود تا لیگ‌های تازه/فصل جدید هم دیده شوند).
 *
 *  مسیرهای جدید:
 *    /api/leagues        (بدون country_id) → فهرست کامل لیگ‌های داخلی هر کشور
 *    /api/leagues?country_id=X              → فقط لیگ‌های همان کشور (سریع)
 *    /api/tournaments     → تورنمنت‌های قاره‌ای/بین‌المللی (لیگ قهرمانان
 *                            اروپا/آسیا/آفریقا، جام‌های ملی قاره‌ای و ...)
 *    /api/highlights      → Scorebat free-feed
 *
 *  بقیهٔ مسیرها مثل قبل: countries, teams, players, standings, matches,
 *  live, lineups, statistics, odds, h2h, predictions, topscorers, videos,
 *  news, health
 * ==========================================================================
 */

const UPSTREAM_BASE = 'https://apiv3.apifootball.com/';
const SCOREBAT_FREE_FEED = 'https://www.scorebat.com/video-api/v3/free-feed/';

const ROUTES = {
  countries:   { action: 'get_countries',   allow: [] },
  leagues:     { action: 'get_leagues',     allow: ['country_id'] },
  teams:       { action: 'get_teams',       allow: ['league_id', 'team_id'] },
  players:     { action: 'get_players',     allow: ['player_id', 'player_name'] },
  standings:   { action: 'get_standings',   allow: ['league_id'] },
  matches:     { action: 'get_events',      allow: ['from', 'to', 'league_id', 'country_id', 'match_id', 'team_id', 'match_live', 'timezone', 'withPlayerStats'] },
  lineups:     { action: 'get_lineups',     allow: ['match_id'] },
  statistics:  { action: 'get_statistics',  allow: ['match_id'] },
  odds:        { action: 'get_odds',        allow: ['from', 'to', 'match_id'] },
  h2h:         { action: 'get_H2H',         allow: ['firstTeam', 'secondTeam', 'firstTeamId', 'secondTeamId', 'timezone'] },
  predictions: { action: 'get_predictions', allow: ['from', 'to', 'country_id', 'league_id', 'match_id'] },
  topscorers:  { action: 'get_topscorers',  allow: ['league_id'] },
  videos:      { action: 'get_videos',      allow: ['match_id'] },
  news:        { action: 'get_news',        allow: ['from', 'to'] },
};

const CACHE_TTL = {
  live: 25, matches: 45, standings: 1800, topscorers: 1800, leagues: 21600,
  countries: 86400, teams: 21600, players: 21600, lineups: 60, statistics: 60,
  odds: 120, h2h: 3600, predictions: 1800, videos: 600, news: 900,
  highlights: 300, // فید رایگان Scorebat؛ ۵ دقیقه کافی است
  catalog: 21600,  // فهرست کامل لیگ‌ها/تورنمنت‌ها؛ ۶ ساعت (Cron خودش تازه نگه می‌دارد)
  default: 60,
};

// ---------------------- تشخیص «تورنمنت قاره‌ای/بین‌المللی» ----------------------
// apifootball خودش این‌ها را به‌صورت «کشورهای مجازی» برمی‌گرداند، مثلاً:
//   country_name: "Eurocups"  →  لیگ قهرمانان اروپا، لیگ اروپا، یورو و ...
// این الگوها بر اساس نام همین «کشورهای مجازی» تشخیص می‌دهند، نه بر اساس
// شناسهٔ عددی ثابت (چون شناسه‌ها بسته به پلن حساب هر کاربر فرق می‌کند).
const CONTINENTAL_PATTERNS = [
  /^world$/i, /^international/i, /friendl/i, /clubs?\s*friendly/i,
  /eurocups?/i, /^europe$/i, /^uefa\b/i,
  /^asia$/i, /^afc\b/i, /^asian\b/i,
  /^africa$/i, /^caf\b/i, /^african\b/i,
  /^north[\s-]*america/i, /^concacaf\b/i, /^central[\s-]*america/i, /^caribbean/i,
  /^south[\s-]*america/i, /^conmebol\b/i, /copa[\s-]*am[ée]rica/i, /libertadores/i, /sudamericana/i,
  /^oceania$/i, /^ofc\b/i,
];
function isContinental(countryName) {
  const n = (countryName || '').trim();
  if (!n) return false;
  return CONTINENTAL_PATTERNS.some((rx) => rx.test(n));
}

function corsHeaders(env, request) {
  const allowedOrigin = env.ALLOWED_ORIGIN || '*';
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allowedOrigin === '*') {
    headers['Access-Control-Allow-Origin'] = '*';
  } else {
    const list = allowedOrigin.split(',').map(s => s.trim());
    headers['Access-Control-Allow-Origin'] = (origin && list.includes(origin)) ? origin : list[0];
  }
  return headers;
}

function jsonResponse(data, status, env, request, cacheSeconds) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
    ...corsHeaders(env, request),
  };
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(message, status, env, request) {
  return jsonResponse({ error: true, message }, status, env, request, 0);
}

// کش لبه‌ی Cloudflare با کلیدی که توکن/کلید داخلش نیست
async function cachedJson(cacheKeyUrl, ttl, ctx, producer) {
  const cache = caches.default;
  const key = new Request(cacheKeyUrl, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return { data: await hit.json(), fromCache: true };

  const data = await producer(); // اگر خطا بدهد به بالا پرتاب می‌شود
  const res = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
  });
  ctx.waitUntil(cache.put(key, res));
  return { data, fromCache: false };
}

// ---------------------- Scorebat (Highlights) ----------------------
async function handleHighlights(env, request, ctx) {
  if (!env.SCOREBAT_TOKEN) {
    return errorResponse('SCOREBAT_TOKEN تنظیم نشده است (wrangler secret put SCOREBAT_TOKEN)', 500, env, request);
  }
  const ttl = CACHE_TTL.highlights;
  try {
    const { data } = await cachedJson('https://cache.internal/scorebat/free-feed', ttl, ctx, async () => {
      const res = await fetch(`${SCOREBAT_FREE_FEED}?token=${encodeURIComponent(env.SCOREBAT_TOKEN)}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) throw new Error(`Scorebat HTTP ${res.status}`);
      const json = await res.json();
      // فرمت v3: { response: [ {title, competition, thumbnail, date, matchviewUrl, videos:[{title, embed}]} ] }
      const list = Array.isArray(json) ? json : json && json.response;
      if (!Array.isArray(list)) throw new Error('ساختار پاسخ Scorebat نامعتبر است (توکن را چک کنید)');
      return list;
    });
    return jsonResponse(data, 200, env, request, ttl);
  } catch (err) {
    return errorResponse(`Scorebat: ${err.message}`, 502, env, request);
  }
}

// ---------------------- apifootball: مسیرهای عمومی (پاس‌گذر ساده) ----------------------
async function handleRoute(routeName, url, env, request, ctx) {
  const route = ROUTES[routeName];
  if (!route) return errorResponse(`مسیر ناشناخته: ${routeName}`, 404, env, request);
  if (!env.API_FOOTBALL_KEY) {
    return errorResponse('API_FOOTBALL_KEY تنظیم نشده است (wrangler secret put API_FOOTBALL_KEY)', 500, env, request);
  }

  const ttl = CACHE_TTL[routeName] || CACHE_TTL.default;

  // پارامترهای سفیدلیست‌شده
  const params = new URLSearchParams();
  params.set('action', route.action);
  for (const key of route.allow) {
    const val = url.searchParams.get(key);
    if (val !== null && val !== '') params.set(key, val);
  }
  // کلید کش بدون APIkey ساخته می‌شود تا کلید هرگز داخل کش/لاگ نرود
  const cacheKeyUrl = `https://cache.internal/apifootball?${params.toString()}`;

  try {
    const { data } = await cachedJson(cacheKeyUrl, ttl, ctx, async () => {
      const upstream = new URL(UPSTREAM_BASE);
      params.forEach((v, k) => upstream.searchParams.set(k, v));
      upstream.searchParams.set('APIkey', env.API_FOOTBALL_KEY);
      const res = await fetch(upstream.toString(), { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // apifootball گاهی خطا را به‌صورت {"error": N, "message": "..."} برمی‌گرداند
      if (json && !Array.isArray(json) && json.error) throw new Error(json.message || 'خطای نامشخص');
      return json;
    });
    return jsonResponse(data, 200, env, request, ttl);
  } catch (err) {
    return errorResponse(`apifootball.com: ${err.message}`, 502, env, request);
  }
}

// ---------------------- apifootball: فهرست کامل کشورها/لیگ‌ها ----------------------
async function fetchCountries(env) {
  const u = new URL(UPSTREAM_BASE);
  u.searchParams.set('action', 'get_countries');
  u.searchParams.set('APIkey', env.API_FOOTBALL_KEY);
  const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} (get_countries)`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('پاسخ get_countries نامعتبر است (کلید API را بررسی کنید)');
  return j;
}

async function fetchLeaguesForCountry(env, countryId) {
  const u = new URL(UPSTREAM_BASE);
  u.searchParams.set('action', 'get_leagues');
  u.searchParams.set('country_id', countryId);
  u.searchParams.set('APIkey', env.API_FOOTBALL_KEY);
  try {
    const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch (e) {
    return []; // یک کشور مشکل‌دار نباید کل پیمایش را متوقف کند
  }
}

const CATALOG_CONCURRENCY = 6; // سقف «اتصال هم‌زمان» پلن رایگان Workers هم همین ۶ است
const CATALOG_BATCH_ON_DEMAND = 40; // زیر سقف ۵۰ ساب‌ریکوئست پلن رایگان (۱ برای get_countries + ≤۴۰)
const CATALOG_BATCH_PER_TICK = 35;  // اندازهٔ هر Batch در Cron (همان دلیل بالا، با کمی حاشیهٔ امن‌تر)

function mergeLeagueLists(countries, leagueLists) {
  const leagues = {};
  const tournaments = {};
  leagueLists.forEach((list) => {
    list.forEach((l) => {
      if (!l || !l.league_id) return;
      (isContinental(l.country_name) ? tournaments : leagues)[l.league_id] = l;
    });
  });
  return { leagues: Object.values(leagues), tournaments: Object.values(tournaments) };
}

// نسخهٔ «آنی و جزئی»: وقتی KV هنوز وصل/پر نشده، تا سقف امن ۵۰ ساب‌ریکوئست
// همان لحظه چند ده کشور اول را جمع می‌کند تا سایت خالی نماند.
async function onDemandPartialCatalog(env) {
  const countries = await fetchCountries(env);
  const slice = countries.slice(0, CATALOG_BATCH_ON_DEMAND);
  const lists = [];
  for (let i = 0; i < slice.length; i += CATALOG_CONCURRENCY) {
    const chunk = slice.slice(i, i + CATALOG_CONCURRENCY);
    const results = await Promise.all(chunk.map((c) => fetchLeaguesForCountry(env, c.country_id)));
    lists.push(...results);
  }
  const merged = mergeLeagueLists(slice, lists);
  return {
    ...merged,
    partial: countries.length > slice.length,
    totalCountries: countries.length,
    coveredCountries: slice.length,
    builtAt: Date.now(),
  };
}

// یک «گام» از پیمایش پس‌زمینه (از Cron صدا زده می‌شود). هر بار یک Batch از
// کشورها را می‌خواند و روی نتیجهٔ قبلی در KV اضافه می‌کند؛ وقتی همهٔ کشورها
// تمام شدند، یک عکسِ نهایی کامل منتشر و دوباره از صفر شروع می‌شود (تا فصل‌ها/
// لیگ‌های تازه هم دیر یا زود دیده شوند).
async function runCatalogSweepStep(env) {
  if (!env.LEAGUES_KV) return { skipped: true, reason: 'LEAGUES_KV بایند نشده' };

  let countries = await env.LEAGUES_KV.get('catalog:countries', 'json');
  if (!Array.isArray(countries)) {
    countries = await fetchCountries(env);
    await env.LEAGUES_KV.put('catalog:countries', JSON.stringify(countries));
    await env.LEAGUES_KV.put('catalog:cursor', '0');
    await env.LEAGUES_KV.put('catalog:leagues_wip', JSON.stringify({}));
    await env.LEAGUES_KV.put('catalog:tournaments_wip', JSON.stringify({}));
  }

  const cursor = parseInt((await env.LEAGUES_KV.get('catalog:cursor')) || '0', 10);
  const leaguesWip = (await env.LEAGUES_KV.get('catalog:leagues_wip', 'json')) || {};
  const tournamentsWip = (await env.LEAGUES_KV.get('catalog:tournaments_wip', 'json')) || {};

  const slice = countries.slice(cursor, cursor + CATALOG_BATCH_PER_TICK);

  if (slice.length === 0) {
    // پیمایش کامل شد → عکس نهایی را منتشر کن و برای دور بعدی از صفر شروع کن
    await env.LEAGUES_KV.put('catalog:leagues', JSON.stringify(Object.values(leaguesWip)));
    await env.LEAGUES_KV.put('catalog:tournaments', JSON.stringify(Object.values(tournamentsWip)));
    await env.LEAGUES_KV.put('catalog:built_at', String(Date.now()));
    await env.LEAGUES_KV.delete('catalog:countries'); // تیک بعدی، لیست کشورها را دوباره تازه می‌گیرد
    return { done: true, leagues: Object.keys(leaguesWip).length, tournaments: Object.keys(tournamentsWip).length };
  }

  for (let i = 0; i < slice.length; i += CATALOG_CONCURRENCY) {
    const chunk = slice.slice(i, i + CATALOG_CONCURRENCY);
    const results = await Promise.all(chunk.map((c) => fetchLeaguesForCountry(env, c.country_id)));
    results.forEach((list) => list.forEach((l) => {
      if (!l || !l.league_id) return;
      (isContinental(l.country_name) ? tournamentsWip : leaguesWip)[l.league_id] = l;
    }));
  }

  await env.LEAGUES_KV.put('catalog:leagues_wip', JSON.stringify(leaguesWip));
  await env.LEAGUES_KV.put('catalog:tournaments_wip', JSON.stringify(tournamentsWip));
  await env.LEAGUES_KV.put('catalog:cursor', String(cursor + CATALOG_BATCH_PER_TICK));
  return { progress: `${cursor + slice.length}/${countries.length}` };
}

async function getCatalog(env, ctx) {
  if (env.LEAGUES_KV) {
    const leagues = await env.LEAGUES_KV.get('catalog:leagues', 'json');
    if (Array.isArray(leagues)) {
      const tournaments = await env.LEAGUES_KV.get('catalog:tournaments', 'json');
      const builtAt = await env.LEAGUES_KV.get('catalog:built_at');
      return {
        leagues,
        tournaments: Array.isArray(tournaments) ? tournaments : [],
        partial: false,
        builtAt: builtAt ? Number(builtAt) : null,
      };
    }
    // KV وصل است ولی هنوز هیچ پیمایش کاملی تمام نشده؛ یک گام را همین حالا هم بزن
    // (در کنار پاسخ جزئیِ آنی) تا کم‌کم KV پر شود.
    ctx.waitUntil(runCatalogSweepStep(env));
  }
  return await onDemandPartialCatalog(env);
}

async function handleLeaguesFull(env, request, ctx) {
  try {
    const { data } = await cachedJson('https://cache.internal/apifootball/catalog', CACHE_TTL.catalog, ctx, () => getCatalog(env, ctx));
    return jsonResponse(data.leagues, 200, env, request, CACHE_TTL.catalog);
  } catch (err) {
    return errorResponse(`apifootball.com (فهرست کامل لیگ‌ها): ${err.message}`, 502, env, request);
  }
}

async function handleTournaments(env, request, ctx) {
  try {
    const { data } = await cachedJson('https://cache.internal/apifootball/catalog', CACHE_TTL.catalog, ctx, () => getCatalog(env, ctx));
    return jsonResponse(data.tournaments, 200, env, request, CACHE_TTL.catalog);
  } catch (err) {
    return errorResponse(`apifootball.com (تورنمنت‌ها): ${err.message}`, 502, env, request);
  }
}

const pad2 = (n) => String(n).padStart(2, '0');
function todayISO() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }
    if (request.method !== 'GET') {
      return errorResponse('فقط متد GET پشتیبانی می‌شود', 405, env, request);
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api' || !parts[1]) {
      return errorResponse('مسیر معتبر نیست. نمونه: /api/matches?from=2026-09-19&to=2026-09-19', 404, env, request);
    }
    const routeName = parts[1].toLowerCase();

    if (routeName === 'health') {
      let catalogStatus = null;
      if (env.LEAGUES_KV) {
        const builtAt = await env.LEAGUES_KV.get('catalog:built_at');
        const cursor = await env.LEAGUES_KV.get('catalog:cursor');
        catalogStatus = { hasSnapshot: Boolean(builtAt), builtAt: builtAt ? Number(builtAt) : null, sweepCursor: cursor ? Number(cursor) : 0 };
      }
      return jsonResponse({
        ok: true,
        time: new Date().toISOString(),
        hasApiFootballKey: Boolean(env.API_FOOTBALL_KEY),
        hasScorebatToken: Boolean(env.SCOREBAT_TOKEN),
        hasLeaguesKV: Boolean(env.LEAGUES_KV),
        catalog: catalogStatus,
      }, 200, env, request, 0);
    }

    if (routeName === 'highlights') return handleHighlights(env, request, ctx);

    if (routeName === 'live') {
      const today = todayISO();
      const liveUrl = new URL(url.toString());
      liveUrl.searchParams.set('from', today);
      liveUrl.searchParams.set('to', today);
      liveUrl.searchParams.set('match_live', '1');
      return handleRoute('matches', liveUrl, env, request, ctx);
    }

    // /api/leagues بدون country_id → فهرست کامل (همهٔ کشورها، از KV یا جزئیِ آنی)
    // /api/leagues?country_id=X   → همان پاس‌گذر سریع قبلی، فقط برای یک کشور
    if (routeName === 'leagues' && !url.searchParams.get('country_id')) {
      return handleLeaguesFull(env, request, ctx);
    }
    if (routeName === 'tournaments') return handleTournaments(env, request, ctx);

    return handleRoute(routeName, url, env, request, ctx);
  },

  // Cron Trigger: هر تیک فقط یک Batch از کشورها را جارو می‌کند (به دلیل سقف
  // ۵۰ ساب‌ریکوئستِ پلن رایگان Workers). راه‌اندازی در wrangler.toml:
  //   [triggers]
  //   crons = ["star/20 star star star star"]  (به‌جای «star» کاراکتر * بگذارید)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCatalogSweepStep(env));
  },
};

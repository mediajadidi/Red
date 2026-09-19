/**
 * ==========================================================================
 *  Livescore API Gateway — Cloudflare Worker
 * ==========================================================================
 *  یک پروکسی امن جلوی apiv3.apifootball.com.
 *  کلید API هرگز به سمت کلاینت (مرورگر) فرستاده نمی‌شود؛ فقط داخل این
 *  ورکر، از یک Secret خوانده و به درخواست بالادستی اضافه می‌شود.
 *
 *  آدرس نهایی بعد از دیپلوی چیزی شبیه این خواهد بود:
 *    https://<worker-name>.<your-subdomain>.workers.dev/api/<route>
 *
 *  ---------------------------------------------------------------------
 *  راه‌اندازی سریع:
 *    1) wrangler login
 *    2) wrangler secret put API_FOOTBALL_KEY     ← کلید apifootball.com را وارد کنید
 *    3) wrangler deploy
 *    4) آدرس خروجی را در فایل livescore.html به‌جای مقدار API_GATEWAY بگذارید
 *  ---------------------------------------------------------------------
 *
 *  مسیرها (همه GET):
 *    /api/countries                              → get_countries
 *    /api/leagues        ?country_id=             → get_leagues
 *    /api/teams          ?league_id=|team_id=      → get_teams
 *    /api/players         ?player_id=|player_name=  → get_players
 *    /api/standings       ?league_id=              → get_standings
 *    /api/matches         ?from=&to=&league_id=&country_id=&match_id=&team_id=&match_live=&timezone= → get_events
 *    /api/live             (میانبر روی get_events با match_live=1 برای همان روز)
 *    /api/lineups          ?match_id=              → get_lineups
 *    /api/statistics       ?match_id=              → get_statistics
 *    /api/odds             ?from=&to=&match_id=     → get_odds
 *    /api/h2h              ?firstTeamId=&secondTeamId=  → get_H2H
 *    /api/predictions      ?from=&to=&league_id=&match_id=  → get_predictions
 *    /api/topscorers       ?league_id=             → get_topscorers
 *    /api/videos           ?match_id=              → get_videos
 *    /api/news             ?from=&to=              → get_news  (Premium plan only)
 *    /api/highlights                                → Scorebat free video-highlights feed (no key, no plan needed)
 *    /api/health            → وضعیت ورکر (بدون تماس با apifootball)
 * ==========================================================================
 */

const UPSTREAM_BASE = 'https://apiv3.apifootball.com/';
// Scorebat's free, no-key video-highlights feed (verified working with no auth
// headers in multiple independent examples). Used only for the /api/highlights
// route below — completely separate from apifootball and needs no API key.
const SCOREBAT_URL = 'https://www.scorebat.com/video-api/v3/';

// نگاشت مسیر ساده‌ی ما ← اکشن واقعی apifootball + پارامترهای مجاز عبوری
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

// مدت کش (ثانیه) بر اساس نوع داده — داده‌ی زنده کوتاه، داده‌ی ثابت بلند
const CACHE_TTL = {
  live: 25,
  matches: 45,
  standings: 1800,
  topscorers: 1800,
  leagues: 21600,
  countries: 86400,
  teams: 21600,
  players: 21600,
  lineups: 60,
  statistics: 60,
  odds: 120,
  h2h: 3600,
  predictions: 1800,
  videos: 600,
  news: 900,
  highlights: 600,
  default: 60,
};

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
    // پشتیبانی از چند دامنهٔ مجاز، جدا شده با کاما، در ALLOWED_ORIGIN
    const list = allowedOrigin.split(',').map(s => s.trim());
    headers['Access-Control-Allow-Origin'] = (origin && list.includes(origin)) ? origin : list[0];
  }
  return headers;
}

function jsonResponse(data, status, env, request, cacheSeconds) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(env, request),
  };
  if (cacheSeconds) {
    headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
  } else {
    headers['Cache-Control'] = 'no-store';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(message, status, env, request) {
  return jsonResponse({ error: true, message }, status, env, request, 0);
}

async function handleRoute(routeName, url, env, request) {
  const route = ROUTES[routeName];
  if (!route) {
    return errorResponse(`مسیر ناشناخته: ${routeName}`, 404, env, request);
  }
  if (!env.API_FOOTBALL_KEY) {
    return errorResponse('API_FOOTBALL_KEY روی این ورکر تنظیم نشده است (wrangler secret put API_FOOTBALL_KEY)', 500, env, request);
  }

  const upstream = new URL(UPSTREAM_BASE);
  upstream.searchParams.set('action', route.action);
  upstream.searchParams.set('APIkey', env.API_FOOTBALL_KEY);

  // فقط پارامترهای سفیدلیست‌شده برای هر مسیر را عبور بده
  for (const key of route.allow) {
    const val = url.searchParams.get(key);
    if (val !== null && val !== '') upstream.searchParams.set(key, val);
  }

  const cacheKey = new Request(upstream.toString(), { method: 'GET' });
  const cache = caches.default;
  let cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return jsonResponse(JSON.parse(body), 200, env, request, CACHE_TTL[routeName] || CACHE_TTL.default);
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream.toString(), {
      headers: { 'Accept': 'application/json' },
      cf: { cacheTtl: CACHE_TTL[routeName] || CACHE_TTL.default, cacheEverything: true },
    });
  } catch (err) {
    return errorResponse(`عدم دسترسی به apifootball.com: ${err.message}`, 502, env, request);
  }

  if (!upstreamRes.ok) {
    return errorResponse(`apifootball.com خطا برگرداند (HTTP ${upstreamRes.status})`, 502, env, request);
  }

  let data;
  try {
    data = await upstreamRes.json();
  } catch (err) {
    return errorResponse('پاسخ apifootball.com قابل‌تفسیر نبود (JSON نامعتبر)', 502, env, request);
  }

  // apifootball گاهی خطاها را به‌صورت {"error": N, "message": "..."} برمی‌گرداند نه آرایه
  if (data && !Array.isArray(data) && data.error) {
    return errorResponse(`apifootball.com: ${data.message || 'خطای نامشخص'}`, 502, env, request);
  }

  ctxWaitUntilCachePut(cacheKey, data, CACHE_TTL[routeName] || CACHE_TTL.default);
  return jsonResponse(data, 200, env, request, CACHE_TTL[routeName] || CACHE_TTL.default);
}

// نگه‌داشتن یک رفرنس سراسری برای ctx.waitUntil در fetch اصلی
let _ctx = null;
function ctxWaitUntilCachePut(cacheKey, data, ttl) {
  const cache = caches.default;
  const res = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
  });
  if (_ctx) _ctx.waitUntil(cache.put(cacheKey, res));
}

function pad2(n) { return String(n).padStart(2, '0'); }
function todayISO() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Scorebat needs no key and no action= param — just fetch its public feed
// and pass it through with our own CORS headers, cached like everything else.
async function handleHighlights(env, request) {
  const cacheKey = new Request(SCOREBAT_URL, { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return jsonResponse(JSON.parse(body), 200, env, request, CACHE_TTL.highlights);
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(SCOREBAT_URL, {
      headers: { 'Accept': 'application/json' },
      cf: { cacheTtl: CACHE_TTL.highlights, cacheEverything: true },
    });
  } catch (err) {
    return errorResponse(`عدم دسترسی به scorebat.com: ${err.message}`, 502, env, request);
  }
  if (!upstreamRes.ok) {
    return errorResponse(`scorebat.com خطا برگرداند (HTTP ${upstreamRes.status})`, 502, env, request);
  }
  let data;
  try {
    data = await upstreamRes.json();
  } catch (err) {
    return errorResponse('پاسخ scorebat.com قابل‌تفسیر نبود (JSON نامعتبر)', 502, env, request);
  }

  ctxWaitUntilCachePut(cacheKey, data, CACHE_TTL.highlights);
  return jsonResponse(data, 200, env, request, CACHE_TTL.highlights);
}

export default {
  async fetch(request, env, ctx) {
    _ctx = ctx;
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }
    if (request.method !== 'GET') {
      return errorResponse('فقط متد GET پشتیبانی می‌شود', 405, env, request);
    }

    // مسیرها باید با /api/ شروع شوند
    const parts = url.pathname.split('/').filter(Boolean); // ["api", "matches"]
    if (parts[0] !== 'api' || !parts[1]) {
      return errorResponse('مسیر معتبر نیست. نمونه: /api/matches?from=2026-09-18&to=2026-09-18', 404, env, request);
    }

    const routeName = parts[1].toLowerCase();

    if (routeName === 'health') {
      return jsonResponse({ ok: true, time: new Date().toISOString(), hasKey: Boolean(env.API_FOOTBALL_KEY) }, 200, env, request, 0);
    }

    if (routeName === 'highlights') {
      return handleHighlights(env, request);
    }

    if (routeName === 'live') {
      // میانبر: بازی‌های زنده‌ی امروز، بدون نیاز به from/to دستی در کلاینت
      const today = todayISO();
      const liveUrl = new URL(url.toString());
      liveUrl.searchParams.set('from', today);
      liveUrl.searchParams.set('to', today);
      liveUrl.searchParams.set('match_live', '1');
      return handleRoute('matches', liveUrl, env, request);
    }

    return handleRoute(routeName, url, env, request);
  },
};

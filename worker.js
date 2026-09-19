/**
 * ==========================================================================
 *  Livescore API Gateway — Cloudflare Worker
 * ==========================================================================
 *  پروکسی امن جلوی دو سرویس:
 *    1) apiv3.apifootball.com   (نتایج، جدول، لیگ‌ها، اخبار ...)
 *    2) scorebat.com Video API  (هایلایت بازی‌ها — فید رایگان)
 *  کلیدها فقط داخل ورکر (Secret) نگه داشته می‌شوند و به مرورگر نمی‌رسند.
 *
 *  راه‌اندازی:
 *    wrangler login
 *    wrangler secret put API_FOOTBALL_KEY     ← کلید apifootball
 *    wrangler secret put SCOREBAT_TOKEN       ← توکن Scorebat (از تب «دسترسی»)
 *    wrangler deploy
 *
 *  مسیر جدید:
 *    /api/highlights   → Scorebat free-feed  (خروجی: آرایه‌ی ساده‌ی مسابقات)
 *
 *  بقیهٔ مسیرها مثل قبل: countries, leagues, teams, players, standings,
 *  matches, live, lineups, statistics, odds, h2h, predictions, topscorers,
 *  videos, news, health
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

// ---------------------- apifootball ----------------------
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
      return jsonResponse({
        ok: true,
        time: new Date().toISOString(),
        hasApiFootballKey: Boolean(env.API_FOOTBALL_KEY),
        hasScorebatToken: Boolean(env.SCOREBAT_TOKEN),
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

    return handleRoute(routeName, url, env, request, ctx);
  },
};

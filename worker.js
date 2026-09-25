/**
 * دروازهٔ امن apifootball  (Cloudflare Worker)
 * ------------------------------------------------------------
 * - کلید API فقط اینجا نگه‌داری می‌شود:  wrangler secret put APIFOOTBALL_KEY
 * - مسیرها (همان مسیرهایی که index.html صدا می‌زند):
 *     /api/matches?from=&to=[&league_id=&country_id=&team_id=&match_id=&timezone=]   → get_events
 *     /api/live[?league_id=&country_id=&timezone=]                                    → get_events&match_live=1
 *     /api/matchdetail?match_id=                                                      → get_events&match_id= (شامل لاین‌آپ/آمار/گل/کارت)
 *     /api/standings?league_id=                                                       → get_standings
 *     /api/topscorers?league_id=                                                      → get_topscorers (+ تصاویر بازیکن/نشان تیم غنی‌سازی‌شده)
 *     /api/leaguestats?league_id=                                                     → get_teams(league_id=) که به فهرست تخت (flat) بازیکنانِ کل لیگ
 *                                                                                        تبدیل شده؛ منبع تب‌های «پاس‌گل» و «کارت‌ها» در فرانت (goals/
 *                                                                                        assists/yellow/red هر بازیکنِ کل روستر همهٔ تیم‌های لیگ، نه فقط
 *                                                                                        گلزن‌های برتر)
 *     /api/countries                                                                  → get_countries
 *     /api/leagues[?country_id=]                                                      → get_leagues
 *     /api/news?from=&to=[&league_id=&team_id=&match_id=]                             → get_news
 *     /api/teams?team_id=|league_id=                                                  → get_teams
 *     /api/players?player_id=|player_name=                                            → get_players
 *     /api/lineups?match_id=                                                          → get_lineups (سبک‌تر از matchdetail، برای رفرش)
 *     /api/statistics?match_id=                                                       → get_statistics (سبک‌تر از matchdetail، برای رفرش)
 *     /api/h2h?firstTeamId=&secondTeamId=                                             → get_H2H
 *     /api/predictions?match_id=|league_id=|from=&to=                                 → get_predictions
 *     /api/odds?match_id=|from=&to=                                                   → get_odds
 *     /api/liveodds?match_id=|league_id=|country_id=                                  → get_live_odds_commnets (شامل گزارش زندهٔ متنی)
 *     /api/videos?match_id=                                                           → get_videos
 *     /api/form?league_id=                                                            → get_events (۴۵ روز اخیر) که به نتایج جمع‌وجورِ بازی‌های تمام‌شده
 *                                                                                        تبدیل می‌شود؛ منبع «فرم ۵ بازی اخیر» در جدول لیگ (apifootball
 *                                                                                        در get_standings فیلد فرم ندارد و اکشن get_injuries هم ندارد)
 *     /api/highlights                                                                 → فید Scorebat
 * - پاسخ‌ها در کش لبهٔ Cloudflare نگه داشته می‌شوند تا سهمیهٔ API هدر نرود
 *   (کشورها/لیگ‌ها/تیم‌ها چند ساعت، لایو/جزئیات مسابقهٔ جاری چند ثانیه، ...).
 * - اختیاری: متغیر ALLOWED_ORIGINS (چند دامنه با کاما) برای محدودکردن CORS؛ اگر خالی باشد همه مجازند.
 *
 * توجه: برخی اکشن‌ها (get_news, get_H2H, get_predictions, get_odds,
 * get_live_odds_commnets) ممکن است روی پلن‌های بالاتر apifootball در دسترس
 * باشند؛ اگر اکانت شما به آن‌ها دسترسی ندارد، این مسیرها آرایهٔ خالی
 * برمی‌گردانند (نه خطا) و بخش مربوطه در فرانت به‌صورت خودکار «داده‌ای موجود
 * نیست» نشان می‌دهد.
 *
 * ─────────────────────────────────────────────────────────────
 * نکتهٔ مهم دربارهٔ تصاویر آقای‌گل‌ها (get_topscorers):
 * پاسخ رسمی این اکشن در APIv3 اصلاً فیلد player_image / team_badge ندارد
 * (فقط player_place, player_name, player_key, team_name, team_key, goals,
 * assists, penalty_goals). این تصاویر فقط داخل get_teams (پارامتر team_id)
 * زیر آرایهٔ players برمی‌گردند و با player_key به هم مرتبط می‌شوند.
 * به همین دلیل، مسیر /api/topscorers بعد از گرفتن پاسخ خام، روستر تیم‌های
 * یکتای همان لیست را (با کش جداگانه) می‌گیرد و player_image/team_badge را
 * به هر ردیف اضافه می‌کند تا فرانت (که همین دو فیلد را می‌خواند) بتواند
 * آواتارها را نشان دهد.
 * ─────────────────────────────────────────────────────────────
 * نکتهٔ مهم دربارهٔ تب‌های «پاس‌گل» و «کارت‌ها»:
 * apiv3.apifootball.com اکشن اختصاصی «top assists» یا «top cards» ندارد
 * (get_topscorers فقط تعداد محدودی گلزن برتر را برمی‌گرداند و فیلد کارت
 * اصلاً ندارد). اما get_teams با پارامتر league_id کل روستر همهٔ تیم‌های
 * آن لیگ را با آمار هر بازیکن (گل/پاس‌گل/کارت زرد/کارت قرمز/امتیاز) برمی‌گرداند.
 * مسیر /api/leaguestats همین پاسخ را می‌گیرد، فقط فیلدهای لازم را نگه
 * می‌دارد (flattenLeagueRoster) و یک فهرست تخت از همهٔ بازیکنان لیگ پس
 * می‌دهد؛ فرانت از روی همین یک پاسخِ کش‌شده، هم جدول پاس‌گل و هم جدول
 * کارت‌ها را می‌سازد (بدون فراخوانی اضافهٔ API بالادستی).
 * ─────────────────────────────────────────────────────────────
 */
const UPSTREAM = 'https://apiv3.apifootball.com/';
const SCOREBAT = 'https://www.scorebat.com/video-api/v3/';
const HOUR = 3600;

const ROUTES = {
  matches:     { action: 'get_events',           params: ['from', 'to', 'league_id', 'country_id', 'team_id', 'match_id', 'timezone'], need: ['from', 'to'], ttl: 30 },
  live:        { action: 'get_events',           params: ['league_id', 'country_id', 'timezone'], fixed: { match_live: '1' }, liveWindow: true, ttl: 15 },
  matchdetail: { action: 'get_events',           params: ['match_id', 'timezone'], need: ['match_id'], fixed: { withPlayerStats: '1' }, ttl: 20 },
  standings:   { action: 'get_standings',        params: ['league_id'], need: ['league_id'], ttl: 120 },
  topscorers:  { action: 'get_topscorers',       params: ['league_id'], need: ['league_id'], ttl: 600, enrichPlayerImages: true },
  leaguestats: { action: 'get_teams',            params: ['league_id'], need: ['league_id'], ttl: 3 * HOUR, flattenRoster: true },
  countries:   { action: 'get_countries',        params: [], ttl: 6 * HOUR },
  leagues:     { action: 'get_leagues',          params: ['country_id'], ttl: 6 * HOUR },
  news:        { action: 'get_news',             params: ['from', 'to', 'league_id', 'team_id', 'match_id'], need: ['from', 'to'], ttl: 300 },
  teams:       { action: 'get_teams',            params: ['team_id', 'league_id'], ttl: 3 * HOUR },
  players:     { action: 'get_players',          params: ['player_id', 'player_name'], ttl: 3 * HOUR },
  lineups:     { action: 'get_lineups',          params: ['match_id'], need: ['match_id'], ttl: 20 },
  statistics:  { action: 'get_statistics',       params: ['match_id'], need: ['match_id'], ttl: 20 },
  h2h:         { action: 'get_H2H',              params: ['firstTeamId', 'secondTeamId', 'timezone'], need: ['firstTeamId', 'secondTeamId'], ttl: HOUR },
  predictions: { action: 'get_predictions',      params: ['match_id', 'league_id', 'country_id', 'from', 'to'], ttl: 600 },
  odds:        { action: 'get_odds',             params: ['match_id', 'from', 'to'], ttl: 60 },
  liveodds:    { action: 'get_live_odds_commnets', params: ['match_id', 'league_id', 'country_id'], ttl: 15 },
  videos:      { action: 'get_videos',           params: ['match_id'], ttl: 600 },
  form:        { action: 'get_events',           params: ['league_id'], need: ['league_id'], pastDays: 45, compactResults: true, ttl: 600 },
  highlights:  { external: SCOREBAT, ttl: 300 },
};

// حروف یونیکد/اعداد/فاصله و چند نویسهٔ بی‌خطر — برای پارامترهایی مثل نام
// تیم/بازیکن که می‌توانند حروف لاتین غیرانگلیسی داشته باشند (مثل Alavés).
const SAFE_VALUE = /^[\p{L}\p{N}\s\-+:./,']{1,80}$/u;
const ymd = (d) => d.toISOString().slice(0, 10);

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allow = !allowed.length ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers) });

/**
 * روستر یک تیم را از get_teams می‌گیرد (فقط برای استخراج player_image و
 * team_badge) و آن را جدا از مسیرهای عمومی در کش لبه نگه می‌دارد تا هر
 * درخواست topscorers باعث فراخوانی مجدد API بالادستی نشود.
 */
async function getTeamRosterCached(teamId, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://internal.cache/team-roster?team_id=${encodeURIComponent(teamId)}`);
  const hit = await cache.match(cacheKey);
  if (hit) {
    try { return await hit.json(); } catch { /* fall through to refetch */ }
  }
  if (!env.APIFOOTBALL_KEY) return null;
  const target = new URL(UPSTREAM);
  target.searchParams.set('action', 'get_teams');
  target.searchParams.set('team_id', teamId);
  target.searchParams.set('APIkey', env.APIFOOTBALL_KEY);
  let data;
  try {
    const res = await fetch(target.toString(), { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  const toStore = Array.isArray(data) ? data : [];
  const resp = new Response(JSON.stringify(toStore), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${3 * HOUR}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return toStore;
}

/**
 * لیست خام get_topscorers را با player_image و team_badge از روستر تیم‌ها
 * غنی‌سازی می‌کند. اگر بازیکنی در روستر پیدا نشود (مثلاً به‌تازگی منتقل شده)
 * فیلدها null می‌مانند و فرانت خودش fallback خالی نشان می‌دهد.
 */
async function enrichTopscorers(list, env, ctx) {
  if (!Array.isArray(list) || !list.length) return list;

  const teamIds = [...new Set(list.map(p => p && p.team_key).filter(v => v !== undefined && v !== null && v !== ''))];
  if (!teamIds.length) return list;

  const rosters = await Promise.all(teamIds.map(id => getTeamRosterCached(id, env, ctx).catch(() => null)));

  const playerImageByKey = new Map();
  const teamBadgeByKey = new Map();
  rosters.forEach((teamArr, i) => {
    const team = Array.isArray(teamArr) ? teamArr[0] : null;
    if (!team) return;
    const tid = String(teamIds[i]);
    if (team.team_badge) teamBadgeByKey.set(tid, team.team_badge);
    (team.players || []).forEach(pl => {
      if (pl && pl.player_key != null && pl.player_image) {
        playerImageByKey.set(String(pl.player_key), pl.player_image);
      }
    });
  });

  return list.map(p => ({
    ...p,
    player_image: playerImageByKey.get(String(p.player_key)) || p.player_image || null,
    team_badge: teamBadgeByKey.get(String(p.team_key)) || p.team_badge || null,
  }));
}

/**
 * خروجی get_teams(league_id=) آرایه‌ای از تیم‌هاست که هرکدام آرایهٔ کامل
 * players (با ده‌ها فیلد: قد/وزن/مصدومیت/تاریخ تولد/...) دارند. این تابع
 * فقط فیلدهای لازم برای جدول‌های پاس‌گل/کارت‌های فرانت را نگه می‌دارد تا
 * حجم پاسخ (و ترافیک موبایل کاربر) کم بماند.
 */
function flattenLeagueRoster(teams) {
  if (!Array.isArray(teams)) return [];
  const out = [];
  teams.forEach(team => {
    if (!team) return;
    (team.players || []).forEach(p => {
      if (!p || !p.player_name) return;
      out.push({
        player_key: p.player_key,
        player_name: p.player_name,
        player_image: p.player_image || null,
        player_number: p.player_number || '',
        player_type: p.player_type || '',
        player_match_played: p.player_match_played || '0',
        player_goals: p.player_goals || '0',
        player_assists: p.player_assists || '0',
        player_yellow_cards: p.player_yellow_cards || '0',
        player_red_cards: p.player_red_cards || '0',
        player_rating: p.player_rating || '',
        team_key: team.team_key,
        team_name: team.team_name,
        team_badge: team.team_badge || null,
      });
    });
  });
  return out;
}

const FINISHED_STATUSES = ['Finished', 'After ET', 'After Pen.', 'Awarded'];

/**
 * get_events هر مسابقه را با ده‌ها فیلد (لاین‌آپ/آمار/گل/کارت/...) برمی‌گرداند؛ برای محاسبهٔ فرم
 * فقط نتیجهٔ بازی‌های تمام‌شده لازم است، پس به چند فیلد کوچک فشرده می‌شود.
 */
function compactResults(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(e => e && FINISHED_STATUSES.includes(e.match_status))
    .map(e => ({
      match_id: e.match_id,
      match_date: e.match_date,
      match_time: e.match_time,
      match_status: e.match_status,
      match_hometeam_id: e.match_hometeam_id,
      match_awayteam_id: e.match_awayteam_id,
      match_hometeam_score: e.match_hometeam_score,
      match_awayteam_score: e.match_awayteam_score,
    }));
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, cors);

    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/([a-z]+)\/?$/);
    const routeKey = m && m[1];
    const route = routeKey && ROUTES[routeKey];
    if (!route) return json({ error: 'not_found' }, 404, cors);

    // فقط پارامترهای مجاز و ایمن عبور می‌کنند
    const q = {};
    for (const k of (route.params || [])) {
      const v = url.searchParams.get(k);
      if (v !== null && v !== '') {
        if (!SAFE_VALUE.test(v)) return json({ error: 'bad_param', param: k }, 400, cors);
        q[k] = v;
      }
    }
    for (const k of (route.need || [])) if (!q[k]) return json({ error: 'missing_param', param: k }, 400, cors);

    // کش لبه
    const cache = caches.default;
    const cacheKey = new Request(url.origin + url.pathname + '?' + new URLSearchParams(q).toString(), { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { status: hit.status, headers: Object.assign({}, Object.fromEntries(hit.headers), cors) });

    let body, status = 200, ttl = route.ttl, note = '';
    try {
      let target;
      if (route.external) {
        target = new URL(route.external);
      } else {
        if (!env.APIFOOTBALL_KEY) return json({ error: 'server_not_configured' }, 500, cors);
        target = new URL(UPSTREAM);
        target.searchParams.set('action', route.action);
        Object.entries(Object.assign({}, route.fixed || {}, q)).forEach(([k, v]) => target.searchParams.set(k, v));
        if (route.liveWindow) {   // get_events به from/to نیاز دارد؛ بازهٔ کوچکِ اطراف امروز
          const now = new Date();
          target.searchParams.set('from', ymd(new Date(now.getTime() - 86400000)));
          target.searchParams.set('to', ymd(new Date(now.getTime() + 86400000)));
        } else if (route.pastDays) {   // بازهٔ گذشته تا امروز (برای محاسبهٔ فرم)
          const now = new Date();
          target.searchParams.set('from', ymd(new Date(now.getTime() - route.pastDays * 86400000)));
          target.searchParams.set('to', ymd(now));
        }
        target.searchParams.set('APIkey', env.APIFOOTBALL_KEY);
      }
      const res = await fetch(target.toString(), { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('upstream_' + res.status);
      const data = await res.json();
      if (data && !Array.isArray(data) && typeof data === 'object' && data.error !== undefined && !route.external) {
        // «داده‌ای یافت نشد» یا «این اکشن روی پلن شما نیست» → لیست خالی
        // (کد/پیام برای دیباگ در هدر X-Upstream-Message می‌ماند، نه در بدنه)
        note = String(data.message || data.error).slice(0, 120);
        body = '[]'; ttl = Math.min(ttl, 30);
      } else if (route.enrichPlayerImages && Array.isArray(data)) {
        // get_topscorers فیلد تصویر ندارد؛ از روستر تیم‌ها غنی‌سازی می‌شود.
        const enriched = await enrichTopscorers(data, env, ctx);
        body = JSON.stringify(enriched);
      } else if (route.compactResults && Array.isArray(data)) {
        body = JSON.stringify(compactResults(data));
      } else if (route.flattenRoster && Array.isArray(data)) {
        // get_teams(league_id=) → فهرست تخت بازیکنان کل لیگ (برای پاس‌گل/کارت‌ها)
        body = JSON.stringify(flattenLeagueRoster(data));
      } else {
        body = JSON.stringify(data);
      }
    } catch (err) {
      return json({ error: 'upstream_failed' }, 502, cors);
    }

    const out = new Response(body, {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${ttl}`,
        ...(note ? { 'X-Upstream-Message': note } : {}),
      },
    });
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return new Response(out.body, { status, headers: Object.assign({}, Object.fromEntries(out.headers), cors) });
  },
};

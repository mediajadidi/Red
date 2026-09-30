/**
 * دروازهٔ امن apifootball  (Cloudflare Worker)  +  لایهٔ ترجمهٔ ۸ زبانه
 * ══════════════════════════════════════════════════════════════════
 * این نسخه روی معماری اصلی شما (جدول ROUTES، کش لبه، enrichTopscorers،
 * flattenLeagueRoster و ...) دست نزده؛ فقط یک «لایهٔ ترجمه» روی خروجی
 * اضافه کرده. مستندات کامل مسیرها همان چیزی‌ست که در نسخهٔ قبلی داشتید.
 *
 * ── معماری ترجمه (۳ لایه، به ترتیب اولویت و هزینه) ──────────────────
 *   1) دیکشنری ایستا (COUNTRY_I18N / COMPETITION_I18N)
 *      صفر تأخیر، صفر هزینه، صفر وابستگی بیرونی، بالاترین کیفیت.
 *      برای ~۵۰ کشور و ~۱۵ رقابت پرتکرار از قبل نوشته شده؛ هر ردیف جدید
 *      که اضافه کنید، دیگر هرگز از MT عبور نمی‌کند.
 *   2) کش دائمی Cloudflare KV (Cache-First)
 *      برای نام تیم/بازیکن که تعدادشان زیاد ولی *متناهی* است. هر
 *      (متن, زبان) فقط یک‌بار در کل عمر سایت ترجمه می‌شود و برای همیشه
 *      در KV می‌ماند.
 *   3) فراخوانی MT (Google GTX، غیررسمی) فقط در Cache Miss واقعی.
 *
 * ── نکتهٔ صداقت مهندسی (لطفاً این را از کد پاک نکنید) ────────────────
 *   translate.googleapis.com/translate_a/single یک endpoint رسمی و
 *   مستندشدهٔ گوگل نیست؛ SLA ندارد و می‌تواند بدون اطلاع قبلی تغییر کند
 *   یا IP ورکر را موقتاً محدود کند. به همین دلیل این کد:
 *     - آن را فقط برای متن‌هایی که در KV نیستند صدا می‌زند (نه هر بار)،
 *     - حداکثر MT_MAX_SYNC مورد را هم‌زمان منتظر می‌ماند (زیر سقف
 *       Sub-request پلن رایگان Workers که ۵۰ است)،
 *     - Timeout کوتاه دارد و هرگز پاسخ نهایی کاربر را بلاک/خراب نمی‌کند؛
 *       در بدترین حالت، همان نام انگلیسی نمایش داده می‌شود.
 *   اگر لیگ/کشورهای پرتکرار سایت‌تان را به COUNTRY_I18N/COMPETITION_I18N
 *   اضافه کنید، عملاً هیچ‌وقت به این لایه نمی‌رسید.
 *
 * ── محدودیت واقع‌بینانهٔ «رایگان» (این را هم پاک نکنید) ──────────────
 *   Workers Free  = ۱۰۰,۰۰۰ درخواست/روز.
 *   KV Free       = ۱۰۰,۰۰۰ خواندن/روز، ۱,۰۰۰ نوشتن/روز، ۱GB ذخیره‌سازی.
 *   برای ترافیک واقعاً میلیونی روزانه باید روی پلن Workers Paid ($5/ماه،
 *   ۱۰ میلیون درخواست) بروید. با همین معماری (کش لبه + KV دائمی) هزینهٔ
 *   اضافه‌شده روی آن پلن ناچیز است، چون بیشتر پاسخ‌ها از Edge Cache
 *   می‌آیند و اصلاً به KV/MT نمی‌رسند.
 *
 * ── تنظیمات لازم قبل از Deploy ────────────────────────────────────
 *   1) یک KV Namespace به نام دلخواه بسازید و آن را با نام Binding
 *      دقیقاً  TRANSLATE_KV  به این Worker وصل کنید.
 *   2) (اختیاری) اگر می‌خواهید صد در صد به Google GTX متکی نباشید،
 *      تابع fetchMT را با یک provider دیگر (DeepL/LibreTranslate خودمیزبان)
 *      جایگزین کنید؛ بقیهٔ معماری (کش، دیکشنری ایستا، دسته‌بندی) بدون
 *      تغییر کار می‌کند.
 */

const UPSTREAM = 'https://apiv3.apifootball.com/';
const SCOREBAT = 'https://www.scorebat.com/video-api/v3/';
const HOUR = 3600;

/* ── تب «شبکه‌های پخش» ────────────────────────────────────────────────
 * apiv3.apifootball.com اطلاعات شبکهٔ پخش‌کننده ندارد؛ برای همین این تب
 * منحصراً از API عمومی و بدون‌کلید ESPN (site.api.espn.com) تغذیه می‌شود؛
 * هیچ داده‌ای از apifootball با آن قاطی نمی‌شود. برای افزودن لیگ جدید،
 * فقط یک ردیف با اسلاگ درست ESPN به این آرایه اضافه کنید.
 */
const ESPN_SOCCER_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/';
const BROADCAST_LEAGUES = [
  { slug: 'eng.1', country_name: 'England', league_name: 'Premier League' },
  { slug: 'eng.2', country_name: 'England', league_name: 'Championship' },
  { slug: 'eng.fa', country_name: 'England', league_name: 'FA Cup' },
  { slug: 'eng.league_cup', country_name: 'England', league_name: 'EFL Cup' },
  { slug: 'esp.1', country_name: 'Spain', league_name: 'La Liga' },
  { slug: 'esp.copa_del_rey', country_name: 'Spain', league_name: 'Copa del Rey' },
  { slug: 'ita.1', country_name: 'Italy', league_name: 'Serie A' },
  { slug: 'ita.coppa_italia', country_name: 'Italy', league_name: 'Coppa Italia' },
  { slug: 'ger.1', country_name: 'Germany', league_name: 'Bundesliga' },
  { slug: 'ger.dfb_pokal', country_name: 'Germany', league_name: 'DFB Pokal' },
  { slug: 'fra.1', country_name: 'France', league_name: 'Ligue 1' },
  { slug: 'ned.1', country_name: 'Netherlands', league_name: 'Eredivisie' },
  { slug: 'por.1', country_name: 'Portugal', league_name: 'Primeira Liga' },
  { slug: 'tur.1', country_name: 'Turkey', league_name: 'Süper Lig' },
  { slug: 'sco.1', country_name: 'Scotland', league_name: 'Scottish Premiership' },
  { slug: 'usa.1', country_name: 'USA', league_name: 'MLS' },
  { slug: 'mex.1', country_name: 'Mexico', league_name: 'Liga MX' },
  { slug: 'bra.1', country_name: 'Brazil', league_name: 'Brasileirão' },
  { slug: 'arg.1', country_name: 'Argentina', league_name: 'Liga Profesional' },
  { slug: 'ksa.1', country_name: 'Saudi Arabia', league_name: 'Saudi Pro League' },
  { slug: 'uefa.champions', country_name: 'World', league_name: 'UEFA Champions League' },
  { slug: 'uefa.europa', country_name: 'World', league_name: 'UEFA Europa League' },
  { slug: 'uefa.europa.conf', country_name: 'World', league_name: 'UEFA Europa Conference League' },
  { slug: 'uefa.nations', country_name: 'World', league_name: 'UEFA Nations League' },
  { slug: 'conmebol.libertadores', country_name: 'South America', league_name: 'Copa Libertadores' },
  { slug: 'conmebol.sudamericana', country_name: 'South America', league_name: 'Copa Sudamericana' },
  { slug: 'fifa.world', country_name: 'World', league_name: 'FIFA World Cup' },
  { slug: 'fifa.cwc', country_name: 'World', league_name: 'FIFA Club World Cup' },
  { slug: 'fifa.friendly', country_name: 'World', league_name: 'International Friendly' },
];

const ROUTES = {
  matches:     { action: 'get_events',           params: ['from', 'to', 'league_id', 'country_id', 'team_id', 'match_id', 'timezone'], need: ['from', 'to'], ttl: 30 },
  live:        { action: 'get_events',           params: ['league_id', 'country_id', 'timezone'], fixed: { match_live: '1' }, liveWindow: true, ttl: 15 },
  matchdetail: { action: 'get_events',           params: ['match_id', 'timezone'], need: ['match_id'], fixed: { withPlayerStats: '1' }, ttl: 20 },
  standings:   { action: 'get_standings',        params: ['league_id'], need: ['league_id'], ttl: 120 },
  // آرشیو فصل‌های گذشته: get_standings پارامتر فصل ندارد؛ جدول از نتایج get_events همان فصل محاسبه می‌شود. مسیر بالا دست‌نخورده است.
  standingsarchive: { action: 'get_events', params: ['league_id', 'season', 'archive'], need: ['league_id', 'season', 'archive'], ttl: 3600, custom: 'standingsarchive' },
  // topscorers / leaguestats: پارامتر season فقط داخلی است (به apifootball فرستاده نمی‌شود)
  // و برای «نگهبان فصل» (Season Guard) استفاده می‌شود؛ ttl عمداً کوتاه است.
  topscorers:  { action: 'get_topscorers',       params: ['league_id', 'season', 'archive'], need: ['league_id'], ttl: 300, custom: 'topscorers' },
  leaguestats: { action: 'get_teams',            params: ['league_id', 'season', 'archive'], need: ['league_id'], ttl: 900, custom: 'leaguestats' },
  // تب‌های جدید لیگ (فاز ۱) — season داخلی است و به apifootball فرستاده نمی‌شود
  cleansheets: { action: 'get_events', params: ['league_id', 'season', 'archive'], need: ['league_id'], ttl: 300, custom: 'cleansheets' },
  toprated:    { action: 'get_teams',  params: ['league_id', 'season'], need: ['league_id'], ttl: 900, custom: 'toprated' },
  overview:    { action: 'get_events', params: ['league_id', 'season', 'archive'], need: ['league_id'], ttl: 300, custom: 'overview' },
  bracket:     { action: 'get_events', params: ['league_id', 'season', 'archive'], need: ['league_id'], ttl: 300, custom: 'bracket' },
  // فاز ۲: مودال بازیکن/تیم
  playerlog:   { action: 'get_events', params: ['player_id', 'team_id', 'season'], need: ['player_id', 'team_id'], ttl: 600, custom: 'playerlog' },
  teamstats:   { action: 'get_events', params: ['team_id', 'season', 'timezone'], need: ['team_id'], ttl: 300, custom: 'teamstats' },
  // ۵ بازی اخیر لیگ برای ستون «فرم» جدول (قبلاً فرانت این مسیر را صدا می‌زد ولی در Worker وجود نداشت → 404)
  form:        { action: 'get_events',           params: ['league_id', 'timezone'], need: ['league_id'], custom: 'form', ttl: 600 },
  countries:   { action: 'get_countries',        params: [], ttl: 6 * HOUR },
  leagues:     { action: 'get_leagues',          params: ['country_id'], ttl: 6 * HOUR },
  news:        { action: 'get_news',             params: ['from', 'to', 'league_id', 'team_id', 'match_id'], need: ['from', 'to'], ttl: 300 },
  teams:       { action: 'get_teams',            params: ['team_id', 'league_id'], ttl: 3 * HOUR },
  players:     { action: 'get_players',          params: ['player_id', 'player_name'], ttl: 3 * HOUR },
  lineups:     { action: 'get_lineups',          params: ['match_id'], need: ['match_id'], ttl: 20, enrichLineupPhotos: true },
  statistics:  { action: 'get_statistics',       params: ['match_id'], need: ['match_id'], ttl: 20 },
  h2h:         { action: 'get_H2H',              params: ['firstTeamId', 'secondTeamId', 'firstTeam', 'secondTeam', 'timezone'], ttl: HOUR, custom: 'h2h' },
  predictions: { action: 'get_predictions',      params: ['match_id', 'league_id', 'country_id', 'from', 'to', 'match_date'], ttl: 600, custom: 'predictions' },
  odds:        { action: 'get_odds',             params: ['match_id', 'from', 'to'], ttl: 60 },
  liveodds:    { action: 'get_live_odds_commnets', params: ['match_id', 'league_id', 'country_id'], ttl: 15 },
  // نمودار فشار و جریان بازی زنده — سری زمانی ۵دقیقه‌ای از live_comments؛ خروجی نام تیم/بازیکن ندارد پس ترجمه/KV را لمس نمی‌کند
  momentum:    { action: 'get_live_odds_commnets', params: ['match_id'], need: ['match_id'], ttl: 15, custom: 'momentum', noTranslate: true },
  videos:      { action: 'get_videos',           params: ['match_id'], ttl: 600 },
  highlights:  { external: SCOREBAT, ttl: 300, noTranslate: true }, // فید Scorebat؛ ساختار متفاوت، ترجمه نمی‌شود
  // تب «شبکه‌های پخش» — منبع دادهٔ آن apifootball نیست، ESPN عمومی است (بدون کلید)
  broadcast:   { params: ['date'], ttl: 180, custom: 'broadcast' },
};

const SAFE_VALUE = /^[\p{L}\p{N}\s\-+:./,_']{1,80}$/u;
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

/* ════════════════════════════ لایهٔ ترجمه ════════════════════════════ */

// باید دقیقاً با SUPPORTED_LANGS فرانت‌اند یکی باشد
const SUPPORTED_LANGS = ['en', 'fa', 'fr', 'ar', 'de', 'ru', 'es', 'zh'];

// این کلیدها در هر عمقی از JSON پیدا شوند، ترجمه می‌شوند (مقدار اصلی
// دست‌نخورده می‌ماند؛ نتیجه در همان آبجکت با پسوند «_i18n» اضافه می‌شود
// تا منطق مرتب‌سازی/رتبه‌بندی/فیلتر فرانت که روی متن انگلیسی کار می‌کند
// هرگز نشکند).
const TRANSLATE_KEYS = new Set([
  'country_name', 'league_name', 'team_name',
  'match_hometeam_name', 'match_awayteam_name',
  'player_name', 'lineup_player',
  'home_scorer', 'away_scorer', 'home_assist', 'away_assist',
  'home_fault', 'away_fault',
]);

// apifootball اسم لیگ/تیم را معمولاً به زبان محلی همان کشور می‌دهد، نه
// انگلیسی (مثلاً «Segunda División»، «Novorizontino»). اگر به مدل ترجمه
// بگوییم همه‌چیز انگلیسی است، خروجی قاطی می‌شود (نمونه: «Primera C» که
// اسپانیایی است). این نگاشت، زبان مبدأ درست را از روی country_name همان
// آیتم حدس می‌زند تا ورودی درست به مدل داده شود.
const COUNTRY_SRC_LANG = {
  spain: 'es', argentina: 'es', mexico: 'es', peru: 'es', paraguay: 'es', chile: 'es', colombia: 'es',
  ecuador: 'es', bolivia: 'es', uruguay: 'es', venezuela: 'es', 'costa rica': 'es', honduras: 'es',
  panama: 'es', guatemala: 'es', 'el salvador': 'es', 'dominican republic': 'es',
  brazil: 'pt', portugal: 'pt',
  france: 'fr',
  germany: 'de', austria: 'de', switzerland: 'de',
  russia: 'ru',
  turkey: 'tr',
  italy: 'it',
  netherlands: 'nl',
  poland: 'pl',
  romania: 'ro',
  greece: 'el',
  sweden: 'sv', norway: 'no', denmark: 'da', finland: 'fi',
  hungary: 'hu', 'czech republic': 'cs', slovakia: 'sk',
  croatia: 'hr', serbia: 'sr', slovenia: 'sl', 'bosnia and herzegovina': 'bs', albania: 'sq', 'north macedonia': 'mk',
  bulgaria: 'bg', ukraine: 'uk', georgia: 'ka', armenia: 'hy', azerbaijan: 'az', kazakhstan: 'kk',
  iran: 'fa',
  'saudi arabia': 'ar', qatar: 'ar', 'united arab emirates': 'ar', uae: 'ar', iraq: 'ar', jordan: 'ar',
  kuwait: 'ar', bahrain: 'ar', oman: 'ar', lebanon: 'ar', egypt: 'ar', morocco: 'ar', algeria: 'ar', tunisia: 'ar',
  china: 'zh', japan: 'ja', 'south korea': 'ko', 'korea republic': 'ko',
  vietnam: 'vi', thailand: 'th', indonesia: 'id',
};
function srcLangFor(countryName) {
  return COUNTRY_SRC_LANG[normKey(countryName)] || 'en';
}

const normKey = (s) => String(s || '').trim().toLowerCase();
const NUMERIC_OR_EMPTY = /^[\s\d.,:/-]*$/;
const shouldTranslate = (v) => typeof v === 'string' && v.trim() !== '' && !NUMERIC_OR_EMPTY.test(v);
// کلید ترکیبی (زبان مبدأ + متن) برای Map/دیکشنری داخلی — یک متن با دو زبان
// مبدأ متفاوت (نادر، ولی ممکن) دو ترجمهٔ جداگانه می‌گیرد.
const srcTextKey = (src, text) => src + '\u0001' + normKey(text);

// ── دیکشنری ایستای کشورها (۷ زبان؛ انگلیسی خودِ کلید است) ──────────
// کلید = country_name خام API با حروف کوچک. هر کشور جدید که اضافه کنید،
// دیگر هرگز به MT نمی‌رسد.
const COUNTRY_I18N = {
  'england': { fa: 'انگلیس', fr: 'Angleterre', de: 'England', es: 'Inglaterra', ru: 'Англия', ar: 'إنجلترا', zh: '英格兰' },
  'spain': { fa: 'اسپانیا', fr: 'Espagne', de: 'Spanien', es: 'España', ru: 'Испания', ar: 'إسبانيا', zh: '西班牙' },
  'germany': { fa: 'آلمان', fr: 'Allemagne', de: 'Deutschland', es: 'Alemania', ru: 'Германия', ar: 'ألمانيا', zh: '德国' },
  'italy': { fa: 'ایتالیا', fr: 'Italie', de: 'Italien', es: 'Italia', ru: 'Италия', ar: 'إيطاليا', zh: '意大利' },
  'france': { fa: 'فرانسه', fr: 'France', de: 'Frankreich', es: 'Francia', ru: 'Франция', ar: 'فرنسا', zh: '法国' },
  'iran': { fa: 'ایران', fr: 'Iran', de: 'Iran', es: 'Irán', ru: 'Иран', ar: 'إيران', zh: '伊朗' },
  'netherlands': { fa: 'هلند', fr: 'Pays-Bas', de: 'Niederlande', es: 'Países Bajos', ru: 'Нидерланды', ar: 'هولندا', zh: '荷兰' },
  'portugal': { fa: 'پرتغال', fr: 'Portugal', de: 'Portugal', es: 'Portugal', ru: 'Португалия', ar: 'البرتغال', zh: '葡萄牙' },
  'turkey': { fa: 'ترکیه', fr: 'Turquie', de: 'Türkei', es: 'Turquía', ru: 'Турция', ar: 'تركيا', zh: '土耳其' },
  'saudi arabia': { fa: 'عربستان سعودی', fr: 'Arabie saoudite', de: 'Saudi-Arabien', es: 'Arabia Saudita', ru: 'Саудовская Аравия', ar: 'السعودية', zh: '沙特阿拉伯' },
  'brazil': { fa: 'برزیل', fr: 'Brésil', de: 'Brasilien', es: 'Brasil', ru: 'Бразилия', ar: 'البرازيل', zh: '巴西' },
  'argentina': { fa: 'آرژانتین', fr: 'Argentine', de: 'Argentinien', es: 'Argentina', ru: 'Аргентина', ar: 'الأرجنتين', zh: '阿根廷' },
  'usa': { fa: 'آمریکا', fr: 'États-Unis', de: 'USA', es: 'Estados Unidos', ru: 'США', ar: 'الولايات المتحدة', zh: '美国' },
  'scotland': { fa: 'اسکاتلند', fr: 'Écosse', de: 'Schottland', es: 'Escocia', ru: 'Шотландия', ar: 'اسكتلندا', zh: '苏格兰' },
  'belgium': { fa: 'بلژیک', fr: 'Belgique', de: 'Belgien', es: 'Bélgica', ru: 'Бельгия', ar: 'بلجيكا', zh: '比利时' },
  'russia': { fa: 'روسیه', fr: 'Russie', de: 'Russland', es: 'Rusia', ru: 'Россия', ar: 'روسيا', zh: '俄罗斯' },
  'japan': { fa: 'ژاپن', fr: 'Japon', de: 'Japan', es: 'Japón', ru: 'Япония', ar: 'اليابان', zh: '日本' },
  'qatar': { fa: 'قطر', fr: 'Qatar', de: 'Katar', es: 'Catar', ru: 'Катар', ar: 'قطر', zh: '卡塔尔' },
  'united arab emirates': { fa: 'امارات', fr: 'Émirats arabes unis', de: 'Vereinigte Arabische Emirate', es: 'Emiratos Árabes Unidos', ru: 'ОАЭ', ar: 'الإمارات', zh: '阿联酋' },
  'uae': { fa: 'امارات', fr: 'Émirats arabes unis', de: 'Vereinigte Arabische Emirate', es: 'Emiratos Árabes Unidos', ru: 'ОАЭ', ar: 'الإمارات', zh: '阿联酋' },
  'south korea': { fa: 'کره جنوبی', fr: 'Corée du Sud', de: 'Südkorea', es: 'Corea del Sur', ru: 'Южная Корея', ar: 'كوريا الجنوبية', zh: '韩国' },
  'korea republic': { fa: 'کره جنوبی', fr: 'Corée du Sud', de: 'Südkorea', es: 'Corea del Sur', ru: 'Южная Корея', ar: 'كوريا الجنوبية', zh: '韩国' },
  'china': { fa: 'چین', fr: 'Chine', de: 'China', es: 'China', ru: 'Китай', ar: 'الصين', zh: '中国' },
  'mexico': { fa: 'مکزیک', fr: 'Mexique', de: 'Mexiko', es: 'México', ru: 'Мексика', ar: 'المكسيك', zh: '墨西哥' },
  'iraq': { fa: 'عراق', fr: 'Irak', de: 'Irak', es: 'Irak', ru: 'Ирак', ar: 'العراق', zh: '伊拉克' },
  'uzbekistan': { fa: 'ازبکستان', fr: 'Ouzbékistan', de: 'Usbekistan', es: 'Uzbekistán', ru: 'Узбекистан', ar: 'أوزبكستان', zh: '乌兹别克斯坦' },
  'australia': { fa: 'استرالیا', fr: 'Australie', de: 'Australien', es: 'Australia', ru: 'Австралия', ar: 'أستراليا', zh: '澳大利亚' },
  'greece': { fa: 'یونان', fr: 'Grèce', de: 'Griechenland', es: 'Grecia', ru: 'Греция', ar: 'اليونان', zh: '希腊' },
  'switzerland': { fa: 'سوئیس', fr: 'Suisse', de: 'Schweiz', es: 'Suiza', ru: 'Швейцария', ar: 'سويسرا', zh: '瑞士' },
  'austria': { fa: 'اتریش', fr: 'Autriche', de: 'Österreich', es: 'Austria', ru: 'Австрия', ar: 'النمسا', zh: '奥地利' },
  'denmark': { fa: 'دانمارک', fr: 'Danemark', de: 'Dänemark', es: 'Dinamarca', ru: 'Дания', ar: 'الدنمارك', zh: '丹麦' },
  'sweden': { fa: 'سوئد', fr: 'Suède', de: 'Schweden', es: 'Suecia', ru: 'Швеция', ar: 'السويد', zh: '瑞典' },
  'norway': { fa: 'نروژ', fr: 'Norvège', de: 'Norwegen', es: 'Noruega', ru: 'Норвегия', ar: 'النرويج', zh: '挪威' },
  'poland': { fa: 'لهستان', fr: 'Pologne', de: 'Polen', es: 'Polonia', ru: 'Польша', ar: 'بولندا', zh: '波兰' },
  'ukraine': { fa: 'اوکراین', fr: 'Ukraine', de: 'Ukraine', es: 'Ucrania', ru: 'Украина', ar: 'أوكرانيا', zh: '乌克兰' },
  'croatia': { fa: 'کرواسی', fr: 'Croatie', de: 'Kroatien', es: 'Croacia', ru: 'Хорватия', ar: 'كرواتيا', zh: '克罗地亚' },
  'serbia': { fa: 'صربستان', fr: 'Serbie', de: 'Serbien', es: 'Serbia', ru: 'Сербия', ar: 'صربيا', zh: '塞尔维亚' },
  'egypt': { fa: 'مصر', fr: 'Égypte', de: 'Ägypten', es: 'Egipto', ru: 'Египет', ar: 'مصر', zh: '埃及' },
  'morocco': { fa: 'مراکش', fr: 'Maroc', de: 'Marokko', es: 'Marruecos', ru: 'Марокко', ar: 'المغرب', zh: '摩洛哥' },
  'algeria': { fa: 'الجزایر', fr: 'Algérie', de: 'Algerien', es: 'Argelia', ru: 'Алжир', ar: 'الجزائر', zh: '阿尔及利亚' },
  'tunisia': { fa: 'تونس', fr: 'Tunisie', de: 'Tunesien', es: 'Túnez', ru: 'Тунис', ar: 'تونس', zh: '突尼斯' },
  'nigeria': { fa: 'نیجریه', fr: 'Nigeria', de: 'Nigeria', es: 'Nigeria', ru: 'Нигерия', ar: 'نيجيريا', zh: '尼日利亚' },
  'wales': { fa: 'ولز', fr: 'Pays de Galles', de: 'Wales', es: 'Gales', ru: 'Уэльс', ar: 'ويلز', zh: '威尔士' },
  'ireland': { fa: 'ایرلند', fr: 'Irlande', de: 'Irland', es: 'Irlanda', ru: 'Ирландия', ar: 'أيرلندا', zh: '爱尔兰' },
  'india': { fa: 'هند', fr: 'Inde', de: 'Indien', es: 'India', ru: 'Индия', ar: 'الهند', zh: '印度' },
  'canada': { fa: 'کانادا', fr: 'Canada', de: 'Kanada', es: 'Canadá', ru: 'Канада', ar: 'كندا', zh: '加拿大' },
  'jordan': { fa: 'اردن', fr: 'Jordanie', de: 'Jordanien', es: 'Jordania', ru: 'Иордания', ar: 'الأردن', zh: '约旦' },
  'kuwait': { fa: 'کویت', fr: 'Koweït', de: 'Kuwait', es: 'Kuwait', ru: 'Кувейт', ar: 'الكويت', zh: '科威特' },
  'bahrain': { fa: 'بحرین', fr: 'Bahreïn', de: 'Bahrain', es: 'Baréin', ru: 'Бахрейн', ar: 'البحرين', zh: '巴林' },
  'oman': { fa: 'عمان', fr: 'Oman', de: 'Oman', es: 'Omán', ru: 'Оман', ar: 'عمان', zh: '阿曼' },
  'lebanon': { fa: 'لبنان', fr: 'Liban', de: 'Libanon', es: 'Líbano', ru: 'Ливан', ar: 'لبنان', zh: '黎巴嫩' },
  'peru': { fa: 'پرو', fr: 'Pérou', de: 'Peru', es: 'Perú', ru: 'Перу', ar: 'بيرو', zh: '秘鲁' },
  'paraguay': { fa: 'پاراگوئه', fr: 'Paraguay', de: 'Paraguay', es: 'Paraguay', ru: 'Парагвай', ar: 'باراغواي', zh: '巴拉圭' },
  'venezuela': { fa: 'ونزوئلا', fr: 'Venezuela', de: 'Venezuela', es: 'Venezuela', ru: 'Венесуэла', ar: 'فنزويلا', zh: '委内瑞拉' },
  'bolivia': { fa: 'بولیوی', fr: 'Bolivie', de: 'Bolivien', es: 'Bolivia', ru: 'Боливия', ar: 'بوليفيا', zh: '玻利维亚' },
  'chile': { fa: 'شیلی', fr: 'Chili', de: 'Chile', es: 'Chile', ru: 'Чили', ar: 'تشيلي', zh: '智利' },
  'colombia': { fa: 'کلمبیا', fr: 'Colombie', de: 'Kolumbien', es: 'Colombia', ru: 'Колумбия', ar: 'كولومبيا', zh: '哥伦比亚' },
  'ecuador': { fa: 'اکوادور', fr: 'Équateur', de: 'Ecuador', es: 'Ecuador', ru: 'Эквадор', ar: 'الإكوادور', zh: '厄瓜多尔' },
  'uruguay': { fa: 'اروگوئه', fr: 'Uruguay', de: 'Uruguay', es: 'Uruguay', ru: 'Уругвай', ar: 'الأوروغواي', zh: '乌拉圭' },
  'costa rica': { fa: 'کاستاریکا', fr: 'Costa Rica', de: 'Costa Rica', es: 'Costa Rica', ru: 'Коста-Рика', ar: 'كوستاريكا', zh: '哥斯达黎加' },
  'honduras': { fa: 'هندوراس', fr: 'Honduras', de: 'Honduras', es: 'Honduras', ru: 'Гондурас', ar: 'هندوراس', zh: '洪都拉斯' },
  'panama': { fa: 'پاناما', fr: 'Panama', de: 'Panama', es: 'Panamá', ru: 'Панама', ar: 'بنما', zh: '巴拿马' },
  'guatemala': { fa: 'گواتمالا', fr: 'Guatemala', de: 'Guatemala', es: 'Guatemala', ru: 'Гватемала', ar: 'غواتيمالا', zh: '危地马拉' },
  'el salvador': { fa: 'السالوادور', fr: 'Salvador', de: 'El Salvador', es: 'El Salvador', ru: 'Сальвадор', ar: 'السلفادور', zh: '萨尔瓦多' },
  'dominican republic': { fa: 'جمهوری دومینیکن', fr: 'République dominicaine', de: 'Dominikanische Republik', es: 'República Dominicana', ru: 'Доминиканская Республика', ar: 'جمهورية الدومينيكان', zh: '多米尼加共和国' },
  'jamaica': { fa: 'جامائیکا', fr: 'Jamaïque', de: 'Jamaika', es: 'Jamaica', ru: 'Ямайка', ar: 'جامايكا', zh: '牙买加' },
  'trinidad and tobago': { fa: 'ترینیداد و توباگو', fr: 'Trinité-et-Tobago', de: 'Trinidad und Tobago', es: 'Trinidad y Tobago', ru: 'Тринидад и Тобаго', ar: 'ترينيداد وتوباغو', zh: '特立尼达和多巴哥' },
  'finland': { fa: 'فنلاند', fr: 'Finlande', de: 'Finnland', es: 'Finlandia', ru: 'Финляндия', ar: 'فنلندا', zh: '芬兰' },
  'iceland': { fa: 'ایسلند', fr: 'Islande', de: 'Island', es: 'Islandia', ru: 'Исландия', ar: 'آيسلندا', zh: '冰岛' },
  'czech republic': { fa: 'جمهوری چک', fr: 'République tchèque', de: 'Tschechien', es: 'República Checa', ru: 'Чехия', ar: 'التشيك', zh: '捷克' },
  'slovakia': { fa: 'اسلواکی', fr: 'Slovaquie', de: 'Slowakei', es: 'Eslovaquia', ru: 'Словакия', ar: 'سلوفاكيا', zh: '斯洛伐克' },
  'hungary': { fa: 'مجارستان', fr: 'Hongrie', de: 'Ungarn', es: 'Hungría', ru: 'Венгрия', ar: 'المجر', zh: '匈牙利' },
  'romania': { fa: 'رومانی', fr: 'Roumanie', de: 'Rumänien', es: 'Rumania', ru: 'Румыния', ar: 'رومانيا', zh: '罗马尼亚' },
  'bulgaria': { fa: 'بلغارستان', fr: 'Bulgarie', de: 'Bulgarien', es: 'Bulgaria', ru: 'Болгария', ar: 'بلغاريا', zh: '保加利亚' },
  'slovenia': { fa: 'اسلوونی', fr: 'Slovénie', de: 'Slowenien', es: 'Eslovenia', ru: 'Словения', ar: 'سلوفينيا', zh: '斯洛文尼亚' },
  'bosnia and herzegovina': { fa: 'بوسنی و هرزگوین', fr: 'Bosnie-Herzégovine', de: 'Bosnien und Herzegowina', es: 'Bosnia y Herzegovina', ru: 'Босния и Герцеговина', ar: 'البوسنة والهرسك', zh: '波斯尼亚和黑塞哥维那' },
  'albania': { fa: 'آلبانی', fr: 'Albanie', de: 'Albanien', es: 'Albania', ru: 'Албания', ar: 'ألبانيا', zh: '阿尔巴尼亚' },
  'north macedonia': { fa: 'مقدونیه شمالی', fr: 'Macédoine du Nord', de: 'Nordmazedonien', es: 'Macedonia del Norte', ru: 'Северная Македония', ar: 'مقدونيا الشمالية', zh: '北马其顿' },
  'georgia': { fa: 'گرجستان', fr: 'Géorgie', de: 'Georgien', es: 'Georgia', ru: 'Грузия', ar: 'جورجيا', zh: '格鲁吉亚' },
  'armenia': { fa: 'ارمنستان', fr: 'Arménie', de: 'Armenien', es: 'Armenia', ru: 'Армения', ar: 'أرمينيا', zh: '亚美尼亚' },
  'azerbaijan': { fa: 'آذربایجان', fr: 'Azerbaïdjan', de: 'Aserbaidschan', es: 'Azerbaiyán', ru: 'Азербайджан', ar: 'أذربيجان', zh: '阿塞拜疆' },
  'kazakhstan': { fa: 'قزاقستان', fr: 'Kazakhstan', de: 'Kasachstan', es: 'Kazajistán', ru: 'Казахстан', ar: 'كازاخستان', zh: '哈萨克斯坦' },
  'cyprus': { fa: 'قبرس', fr: 'Chypre', de: 'Zypern', es: 'Chipre', ru: 'Кипр', ar: 'قبرص', zh: '塞浦路斯' },
  'israel': { fa: 'اسرائیل', fr: 'Israël', de: 'Israel', es: 'Israel', ru: 'Израиль', ar: 'إسرائيل', zh: '以色列' },
  'south africa': { fa: 'آفریقای جنوبی', fr: 'Afrique du Sud', de: 'Südafrika', es: 'Sudáfrica', ru: 'ЮАР', ar: 'جنوب أفريقيا', zh: '南非' },
  'kenya': { fa: 'کنیا', fr: 'Kenya', de: 'Kenia', es: 'Kenia', ru: 'Кения', ar: 'كينيا', zh: '肯尼亚' },
  'ghana': { fa: 'غنا', fr: 'Ghana', de: 'Ghana', es: 'Ghana', ru: 'Гана', ar: 'غانا', zh: '加纳' },
  'senegal': { fa: 'سنگال', fr: 'Sénégal', de: 'Senegal', es: 'Senegal', ru: 'Сенегал', ar: 'السنغال', zh: '塞内加尔' },
  'cameroon': { fa: 'کامرون', fr: 'Cameroun', de: 'Kamerun', es: 'Camerún', ru: 'Камерун', ar: 'الكاميرون', zh: '喀麦隆' },
  'ivory coast': { fa: 'ساحل عاج', fr: "Côte d'Ivoire", de: 'Elfenbeinküste', es: 'Costa de Marfil', ru: "Кот-д'Ивуар", ar: 'ساحل العاج', zh: '科特迪瓦' },
  'vietnam': { fa: 'ویتنام', fr: 'Vietnam', de: 'Vietnam', es: 'Vietnam', ru: 'Вьетнам', ar: 'فيتنام', zh: '越南' },
  'thailand': { fa: 'تایلند', fr: 'Thaïlande', de: 'Thailand', es: 'Tailandia', ru: 'Таиланд', ar: 'تايلاند', zh: '泰国' },
  'indonesia': { fa: 'اندونزی', fr: 'Indonésie', de: 'Indonesien', es: 'Indonesia', ru: 'Индонезия', ar: 'إندونيسيا', zh: '印度尼西亚' },
  'malaysia': { fa: 'مالزی', fr: 'Malaisie', de: 'Malaysia', es: 'Malasia', ru: 'Малайзия', ar: 'ماليزيا', zh: '马来西亚' },
  'philippines': { fa: 'فیلیپین', fr: 'Philippines', de: 'Philippinen', es: 'Filipinas', ru: 'Филиппины', ar: 'الفلبين', zh: '菲律宾' },
  'singapore': { fa: 'سنگاپور', fr: 'Singapour', de: 'Singapur', es: 'Singapur', ru: 'Сингапур', ar: 'سنغافورة', zh: '新加坡' },
  'northern ireland': { fa: 'ایرلند شمالی', fr: 'Irlande du Nord', de: 'Nordirland', es: 'Irlanda del Norte', ru: 'Северная Ирландия', ar: 'أيرلندا الشمالية', zh: '北爱尔兰' },
  'new zealand': { fa: 'نیوزیلند', fr: 'Nouvelle-Zélande', de: 'Neuseeland', es: 'Nueva Zelanda', ru: 'Новая Зеландия', ar: 'نيوزيلندا', zh: '新西兰' },
};

// ── دیکشنری ایستای رقابت‌های پرتکرار (regex روی متن انگلیسی خام) ────
const COMPETITION_I18N = [
  [/world cup.*qualif|qualif.*world cup/i, { fa: 'مقدماتی جام جهانی', fr: 'Qualifications Coupe du Monde', de: 'WM-Qualifikation', es: 'Clasificación Mundial', ru: 'Отбор ЧМ', ar: 'تصفيات كأس العالم', zh: '世界杯预选赛' }],
  [/club world cup/i, { fa: 'جام باشگاه‌های جهان', fr: 'Coupe du Monde des Clubs', de: 'Klub-Weltmeisterschaft', es: 'Mundial de Clubes', ru: 'Клубный чемпионат мира', ar: 'كأس العالم للأندية', zh: '世俱杯' }],
  [/fifa world cup|^world cup$/i, { fa: 'جام جهانی', fr: 'Coupe du Monde', de: 'Weltmeisterschaft', es: 'Copa Mundial', ru: 'Чемпионат мира', ar: 'كأس العالم', zh: '世界杯' }],
  [/afc champions league/i, { fa: 'لیگ قهرمانان آسیا', fr: 'Ligue des Champions AFC', de: 'AFC Champions League', es: 'Liga de Campeones AFC', ru: 'Лига чемпионов АФК', ar: 'دوري أبطال آسيا', zh: '亚冠联赛' }],
  [/asian cup/i, { fa: 'جام ملت‌های آسیا', fr: "Coupe d'Asie", de: 'Asienmeisterschaft', es: 'Copa Asiática', ru: 'Кубок Азии', ar: 'كأس آسيا', zh: '亚洲杯' }],
  [/caf champions league/i, { fa: 'لیگ قهرمانان آفریقا', fr: 'Ligue des Champions CAF', de: 'CAF Champions League', es: 'Liga de Campeones CAF', ru: 'Лига чемпионов КАФ', ar: 'دوري أبطال أفريقيا', zh: '非冠联赛' }],
  [/africa cup of nations|africa cup/i, { fa: 'جام ملت‌های آفریقا', fr: 'CAN', de: 'Afrika-Cup', es: 'Copa Africana', ru: 'Кубок африканских наций', ar: 'كأس الأمم الأفريقية', zh: '非洲杯' }],
  [/uefa.*conference|europa conference/i, { fa: 'لیگ کنفرانس اروپا', fr: 'Ligue Conférence', de: 'Conference League', es: 'Liga Conferencia', ru: 'Лига конференций', ar: 'دوري المؤتمر الأوروبي', zh: '欧协联' }],
  [/uefa.*europa league|^europa league/i, { fa: 'لیگ اروپا', fr: 'Ligue Europa', de: 'Europa League', es: 'Liga Europa', ru: 'Лига Европы', ar: 'الدوري الأوروبي', zh: '欧联杯' }],
  [/uefa.*champions league|^champions league$/i, { fa: 'لیگ قهرمانان اروپا', fr: 'Ligue des Champions', de: 'Champions League', es: 'Liga de Campeones', ru: 'Лига чемпионов', ar: 'دوري أبطال أوروبا', zh: '欧冠' }],
  [/uefa nations league/i, { fa: 'لیگ ملت‌های اروپا', fr: 'Ligue des Nations', de: 'Nations League', es: 'Liga de Naciones', ru: 'Лига наций', ar: 'دوري الأمم الأوروبية', zh: '欧洲国家联赛' }],
  [/european championship|uefa euro/i, { fa: 'یورو (قهرمانی اروپا)', fr: 'Euro', de: 'EM', es: 'Eurocopa', ru: 'Евро', ar: 'يورو', zh: '欧洲杯' }],
  [/libertadores/i, { fa: 'کوپا لیبرتادورس', fr: 'Copa Libertadores', de: 'Copa Libertadores', es: 'Copa Libertadores', ru: 'Кубок Либертадорес', ar: 'كوبا ليبرتادوريس', zh: '解放者杯' }],
  [/copa am[eé]rica/i, { fa: 'کوپا آمه‌ریکا', fr: 'Copa América', de: 'Copa América', es: 'Copa América', ru: 'Кубок Америки', ar: 'كوبا أمريكا', zh: '美洲杯' }],
  [/friendl/i, { fa: 'دوستانه', fr: 'Amical', de: 'Freundschaftsspiel', es: 'Amistoso', ru: 'Товарищеский матч', ar: 'ودية', zh: '友谊赛' }],
  [/^premier league$/i, { fa: 'لیگ برتر انگلیس', fr: 'Premier League', de: 'Premier League', es: 'Premier League', ru: 'Премьер-лига', ar: 'الدوري الإنجليزي الممتاز', zh: '英超' }],
  [/^la ?liga/i, { fa: 'لالیگا', fr: 'Liga', de: 'La Liga', es: 'LaLiga', ru: 'Ла Лига', ar: 'الليغا', zh: '西甲' }],
  [/^serie a$/i, { fa: 'سری آ', fr: 'Serie A', de: 'Serie A', es: 'Serie A', ru: 'Серия А', ar: 'الدوري الإيطالي', zh: '意甲' }],
  [/^bundesliga$/i, { fa: 'بوندس‌لیگا', fr: 'Bundesliga', de: 'Bundesliga', es: 'Bundesliga', ru: 'Бундеслига', ar: 'الدوري الألماني', zh: '德甲' }],
  [/^ligue 1/i, { fa: 'لیگ ۱ فرانسه', fr: 'Ligue 1', de: 'Ligue 1', es: 'Ligue 1', ru: 'Лига 1', ar: 'الدوري الفرنسي', zh: '法甲' }],
];

function getStaticTranslation(text, lang) {
  const key = normKey(text);
  if (!key) return null;
  const c = COUNTRY_I18N[key];
  if (c && c[lang]) return c[lang];
  for (const [re, dict] of COMPETITION_I18N) {
    if (re.test(text) && dict[lang]) return dict[lang];
  }
  return null;
}

// ── لایهٔ MT دینامیک ──────────────────────────────────────────────
// Cloudflare هر KV.get/put و هر fetch() را «Sub-request» حساب می‌کند و
// روی پلن رایگان سقفش ۵۰ تاست (هم برای فراخوانی‌های هم‌زمان، هم برای
// آن‌هایی که در پس‌زمینه با ctx.waitUntil اجرا می‌شوند — چون هنوز جزو
// همان اجرای Worker به‌حساب می‌آیند). به همین دلیل به‌جای یک کلید KV
// جدا برای هر اسم (که با ۲۰-۳۰ بازی زنده خیلی زود از ۵۰ رد می‌شد)، کل
// دیکشنری هر زبان را در یک رکورد واحد نگه می‌داریم: کل درخواست فقط
// ۱ خواندن و (در صورت وجود نام جدید) ۱ نوشتن از KV مصرف می‌کند —
// صرف‌نظر از این‌که صفحه چند بازی/تیم داشته باشد.
const MT_TIMEOUT_MS = 4000;
const MT_MAX_SYNC = 20; // با تایم‌اوت ۳.۵ث به‌ازای هر تماس، بدترین حالت این دسته ~۷-۸ ثانیه طول می‌کشد، نه بی‌نهایت

// دو مدل، دو کار متفاوت:
//   'text'  → m2m100-1.2b: برای متن واقعی زبانی (اسم کشور/لیگ) دقیق و ارزان است.
//   'name'  → یک LLM دستوری بزرگ‌تر با دانش دنیای واقعی: چون مدل کوچک روی
//             اسم خاص (تیم/بازیکن) گاهی توهم می‌زد (مثال: «Dukla» که به یک
//             چیز کاملاً نامرتبط ترجمه شد). LLM با پرامپت محدود این ریسک را
//             کم می‌کند، هرچند صد در صد هم نیست — هیچ MT ای نیست.
//
// ── انتخاب مدل (به‌روزرسانی) ──────────────────────────────────────
// llama-3.1-8b-instruct-fast قبلاً اینجا بود؛ هنوز روی Workers AI فعال و
// معتبر است (بر خلاف @cf/meta/llama-3.1-8b-instruct بدون پسوند که در
// ۳۰ می ۲۰۲۶ Deprecated شد — از آن استفاده نکنید). اما برای دانش دنیای
// واقعیِ لازم جهت اسم دقیق تیم‌های کمترشناخته‌شده/بازیکنان، مدل جدیدتر و
// به‌طور محسوس بزرگ‌تر llama-3.3-70b-instruct-fp8-fast (نسخهٔ سریع‌شدهٔ
// FP8) در دسترس است و باید خطای اسم خاص را کم کند. هزینه به‌ازای هر
// فراخوانی (~۵۰ توکن ورودی + ~۱۰ توکن خروجی) طبق نرخ رسمی Neuron حدود
// ۳ تا ۴ Neuron است؛ با سقف رایگان ۱۰,۰۰۰ Neuron/روز یعنی چند هزار اسمِ
// واقعاً جدید در روز — و چون هر اسم فقط یک‌بار در عمر KV ترجمه می‌شود
// (نه به‌ازای هر بازدید)، این سقف در عمل هرگز لمس نمی‌شود. تنها هزینهٔ
// جانبی: مدل ۷۰ میلیاردی کمی کندتر از ۸ میلیاردی است، برای همین
// AI_CALL_TIMEOUT_MS کمی بالاتر برده شده تا زودتر از موعد به GTX سقوط
// نکند. هیچ مدلی (نه این‌یکی، نه هیچ MT دیگری) ترجمهٔ اسم خاص را «صددرصد
// بدون خطا» تضمین نمی‌کند؛ اگر روی نامی نامطمئن باشد، طبق پرامپت زیر آن
// را به لاتین دست‌نخورده برمی‌گرداند تا حداقل نمایش خراب/جعلی نشود.
const NAME_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
// اگر روزی این مدل هم Deprecated/کند شد، جایگزین بعدی برای امتحان:
// '@cf/meta/llama-3.1-8b-instruct-fast' (سریع‌تر، ارزان‌تر، کمی ضعیف‌تر روی اسم‌های نادر)
const LANG_HUMAN = { fa: 'Persian (Farsi)', fr: 'French', ar: 'Arabic', de: 'German', ru: 'Russian', es: 'Spanish', zh: 'Simplified Chinese' };

function dictKvKey(lang) { return `dict:v4:${lang}`; }

async function loadDict(lang, env) {
  if (!env.TRANSLATE_KV) return {};
  try {
    const raw = await env.TRANSLATE_KV.get(dictKvKey(lang));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
async function saveDict(lang, dict, env) {
  if (!env.TRANSLATE_KV) return;
  try { await env.TRANSLATE_KV.put(dictKvKey(lang), JSON.stringify(dict)); }
  catch { /* بی‌اثر — دفعهٔ بعد دوباره تلاش می‌شود */ }
}

function cleanLlmName(raw, fallback) {
  if (!raw) return null;
  let t = String(raw).trim();
  t = t.split('\n')[0].trim();                 // فقط خط اول
  t = t.replace(/^["'«»`]+|["'«»`]+$/g, '');    // گیومهٔ اضافه
  t = t.replace(/^(ترجمه|translation)\s*:\s*/i, '');
  if (!t || t.length > fallback.length * 4) return null; // خروجی عجیب/خیلی بلند = رد
  return t;
}

// env.AI.run هیچ Timeout داخلی‌ای ندارد؛ اگر یک بار مدل کند/هنگ کند و ما
// منتظرش بمانیم، کل اجرای Worker (و درنتیجه کل پاسخ /live) قفل می‌شود.
// این تابع تضمین می‌کند که هر فراخوانی AI حداکثر AI_CALL_TIMEOUT_MS طول
// بکشد؛ اگر بیشتر شود، شکست می‌خورد (نه هنگ) و کد به GTX یا متن اصلی
// می‌افتد.
// با مدل ۷۰ میلیاردی (کمی کندتر از ۸ میلیاردیِ قبلی) سقف قبلی (۳۵۰۰ms)
// زودتر از لازم به GTX سقوط می‌کرد؛ کمی بالا برده شد. با MT_MAX_SYNC=20
// و اجرای موازی (Promise.all)، بدترین حالت یک دسته هنوز حدود ۵-۶ ثانیه
// است، نه بیشتر.
const AI_CALL_TIMEOUT_MS = 5000;
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('ai_timeout_' + ms + 'ms')), ms)),
  ]);
}

async function fetchMTText(text, lang, env, srcLang) {
  if (env.AI) {
    try {
      const r = await withTimeout(env.AI.run('@cf/meta/m2m100-1.2b', { text, source_lang: srcLang || 'en', target_lang: lang }), AI_CALL_TIMEOUT_MS);
      const t = r && (r.translated_text || (r.result && r.result.translated_text));
      if (t && String(t).trim()) return String(t).trim();
    } catch { /* بیفتد روی GTX */ }
  }
  return fetchGTX(text, lang);
}

async function fetchMTName(text, lang, env) {
  if (env.AI) {
    try {
      const target = LANG_HUMAN[lang] || lang;
      const r = await withTimeout(env.AI.run(NAME_MODEL, {
        messages: [
          { role: 'system', content: `You localize football (soccer) proper nouns — club, competition, and player names — for a sports app. Reply with ONLY the ${target} form of the given name, nothing else: no quotes, no explanation, no extra words. If you are not confident about how a name is normally written in ${target}, output it unchanged in Latin script rather than guessing or inventing something.` },
          { role: 'user', content: text },
        ],
        max_tokens: 32,
        temperature: 0,
      }), AI_CALL_TIMEOUT_MS);
      const cleaned = cleanLlmName(r && r.response, text);
      if (cleaned) return cleaned;
    } catch { /* بیفتد روی GTX */ }
  }
  return fetchGTX(text, lang);
}

// Google GTX غیررسمی، فقط آخرین راه‌حل (اگر AI Binding وصل نبود)؛ تشخیص
// خودکار زبان مبدأ دارد، برخلاف مدل‌های Workers AI بالا.
async function fetchGTX(text, lang) {
  const gUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(gUrl, { signal: AbortSignal.timeout(MT_TIMEOUT_MS) });
  if (!res.ok) throw new Error('mt_http_' + res.status);
  const result = await res.json();
  const parts = (result && result[0]) || [];
  const translated = parts.map(p => p && p[0]).filter(Boolean).join('');
  if (!translated) throw new Error('mt_empty');
  return translated;
}

/**
 * دیکشنری آن زبان را یک‌بار می‌خواند (۱ Sub-request)، هر (نوع+زبان‌مبدأ+متن)
 * را در آن جست‌وجو می‌کند، و فقط برای موارد واقعاً جدید MT صدا می‌زند —
 * حداکثر MT_MAX_SYNC مورد هم‌زمان. نتیجهٔ جدید در یک نوشتن واحد در KV
 * ادغام می‌شود، پس هیچ‌وقت چیزی که «قبلاً ترجمه شده» به‌خاطر سقف Batch
 * از قلم نمی‌افتد.
 */
async function translateBatch(items, lang, env, ctx, debugErrors) {
  // items: [{ text, src, kind }]  kind: 'text' | 'name'
  const map = new Map(); // key -> ترجمه
  const dict = await loadDict(lang, env);
  const misses = [];
  for (const { text, src, kind } of items) {
    const k = srcTextKey(kind + ':' + src, text);
    if (dict[k]) map.set(k, dict[k]); else misses.push({ text, src, kind, k });
  }
  if (!misses.length) return map;

  const run = (text, src, kind) => kind === 'name' ? fetchMTName(text, lang, env) : fetchMTText(text, lang, env, src);

  const head = misses.slice(0, MT_MAX_SYNC);
  const tail = misses.slice(MT_MAX_SYNC);
  const additions = {};
  await Promise.all(head.map(async ({ text, src, kind, k }) => {
    try {
      const translated = await run(text, src, kind);
      map.set(k, translated);
      additions[k] = translated;
    } catch (e) { if (debugErrors && debugErrors.length < 5) debugErrors.push(String(e && e.message || e)); }
  }));
  if (Object.keys(additions).length) {
    Object.assign(dict, additions);
    ctx.waitUntil(saveDict(lang, dict, env)); // ۱ نوشتن برای کل دسته، نه به‌ازای هر اسم
  }
  if (tail.length && ctx && ctx.waitUntil) {
    // باقی‌مانده (نادر: فقط وقتی یک صفحه بیش از MT_MAX_SYNC اسمِ کاملاً
    // جدید دارد) در پس‌زمینه تکمیل می‌شود تا رفرش بعدی آماده باشد.
    ctx.waitUntil((async () => {
      const bg = {};
      await Promise.all(tail.map(async ({ text, src, kind, k }) => {
        try { bg[k] = await run(text, src, kind); } catch { /* بار بعد دوباره امتحان می‌شود */ }
      }));
      if (Object.keys(bg).length) {
        const fresh = await loadDict(lang, env);
        Object.assign(fresh, bg);
        await saveDict(lang, fresh, env);
      }
    })());
  }
  return map;
}

// کدام فیلدها متن واقعی زبانی‌اند (m2m100) و کدام‌ها اسم خاص‌اند (LLM).
const LITERAL_TEXT_KEYS = new Set(['country_name', 'league_name']);

// country_name همیشه با source=en ترجمه می‌شود (apifootball این فیلد را
// همیشه با نام انگلیسی کشور می‌دهد). league_name اما اغلب به زبان محلی
// همان کشور است؛ پس زبان مبدأش را از country_name همان آبجکت می‌گیریم.
// برای اسم‌های خاص (team/player/...) اصلاً به source_lang نیازی نیست،
// چون از مسیر LLM (نه m2m100) رد می‌شوند.
function collectTexts(node, out, depth, ctxCountry) {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) { for (const c of node) collectTexts(c, out, depth + 1, ctxCountry); return; }
  if (typeof node !== 'object') return;
  const country = node.country_name || ctxCountry;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (!TRANSLATE_KEYS.has(k)) { if (v && typeof v === 'object') collectTexts(v, out, depth + 1, country); continue; }
    if (!shouldTranslate(v)) continue;
    const isLiteral = LITERAL_TEXT_KEYS.has(k);
    const src = k === 'country_name' ? 'en' : srcLangFor(country);
    const kind = isLiteral ? 'text' : 'name';
    out.set(srcTextKey(kind + ':' + src, v), { text: v, src, kind });
  }
}

function applyTranslations(node, lang, dynamicMap, depth, ctxCountry) {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) { for (const c of node) applyTranslations(c, lang, dynamicMap, depth + 1, ctxCountry); return; }
  if (typeof node !== 'object') return;
  const country = node.country_name || ctxCountry;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (!TRANSLATE_KEYS.has(k)) { if (v && typeof v === 'object') applyTranslations(v, lang, dynamicMap, depth + 1, country); continue; }
    if (!shouldTranslate(v)) continue;
    const isLiteral = LITERAL_TEXT_KEYS.has(k);
    const src = k === 'country_name' ? 'en' : srcLangFor(country);
    const kind = isLiteral ? 'text' : 'name';
    const translated = getStaticTranslation(v, lang) || dynamicMap.get(srcTextKey(kind + ':' + src, v)) || null;
    if (translated && translated !== v) node[k + '_i18n'] = translated; // مقدار اصلی دست‌نخورده می‌ماند
  }
}

/** نقطهٔ ورود لایهٔ ترجمه؛ هرگز throw نمی‌کند — بدترین حالت: بدون تغییر برمی‌گرداند. */
async function translatePayload(data, lang, env, ctx, debugErrors) {
  if (lang === 'en' || !data) return data;
  try {
    const collected = new Map(); // srcTextKey -> {text, src}
    collectTexts(data, collected, 0, null);
    const needsDynamic = [];
    for (const { text, src, kind } of collected.values()) { if (!getStaticTranslation(text, lang)) needsDynamic.push({ text, src, kind }); }
    const dynamicMap = needsDynamic.length ? await translateBatch(needsDynamic, lang, env, ctx, debugErrors) : new Map();
    applyTranslations(data, lang, dynamicMap, 0, null);
  } catch (e) { if (debugErrors && debugErrors.length < 5) debugErrors.push('translatePayload: ' + String(e && e.message || e)); }
  return data;
}

/* ════════════════════════ منطق اصلی (بدون تغییر) ════════════════════════ */

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

/* ─────────────────────── H2H: فقط ۵ تقابل آخر ─────────────────────── */
// apifootball برای get_H2H آبجکتی با کلیدهای firstTeam_VS_secondTeam،
// firstTeam_lastResults و secondTeam_lastResults برمی‌گرداند. طبق درخواست،
// هر کدام را به ۵ مورد اخیر محدود می‌کنیم (بدون تغییر ساختار/کلیدهای اصلی).
function limitH2H(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const sortRecentFirst = (arr) => {
    if (!Array.isArray(arr)) return arr;
    return [...arr]
      .sort((a, b) => {
        const da = String((a && a.match_date) || '') + ' ' + String((a && a.match_time) || '');
        const db = String((b && b.match_date) || '') + ' ' + String((b && b.match_time) || '');
        return db.localeCompare(da);
      })
      .slice(0, 5);
  };
  const out = { ...raw };
  if (Array.isArray(out.firstTeam_VS_secondTeam)) out.firstTeam_VS_secondTeam = sortRecentFirst(out.firstTeam_VS_secondTeam);
  if (Array.isArray(out.firstTeam_lastResults)) out.firstTeam_lastResults = sortRecentFirst(out.firstTeam_lastResults);
  if (Array.isArray(out.secondTeam_lastResults)) out.secondTeam_lastResults = sortRecentFirst(out.secondTeam_lastResults);
  return out;
}

// نام‌های رایج دیگری که فرانت‌اند ممکن است برای شناسهٔ دو تیم H2H بفرستد؛
// اگر firstTeamId/secondTeamId استاندارد نیامده باشد، از این‌ها جایگزین می‌گیریم
// تا این مسیر «تضمینی» کار کند، صرف‌نظر از نام پارامتری که فرانت می‌فرستد.
const H2H_FIRST_ALIASES = ['home_id', 'hometeam_id', 'home_team_id', 'team1_id', 'team1', 'homeId', 'homeTeamId', 'match_hometeam_id'];
const H2H_SECOND_ALIASES = ['away_id', 'awayteam_id', 'away_team_id', 'team2_id', 'team2', 'awayId', 'awayTeamId', 'match_awayteam_id'];

/* ────────────────── ترکیب: تصویر واقعی بازیکن در lineups ────────────────── */
// get_lineups شناسهٔ تیم را برنمی‌گرداند، فقط match_id می‌گیرد؛ پس اول با یک
// فراخوانی سبک (و کش‌شونده) شناسهٔ دو تیم بازی را پیدا می‌کنیم، سپس با همان
// getTeamRosterCached موجود (دقیقاً همان متدی که برای آقای گل/پاس‌گل استفاده
// می‌شود) تصویر هر بازیکن را از روی player_key پیدا و به ترکیب اضافه می‌کنیم.
async function getMatchTeamsCached(matchId, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://internal.cache/match-teams?match_id=${encodeURIComponent(matchId)}`);
  const hit = await cache.match(cacheKey);
  if (hit) {
    try { return await hit.json(); } catch { /* fall through */ }
  }
  if (!env.APIFOOTBALL_KEY) return null;
  const target = new URL(UPSTREAM);
  target.searchParams.set('action', 'get_events');
  target.searchParams.set('match_id', matchId);
  target.searchParams.set('APIkey', env.APIFOOTBALL_KEY);
  let data;
  try {
    const res = await fetch(target.toString(), { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  const match = Array.isArray(data) ? data[0] : null;
  const toStore = match ? { home: match.match_hometeam_id, away: match.match_awayteam_id } : null;
  if (toStore) {
    const resp = new Response(JSON.stringify(toStore), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${3 * HOUR}` },
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  }
  return toStore;
}

function playerImageMapFromRoster(rosterArr) {
  const map = new Map();
  const team = Array.isArray(rosterArr) ? rosterArr[0] : null;
  (team && team.players || []).forEach(pl => {
    if (pl && pl.player_key != null && pl.player_image) map.set(String(pl.player_key), pl.player_image);
  });
  return map;
}

function decorateLineupList(list, imageMap) {
  if (!Array.isArray(list)) return list;
  return list.map(p => ({
    ...p,
    player_image: (p && p.player_key != null && imageMap.get(String(p.player_key))) || (p && p.player_image) || null,
  }));
}

/** هرگز throw نمی‌کند؛ بدترین حالت: lineup بدون تصویر برمی‌گردد (رفتار قبلی). */
async function enrichLineupsWithPhotos(matchId, raw, env, ctx) {
  try {
    const key = (matchId != null && String(matchId) in raw) ? String(matchId) : Object.keys(raw || {})[0];
    const entry = raw && key != null && raw[key];
    if (!entry || !entry.lineup) return raw;

    const teams = await getMatchTeamsCached(key, env, ctx).catch(() => null);
    if (!teams || (!teams.home && !teams.away)) return raw;

    const [homeRoster, awayRoster] = await Promise.all([
      teams.home ? getTeamRosterCached(teams.home, env, ctx).catch(() => null) : null,
      teams.away ? getTeamRosterCached(teams.away, env, ctx).catch(() => null) : null,
    ]);
    const homeMap = playerImageMapFromRoster(homeRoster);
    const awayMap = playerImageMapFromRoster(awayRoster);

    if (entry.lineup.home) {
      entry.lineup.home.starting_lineups = decorateLineupList(entry.lineup.home.starting_lineups, homeMap);
      entry.lineup.home.substitutes = decorateLineupList(entry.lineup.home.substitutes, homeMap);
    }
    if (entry.lineup.away) {
      entry.lineup.away.starting_lineups = decorateLineupList(entry.lineup.away.starting_lineups, awayMap);
      entry.lineup.away.substitutes = decorateLineupList(entry.lineup.away.substitutes, awayMap);
    }
    return raw;
  } catch {
    return raw;
  }
}

/* ─────────────────────── تب «شبکه‌های پخش» (ESPN) ─────────────────────── */
// خروجی هر لیگ عمداً با همان اسم کلیدهایی ساخته می‌شود که بقیهٔ مسیرها
// (country_name، league_name، match_hometeam_name، ...) استفاده می‌کنند؛
// این‌طوری، بدون هیچ کد اضافه، لایهٔ ترجمهٔ موجود (TRANSLATE_KEYS) و همان
// گرافیک/کامپوننت‌های فرانت که برای بقیهٔ تب‌ها دارید، برای این تب هم کار می‌کند.
/* ── ESPN: هدر مرورگری + میزبان‌های جایگزین ─────────────────────────────
 * ESPN (پشت Akamai) درخواست‌های بدون User-Agent مرورگری را گاهی با 403 رد می‌کند؛ همین باعث می‌شد
 * همهٔ لیگ‌ها null برگردند و تب «شبکه‌های پخش» همیشه خالی بماند. پس:
 *   ۱) هدرهای مرورگری می‌فرستیم،
 *   ۲) اگر site.api جواب نداد، site.web.api و سپس cdn.espn.com (شکل پاسخ متفاوت: content.sbData) را امتحان می‌کنیم،
 *   ۳) میزبانِ سالم را یک‌بار پیدا و در حافظهٔ ایزوله نگه می‌داریم تا تعداد Sub-request از سقف ۵۰ رد نشود.
 */
const ESPN_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://www.espn.com/',
  'Origin': 'https://www.espn.com',
};
const ESPN_HOSTS = [
  { id: 'site',  url: (slug, d) => `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?lang=en&region=us&limit=200${d ? '&dates=' + d : ''}` },
  { id: 'web',   url: (slug, d) => `https://site.web.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?lang=en&region=us&limit=200${d ? '&dates=' + d : ''}` },
  { id: 'cdn',   url: (slug, d) => `https://cdn.espn.com/core/soccer/scoreboard?xhr=1&league=${slug}${d ? '&dates=' + d : ''}` },
];
let espnHostIdx = 0; // آخرین میزبانِ سالم (در حافظهٔ ایزوله)

// cdn.espn.com پاسخ را زیر content.sbData می‌گذارد؛ بقیه مستقیم events/leagues دارند.
function unwrapEspn(j) {
  if (!j || typeof j !== 'object') return null;
  if (Array.isArray(j.events)) return j;
  const sb = j.content && j.content.sbData;
  if (sb && Array.isArray(sb.events)) return sb;
  return null;
}
async function espnGet(hostIdx, slug, dateParam) {
  const h = ESPN_HOSTS[hostIdx];
  try {
    const res = await fetch(h.url(slug, dateParam), { headers: ESPN_HEADERS, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: unwrapEspn(await res.json()) };
  } catch (e) { return { ok: false, status: 0 }; }
}
// اگر میزبان فعلی شکست خورد، بقیه را به ترتیب امتحان می‌کند و اولین سالم را «فعلی» می‌کند.
async function espnFetchScoreboard(slug, dateParam) {
  const order = ESPN_HOSTS.map((_, i) => (espnHostIdx + i) % ESPN_HOSTS.length);
  for (const i of order) {
    const r = await espnGet(i, slug, dateParam);
    if (r.ok && r.data) { espnHostIdx = i; return r.data; }
  }
  return null;
}

// نام‌های شبکهٔ پخش را از همهٔ شکل‌های شناخته‌شدهٔ ESPN جمع می‌کند.
function collectBroadcastNames(ev, comp) {
  const names = new Set();
  const add = (n) => { if (typeof n === 'string' && n.trim()) names.add(n.trim()); };
  const scan = (arr) => (Array.isArray(arr) ? arr : []).forEach(b => {
    if (!b) return;
    if (typeof b === 'string') return add(b);
    (Array.isArray(b.names) ? b.names : []).forEach(add);
    add(b.name); add(b.shortName);
    if (b.media) { add(b.media.shortName); add(b.media.name); }
    if (b.station) add(b.station);
  });
  scan(comp.broadcasts); scan(comp.geoBroadcasts); scan(ev.broadcasts); scan(ev.geoBroadcasts);
  if (typeof comp.broadcast === 'string') add(comp.broadcast);
  return Array.from(names);
}

async function fetchLeagueBroadcasts(leagueInfo, dateParam, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://internal.cache/espn-broadcast-${BROADCAST_CACHE_VERSION}?slug=${encodeURIComponent(leagueInfo.slug)}&date=${encodeURIComponent(dateParam || '')}`);
  const hit = await cache.match(cacheKey);
  if (hit) {
    try { return { out: await hit.json(), failed: false }; } catch { /* fall through */ }
  }

  const espn = await espnFetchScoreboard(leagueInfo.slug, dateParam);
  if (!espn) return { out: null, failed: true };

  const events = Array.isArray(espn.events) ? espn.events : [];
  const leagueMeta = (Array.isArray(espn.leagues) && espn.leagues[0]) || {};

  const matches = events.map(ev => {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home') || competitors[0] || {};
    const away = competitors.find(c => c.homeAway === 'away') || competitors[1] || {};
    const statusType = (comp.status && comp.status.type) || (ev.status && ev.status.type) || {};
    const iso = String(ev.date || comp.date || '');
    return {
      match_id: ev.id,
      match_date: iso.slice(0, 10),
      match_time: iso.slice(11, 16),
      match_status: statusType.description || statusType.shortDetail || statusType.detail || '',
      match_hometeam_name: (home.team && (home.team.displayName || home.team.name)) || '',
      match_hometeam_logo: (home.team && (home.team.logo || (home.team.logos && home.team.logos[0] && home.team.logos[0].href))) || '',
      match_hometeam_score: home.score != null ? String(home.score) : '',
      match_awayteam_name: (away.team && (away.team.displayName || away.team.name)) || '',
      match_awayteam_logo: (away.team && (away.team.logo || (away.team.logos && away.team.logos[0] && away.team.logos[0].href))) || '',
      match_awayteam_score: away.score != null ? String(away.score) : '',
      broadcasts: collectBroadcastNames(ev, comp),
    };
  }).sort((a, b) => a.match_time.localeCompare(b.match_time));

  const out = {
    country_name: leagueInfo.country_name,
    league_name: leagueMeta.name || leagueInfo.league_name,
    league_logo: (leagueMeta.logos && leagueMeta.logos[0] && leagueMeta.logos[0].href) || '',
    matches,
  };

  const resp = new Response(JSON.stringify(out), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=180' },
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return { out, failed: false };
}

/** تشخیص: وضعیت هر سه میزبان ESPN را برای دو لیگ نمونه برمی‌گرداند (فقط با &diag=1 صدا زده می‌شود). */
async function broadcastDiag(dateParam) {
  const out = [];
  for (const slug of ['eng.1', 'uefa.champions']) {
    for (let i = 0; i < ESPN_HOSTS.length; i++) {
      const h = ESPN_HOSTS[i];
      const row = { slug, host: h.id };
      try {
        const res = await fetch(h.url(slug, dateParam), { headers: ESPN_HEADERS, signal: AbortSignal.timeout(6000) });
        row.status = res.status;
        if (res.ok) {
          const d = unwrapEspn(await res.json());
          row.events = d ? d.events.length : 'bad_shape';
          const ev = d && d.events[0];
          const comp = ev && ev.competitions && ev.competitions[0];
          if (comp) row.sample = { broadcasts: comp.broadcasts, geoBroadcasts: comp.geoBroadcasts, names: collectBroadcastNames(ev, comp) };
        }
      } catch (e) { row.error = String(e && e.message || e); }
      out.push(row);
    }
  }
  return { date: dateParam, results: out };
}

/* ── مسیر تکمیلی: «همهٔ بازی‌های فوتبال یک روز» با یک درخواست (soccer/all) ─────────────
 * بازی‌های هر لیگی که در BROADCAST_LEAGUES نباشد (مثل Nations League یا لیگ‌های کوچک) هم از این مسیر می‌آید
 * و با match_id از بازی‌های لیگ‌محور تکراری‌زدایی می‌شود؛ پس هیچ بازی‌ای به‌خاطر اسلاگ ناقص جا نمی‌ماند. */
function toBroadcastMatch(ev) {
  const comp = (ev.competitions && ev.competitions[0]) || {};
  const competitors = comp.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home') || competitors[0] || {};
  const away = competitors.find(c => c.homeAway === 'away') || competitors[1] || {};
  const statusType = (comp.status && comp.status.type) || (ev.status && ev.status.type) || {};
  const iso = String(ev.date || comp.date || '');
  const logo = (t) => (t && (t.logo || (t.logos && t.logos[0] && t.logos[0].href))) || '';
  return {
    match_id: ev.id,
    match_date: iso.slice(0, 10),
    match_time: iso.slice(11, 16),
    match_status: statusType.description || statusType.shortDetail || statusType.detail || '',
    match_hometeam_name: (home.team && (home.team.displayName || home.team.name)) || '',
    match_hometeam_logo: logo(home.team),
    match_hometeam_score: home.score != null ? String(home.score) : '',
    match_awayteam_name: (away.team && (away.team.displayName || away.team.name)) || '',
    match_awayteam_logo: logo(away.team),
    match_awayteam_score: away.score != null ? String(away.score) : '',
    broadcasts: collectBroadcastNames(ev, comp),
  };
}

async function fetchAllSoccerEvents(dateParam) {
  const q = `lang=en&region=us&limit=500${dateParam ? '&dates=' + dateParam : ''}`;
  const urls = [
    `https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?${q}`,
    `https://site.web.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?${q}`,
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers: ESPN_HEADERS, signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && Array.isArray(j.events)) return j.events;
    } catch (e) { /* میزبان بعدی */ }
  }
  return null; // null = دسترسی نبود؛ [] = واقعاً بازی نبود
}

async function getBroadcastsForDate(dateParam, env, ctx) {
  const allP = fetchAllSoccerEvents(dateParam).catch(() => null);
  // یک بار میزبان سالم را با اولین لیگ پیدا می‌کنیم تا بقیه مستقیم از همان استفاده کنند
  const first = await fetchLeagueBroadcasts(BROADCAST_LEAGUES[0], dateParam, ctx).catch(() => ({ out: null, failed: true }));
  let rest = [];
  if (!first.failed) {
    rest = await Promise.all(
      BROADCAST_LEAGUES.slice(1).map(l => fetchLeagueBroadcasts(l, dateParam, ctx).catch(() => ({ out: null, failed: true })))
    );
  }
  const all = [first, ...rest];
  const groups = all.map(r => r.out).filter(r => r && Array.isArray(r.matches) && r.matches.length);

  // بازی‌هایی که در گروه‌های لیگ‌محور نیامده‌اند را از soccer/all اضافه می‌کنیم
  const events = await allP;
  const seen = new Set();
  groups.forEach(g => g.matches.forEach(m => seen.add(String(m.match_id))));
  const extra = new Map();
  (events || []).forEach(ev => {
    if (!ev || seen.has(String(ev.id))) return;
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const lid = (String(ev.uid || '').match(/~l:(\d+)/) || [])[1] || 'x';
    const note = String(comp.altGameNote || '').split(',')[0].trim();
    if (!extra.has(lid)) extra.set(lid, { country_name: 'World', league_name: note || 'Other Competitions', league_logo: '', matches: [] });
    extra.get(lid).matches.push(toBroadcastMatch(ev));
  });
  const extraGroups = Array.from(extra.values())
    .map(g => Object.assign(g, { matches: g.matches.sort((a, b) => a.match_time.localeCompare(b.match_time)) }))
    .sort((a, b) => a.league_name.localeCompare(b.league_name));

  const failedAll = all.every(r => r.failed) && events === null;
  return { groups: groups.concat(extraGroups), failedAll };
}

/* ═══════════════ لایهٔ «فصل‌محور» و مسیرهای سفارشی (نسخهٔ جدید) ═══════════════
 * هدف: هیچ‌وقت آمار فصل قبل به کاربر نشان داده نشود؛ کاپ‌های حذفی (بدون جدول) درست کار کنند؛
 * H2H / پیش‌بینی / فرم با پارامترهای دقیق مستندات apifootball صدا زده شوند.
 * تمام توابع اینجا throw نمی‌کنند؛ بدترین حالت: آرایهٔ خالی + note (هدر X-Upstream-Message).
 */
const CACHE_VERSION = 'v6'; // مشترک بین همهٔ تب‌ها — دست نزنید
// نسخهٔ کش مخصوص تب «شبکه‌های پخش»؛ برای پاک‌کردن کش همین تب فقط این را عوض کنید
const BROADCAST_CACHE_VERSION = 'bc1';
const FINISHED_STATUS = new Set(['Finished', 'After ET', 'After Pen.', 'Awarded']);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

// یک فراخوانی امن به apifootball؛ همیشه {ok,data,error} برمی‌گرداند.
async function apiCall(action, params, env) {
  try {
    const u = new URL(UPSTREAM);
    u.searchParams.set('action', action);
    Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v); });
    u.searchParams.set('APIkey', env.APIFOOTBALL_KEY);
    const res = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, data: null, error: 'http_' + res.status };
    const raw = await res.json();
    if (raw && !Array.isArray(raw) && typeof raw === 'object' && raw.error !== undefined) {
      return { ok: false, data: null, error: String(raw.message || raw.error).slice(0, 120) };
    }
    return { ok: true, data: raw, error: '' };
  } catch (e) { return { ok: false, data: null, error: String(e && e.message || e) }; }
}

// فصل → بازهٔ تاریخ. «2026/2027» → 2026-06-01..2027-07-31 ؛ «2026» → کل سال.
// اگر فرانت فصل نفرستاد، از تاریخ امروز حدس می‌زنیم (سپتامبر ۲۰۲۶ ⇒ 2026/2027).
function seasonBounds(season, now, exact) {
  now = now || new Date();
  let s = String(season || '').trim();
  let m = s.match(/^(\d{4})\s*\/\s*(\d{4})$/);
  if (!m && /^\d{4}$/.test(s)) return { label: s, from: s + '-01-01', to: s + '-12-31' };
  // حالت آرشیو: فصل گذشتهٔ صریح؛ «نگهبان فصل جاری» نباید آن را به فصل امروز برگرداند
  if (exact && m) return { label: m[1] + '/' + m[2], from: m[1] + '-06-01', to: m[2] + '-07-31' };
  {
    // اگر کاتالوگ هنوز فصل قبل را نشان بدهد (get_leagues دیر آپدیت شود)، هرگز از فصلِ حدس‌زده‌شدهٔ امروز عقب‌تر نمی‌رویم.
    const y = now.getUTCFullYear(), mo = now.getUTCMonth() + 1;
    const y1 = mo >= 7 ? y : y - 1;
    if (!m || parseInt(m[1], 10) < y1) m = [null, String(y1), String(y1 + 1)];
  }
  return { label: m[1] + '/' + m[2], from: m[1] + '-06-01', to: m[2] + '-07-31' };
}

// جدول → Map(team_id → {gf, played}); برای مسابقات چندمرحله‌ای بیشینه را برمی‌داریم.
async function getStandingsMap(leagueId, env) {
  const r = await apiCall('get_standings', { league_id: leagueId }, env);
  const map = new Map();
  if (!r.ok || !Array.isArray(r.data)) return { map, rows: 0, error: r.error };
  r.data.forEach(row => {
    if (!row || row.team_id == null) return;
    const gf = parseInt(row.overall_league_GF) || 0, ga = parseInt(row.overall_league_GA) || 0, pl = parseInt(row.overall_league_payed) || 0;
    const k = String(row.team_id), prev = map.get(k);
    map.set(k, { gf: Math.max(gf, prev ? prev.gf : 0), ga: Math.max(ga, prev ? prev.ga : 0), played: Math.max(pl, prev ? prev.played : 0) });
  });
  return { map, rows: r.data.length, error: '' };
}

/* آمار را از خودِ بازی‌های همین فصل می‌سازد (goalscorer / cards در get_events) — چون بازه‌ی تاریخ
 * دارد، ذاتاً نمی‌تواند فصل قبل باشد. فقط وقتی استفاده می‌شود که آمار آماده‌ی API رد شود یا لیگ جدول نداشته باشد. */
async function aggregateSeasonStats(leagueId, season, env, exact) {
  const b = seasonBounds(season, undefined, exact);
  const y0 = parseInt(b.label.slice(0, 4), 10);
  const today = ymd(addDays(new Date(), 1));
  const to = b.to < today ? b.to : today;
  const r = await apiCall('get_events', { league_id: leagueId, from: b.from, to }, env);
  const players = new Map();
  const get = (id, name, teamId, teamName, badge) => {
    const key = String(id || name);
    if (!players.has(key)) players.set(key, { player_key: id || key, player_name: name, team_key: teamId, team_name: teamName, team_badge: badge || null, goals: 0, assists: 0, penalty_goals: 0, yellow: 0, red: 0 });
    return players.get(key);
  };
  let matches = 0;
  if (r.ok && Array.isArray(r.data)) {
    r.data.forEach(m => {
      if (!m || !FINISHED_STATUS.has(m.match_status) && m.match_live !== '1') return;
      if (exact && !lyMatches(m.league_year, y0)) return; // آرشیو: فقط رویدادهای دقیقاً همین فصل
      matches++;
      const side = (s) => s === 'home'
        ? [m.match_hometeam_id, m.match_hometeam_name, m.team_home_badge]
        : [m.match_awayteam_id, m.match_awayteam_name, m.team_away_badge];
      (m.goalscorer || []).forEach(g => {
        ['home', 'away'].forEach(sd => {
          const nm = g[sd + '_scorer'];
          if (!nm || /o\.?\s?g\.?|own/i.test(String(g.info || ''))) return;
          const [tid, tn, tb] = side(sd);
          const p = get(g[sd + '_scorer_id'], nm, tid, tn, tb);
          p.goals++;
          if (/pen/i.test(String(g.info || ''))) p.penalty_goals++;
          const an = g[sd + '_assist'];
          if (an) get(g[sd + '_assist_id'], an, tid, tn, tb).assists++;
        });
      });
      (m.cards || []).forEach(c => {
        ['home', 'away'].forEach(sd => {
          const nm = c[sd + '_fault'];
          if (!nm) return;
          const [tid, tn, tb] = side(sd);
          const p = get(c[sd + '_player_id'], nm, tid, tn, tb);
          if (/red/i.test(String(c.card || ''))) p.red++; else p.yellow++;
        });
      });
    });
  }
  return { players: [...players.values()], matches, season: b.label, error: r.error };
}

async function topscorersHandler(q, env, ctx) {
  if (archiveLabel(q)) return topscorersArchive(q, env, ctx);
  const season = seasonBounds(q.season).label;
  const [api, st] = await Promise.all([
    apiCall('get_topscorers', { league_id: q.league_id }, env),
    getStandingsMap(q.league_id, env),
  ]);
  const list = api.ok && Array.isArray(api.data) ? api.data : [];
  let stale = false, reason = '';
  if (!st.rows) { stale = true; reason = 'no_standings(cup)'; }
  else {
    const totalGF = [...st.map.values()].reduce((a, x) => a + x.gf, 0);
    let bad = 0;
    list.forEach(p => { const t = st.map.get(String(p.team_key)); if (t && (parseInt(p.goals) || 0) > t.gf) bad++; });
    if (list.length && totalGF === 0) { stale = true; reason = 'season_not_started_but_scorers_have_goals'; }
    else if (bad >= Math.min(2, list.length || 1) && list.length) { stale = true; reason = 'goals_exceed_team_GF x' + bad; }
    else if (!list.length && totalGF > 0) { stale = true; reason = 'api_empty_but_season_has_goals'; }
  }
  let out = list, source = 'api';
  if (stale) {
    const agg = await aggregateSeasonStats(q.league_id, season, env);
    source = 'season_events(' + agg.matches + ' matches)';
    out = agg.players.filter(p => p.goals > 0)
      .sort((a, b) => b.goals - a.goals || b.assists - a.assists).slice(0, 50)
      .map((p, i) => ({ player_place: String(i + 1), player_name: p.player_name, player_key: p.player_key, team_name: p.team_name, team_key: String(p.team_key), team_badge: p.team_badge, goals: String(p.goals), assists: String(p.assists), penalty_goals: String(p.penalty_goals) }));
  }
  const data = await enrichTopscorers(out, env, ctx);
  return { data, note: api.ok ? '' : api.error, ttl: data.length ? 300 : 30, diag: { season, source, stale, reason, apiRows: list.length, standingsRows: st.rows, first: list.slice(0, 3), apiError: api.error, standingsError: st.error } };
}

async function leaguestatsHandler(q, env, ctx) {
  if (archiveLabel(q)) return leaguestatsArchive(q, env, ctx);
  const season = seasonBounds(q.season).label;
  const [api, st] = await Promise.all([
    apiCall('get_teams', { league_id: q.league_id }, env),
    getStandingsMap(q.league_id, env),
  ]);
  const flat = api.ok && Array.isArray(api.data) ? flattenLeagueRoster(api.data) : [];
  let stale = false, reason = '';
  if (!st.rows) { stale = true; reason = 'no_standings(cup)'; }
  else {
    let bad = 0;
    flat.forEach(p => {
      const t = st.map.get(String(p.team_key)); if (!t) return;
      if ((parseInt(p.player_match_played) || 0) > t.played || (parseInt(p.player_goals) || 0) > t.gf) bad++;
    });
    if (bad >= 2) { stale = true; reason = 'roster_stats_exceed_team_totals x' + bad; }
  }
  let out = flat, source = 'api';
  if (stale) {
    const agg = await aggregateSeasonStats(q.league_id, season, env);
    source = 'season_events(' + agg.matches + ' matches)';
    const top = new Map();
    agg.players.filter(p => p.assists > 0).sort((a, b) => b.assists - a.assists).slice(0, 30).forEach(p => top.set(String(p.player_key), p));
    agg.players.filter(p => p.yellow + p.red > 0).sort((a, b) => b.red - a.red || b.yellow - a.yellow).slice(0, 30).forEach(p => top.set(String(p.player_key), p));
    out = await enrichTopscorers([...top.values()].map(p => ({ player_key: p.player_key, player_name: p.player_name, player_image: null, player_number: '', player_type: '', player_match_played: '', player_goals: String(p.goals), player_assists: String(p.assists), player_yellow_cards: String(p.yellow), player_red_cards: String(p.red), player_rating: '', team_key: String(p.team_key), team_name: p.team_name, team_badge: p.team_badge })), env, ctx);
  }
  return { data: out, note: api.ok ? '' : api.error, ttl: out.length ? 900 : 30, diag: { season, source, stale, reason, rosterPlayers: flat.length, standingsRows: st.rows, apiError: api.error } };
}

// H2H طبق مستندات: firstTeamId/secondTeamId یا firstTeam/secondTeam (نام). اگر با id خالی بود، با نام هم تلاش می‌کنیم.
async function h2hHandler(q, env) {
  const empty = { firstTeam_VS_secondTeam: [], firstTeam_lastResults: [], secondTeam_lastResults: [] };
  const hasData = (d) => d && !Array.isArray(d) && ['firstTeam_VS_secondTeam', 'firstTeam_lastResults', 'secondTeam_lastResults'].some(k => Array.isArray(d[k]) && d[k].length);
  const attempts = [];
  if (q.firstTeamId && q.secondTeamId) attempts.push({ firstTeamId: q.firstTeamId, secondTeamId: q.secondTeamId });
  if (q.firstTeam && q.secondTeam) attempts.push({ firstTeam: q.firstTeam, secondTeam: q.secondTeam });
  if (!attempts.length) return { data: empty, note: 'missing_team_params', ttl: 30 };
  let err = '';
  for (const a of attempts) {
    const r = await apiCall('get_H2H', Object.assign({}, a, q.timezone ? { timezone: q.timezone } : {}), env);
    if (r.ok && hasData(r.data)) return { data: limitH2H(r.data), note: '', ttl: HOUR };
    if (!r.ok) err = r.error;
  }
  return { data: empty, note: err || 'no_h2h_history', ttl: err ? 30 : 600 };
}

// Predictions: مستندات from/to را تعریف کرده و فقط با match_id تنها روی همه‌ی پلن‌ها/شرایط پایدار نیست.
// پس تاریخ بازی را پیدا می‌کنیم و پنجرهٔ ±۱ روز (به‌خاطر اختلاف timezone) می‌فرستیم، سپس روی match_id فیلتر می‌کنیم.
async function predictionsHandler(q, env) {
  let center = q.match_date && /^\d{4}-\d{2}-\d{2}$/.test(q.match_date) ? q.match_date : '';
  if (!center && q.match_id && !(q.from && q.to)) {
    const ev = await apiCall('get_events', { match_id: q.match_id }, env);
    const m = ev.ok && Array.isArray(ev.data) ? ev.data[0] : null;
    if (m) { center = m.match_date; q.league_id = q.league_id || m.league_id; }
  }
  let from = q.from, to = q.to;
  if (center) { const d = new Date(center + 'T00:00:00Z'); from = ymd(addDays(d, -1)); to = ymd(addDays(d, 1)); }
  if (!from || !to) return { data: [], note: 'cannot_resolve_match_date', ttl: 30 };
  const tries = [
    { from, to, match_id: q.match_id, league_id: q.league_id, country_id: q.country_id },
    { from, to, league_id: q.league_id, country_id: q.country_id },
  ];
  let err = '';
  for (const p of tries) {
    const r = await apiCall('get_predictions', p, env);
    if (!r.ok) { err = r.error; continue; }
    const arr = Array.isArray(r.data) ? r.data : [];
    const hit = q.match_id ? arr.filter(x => String(x.match_id) === String(q.match_id)) : arr;
    if (hit.length) return { data: hit, note: '', ttl: 600 };
  }
  return { data: [], note: err || 'no_prediction_for_match', ttl: 60 };
}

// فرم ۵ بازی اخیر: فقط بازی‌های تمام‌شدهٔ ۶۰ روز اخیر، با فیلدهای حداقلی (کوچک و قابل کش).
async function formHandler(q, env) {
  const now = new Date();
  const r = await apiCall('get_events', { league_id: q.league_id, from: ymd(addDays(now, -60)), to: ymd(now), timezone: q.timezone }, env);
  const arr = r.ok && Array.isArray(r.data) ? r.data : [];
  const data = arr.filter(m => m && FINISHED_STATUS.has(m.match_status)).map(m => ({
    match_id: m.match_id, match_date: m.match_date, match_time: m.match_time, match_status: m.match_status,
    match_hometeam_id: m.match_hometeam_id, match_hometeam_name: m.match_hometeam_name, match_hometeam_score: m.match_hometeam_score,
    match_awayteam_id: m.match_awayteam_id, match_awayteam_name: m.match_awayteam_name, match_awayteam_score: m.match_awayteam_score,
  }));
  return { data, note: r.ok ? '' : r.error, ttl: data.length ? 600 : 30 };
}

/* ============================================================================
 * فاز ۱ — تب‌های جدید لیگ: cleansheets / toprated / overview / bracket
 * همه‌ی آمارِ مبتنی بر بازی از یک «اسنپ‌شات فشردهٔ رویدادهای فصل» ساخته می‌شود (یک فراخوانی
 * get_events با from/to؛ ذاتاً فقط همان فصل) که در کش لبه مشترک است تا ۴ تب فقط یک‌بار به
 * apifootball بروند. هیچ‌کدام از هندلرهای قبلی تغییر نکرده‌اند.
 * ========================================================================== */
const REGULAR_FINISHED = 'Finished'; // وضعیت ۹۰ دقیقه‌ای؛ After ET / After Pen. عمداً از آمار گل/کلین‌شیت کنار گذاشته می‌شوند (مبهم بودن معنای score)
const numOrNull = (v) => (v === '' || v == null || isNaN(Number(v))) ? null : parseInt(v, 10);

function slimEvent(m) {
  const lu = m.lineup || {};
  const gkOf = (side) => {
    const s = lu[side] && Array.isArray(lu[side].starting_lineups) ? lu[side].starting_lineups : [];
    const g = s.find(p => p && String(p.lineup_position) === '1');
    return g ? { id: String(g.player_key || ''), name: g.lineup_player || '' } : null;
  };
  const outIds = (side) => {
    const s = m.substitutions && Array.isArray(m.substitutions[side]) ? m.substitutions[side] : [];
    return s.map(x => String((x && x.substitution_player_id || '').split('|')[0]).trim()).filter(Boolean); // فرمت مستندات: «خارج | داخل»
  };
  return {
    id: m.match_id, date: m.match_date, time: m.match_time, status: m.match_status || '',
    round: m.match_round || '', stage: m.stage_name || '', ly: m.league_year || '',
    hid: String(m.match_hometeam_id || ''), hn: m.match_hometeam_name || '', hb: m.team_home_badge || null,
    aid: String(m.match_awayteam_id || ''), an: m.match_awayteam_name || '', ab: m.team_away_badge || null,
    hs: numOrNull(m.match_hometeam_score), as: numOrNull(m.match_awayteam_score),
    hp: numOrNull(m.match_hometeam_penalty_score), ap: numOrNull(m.match_awayteam_penalty_score),
    gkh: gkOf('home'), gka: gkOf('away'), outh: outIds('home'), outa: outIds('away'),
  };
}

async function getSeasonEvents(leagueId, season, env, ctx, exact) {
  const b = seasonBounds(season, undefined, exact);
  const cache = caches.default;
  const key = new Request('https://internal.cache/season-events/v1/' + encodeURIComponent(leagueId) + '/' + b.label.replace('/', '-'), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) { try { const d = await hit.json(); if (d && Array.isArray(d.events)) return d; } catch (e) { /* ادامه */ } }
  const today = ymd(addDays(new Date(), 1));
  const to = b.to; // کل فصل (برنامهٔ آینده هم برای نمودار حذفی لازم است)
  const r = await apiCall('get_events', { league_id: leagueId, from: b.from, to }, env);
  const y0 = parseInt(b.label.slice(0, 4), 10);
  const events = (r.ok && Array.isArray(r.data) ? r.data : [])
    .filter(m => m && m.match_id && m.match_date >= b.from && m.match_date <= b.to)
    .filter(m => { const ly = parseInt(String(m.league_year || '').slice(0, 4), 10); return !ly || ly >= y0; }) // نشت فصل قبل ممنوع
    .filter(m => !exact || lyMatches(m.league_year, y0)) // آرشیو: نشت فصل بعد هم ممنوع
    .map(slimEvent)
    .sort((x, y) => (x.date + ' ' + x.time).localeCompare(y.date + ' ' + y.time));
  const payload = { label: b.label, error: r.ok ? '' : r.error, events };
  const ttl = events.length ? (exact ? 21600 : 300) : (exact ? 300 : 60);
  if (r.ok) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + ttl } })));
  return payload;
}

// رُستر معتبر است؟ (همان منطق نگهبان فصل leaguestats + «فصل هنوز شروع نشده»)
function rosterStaleReason(teams, st) {
  if (!st.rows) return 'no_standings(cup)';
  let played = 0; st.map.forEach(t => { played += t.played; });
  if (!played) return 'season_not_started';
  let bad = 0;
  (Array.isArray(teams) ? teams : []).forEach(team => {
    const t = st.map.get(String(team && team.team_key)); if (!t) return;
    (team.players || []).forEach(p => {
      if (!p) return;
      const mp = parseInt(p.player_match_played) || 0, g = parseInt(p.player_goals) || 0, gc = parseInt(p.player_goals_conceded) || 0;
      if (mp > t.played || g > t.gf || (/goalkeeper/i.test(p.player_type || '') && gc > t.ga)) bad++;
    });
  });
  return bad >= 2 ? 'roster_stats_exceed_team_totals x' + bad : '';
}

function buildGkRows(se, savesByKey, gks) {
  se.events.forEach(m => {
    if (m.status !== REGULAR_FINISHED || m.hs == null || m.as == null) return;
    [['h', m.gkh, m.outh, m.hid, m.hn, m.hb, m.as], ['a', m.gka, m.outa, m.aid, m.an, m.ab, m.hs]].forEach(([, gk, outs, tid, tn, tb, conceded]) => {
      if (!gk || !gk.id) return;
      let g = gks.get(gk.id);
      if (!g) { g = { player_key: gk.id, player_name: gk.name, team_key: tid, team_name: tn, team_badge: tb, starts: 0, full: 0, cs: 0, ga: 0 }; gks.set(gk.id, g); }
      g.team_key = tid; g.team_name = tn; g.team_badge = tb; // آخرین تیم
      g.starts++;
      if (outs.indexOf(gk.id) !== -1) return; // تعویض شده → بازی کامل نیست
      g.full++; g.ga += conceded; if (conceded === 0) g.cs++;
    });
  });
  let rows = [...gks.values()].filter(g => g.full > 0)
    .sort((a, b) => b.cs - a.cs || (a.ga / a.full) - (b.ga / b.full) || b.full - a.full)
    .slice(0, 30)
    .map(g => ({
      player_key: g.player_key, player_name: g.player_name, player_image: null,
      team_key: g.team_key, team_name: g.team_name, team_badge: g.team_badge,
      clean_sheets: g.cs, matches: g.full, goals_conceded: g.ga,
      avg_conceded: (g.ga / g.full).toFixed(2),
      saves: savesByKey.has(g.player_key) ? savesByKey.get(g.player_key) : null,
    }));
  return rows;
}

/* ---- کلین‌شیت دروازه‌بان‌ها ----
 * کلین‌شیت = دروازه‌بانِ ثابت (lineup_position=1) کل بازی ۹۰ دقیقه‌ای را بازی کرده (تعویض نشده) و تیمش گل نخورده.
 * میانگین گل خورده = گل‌های خورده ÷ بازی‌های کاملِ او. سیو فقط از رُسترِ تأییدشده (get_teams: player_saves). */
async function cleansheetsHandler(q, env, ctx) {
  const arch = archiveLabel(q);
  if (arch) { // آرشیو: فقط از بازی‌های همان فصل؛ سیو (رُستر فعلی) عمداً حذف می‌شود تا هیچ آمار فصل جاری نشت نکند
    const seA = await getSeasonEvents(q.league_id, arch, env, ctx, true);
    let rowsA = buildGkRows(seA, new Map(), new Map());
    rowsA = await enrichTopscorers(rowsA, env, ctx);
    return { data: rowsA, note: seA.error, ttl: rowsA.length ? 21600 : 60 };
  }
  const [se, teamsR, st] = await Promise.all([
    getSeasonEvents(q.league_id, q.season, env, ctx),
    apiCall('get_teams', { league_id: q.league_id }, env),
    getStandingsMap(q.league_id, env),
  ]);
  const stale = teamsR.ok ? rosterStaleReason(teamsR.data, st) : 'teams_error';
  const savesByKey = new Map();
  if (!stale) (teamsR.data || []).forEach(t => (t.players || []).forEach(p => {
    if (p && /goalkeeper/i.test(p.player_type || '')) savesByKey.set(String(p.player_key), parseInt(p.player_saves) || 0);
  }));
  const gks = new Map();
  let rows = buildGkRows(se, savesByKey, gks);
  rows = await enrichTopscorers(rows, env, ctx);
  return { data: rows, note: se.error, ttl: rows.length ? 300 : 30, diag: { season: se.label, events: se.events.length, rosterStale: stale, gks: gks.size } };
}

/* ---- برترین نمرات ---- میانگین فصلی player_rating از get_teams؛ فقط با رُستر تأییدشدهٔ همین فصل. */
async function topratedHandler(q, env, ctx) {
  const [teamsR, st] = await Promise.all([apiCall('get_teams', { league_id: q.league_id }, env), getStandingsMap(q.league_id, env)]);
  if (!teamsR.ok || !Array.isArray(teamsR.data)) return { data: [], note: teamsR.error, ttl: 30, diag: { error: teamsR.error } };
  const stale = rosterStaleReason(teamsR.data, st);
  if (stale) return { data: [], note: 'rating_unavailable:' + stale, ttl: 120, diag: { stale } }; // ترجیحِ «خالی» به «آمار فصل قبل»
  let maxPlayed = 0; st.map.forEach(t => { if (t.played > maxPlayed) maxPlayed = t.played; });
  const minApps = Math.max(1, Math.ceil(maxPlayed * 0.4)); // حذف نمرات بازیکنانِ با ۱–۲ بازی
  const rows = [];
  teamsR.data.forEach(team => (team && team.players || []).forEach(p => {
    if (!p || !p.player_name) return;
    const rt = parseFloat(p.player_rating), mp = parseInt(p.player_match_played) || 0;
    if (!(rt > 0) || mp < minApps) return;
    rows.push({ player_key: p.player_key, player_name: p.player_name, player_image: p.player_image || null, player_type: p.player_type || '',
      player_rating: rt.toFixed(2), player_match_played: String(mp), player_goals: String(parseInt(p.player_goals) || 0), player_assists: String(parseInt(p.player_assists) || 0),
      team_key: String(team.team_key), team_name: team.team_name, team_badge: team.team_badge || null });
  }));
  rows.sort((a, b) => parseFloat(b.player_rating) - parseFloat(a.player_rating) || b.player_match_played - a.player_match_played || b.player_goals - a.player_goals);
  const out = await enrichTopscorers(rows.slice(0, 30), env, ctx);
  return { data: out, note: '', ttl: out.length ? 900 : 60, diag: { minApps, candidates: rows.length } };
}

/* ---- آمار کلی لیگ ---- فقط بازی‌های «Finished» (۹۰ دقیقه‌ای)؛ زنجیره با هر بازیِ غیرعادی (ET/پنالتی) قطع می‌شود. */
async function overviewHandler(q, env, ctx) {
  const arch = archiveLabel(q);
  const se = await getSeasonEvents(q.league_id, arch || q.season, env, ctx, !!arch);
  const fin = se.events.filter(m => m.status === REGULAR_FINISHED && m.hs != null && m.as != null);
  if (!fin.length) return { data: {}, note: se.error, ttl: 60 };
  let goals = 0, hw = 0, dr = 0, aw = 0, btts = 0, o25 = 0, cs = 0, best = null, bestTies = 0, biggest = null;
  fin.forEach(m => {
    const tot = m.hs + m.as; goals += tot;
    if (m.hs > m.as) hw++; else if (m.hs < m.as) aw++; else dr++;
    if (m.hs > 0 && m.as > 0) btts++; if (tot > 2) o25++; if (m.hs === 0 || m.as === 0) cs++;
    if (!best || tot > best.tot) { best = { m, tot }; bestTies = 1; } else if (tot === best.tot) { best = { m, tot }; bestTies++; } // در تساوی: جدیدترین
    const diff = Math.abs(m.hs - m.as);
    if (diff > 0 && (!biggest || diff > biggest.diff || (diff === biggest.diff && m.hs + m.as > biggest.tot))) biggest = { m, diff, tot: m.hs + m.as };
  });
  const n = fin.length, pct = (x) => Math.round(x / n * 1000) / 10;
  const matchView = (m) => ({ match_id: m.id, match_date: m.date, match_hometeam_name: m.hn, match_awayteam_name: m.an, team_home_badge: m.hb, team_away_badge: m.ab, match_hometeam_score: String(m.hs), match_awayteam_score: String(m.as) });
  // زنجیره‌ها: برای هر تیم به‌ترتیب زمانی (کل بازی‌های تمام‌شده/زنده‌نشده؛ ET/پنالتی زنجیره را می‌شکند)
  const seq = new Map();
  se.events.forEach(m => {
    if (m.status !== REGULAR_FINISHED && m.status !== 'After ET' && m.status !== 'After Pen.' && m.status !== 'Awarded') return;
    [[m.hid, m.hn, m.hb, m.hs, m.as], [m.aid, m.an, m.ab, m.as, m.hs]].forEach(([id, nm, bd, f, a]) => {
      if (!id) return;
      if (!seq.has(id)) seq.set(id, { id, nm, bd, r: [] });
      const t = seq.get(id); t.nm = nm; t.bd = bd;
      t.r.push({ d: m.date, res: m.status !== REGULAR_FINISHED || f == null || a == null ? 'X' : f > a ? 'W' : f < a ? 'L' : 'D' });
    });
  });
  const streak = (kind) => {
    let top = null;
    seq.forEach(t => {
      let c = 0, from = '';
      t.r.forEach((x, i) => {
        if (x.res === kind) { if (!c) from = x.d; c++; } else c = 0;
        const ongoing = i === t.r.length - 1 && c > 0;
        if (c > 0 && (!top || c > top.count || (c === top.count && ((ongoing && !top.ongoing) || (ongoing === top.ongoing && x.d > top.to))))) {
          top = { team_key: t.id, team_name: t.nm, team_badge: t.bd, count: c, from, to: x.d, ongoing };
        }
      });
    });
    return top;
  };
  return { data: {
    matches: n, goals, avg_goals: Math.round(goals / n * 100) / 100,
    avg_home_goals: Math.round(fin.reduce((s, m) => s + m.hs, 0) / n * 100) / 100,
    avg_away_goals: Math.round(fin.reduce((s, m) => s + m.as, 0) / n * 100) / 100,
    home_wins: hw, draws: dr, away_wins: aw, home_pct: pct(hw), draw_pct: pct(dr), away_pct: pct(aw),
    btts_pct: pct(btts), over25_pct: pct(o25), clean_sheet_pct: pct(cs),
    highest_scoring: Object.assign(matchView(best.m), { total_goals: best.tot, tied_count: bestTies }),
    biggest_win: biggest ? Object.assign(matchView(biggest.m), { margin: biggest.diff }) : null,
    longest_win_streak: streak('W'), longest_loss_streak: streak('L'),
  }, note: se.error, ttl: arch ? 21600 : 300 };
}

/* ---- نمودار حذفی ---- دور = stage_name (به‌جز «Current») وگرنه match_round؛ رفت‌وبرگشت با جفتِ تیم تجمیع می‌شود. */
const KO_ROUND_RE = /final|semi|quarter|round of|1\/\d+|play-?offs?|preliminar|qualif|knockout|last \d+|\d+(st|nd|rd|th)\s+round|round\s*\d+|third|3rd|eighth|sixteen/i;
const GROUP_RE = /group|league (phase|stage)|matchday|regular season/i;
function buildTie(ms) {
  const first = ms[0];
  const A = { team_key: first.hid, team_name: first.hn, team_badge: first.hb }, B = { team_key: first.aid, team_name: first.an, team_badge: first.ab };
  const legs = ms.map(m => {
    const flip = m.hid !== A.team_key; // جهت‌دهی نسبت به تیم A
    const g = (h, a) => flip ? [a, h] : [h, a];
    const [sa, sb] = g(m.hs, m.as), [pa, pb] = g(m.hp, m.ap);
    const done = FINISHED_STATUS.has(m.status);
    return { match_id: m.id, match_date: m.date, match_time: m.time, status: m.status, done, score_a: done ? sa : null, score_b: done ? sb : null, pen_a: pa, pen_b: pb };
  });
  const need = ms.length >= 2 ? 2 : 1; // رفت‌وبرگشت
  let winner = null, by = '', aggA = null, aggB = null;
  if (legs.length && legs.every(l => l.done) && legs.length >= need) {
    aggA = legs.reduce((s, l) => s + (l.score_a || 0), 0); aggB = legs.reduce((s, l) => s + (l.score_b || 0), 0);
    const last = legs[legs.length - 1], hasPen = last.pen_a != null && last.pen_b != null && (last.pen_a + last.pen_b) > 0;
    if (last.status === 'After Pen.' && hasPen && last.pen_a !== last.pen_b) { winner = last.pen_a > last.pen_b ? 'a' : 'b'; by = 'pen'; }
    else if (aggA !== aggB) { winner = aggA > aggB ? 'a' : 'b'; by = legs.length > 1 ? 'agg' : (last.status === 'After ET' ? 'aet' : 'score'); }
    else if (hasPen && last.pen_a !== last.pen_b) { winner = last.pen_a > last.pen_b ? 'a' : 'b'; by = 'pen'; }
  }
  return { team_a: A, team_b: B, legs, agg_a: legs.length > 1 ? aggA : null, agg_b: legs.length > 1 ? aggB : null, winner, decided_by: by };
}
async function bracketHandler(q, env, ctx) {
  const arch = archiveLabel(q);
  const se = await getSeasonEvents(q.league_id, arch || q.season, env, ctx, !!arch);
  const byRound = new Map();
  se.events.forEach(m => {
    if (!m.hid || !m.aid) return;
    const label = (m.stage && m.stage !== 'Current' ? m.stage : m.round || '').trim();
    if (!label || GROUP_RE.test(label) || /^\d+$/.test(label) || !KO_ROUND_RE.test(label)) return;
    if (!byRound.has(label)) byRound.set(label, []);
    byRound.get(label).push(m);
  });
  const rounds = [], third = [];
  byRound.forEach((ms, label) => {
    const pairs = new Map();
    ms.forEach(m => { const k = [m.hid, m.aid].sort().join('|'); if (!pairs.has(k)) pairs.set(k, []); pairs.get(k).push(m); });
    const ties = [...pairs.values()].map(buildTie);
    const entry = { round: label, first_date: ms[0].date, ties };
    if (/third|3rd/i.test(label)) third.push(entry); else rounds.push(entry);
  });
  rounds.sort((a, b) => a.first_date.localeCompare(b.first_date));
  return { data: { rounds, third_place: third[0] || null, season: se.label }, note: se.error, ttl: rounds.length ? (arch ? 21600 : 300) : 60 };
}

/* ============================================================================
 * فاز ۲ — دادهٔ مودال بازیکن و تیم: /api/playerlog  و  /api/teamstats
 * فقط فیلدهایی که در مستندات apiv3 واقعاً وجود دارند خوانده می‌شوند (ارزش بازار، پایان قرارداد، قد/وزن،
 * پای تخصصی، تاریخ بازگشت از مصدومیت و نقل‌وانتقالات در API نیستند → هرگز جعل نمی‌شوند).
 * ========================================================================== */
function zonedEpoch(date, time, tz) {
  const d = String(date || '').split('-').map(Number), h = String(time || '').split(':').map(Number);
  if (d.length < 3 || d.some(isNaN) || h.length < 2 || h.some(isNaN)) return null;
  const want = Date.UTC(d[0], d[1] - 1, d[2], h[0], h[1]);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    const asZone = (ts) => { const o = {}; fmt.formatToParts(new Date(ts)).forEach(p => { o[p.type] = +p.value; }); return Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute); };
    let ts = want; ts = want - (asZone(ts) - ts); ts = want - (asZone(ts) - ts);
    return ts;
  } catch (e) { return null; }
}
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return !!tz; } catch (e) { return false; } };
const statOf = (m, type, side) => { const s = (m.statistics || []).find(x => x && x.type === type); return s ? s[side] : ''; };
const pctNum = (v) => { const n = parseFloat(String(v == null ? '' : v).replace('%', '')); return isNaN(n) ? null : n; };
const regularScore = (m, side) => { // نتیجهٔ ۹۰ دقیقه: برای ET/پنالتی از ft_score استفاده می‌شود
  const ft = numOrNull(side === 'h' ? m.match_hometeam_ft_score : m.match_awayteam_ft_score);
  const sc = numOrNull(side === 'h' ? m.match_hometeam_score : m.match_awayteam_score);
  return (m.match_status === 'Finished') ? sc : (ft != null ? ft : null);
};

async function teamEvents(teamId, season, tz, env, extra) {
  const b = seasonBounds(season), y0 = parseInt(b.label.slice(0, 4), 10);
  const p = Object.assign({ team_id: teamId, from: b.from, to: b.to }, extra || {});
  if (tz) p.timezone = tz;
  const r = await apiCall('get_events', p, env);
  const ev = (r.ok && Array.isArray(r.data) ? r.data : [])
    .filter(m => m && m.match_id && m.match_date >= p.from && m.match_date <= p.to)
    .filter(m => { const ly = parseInt(String(m.league_year || '').slice(0, 4), 10); return !ly || ly >= y0; });
  return { events: ev, error: r.ok ? '' : r.error, label: b.label };
}

async function teamstatsHandler(q, env, ctx) {
  const tz = validTz(q.timezone) ? q.timezone : 'Europe/Berlin';
  const te = await teamEvents(q.team_id, q.season, tz, env);
  const id = String(q.team_id);
  const mine = te.events.filter(m => String(m.match_hometeam_id) === id || String(m.match_awayteam_id) === id)
    .sort((a, b) => (a.match_date + ' ' + a.match_time).localeCompare(b.match_date + ' ' + b.match_time));
  const view = (m) => {
    const home = String(m.match_hometeam_id) === id;
    return { match_id: m.match_id, match_date: m.match_date, match_time: m.match_time, is_home: home,
      team_name: home ? m.match_awayteam_name : m.match_hometeam_name, team_badge: home ? m.team_away_badge : m.team_home_badge,
      league_name: m.league_name || '', kickoff_ts: zonedEpoch(m.match_date, m.match_time, tz) };
  };
  const now = Date.now();
  const skip = new Set(['Postponed', 'Cancelled', 'Awarded']);
  const next = mine.find(m => !FINISHED_STATUS.has(m.match_status) && !skip.has(m.match_status) && (zonedEpoch(m.match_date, m.match_time, tz) || 0) >= now - 3 * 3600000);
  const done = mine.filter(m => m.match_status === REGULAR_FINISHED || m.match_status === 'After ET' || m.match_status === 'After Pen.');
  // فرم: ۵ بازی اخیر (ET/پنالتی بر اساس نتیجهٔ ۹۰ دقیقه)
  const form = done.slice(-5).reverse().map(m => {
    const home = String(m.match_hometeam_id) === id, f = regularScore(m, home ? 'h' : 'a'), a = regularScore(m, home ? 'a' : 'h');
    return f == null || a == null ? null : (f > a ? 'W' : f < a ? 'L' : 'D');
  }).filter(Boolean);
  // آمار تحلیلی: فقط بازی‌های «Finished» (۹۰ دقیقه‌ای)؛ همهٔ رقابت‌های همین فصل
  const fin = done.filter(m => m.match_status === REGULAR_FINISHED);
  let cs = 0, gf = 0, ga = 0, h1f = 0, h1a = 0, h2f = 0, h2a = 0, htN = 0, posSum = 0, posN = 0, shots = 0, shotsGoals = 0, shotsN = 0, sot = 0;
  fin.forEach(m => {
    const home = String(m.match_hometeam_id) === id, sd = home ? 'home' : 'away';
    const f = numOrNull(home ? m.match_hometeam_score : m.match_awayteam_score), a = numOrNull(home ? m.match_awayteam_score : m.match_hometeam_score);
    if (f == null || a == null) return;
    gf += f; ga += a; if (a === 0) cs++;
    const hf = numOrNull(home ? m.match_hometeam_halftime_score : m.match_awayteam_halftime_score), ha = numOrNull(home ? m.match_awayteam_halftime_score : m.match_hometeam_halftime_score);
    if (hf != null && ha != null && hf <= f && ha <= a) { htN++; h1f += hf; h1a += ha; h2f += f - hf; h2a += a - ha; }
    const pos = pctNum(statOf(m, 'Ball Possession', sd)); if (pos != null) { posSum += pos; posN++; }
    const sh = pctNum(statOf(m, 'Shots Total', sd)); if (sh != null) { shots += sh; shotsGoals += f; shotsN++; const on = pctNum(statOf(m, 'Shots On Goal', sd)); if (on != null) sot += on; }
  });
  const r1 = (x) => Math.round(x * 10) / 10;
  return { data: {
    season: te.label, next_match: next ? view(next) : null, form,
    analytics: {
      matches: fin.length, played_all: done.length, goals_for: gf, goals_against: ga, clean_sheets: cs,
      avg_possession: posN ? r1(posSum / posN) : null, possession_matches: posN,
      half_matches: htN, h1_for: h1f, h1_against: h1a, h2_for: h2f, h2_against: h2a,
      shots_total: shotsN ? shots : null, shots_on_target: shotsN ? sot : null, shot_matches: shotsN,
      shot_conversion: shotsN && shots > 0 ? r1(shotsGoals / shots * 100) : null,
    },
  }, note: te.error, ttl: mine.length ? 300 : 60 };
}

async function playerlogHandler(q, env, ctx) {
  const tz = 'Europe/Berlin';
  const b = seasonBounds(q.season), today = ymd(addDays(new Date(), 1));
  const from = ymd(addDays(new Date(), -150)) > b.from ? ymd(addDays(new Date(), -150)) : b.from; // آخرین ~۵ ماه کافی است (وزن پاسخ کم می‌ماند)
  const to = b.to < today ? b.to : today;
  const r = await apiCall('get_events', { team_id: q.team_id, from, to, withPlayerStats: '1', timezone: tz }, env);
  const y0 = parseInt(b.label.slice(0, 4), 10), tid = String(q.team_id), pid = String(q.player_id);
  const evs = (r.ok && Array.isArray(r.data) ? r.data : [])
    .filter(m => m && m.match_id && FINISHED_STATUS.has(m.match_status) && m.match_status !== 'Awarded')
    .filter(m => { const ly = parseInt(String(m.league_year || '').slice(0, 4), 10); return !ly || ly >= y0; })
    .sort((a, c) => (c.match_date + ' ' + c.match_time).localeCompare(a.match_date + ' ' + a.match_time))
    .slice(0, 14);
  // آمار بازیکنان: اول از خود get_events(withPlayerStats)، اگر نبود از get_statistics (طبق مستندات)
  const statsFor = async (m) => {
    if (Array.isArray(m.player_statistics) && m.player_statistics.length) return m.player_statistics;
    const s = await apiCall('get_statistics', { match_id: m.match_id }, env);
    const node = s.ok && s.data && !Array.isArray(s.data) ? s.data[m.match_id] : null;
    return node && Array.isArray(node.player_statistics) ? node.player_statistics : [];
  };
  const all = await Promise.all(evs.map(m => statsFor(m).catch(() => [])));
  const log = [];
  evs.forEach((m, i) => {
    const me = all[i].find(p => p && String(p.player_key) === pid);
    if (!me) return;
    const rating = parseFloat(me.player_rating), min = parseInt(me.player_minutes_played) || 0;
    if (!(rating > 0) && !min) return;
    const home = String(m.match_hometeam_id) === tid;
    log.push({ match_id: m.match_id, match_date: m.match_date, is_home: home,
      match_hometeam_name: m.match_hometeam_name, match_awayteam_name: m.match_awayteam_name, team_home_badge: m.team_home_badge, team_away_badge: m.team_away_badge,
      match_hometeam_score: m.match_hometeam_score, match_awayteam_score: m.match_awayteam_score,
      rating: rating > 0 ? rating.toFixed(1) : null, minutes: min, goals: parseInt(me.player_goals) || 0, assists: parseInt(me.player_assists) || 0,
      yellow: parseInt(me.player_yellowcards) || 0, red: parseInt(me.player_redcards) || 0 });
  });
  const rated = log.slice(0, 10).filter(x => x.rating);
  return { data: { matches: log.slice(0, 10), avg_rating: rated.length ? (rated.reduce((s, x) => s + parseFloat(x.rating), 0) / rated.length).toFixed(2) : null, scanned: evs.length },
    note: r.ok ? '' : r.error, ttl: log.length ? 600 : 60 };
}

/* ============================================================================
 * ارتقای لایو اسکور — نمودار فشار و جریان بازی زنده: /api/momentum?match_id=
 * منبع داده (طبق مستندات apiv3): get_live_odds_commnets → live_comments[{time:"44:58", text}]
 * و get_events(match_id) → goalscorer / cards با دقیقه. apifootball هیچ سری زمانی دیگری نمی‌دهد؛
 * پس «فشار» از شمارش رویدادهای متنیِ واقعیِ زمان‌دار ساخته می‌شود (از شروع بازی، نه از لحظهٔ باز شدن صفحه).
 * هر کامنتی که نتوان تیمش را با اطمینان تشخیص داد، شمرده نمی‌شود (نه حدس، نه جعل).
 * این تابع throw نمی‌کند؛ بدترین حالت: buckets خالی + source:'none'.
 * ========================================================================== */
const MOM_MAX_BUCKET = 27; // سطل ۵دقیقه‌ای؛ تا دقیقهٔ ~۱۴۰ (وقت اضافه)
// وزن هر نوع رویداد در شاخص فشار؛ اولین قاعدهٔ منطبق برنده است (ترتیب مهم است)
const MOM_RULES = [
  { type: 'skip',      w: 0,   re: /goal\s*kick/i },
  { type: 'skip',      w: 0,   re: /\b(goal|scores?|scored)\b/i },          // گل‌ها از get_events می‌آیند؛ دوباره شمرده نمی‌شوند
  { type: 'penalty',   w: 4,   re: /penalt/i },
  { type: 'sot',       w: 3,   re: /on\s*(target|goal)|\bsaved?\b|\bsave\b/i },
  { type: 'shot',      w: 1.5, re: /\b(shot|attempt)s?\b|\bwide\b|off\s*target|\bblocked\b|\b(post|bar|woodwork)\b/i },
  { type: 'corner',    w: 1.2, re: /corner/i },
  { type: 'dangerous', w: 1,   re: /danger/i },
  { type: 'freekick',  w: 0.3, re: /free\s*kick/i },
  { type: 'attack',    w: 0.4, re: /\battack/i },
];
const MOM_STOP = new Set(['fc', 'cf', 'sc', 'ac', 'afc', 'fk', 'sk', 'bk', 'cd', 'ca', 'ud', 'sd', 'de', 'the', 'of', 'la', 'el', 'and']);
const momNorm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const momTokens = (n) => n.split(' ').filter(w => w.length >= 3 && !MOM_STOP.has(w));
function momMinute(v) {
  const mo = /^(\d+)(?:\s*\+\s*(\d+))?/.exec(String(v == null ? '' : v).trim());
  return mo ? parseInt(mo[1], 10) + (mo[2] ? parseInt(mo[2], 10) : 0) : null;
}
// تیمِ یک کامنت را فقط وقتی برمی‌گرداند که بدون ابهام باشد: 'h' | 'a' | null
function momSide(textN, home, away) {
  const words = new Set(textN.split(' '));
  const hFull = !!home.n && (' ' + textN + ' ').includes(' ' + home.n + ' ');
  const aFull = !!away.n && (' ' + textN + ' ').includes(' ' + away.n + ' ');
  if (hFull !== aFull) return hFull ? 'h' : 'a';
  if (hFull && aFull) return null;
  const hHit = home.tok.some(w => words.has(w)), aHit = away.tok.some(w => words.has(w));
  if (hHit !== aHit) return hHit ? 'h' : 'a';
  return null;
}

async function momentumHandler(q, env) {
  const id = String(q.match_id);
  const empty = { source: 'none', buckets: [], markers: [], totals: { h: 0, a: 0 }, comments: 0, attributed: 0, max_minute: 0 };
  const [c, e] = await Promise.all([
    apiCall('get_live_odds_commnets', { match_id: id }, env),
    apiCall('get_events', { match_id: id }, env),
  ]);
  const ev = e.ok && Array.isArray(e.data) ? e.data.find(x => x && String(x.match_id) === id) || e.data[0] : null;
  let entry = null;
  if (c.ok && c.data && typeof c.data === 'object' && !Array.isArray(c.data)) entry = c.data[id] || Object.values(c.data).find(x => x && typeof x === 'object' && x.live_comments) || null;
  const homeName = (entry && entry.match_hometeam_name) || (ev && ev.match_hometeam_name) || '';
  const awayName = (entry && entry.match_awayteam_name) || (ev && ev.match_awayteam_name) || '';
  const hn = momNorm(homeName), an = momNorm(awayName);
  const hAll = momTokens(hn), aAll = momTokens(an);
  const home = { n: hn, tok: hAll.filter(w => !aAll.includes(w)) };
  const away = { n: an, tok: aAll.filter(w => !hAll.includes(w)) };

  const comments = entry && Array.isArray(entry.live_comments) ? entry.live_comments : [];
  const buckets = new Map();
  let attributed = 0, maxMin = 0;
  const totals = { h: 0, a: 0 };
  comments.forEach(cm => {
    if (!cm) return;
    const min = momMinute(cm.time);
    if (min == null) return;
    if (min > maxMin) maxMin = min;
    const textN = momNorm(cm.text);
    if (!textN) return;
    const rule = MOM_RULES.find(r => r.re.test(String(cm.text)));
    if (!rule || !rule.w) return;
    const side = momSide(textN, home, away);
    if (!side) return;
    const b = Math.max(0, Math.min(Math.floor(min / 5), MOM_MAX_BUCKET));
    const slot = buckets.get(b) || { b, h: 0, a: 0 };
    slot[side] += rule.w; totals[side] += rule.w; attributed++;
    buckets.set(b, slot);
  });

  // نشانگرها: گل و کارت قرمز با دقیقهٔ واقعی از get_events
  const markers = [];
  if (ev) {
    (Array.isArray(ev.goalscorer) ? ev.goalscorer : []).forEach(g => {
      const min = momMinute(g && g.time); if (min == null) return;
      const side = g.home_scorer ? 'h' : (g.away_scorer ? 'a' : null);
      if (side) { markers.push({ min, type: 'goal', side }); if (min > maxMin) maxMin = min; }
    });
    (Array.isArray(ev.cards) ? ev.cards : []).forEach(cd => {
      if (!cd || !/red/i.test(String(cd.card || ''))) return;
      const min = momMinute(cd.time); if (min == null) return;
      const side = cd.home_fault ? 'h' : (cd.away_fault ? 'a' : null);
      if (side) { markers.push({ min, type: 'red', side }); if (min > maxMin) maxMin = min; }
    });
  }
  const round1 = (x) => Math.round(x * 10) / 10;
  const out = {
    source: attributed ? 'comments' : 'none',
    buckets: [...buckets.values()].sort((x, y) => x.b - y.b).map(x => ({ b: x.b, h: round1(x.h), a: round1(x.a) })),
    markers: markers.sort((x, y) => x.min - y.min),
    totals: { h: round1(totals.h), a: round1(totals.a) },
    comments: comments.length, attributed, max_minute: maxMin,
  };
  const live = !!(ev && String(ev.match_live) === '1') || comments.length > 0;
  return { data: attributed || markers.length ? out : empty, note: c.ok ? '' : c.error, ttl: live ? 15 : 60 };
}


/* ============================================================================
 * آرشیو فصل‌های گذشته
 * ----------------------------------------------------------------------------
 * مستندات apiv3: get_standings / get_topscorers / get_teams فقط league_id می‌گیرند و همیشه «فصل جاری»
 * را برمی‌گردانند (پارامتر فصل ندارند). تنها اکشنی که بازهٔ زمانی و فیلد league_year دارد get_events است
 * (از/تا + league_year)، پس همهٔ آمار فصل‌های گذشته از نتایج همان فصل محاسبه می‌شود و هرگز به خروجی‌های
 * «فصل جاری» دست نمی‌زند (بدون نشت). مسیرهای فصل جاری بدون هیچ تغییری همان‌طور که بودند کار می‌کنند.
 * حالت آرشیو فقط وقتی فعال می‌شود که archive=1 و season واقعاً قبل از فصل جاری باشد.
 * ========================================================================== */
const lyMatches = (ly, y0) => { const v = parseInt(String(ly || '').slice(0, 4), 10); return !v || v === y0; };

function archiveLabel(q, now) {
  if (!q || q.archive !== '1') return null;
  const s = String(q.season || '').trim();
  const d = now || new Date(), y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1;
  const m = s.match(/^(\d{4})\s*\/\s*(\d{4})$/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (b !== a + 1) return null;
    return a < (mo >= 7 ? y : y - 1) ? a + '/' + b : null;
  }
  if (/^\d{4}$/.test(s)) return parseInt(s, 10) < y ? s : null;
  return null;
}

async function topscorersArchive(q, env, ctx) {
  const label = archiveLabel(q);
  if (!label) return { data: [], note: 'not_an_archive_season', ttl: 30 };
  const agg = await aggregateSeasonStats(q.league_id, label, env, true);
  const out = agg.players.filter(p => p.goals > 0)
    .sort((a, b) => b.goals - a.goals || b.assists - a.assists).slice(0, 50)
    .map((p, i) => ({ player_place: String(i + 1), player_name: p.player_name, player_key: p.player_key, team_name: p.team_name, team_key: String(p.team_key), team_badge: p.team_badge, goals: String(p.goals), assists: String(p.assists), penalty_goals: String(p.penalty_goals) }));
  const data = await enrichTopscorers(out, env, ctx);
  return { data, note: agg.error || '', ttl: data.length ? 21600 : 60 };
}

async function leaguestatsArchive(q, env, ctx) {
  const label = archiveLabel(q);
  if (!label) return { data: [], note: 'not_an_archive_season', ttl: 30 };
  const agg = await aggregateSeasonStats(q.league_id, label, env, true);
  const top = new Map();
  agg.players.filter(p => p.assists > 0).sort((a, b) => b.assists - a.assists).slice(0, 30).forEach(p => top.set(String(p.player_key), p));
  agg.players.filter(p => p.yellow + p.red > 0).sort((a, b) => b.red - a.red || b.yellow - a.yellow).slice(0, 30).forEach(p => top.set(String(p.player_key), p));
  const out = await enrichTopscorers([...top.values()].map(p => ({ player_key: p.player_key, player_name: p.player_name, player_image: null, player_number: '', player_type: '', player_match_played: '', player_goals: String(p.goals), player_assists: String(p.assists), player_yellow_cards: String(p.yellow), player_red_cards: String(p.red), player_rating: '', team_key: String(p.team_key), team_name: p.team_name, team_badge: p.team_badge })), env, ctx);
  return { data: out, note: agg.error || '', ttl: out.length ? 21600 : 60 };
}

/* جدول رده‌بندی یک فصل گذشته — فقط بازی‌های «Finished» و «Awarded» همان فصل (۹۰ دقیقه؛ ET/پنالتی و دورهای حذفی شمرده نمی‌شوند).
 * خروجی دقیقاً با همان فیلدهای get_standings (overall_/home_/away_) ساخته می‌شود تا رندر فرانت بدون تغییر کار کند.
 * مرتب‌سازی: امتیاز ← تفاضل گل ← گل زده ← نام. (قوانین خاص هر فدراسیون مثل بازی رو در رو یا کسر امتیاز در دسترس نیست.)
 * promotion (سهمیهٔ قهرمانان/سقوط) در API آرشیوی وجود ندارد و حدس زده نمی‌شود. */
async function standingsArchiveHandler(q, env, ctx) {
  const label = archiveLabel(q);
  if (!label) return { data: [], note: 'not_an_archive_season', ttl: 30 };
  const se = await getSeasonEvents(q.league_id, label, env, ctx, true);
  const stages = new Map();
  se.events.forEach(m => {
    if (!m.hid || !m.aid || m.hs == null || m.as == null) return;
    if (m.status !== 'Finished' && m.status !== 'Awarded') return;
    const stg = (m.stage && m.stage !== 'Current') ? m.stage : '';
    if (stg && !GROUP_RE.test(stg) && KO_ROUND_RE.test(stg)) return; // دور حذفی جدول ندارد
    if (!stages.has(stg)) stages.set(stg, new Map());
    const teams = stages.get(stg);
    const mk = (id, nm, bd) => { if (!teams.has(id)) teams.set(id, { id, nm, bd, o: { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 }, h: { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 }, a: { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 } }); const t = teams.get(id); t.nm = nm; t.bd = bd; return t; };
    const H = mk(m.hid, m.hn, m.hb), A = mk(m.aid, m.an, m.ab);
    const add = (t, part, f, a) => { [t.o, t[part]].forEach(x => { x.p++; x.gf += f; x.ga += a; if (f > a) x.w++; else if (f < a) x.l++; else x.d++; }); };
    add(H, 'h', m.hs, m.as); add(A, 'a', m.as, m.hs);
  });
  const pts = (x) => x.w * 3 + x.d;
  const cmp = (sel) => (x, y) => pts(sel(y)) - pts(sel(x)) || (sel(y).gf - sel(y).ga) - (sel(x).gf - sel(x).ga) || sel(y).gf - sel(x).gf || String(x.nm).localeCompare(String(y.nm));
  const rows = [];
  let si = 0;
  [...stages.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).forEach(([stg, teamsMap]) => {
    const list = [...teamsMap.values()];
    const pos = { o: new Map(), h: new Map(), a: new Map() };
    ['o', 'h', 'a'].forEach(k => [...list].sort(cmp(t => t[k])).forEach((t, i) => pos[k].set(t.id, i + 1)));
    list.sort(cmp(t => t.o)).forEach(t => {
      const f = (pfx, x, k) => ({
        [pfx + '_league_position']: String(pos[k].get(t.id)), [pfx + '_promotion']: '',
        [pfx + '_league_payed']: String(x.p), [pfx + '_league_W']: String(x.w), [pfx + '_league_D']: String(x.d), [pfx + '_league_L']: String(x.l),
        [pfx + '_league_GF']: String(x.gf), [pfx + '_league_GA']: String(x.ga), [pfx + '_league_PTS']: String(pts(x)),
      });
      rows.push(Object.assign({ league_id: String(q.league_id), team_id: t.id, team_name: t.nm, team_badge: t.bd, fk_stage_key: String(si), stage_name: stg || 'Current', league_round: '' },
        f('overall', t.o, 'o'), f('home', t.h, 'h'), f('away', t.a, 'a')));
    });
    si++;
  });
  return { data: rows, note: se.error || '', ttl: rows.length ? 21600 : 60 };
}

const CUSTOM_HANDLERS = { standingsarchive: standingsArchiveHandler, topscorers: topscorersHandler, leaguestats: leaguestatsHandler, cleansheets: cleansheetsHandler, toprated: topratedHandler, overview: overviewHandler, bracket: bracketHandler, playerlog: playerlogHandler, teamstats: teamstatsHandler, h2h: h2hHandler, predictions: predictionsHandler, form: formHandler, momentum: momentumHandler };

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, cors);

    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/([a-z0-9]+)\/?$/);
    const routeKey = m && m[1];
    const route = routeKey && ROUTES[routeKey];
    if (!route) return json({ error: 'not_found' }, 404, cors);

    // زبان درخواستی؛ اگر معتبر نبود یا ارسال نشد → en (بدون هیچ تغییری در رفتار قبلی)
    const rawLang = (url.searchParams.get('lang') || '').toLowerCase();
    const targetLang = SUPPORTED_LANGS.includes(rawLang) ? rawLang : 'en';

    const q = {};
    for (const k of (route.params || [])) {
      const v = url.searchParams.get(k);
      if (v !== null && v !== '') {
        if (!SAFE_VALUE.test(v)) return json({ error: 'bad_param', param: k }, 400, cors);
        q[k] = v;
      }
    }
    // مقاوم‌سازی H2H: اگر فرانت‌اند firstTeamId/secondTeamId استاندارد را نفرستد،
    // نام‌های رایج جایگزین را هم می‌پذیریم تا این تب «تضمینی» کار کند.
    if (routeKey === 'h2h') {
      ['firstTeam', 'secondTeam'].forEach(k => { const v = url.searchParams.get(k); if (v && SAFE_VALUE.test(v)) q[k] = v; });
      if (!q.firstTeamId) {
        for (const alt of H2H_FIRST_ALIASES) {
          const v = url.searchParams.get(alt);
          if (v && SAFE_VALUE.test(v)) { q.firstTeamId = v; break; }
        }
      }
      if (!q.secondTeamId) {
        for (const alt of H2H_SECOND_ALIASES) {
          const v = url.searchParams.get(alt);
          if (v && SAFE_VALUE.test(v)) { q.secondTeamId = v; break; }
        }
      }
    }
    if (routeKey === 'broadcast' && q.date && !/^\d{8}$/.test(q.date)) {
      return json({ error: 'bad_param', param: 'date' }, 400, cors);
    }

    for (const k of (route.need || [])) if (!q[k]) return json({ error: 'missing_param', param: k }, 400, cors);

    const isDebug = url.searchParams.get('tdebug') === '1' || url.searchParams.get('diag') === '1';
    const isDiag = url.searchParams.get('diag') === '1';

    // کش لبه — lang جزو کلید کش است تا هر زبان نسخهٔ خودش را داشته باشد
    const cache = caches.default;
    const cacheParams = Object.assign({}, q, targetLang !== 'en' ? { lang: targetLang } : {});
    const cacheKey = new Request(url.origin + '/' + (routeKey === 'broadcast' ? BROADCAST_CACHE_VERSION : CACHE_VERSION) + url.pathname + '?' + new URLSearchParams(cacheParams).toString(), { method: 'GET' });
    const hit = !isDebug && await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { status: hit.status, headers: Object.assign({}, Object.fromEntries(hit.headers), cors) });

    let data, status = 200, ttl = route.ttl, note = '';
    try {
      if (CUSTOM_HANDLERS[route.custom]) {
        if (!env.APIFOOTBALL_KEY) return json({ error: 'server_not_configured' }, 500, cors);
        const r = await CUSTOM_HANDLERS[route.custom](q, env, ctx);
        if (isDiag && r.diag) return json({ diag: r.diag, note: r.note, count: Array.isArray(r.data) ? r.data.length : undefined }, 200, cors);
        data = r.data; note = r.note || ''; if (r.ttl != null) ttl = r.ttl;
      } else if (route.custom === 'broadcast') {
        // این مسیر apifootball را صدا نمی‌زند؛ منبعش منحصراً ESPN عمومی است.
        if (isDiag) return json(await broadcastDiag(q.date || ''), 200, cors); // /api/broadcast?date=YYYYMMDD&diag=1
        const bc = await getBroadcastsForDate(q.date || '', env, ctx);
        data = bc.groups;
        if (bc.failedAll) { note = 'espn_unreachable'; ttl = 15; } // شکست شبکه را کش نکن تا بار بعد دوباره تلاش شود
        else if (!bc.groups.length) ttl = 60;
      } else {
        let target;
        if (route.external) {
          target = new URL(route.external);
        } else {
          if (!env.APIFOOTBALL_KEY) return json({ error: 'server_not_configured' }, 500, cors);
          target = new URL(UPSTREAM);
          target.searchParams.set('action', route.action);
          Object.entries(Object.assign({}, route.fixed || {}, q)).forEach(([k, v]) => target.searchParams.set(k, v));
          if (route.liveWindow) {
            const now = new Date();
            target.searchParams.set('from', ymd(new Date(now.getTime() - 86400000)));
            target.searchParams.set('to', ymd(new Date(now.getTime() + 86400000)));
          }
          target.searchParams.set('APIkey', env.APIFOOTBALL_KEY);
        }
        const res = await fetch(target.toString(), { headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error('upstream_' + res.status);
        const raw = await res.json();

        if (raw && !Array.isArray(raw) && typeof raw === 'object' && raw.error !== undefined && !route.external) {
          note = String(raw.message || raw.error).slice(0, 120);
          data = []; ttl = Math.min(ttl, 30);
        } else if (route.enrichPlayerImages && Array.isArray(raw)) {
          data = await enrichTopscorers(raw, env, ctx);
        } else if (route.flattenRoster && Array.isArray(raw)) {
          data = flattenLeagueRoster(raw);
        } else if (route.enrichLineupPhotos && raw && typeof raw === 'object' && !Array.isArray(raw)) {
          data = await enrichLineupsWithPhotos(q.match_id, raw, env, ctx);
        } else if (route.limitH2H) {
          data = limitH2H(raw);
        } else {
          data = raw;
        }
      }

      // لایهٔ ترجمه — فقط اگر زبان غیرانگلیسی خواسته شده و مسیر قابل‌ترجمه است
      var debugErrors = isDebug ? [] : null;
      if (targetLang !== 'en' && !route.noTranslate) {
        if (route.custom === 'broadcast') {
          // خطای ترجمه نباید کل تب را خالی کند؛ در بدترین حالت نام‌ها انگلیسی می‌مانند
          try { data = await translatePayload(data, targetLang, env, ctx, debugErrors); } catch (e) { /* بدون ترجمه */ }
        } else {
          data = await translatePayload(data, targetLang, env, ctx, debugErrors);
        }
      }
    } catch (err) {
      return json({ error: 'upstream_failed' }, 502, cors);
    }

    const out = new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${ttl}`,
        ...(note ? { 'X-Upstream-Message': note } : {}),
        ...(debugErrors ? { 'X-Translate-Debug': JSON.stringify({ hasAiBinding: !!env.AI, hasKv: !!env.TRANSLATE_KV, errors: debugErrors }) } : {}),
      },
    });
    ctx.waitUntil(isDebug ? Promise.resolve() : cache.put(cacheKey, out.clone()));
    return new Response(out.body, { status, headers: Object.assign({}, Object.fromEntries(out.headers), cors) });
  },
};

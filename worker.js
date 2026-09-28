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
  // topscorers / leaguestats: پارامتر season فقط داخلی است (به apifootball فرستاده نمی‌شود)
  // و برای «نگهبان فصل» (Season Guard) استفاده می‌شود؛ ttl عمداً کوتاه است.
  topscorers:  { action: 'get_topscorers',       params: ['league_id', 'season'], need: ['league_id'], ttl: 300, custom: 'topscorers' },
  leaguestats: { action: 'get_teams',            params: ['league_id', 'season'], need: ['league_id'], ttl: 900, custom: 'leaguestats' },
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
async function fetchLeagueBroadcasts(leagueInfo, dateParam, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://internal.cache/espn-broadcast?slug=${encodeURIComponent(leagueInfo.slug)}&date=${encodeURIComponent(dateParam || '')}`);
  const hit = await cache.match(cacheKey);
  if (hit) {
    try { return await hit.json(); } catch { /* fall through */ }
  }

  const target = new URL(ESPN_SOCCER_BASE + leagueInfo.slug + '/scoreboard');
  if (dateParam) target.searchParams.set('dates', dateParam);

  let espn;
  try {
    const res = await fetch(target.toString(), { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    espn = await res.json();
  } catch {
    return null;
  }

  const events = Array.isArray(espn && espn.events) ? espn.events : [];
  const leagueMeta = (espn && Array.isArray(espn.leagues) && espn.leagues[0]) || {};

  const matches = events.map(ev => {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const competitors = comp.competitors || [];
    const home = competitors.find(c => c.homeAway === 'home') || competitors[0] || {};
    const away = competitors.find(c => c.homeAway === 'away') || competitors[1] || {};

    const broadcastNames = new Set();
    (comp.broadcasts || []).forEach(b => (b.names || []).forEach(n => n && broadcastNames.add(n)));
    (comp.geoBroadcasts || []).forEach(b => { const n = b && b.media && b.media.shortName; if (n) broadcastNames.add(n); });

    const statusType = (comp.status && comp.status.type) || (ev.status && ev.status.type) || {};
    return {
      match_id: ev.id,
      match_date: String(ev.date || '').slice(0, 10),
      match_time: String(ev.date || '').slice(11, 16),
      match_status: statusType.description || statusType.shortDetail || statusType.detail || '',
      match_hometeam_name: (home.team && home.team.displayName) || '',
      match_hometeam_logo: (home.team && home.team.logo) || '',
      match_hometeam_score: home.score != null ? String(home.score) : '',
      match_awayteam_name: (away.team && away.team.displayName) || '',
      match_awayteam_logo: (away.team && away.team.logo) || '',
      match_awayteam_score: away.score != null ? String(away.score) : '',
      broadcasts: Array.from(broadcastNames),
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
  return out;
}

/** لیست لیگ‌ها را موازی می‌گیرد؛ خطای یک لیگ، بقیه را خراب نمی‌کند. فقط لیگ‌هایی
 *  که برای آن تاریخ بازی دارند برگردانده می‌شوند تا خروجی شلوغ نشود. */
async function getBroadcastsForDate(dateParam, env, ctx) {
  const results = await Promise.all(
    BROADCAST_LEAGUES.map(l => fetchLeagueBroadcasts(l, dateParam, ctx).catch(() => null))
  );
  return results.filter(r => r && Array.isArray(r.matches) && r.matches.length);
}

/* ═══════════════ لایهٔ «فصل‌محور» و مسیرهای سفارشی (نسخهٔ جدید) ═══════════════
 * هدف: هیچ‌وقت آمار فصل قبل به کاربر نشان داده نشود؛ کاپ‌های حذفی (بدون جدول) درست کار کنند؛
 * H2H / پیش‌بینی / فرم با پارامترهای دقیق مستندات apifootball صدا زده شوند.
 * تمام توابع اینجا throw نمی‌کنند؛ بدترین حالت: آرایهٔ خالی + note (هدر X-Upstream-Message).
 */
const CACHE_VERSION = 'v6';
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
function seasonBounds(season, now) {
  now = now || new Date();
  let s = String(season || '').trim();
  let m = s.match(/^(\d{4})\s*\/\s*(\d{4})$/);
  if (!m && /^\d{4}$/.test(s)) return { label: s, from: s + '-01-01', to: s + '-12-31' };
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
    const gf = parseInt(row.overall_league_GF) || 0, pl = parseInt(row.overall_league_payed) || 0;
    const k = String(row.team_id), prev = map.get(k);
    map.set(k, { gf: Math.max(gf, prev ? prev.gf : 0), played: Math.max(pl, prev ? prev.played : 0) });
  });
  return { map, rows: r.data.length, error: '' };
}

/* آمار را از خودِ بازی‌های همین فصل می‌سازد (goalscorer / cards در get_events) — چون بازه‌ی تاریخ
 * دارد، ذاتاً نمی‌تواند فصل قبل باشد. فقط وقتی استفاده می‌شود که آمار آماده‌ی API رد شود یا لیگ جدول نداشته باشد. */
async function aggregateSeasonStats(leagueId, season, env) {
  const b = seasonBounds(season);
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

const CUSTOM_HANDLERS = { topscorers: topscorersHandler, leaguestats: leaguestatsHandler, h2h: h2hHandler, predictions: predictionsHandler, form: formHandler };

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
    const cacheKey = new Request(url.origin + '/' + CACHE_VERSION + url.pathname + '?' + new URLSearchParams(cacheParams).toString(), { method: 'GET' });
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
        data = await getBroadcastsForDate(q.date || '', env, ctx);
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
        data = await translatePayload(data, targetLang, env, ctx, debugErrors);
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

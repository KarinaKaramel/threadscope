/* Threadscope — аналитика и студия постов для Threads
   Все запросы к Threads идут через твой Cloudflare Worker (там же токен и очередь). */
'use strict';

const TZ = 'Europe/Kyiv';
const LS = {
  get(k, d) { try { const v = localStorage.getItem('ts.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ts.' + k, JSON.stringify(v)); } catch {} },
};
const DEFAULT_WORKER = 'https://threadscope-api.karishechka2000.workers.dev';
const S = {
  worker: LS.get('worker', DEFAULT_WORKER),
  key: LS.get('key', ''),
  me: LS.get('me', null),
  posts: LS.get('posts', []),
  insights: LS.get('insights', null),
  history: LS.get('history', []),
  queue: [],
  sort: { k: 'timestamp', d: -1 },
  drafts: LS.get('drafts', []),
};

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => n == null ? '—' : Number(n).toLocaleString('ru-RU');
const pct = x => x == null || isNaN(x) ? '—' : (x * 100).toFixed(1).replace('.', ',') + '%';
const toast = (m, ms = 2600) => { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms); };
const kyiv = (d, o) => new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, ...o }).format(new Date(d));
const kyivParts = d => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date(d)).map(x => [x.type, x.value]));
  return { hour: +p.hour % 24, dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) };
};
const copy = async (t, msg = 'Скопировано') => { try { await navigator.clipboard.writeText(t); toast(msg); } catch { prompt('Скопируй:', t); } };

async function api(path, opt = {}) {
  if (!S.worker) throw new Error('Не указан адрес Worker');
  const res = await fetch(S.worker.replace(/\/$/, '') + path, {
    method: opt.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Key': S.key },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

// ---------- метрики ----------
function m(p) {
  const x = p.metrics || {};
  const views = x.views || 0, likes = x.likes || 0, replies = x.replies || 0, reposts = x.reposts || 0, quotes = x.quotes || 0, shares = x.shares || 0;
  const eng = likes + replies + reposts + quotes + shares;
  return { views, likes, replies, reposts, quotes, shares, eng, er: views ? eng / views : null };
}
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
const rootPosts = () => S.posts.filter(p => p.media_product_type !== 'REPLY' && !p.is_reply);

// ---------- алгоритм-чек поста ----------
const CORE_TOPICS = {
  'стосунки': ['стосун', 'хлопець', 'дівчин', 'чоловік', 'побачен', 'кохан', 'колишн', 'подруг', 'друз', 'ревн'],
  'психологія': ['психолог', 'терап', 'тривог', 'емпат', 'кордон', 'травм', 'самооцін', 'токсич'],
  'робота': ['робот', 'мітинг', 'дзвінк', 'колег', 'керівни', 'дедлайн', 'офіс', 'співбесід', 'зарплат'],
  'айті': ['it', 'айті', 'розроб', 'тестувал', 'джира', 'jira', 'спринт', 'стендап', 'google meet', 'slack', 'код', 'pm '],
  'гроші': ['грош', 'податк', 'курс', 'інфобіз', 'фінанс', 'заробі', 'кредит', 'ціна', 'гривн'],
  'шІ': ['ші', 'штучн', 'chatgpt', 'gpt', 'нейромереж', 'claude', 'ai'],
  'соцмережі': ['тредс', 'threads', 'інстаграм', 'instagram', 'підписник', 'алгоритм', 'тікток', 'лайк', 'пост'],
};
const TOPIC_TAGS = ['психологія', 'стосунки', 'айті', 'робота', 'гроші', 'гумор', 'життя', 'соцмережі', 'штучний інтелект', 'укртредс'];
const BAIT = ['лайкни', 'постав лайк', 'репост якщо', 'зроби репост', 'підпишись', 'підписуйтесь', 'напиши + ', 'став +', 'згодні?', 'що думаєте?', 'а ви як?', 'хто зі мною', 'взаємн'];


const NICHE_TAG = { 'стосунки': 'стосунки', 'психологія': 'психологія', 'робота': 'робота', 'айті': 'айті', 'гроші': 'гроші', 'шІ': 'штучний інтелект', 'соцмережі': 'соцмережі' };
const TAG_NICHE = { 'стосунки': 'стосунки', 'психологія': 'психологія', 'робота': 'робота', 'айті': 'айті', 'гроші': 'гроші', 'штучний інтелект': 'шІ', 'соцмережі': 'соцмережі' };
function nicheWords(tag) {
  const k = TAG_NICHE[tag];
  const words = { 'стосунки': 'стосунки, хлопець, подруга, колишній, побачення', 'психологія': 'психолог, терапія, тривога, кордони, самооцінка', 'робота': 'робота, колега, керівник, дедлайн, мітинг', 'айті': 'айті, мітинг, спринт, дзвінок, стендап', 'гроші': 'гроші, зарплата, податкова, курс, гривні', 'шІ': 'ШІ, штучний інтелект, chatgpt, нейромережа', 'соцмережі': 'тредс, підписники, лайк, пост, інстаграм' };
  return k ? words[k] : 'стосунки, робота, колега, психолог, гроші, ШІ, тредс';
}
function autoTag(text) {
  const low = text.toLowerCase();
  const hit = Object.entries(CORE_TOPICS).find(([, ws]) => ws.some(w => low.includes(w)));
  return hit ? NICHE_TAG[hit[0]] : 'гумор';
}
function splitHook(t) {
  const lines = t.trim().split('\n'); const first = lines[0];
  if (first.length <= 100) return t;
  const m = first.slice(0, 100).match(/^(.*[.!?…])\s+/s);
  if (m && m[1].length >= 20) { lines[0] = m[1]; lines.splice(1, 0, first.slice(m[0].length)); return lines.join('\n'); }
  const c = first.slice(0, 100).lastIndexOf(', ');
  if (c > 30) { lines[0] = first.slice(0, c); lines.splice(1, 0, first.slice(c + 2)); return lines.join('\n'); }
  return t;
}
function localFix(t) {
  t = splitHook(t);
  return t.replace(/[‐-―−]/g, '-').replace(/[«»“”„]/g, '"').replace(/https?:\/\/\S+/g, '').replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
// доводит текст до 100 по проверкам: локальные правки + до 3 раундов точечных правок ИИ
async function polishTo100(text, tag, original, onStep) {
  let cur = localFix(text), t = tag || autoTag(cur);
  for (let round = 0; round < 3; round++) {
    const r = analyzePost(cur, t, null, { ignore: original });
    if (r.score >= 100) return { text: cur, tag: t, score: 100, fails: [] };
    const fixes = r.checks.filter(c => !c.ok && c.fix && !['tag', 'cadence', 'wintopic'].includes(c.id)).map(c => c.fix);
    if (!fixes.length) return { text: cur, tag: t, score: r.score, fails: r.checks.filter(c => !c.ok) };
    onStep?.(round + 1);
    try {
      const out = await api('/improve', { method: 'POST', body: { text: cur, tag: t, fix: fixes } });
      if (out.variants?.[0]?.text) cur = localFix(out.variants[0].text);
    } catch (e) { const r2 = analyzePost(cur, t, null, { ignore: original }); return { text: cur, tag: t, score: r2.score, fails: r2.checks.filter(c => !c.ok), error: e.message }; }
    if (!tag) t = autoTag(cur);
  }
  const r = analyzePost(cur, t, null, { ignore: original });
  return { text: cur, tag: t, score: r.score, fails: r.checks.filter(c => !c.ok) };
}

function tokens(t) { return new Set(String(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 3)); }
function jaccard(a, b) { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); }

function analyzePost(text, tag, whenMs, opts = {}) {
  const t = text.trim(), low = t.toLowerCase();
  const lines = t.split('\n').filter(Boolean);
  const first = lines[0] || '';
  const len = [...t].length;
  const checks = [];
  const add = (ok, title, hint, w = 10, id = '', fix = '') => checks.push({ ok, title, hint, w, id, fix });

  add(len > 0 && len <= 500, len > 500 ? `Длина ${len}/500 — API не примет` : `Длина ${len} симв.`, 'Лимит Threads — 500 символов', 15, 'len500', 'скороти текст до 280 символів');
  add(len > 0 && len <= 280, 'Коротко и плотно (до 280)', 'Короткие тексты дочитывают до конца — меньше «скролла мимо», это сигнал ранжирования', 8, 'len280', `скороти текст до 270 символів (зараз ${len}), прибери воду, не втрачаючи поворот`);
  add(first.length > 0 && first.length <= 100, 'Первая строка короткая (до 100 симв.)', 'В ленте видно начало — в нём должна быть ситуация или поворот, а не разгон', 6, 'hook', `перший рядок має бути гачком до 90 символів (зараз ${first.length}): одразу ситуація або теза, потім перенос рядка`);
  const fl = (first.length < 40 && /[:：]\s*$/.test(first) && lines[1] ? first + ' ' + lines[1] : first).toLowerCase();
  const HOOKS = [
    ['конкретная сцена', /\b\d{1,2}[:.]\d{2}\b|\b\d+\s*(хв|год|рок|раз|грн|років|дн)|^"|"[^"]{3,}"/],
    ['непопулярное мнение', /(непопулярн|хот[- ]?тейк|моя чесна думка|скажу непопулярне|unpopular)/],
    ['признание', /^(раніше я|я та людина|я (просто|завжди|ніколи|чесно)|зізнаюсь|мені \d+|в мене|у мене|мене (знову|завжди))/],
    ['рубрика/список', /(словник|музей|рейтинг|топ-?\d|список|правила|експонат|переклад|чек-?лист|інструкція)/],
    ['перевёрнутая мысль', /(?<!\p{L})не(?!\p{L})[^.!?]*((?<!\p{L})(а|лише|тільки|просто)(?!\p{L})|[.!]\s*\S)|(насправді|виявляється|парадокс)/u],
    ['громкий тезис', /(найбільш|найгірш|найкращ|найчесніш|єдин|кожн|всі |ніхто|завжди|ніколи|чомусь)/],
  ];
  let hookType = (HOOKS.find(([, re]) => re.test(fl)) || [])[0];
  if (!hookType && lines.length >= 2 && /(?<!\p{L})не(?!\p{L})/u.test(fl)) hookType = 'перевёрнутая мысль';
  add(!!hookType, hookType ? `Хук цепляет: ${hookType}` : 'Хук без цепляющего приёма', 'Первая строка решает, остановятся ли на посте. Работают: конкретная сцена («22:47. "ти де?"»), признание («раніше я думала…»), перевёрнутая мысль («тривожні люди не складні. складні ті, хто…»), громкий тезис, рубрика («словник айтішника»)', 12, 'hookq', 'перепиши ПЕРШИЙ рядок як сильний гачок одного з типів: конкретна сцена з часом або фразою в лапках; несподіване твердження, що перевертає звичне ("X не складні. складні ті, хто..."); провокаційна теза з нюансом; зізнання "раніше я думала..."; назва рубрики. Решту тексту збережи');
  const exLines = lines.filter(l => /^\s*("|-|•|\d+[.)])|\s=\s|\s-\s.+/.test(l)).length;
  const lastL = (lines[lines.length - 1] || '').toLowerCase();
  const openList = /(список (явно )?неповний|далі буде|продовж|доповнюйте|у кожного свій|ще варіанти|далі ви)/i.test(lastL);
  const endsQ = /\?\s*$/.test(t) || /(несіть свої|кидайте|розкажіть|пишіть|ваші варіанти|у коментар|в коментар)/i.test(low) || openList || exLines >= 3 || (lines.length >= 2 && !/\?\s*$/.test(lastL) && lastL.length >= 20 && lastL.length <= 170 && /((?<!\p{L})(не|а|але)(?!\p{L})|насправді|тільки|лише|просто|видно|означає|бо |потрібн|справжн|важливіш)/u.test(lastL));
  add(endsQ, 'Есть повод ответить', 'Алгоритм предсказывает «нажмёт ли ответить». Работает: незаконченный список из примеров, вывод с нюансом, с которым хочется поспорить, или конкретный вопрос (не «що думаєте?»)', 15, 'invite', 'дай читачам привід відповісти БЕЗ шаблонного питання: або 3+ конкретні життєві приклади, які хочеться доповнити своїми, або фінальний висновок з нюансом, з яким хочеться погодитись чи посперечатися. Питання в кінці - тільки якщо воно дуже конкретне');
  const lowNoQuotes = low.replace(/"[^"]*"|«[^»]*»|“[^”]*”/g, ' ');
  const bait = BAIT.find(b => lowNoQuotes.includes(b));
  add(!bait, bait ? `Шаблонная приманка: «${bait}»` : 'Без шаблонных приманок', 'Meta понижает engagement-bait; спроси что-то конкретное вместо «що думаєте?»', 10, 'bait', `прибери шаблонну фразу "${bait}" і заміни конкретним питанням`);
  add(!!tag, tag ? `Тема: ${tag}` : 'Не выбрана тема (topic tag)', 'Одна тема на пост помещает его в ленту темы и помогает рекомендациям понять, кому тебя показывать', 12, 'tag');
  add(!/#\S/.test(t), 'Без хештегов в тексте', 'В Threads работает одна тема поста, а не россыпь #хештегов', 5, 'hashtag', 'прибери хештеги');
  add(!/https?:\/\//.test(t), 'Без внешних ссылок', 'Ссылки уводят из приложения; лучше ссылку в первом своём ответе', 5, 'link', 'прибери посилання');
  add(!/[—«»“”]/.test(t), 'Твой стиль: «-» и прямые кавычки', 'Длинное тире и «ёлочки» выдают ИИ-текст', 5, 'style', 'тільки дефіс "-" і прямі лапки');
  const hits = Object.entries(CORE_TOPICS).filter(([, ws]) => ws.some(w => low.includes(w))).map(([k]) => k);
  add(hits.length > 0 || TOPIC_TAGS.includes(tag), hits.length ? `В твоей нише: ${hits.join(', ')}` : TOPIC_TAGS.includes(tag) ? `В твоей нише: ${tag}` : 'Тема вне твоей ниши', 'Рекомендации учат, кому тебя показывать, по повторяющимся темам — держи 3-4 постоянные', 8, 'niche', `природно впиши хоча б одне з цих слів: ${nicheWords(tag)}`);
  if (S.perf?.ready && S.perf.wins.length && !opts.noPerf) {
    const winTags = new Set(S.perf.wins.map(w => w.topic_tag).filter(Boolean));
    const winTok = tokens(S.perf.wins.map(w => w.text).join(' '));
    const sameTheme = (tag && winTags.has(tag)) || [...tokens(t)].filter(x => winTok.has(x)).length >= 2;
    add(sameTheme, sameTheme ? 'Тема из твоих залетевших' : 'Тема не из залетевших', 'Залетевшие темы стоит повторять новым углом — алгоритм уже знает, кому их показывать. Но 1-2 поста в день можно и на новые темы', 3, 'wintopic');
  }
  const tk = tokens(t);
  const sim = rootPosts().slice(0, 15).filter(p => !opts.ignore || jaccard(tokens(opts.ignore), tokens(p.text || '')) < 0.6).map(p => ({ p, s: jaccard(tk, tokens(p.text || '')) })).sort((a, b) => b.s - a.s)[0];
  add(!sim || sim.s < 0.3, sim && sim.s >= 0.3 ? 'Похоже на недавний пост' : 'Не повторяет недавние посты', 'Оригинальность и свежесть — прямые приоритеты ранжирования', 8, 'similar', sim ? `переформулюй, щоб текст суттєво відрізнявся від мого поста: "${(sim.p.text || '').slice(0, 200)}"` : '');
  if (whenMs) {
    const last24 = rootPosts().filter(p => Math.abs(new Date(p.timestamp) - whenMs) < 864e5).length + S.queue.filter(q => q.status === 'scheduled' && Math.abs(new Date(q.at) - whenMs) < 864e5).length;
    add(last24 < 7, `Постов в эти сутки: ${last24}`, 'Для маленького аккаунта 3-6 постов в день — больше шансов в рекомендации; больше 6 — качество падает и посты конкурируют между собой', 5, 'cadence');
    const nearest = Math.min(Infinity, ...rootPosts().map(p => Math.abs(new Date(p.timestamp) - whenMs)), ...S.queue.filter(q => q.status === 'scheduled').map(q => Math.abs(new Date(q.at) - whenMs)));
    add(nearest >= 2 * 3600e3, nearest >= 2 * 3600e3 ? 'Интервал с соседним постом 2+ часа' : `Слишком близко к другому посту (${Math.round(nearest / 60e3)} мин)`, 'Между постами нужно хотя бы 2 часа, чтобы предыдущий успел собрать ответы', 5, 'cadence');
  }
  const total = checks.reduce((a, c) => a + c.w, 0);
  const score = Math.round(checks.reduce((a, c) => a + (c.ok ? c.w : 0), 0) / total * 100);
  return { score, checks, topics: hits };
}

// ---------- лучшее время ----------
function prior(hour, dow) {
  const we = dow >= 5;
  const wd = [.1, .08, .05, .05, .05, .08, .2, .55, .7, .65, .55, .55, .75, .8, .6, .55, .55, .6, .8, .85, .95, 1, .9, .6];
  const wk = [.2, .12, .06, .05, .05, .06, .1, .25, .45, .65, .8, .85, .85, .8, .7, .65, .65, .7, .8, .9, 1, 1, .9, .65];
  return (we ? wk : wd)[hour];
}
function personalByHour() {
  const ps = rootPosts().filter(p => p.metrics);
  if (!ps.length) return { score: Array(24).fill(null), n: Array(24).fill(0), total: 0 };
  const med = median(ps.map(p => m(p).views)) || 1;
  const medE = median(ps.map(p => m(p).eng)) || 1;
  const sum = Array(24).fill(0), n = Array(24).fill(0);
  for (const p of ps) {
    const { hour } = kyivParts(p.timestamp);
    const x = m(p);
    const v = 0.6 * Math.min(x.views / med, 3) + 0.4 * Math.min(x.eng / medE, 3);
    for (const [h, w] of [[hour, 1], [(hour + 23) % 24, .5], [(hour + 1) % 24, .5]]) { sum[h] += v * w; n[h] += w; }
  }
  return { score: sum.map((s, i) => n[i] ? s / n[i] / 3 : null), n, total: ps.length };
}
function bestSlots(count = 6, fromMs = Date.now()) {
  const pers = personalByHour();
  const w = Math.min(pers.total / 25, 0.6);
  const taken = [...rootPosts().map(p => +new Date(p.timestamp)), ...S.queue.filter(q => q.status === 'scheduled').map(q => +new Date(q.at))];
  const slots = [];
  const start = Math.ceil((fromMs + 15 * 60e3) / 1800e3) * 1800e3;
  for (let t = start; t < fromMs + 3 * 864e5; t += 1800e3) {
    const { hour, dow } = kyivParts(t);
    let sc = prior(hour, dow);
    if (pers.score[hour] != null) sc = sc * (1 - w) + pers.score[hour] * w;
    const near = taken.filter(x => Math.abs(x - t) < 2 * 3600e3).length;
    sc *= near ? 0.55 : 1;
    slots.push({ t, sc, hour, dow });
  }
  const picked = [];
  for (const s of slots.sort((a, b) => b.sc - a.sc)) {
    if (picked.every(p => Math.abs(p.t - s.t) > 2.5 * 3600e3)) picked.push(s);
    if (picked.length >= count) break;
  }
  return picked.sort((a, b) => a.t - b.t);
}

// ---------- рекомендации ----------
function recommendations() {
  const ps = rootPosts().filter(p => p.metrics);
  const out = [];
  if (!ps.length) return [{ t: 'Подключи аккаунт', d: 'После синхронизации здесь появятся выводы по твоим постам.' }];
  const byEr = [...ps].filter(p => m(p).views >= 20).sort((a, b) => m(b).er - m(a).er);
  const byV = [...ps].sort((a, b) => m(b).views - m(a).views);
  if (byEr[0]) out.push({ t: `Лучше всего обсуждают: «${(byEr[0].text || '').split('\n')[0].slice(0, 70)}»`, d: `ER ${pct(m(byEr[0]).er)}, ответов ${m(byEr[0]).replies}. Делай больше постов с таким же механизмом: узнаваемая ситуация, в которой каждому есть что добавить.` });
  if (byV[0] && byEr[0] && byV[0].id !== byEr[0].id) out.push({ t: 'Просмотры ≠ разговор', d: `Самый просматриваемый пост («${(byV[0].text || '').split('\n')[0].slice(0, 50)}») дал ER ${pct(m(byV[0]).er)}. Охват дала тема, но не было зацепки ответить — добавляй конкретный вопрос или «несіть свої».` });
  const withQ = ps.filter(p => /\?\s*$/.test((p.text || '').trim()));
  const noQ = ps.filter(p => !/\?\s*$/.test((p.text || '').trim()));
  if (withQ.length && noQ.length) {
    const a = median(withQ.map(p => m(p).replies)), b = median(noQ.map(p => m(p).replies));
    out.push({ t: `Посты с вопросом в конце: медиана ответов ${a} против ${b}`, d: a > b ? 'Вопрос в конце у тебя работает — оставляй его, но конкретный.' : 'Пока вопрос не даёт прироста — попробуй вместо вопроса «приглашение к коллекции» (как «музей фраз»).' });
  }
  const last = byDate(ps)[0];
  const days = last ? (Date.now() - new Date(last.timestamp)) / 864e5 : 99;
  if (days > 2) out.push({ t: `Последний пост ${Math.floor(days)} дн. назад`, d: 'Ранжирование учитывает свежесть — 3-6 постов в день стабильнее, чем всплески.' });
  const tagged = ps.filter(p => p.topic_tag).length;
  if (tagged < ps.length) out.push({ t: `Тема указана в ${tagged} из ${ps.length} постов`, d: 'Ставь одну тему на каждый пост (в Студии это поле «Тема») — так пост попадает в ленту темы.' });
  const rr = ps.reduce((a, p) => a + m(p).replies, 0);
  out.push({ t: 'Ответы — твой второй канал роста', d: `Отвечать на посты больших аккаунтов в своей нише так же полезно, как постить. Цель: 10-15 содержательных ответов в день, особенно в первый час после их публикации. Сейчас под твоими постами ${rr} ответов — отвечай каждому в первый час, это продлевает жизнь поста.` });
  if (S.perf?.ready) out.push({ t: `ИИ учится на твоей статистике: ${S.perf.wins.length} залетело, ${S.perf.flops.length} не зашло`, d: 'Генератор, улучшатель, ответы и отбор трендов берут залетевшие посты за образец и избегают механик провалившихся. Подробнее — Студия → «Чему ИИ научился».' });
  else out.push({ t: 'Скоро ИИ начнёт учиться на твоих результатах', d: `Нужно 4 поста старше 48 часов с 20+ просмотрами (сейчас ${S.perf?.count ?? 0}). Тогда залетевшие станут образцом, а провальные — анти-примером.` });
  const slots = bestSlots(2);
  if (slots.length) out.push({ t: 'Ближайшие хорошие окна', d: slots.map(s => kyiv(s.t, { weekday: 'short', hour: '2-digit', minute: '2-digit' })).join(' · ') + ' (по Киеву).' });
  return out;
}
const byDate = a => [...a].sort((x, y) => new Date(y.timestamp) - new Date(x.timestamp));

// ---------- графики ----------
function lineChart(points, { h = 180, color = 'var(--acc)', fmtX = x => x } = {}) {
  if (!points.length) return '<div class="empty">Пока нет данных</div>';
  const W = 640, H = h, P = 28;
  const max = Math.max(1, ...points.map(p => p.v));
  const x = i => P + (W - P * 2) * (points.length === 1 ? .5 : i / (points.length - 1));
  const y = v => H - P - (H - P * 2) * (v / max);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = d + ` L${x(points.length - 1)},${H - P} L${x(0)},${H - P} Z`;
  const ticks = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">
    <defs><linearGradient id="g${h}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".25"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <line x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}" stroke="var(--line)"/>
    <text x="${P}" y="${P - 10}">${fmt(max)}</text>
    <path d="${area}" fill="url(#g${h})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>
    ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="3" fill="${color}"><title>${esc(fmtX(p.x))}: ${fmt(p.v)}</title></circle>`).join('')}
    ${ticks.map(i => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(fmtX(points[i].x))}</text>`).join('')}
  </svg>`;
}
function hourHeat() {
  const pers = personalByHour();
  const cells = [];
  for (const [lbl, dow] of [['будни', 1], ['вых', 6]]) {
    cells.push(`<span>${lbl}</span>`);
    for (let h = 0; h < 24; h++) {
      let sc = prior(h, dow);
      const w = Math.min(pers.total / 25, .6);
      if (pers.score[h] != null) sc = sc * (1 - w) + pers.score[h] * w;
      cells.push(`<div title="${h}:00 — ${Math.round(sc * 100)}" style="background:color-mix(in srgb,var(--acc) ${Math.round(sc * 100)}%,var(--soft))"></div>`);
    }
  }
  cells.push('<span></span>');
  for (let h = 0; h < 24; h++) cells.push(`<span style="text-align:center">${h % 3 ? '' : h}</span>`);
  return `<div class="heat">${cells.join('')}</div>`;
}

// ---------- ВИДЫ ----------
function renderOverview() {
  const ps = rootPosts().filter(p => p.metrics);
  const tot = ps.reduce((a, p) => { const x = m(p); for (const k of ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares', 'eng']) a[k] += x[k]; return a; }, { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, shares: 0, eng: 0 });
  const hist = S.history.filter(h => h.followers != null);
  const fNow = S.me?.followers ?? hist.at(-1)?.followers;
  const f7 = hist.find(h => (Date.now() - new Date(h.day)) / 864e5 <= 7.5)?.followers;
  const dF = fNow != null && f7 != null ? fNow - f7 : null;
  const pv = S.insights?.views;
  const kpi = (l, v, d = '') => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  $('#overview').innerHTML = `
    <h2>Обзор</h2>
    <div class="grid kpis">
      ${kpi('Подписчики', fmt(fNow), dF == null ? '<span class="mut">история копится с сегодняшнего дня</span>' : `<span class="${dF >= 0 ? 'up' : 'down'}">${dF >= 0 ? '+' : ''}${dF} за 7 дней</span>`)}
      ${kpi('Просмотры постов', fmt(tot.views), `<span class="mut">${ps.length} постов</span>`)}
      ${kpi('Просмотры профиля', fmt(pv?.total), '<span class="mut">за 30 дней</span>')}
      ${kpi('Ответы', fmt(tot.replies), `<span class="mut">лайки ${fmt(tot.likes)}</span>`)}
      ${kpi('Репосты + цитаты', fmt(tot.reposts + tot.quotes), `<span class="mut">поделились ${fmt(tot.shares)}</span>`)}
      ${kpi('ER', pct(tot.views ? tot.eng / tot.views : null), '<span class="mut">действия / просмотры</span>')}
    </div>
    <div class="grid two" style="margin-top:12px">
      <div class="card"><h3>Что делать дальше</h3><ul class="recs">${recommendations().map(r => `<li><b>${esc(r.t)}</b><span class="mut small">${esc(r.d)}</span></li>`).join('')}</ul></div>
      <div class="grid">
        <div class="card"><h3>Просмотры профиля по дням</h3>${lineChart((pv?.series || []).map(s => ({ x: s.t, v: s.v })), { fmtX: x => kyiv(x, { day: 'numeric', month: 'short' }) })}</div>
        <div class="card"><h3>Подписчики</h3>${hist.length > 1 ? lineChart(hist.map(h => ({ x: h.day, v: h.followers })), { h: 150, color: 'var(--acc2)', fmtX: x => kyiv(x, { day: 'numeric', month: 'short' }) }) : '<p class="mut small">Threads API не отдаёт историю подписчиков, поэтому Worker каждую ночь сохраняет снимок. График появится со второго дня.</p>'}</div>
        <div class="card"><h3>Когда постить</h3>${hourHeat()}<p class="mut small" style="margin:8px 0 0">Время Киева. Смесь общей активности укр. аудитории и результатов твоих постов (вес твоих данных растёт с каждым постом).</p></div>
      </div>
    </div>
    <div class="card" style="margin-top:12px"><h3>Топ по обсуждению</h3>${postsTable([...ps].sort((a, b) => m(b).replies - m(a).replies).slice(0, 5), false)}</div>`;
}

function postsTable(list, sortable = true) {
  if (!list.length) return '<div class="empty">Публикаций пока нет — нажми «Обновить»</div>';
  const cols = [['text', 'Пост'], ['timestamp', 'Дата'], ['views', 'Просм.'], ['likes', 'Лайки'], ['replies', 'Ответы'], ['reposts', 'Репосты'], ['quotes', 'Цитаты'], ['shares', 'Поделились'], ['er', 'ER']];
  const head = cols.map(([k, l]) => `<th ${sortable ? `data-sort="${k}"` : ''}>${l}${sortable && S.sort.k === k ? (S.sort.d > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('');
  const rows = list.map(p => {
    const x = m(p);
    return `<tr>
      <td class="txt">${esc((p.text || '(без текста)').slice(0, 220))}${p.topic_tag ? ` <span class="pill">${esc(p.topic_tag)}</span>` : ''}
        <div class="row small" style="margin-top:6px"><a href="${esc(p.permalink)}" target="_blank" rel="noopener">открыть ↗</a>
        ${sortable ? `<a href="#" data-conv="${p.id}">кто обсуждал</a><span id="conv-${p.id}" class="mut"></span>` : ''}</div></td>
      <td class="small">${kyiv(p.timestamp, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
      <td>${fmt(x.views)}</td><td>${fmt(x.likes)}</td><td>${fmt(x.replies)}</td><td>${fmt(x.reposts)}</td><td>${fmt(x.quotes)}</td><td>${fmt(x.shares)}</td><td>${pct(x.er)}</td></tr>`;
  }).join('');
  return `<div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderPosts() {
  const list = [...rootPosts()].sort((a, b) => {
    const k = S.sort.k;
    const va = k === 'timestamp' ? +new Date(a.timestamp) : k === 'text' ? (a.text || '') : (m(a)[k] ?? -1);
    const vb = k === 'timestamp' ? +new Date(b.timestamp) : k === 'text' ? (b.text || '') : (m(b)[k] ?? -1);
    return (va > vb ? 1 : va < vb ? -1 : 0) * S.sort.d;
  });
  $('#posts').innerHTML = `
    <div class="row"><h2>Публикации</h2><span class="sp"></span><button class="ghost sm" id="csvBtn">Скачать CSV</button><button class="ghost sm" id="claudeBtn">Анализ в Claude</button>${GPT()}</div>
    <p class="mut small" style="margin-top:-6px">«Кто обсуждал» считает уникальных людей в ответах без твоих собственных ответов — честная метрика разговора.</p>
    <div class="card">${postsTable(list)}</div>`;
  $('#posts').querySelectorAll('[data-sort]').forEach(th => th.onclick = () => { const k = th.dataset.sort; S.sort = { k, d: S.sort.k === k ? -S.sort.d : -1 }; renderPosts(); });
  $('#posts').querySelectorAll('[data-conv]').forEach(a => a.onclick = async e => {
    e.preventDefault(); const id = a.dataset.conv, out = $('#conv-' + id); out.textContent = '…';
    try { const c = await api('/conversation/' + id); out.textContent = `${c.uniqueParticipants} чел., ${c.fromOthers} их ответов, ${c.mine} твоих${c.participants.length ? ': @' + c.participants.slice(0, 6).join(', @') : ''}`; }
    catch (err) { out.textContent = err.message; }
  });
  $('#csvBtn').onclick = () => {
    const rows = [['date', 'text', 'topic', 'views', 'likes', 'replies', 'reposts', 'quotes', 'shares', 'er', 'url']];
    for (const p of list) { const x = m(p); rows.push([p.timestamp, p.text || '', p.topic_tag || '', x.views, x.likes, x.replies, x.reposts, x.quotes, x.shares, x.er?.toFixed(4) ?? '', p.permalink]); }
    const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `threads-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  };
  $('#claudeBtn').onclick = () => askAI(claudeContext());
}

function claudeContext(extra = '') {
  const ps = byDate(rootPosts()).slice(0, 20);
  return `Статистика моего Threads @${S.me?.me?.username || ''} (подписчиков: ${S.me?.followers ?? '?'}), время по Киеву:\n` +
    ps.map(p => { const x = m(p); return `- ${kyiv(p.timestamp, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} | просм ${x.views}, лайки ${x.likes}, ответы ${x.replies}, репосты ${x.reposts}, ER ${pct(x.er)}${p.topic_tag ? ', тема ' + p.topic_tag : ''}\n  "${(p.text || '').replace(/\n/g, ' / ')}"`; }).join('\n') +
    `\n\n${extra || 'Проанализируй, что работает, и предложи 5 новых постов в моём стиле.'}`;
}


// ---------- Отправка задания в Claude / ChatGPT (по подписке, без API) ----------
const STYLE_EXT = `Мой стиль (Threads @karinella.karamel): украинский, разговорный, часто со строчной буквы; самоирония, точные житейские наблюдения, неожиданное сравнение, интеллектуальный сарказм, поворот в конце. Темы: отношения, психология, работа/IT, деньги/инфобизнес, ИИ, соцсети. Только дефис "-" и прямые кавычки ", без длинного тире, «ёлочек», хештегов и эмодзи-гирлянд. Без морализаторства, шаблонного SMM и искусственных вопросов вроде "що думаєте?". Алгоритм Threads: главное, чтобы людям захотелось ОТВЕТИТЬ своей историей (конкретный повод, коллекция, рейтинг, спорный тезис с нюансом), крючок в первой строке, до 280 символов, оригинально. Пиши без суржика и русизмов.`;
function askAI(prompt, target) {
  target = target || S.nextTarget || 'claude'; S.nextTarget = null;
  let text = prompt;
  if (target === 'chatgpt') text = text.replace(/\s*\((используй )?скилл threads-posts\)/g, '').replace(/\(скилл threads-posts\)/g, '') + '\n\n' + STYLE_EXT;
  const base = target === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/new';
  const url = text.length < 6000 ? base + '?q=' + encodeURIComponent(text) : base;
  window.open(url, '_blank', 'noopener');
  copy(text, text.length < 6000 ? `Открываю ${target === 'chatgpt' ? 'ChatGPT' : 'Claude'} с заданием (и скопировала его)` : `Скопировано — вставь в ${target === 'chatgpt' ? 'ChatGPT' : 'Claude'}`);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-gpt]'); if (!b) return;
  e.preventDefault(); const prev = b.previousElementSibling; if (!prev) return;
  S.nextTarget = 'chatgpt'; prev.click();
});
const GPT = cls => `<button class="${cls || 'ghost sm'}" data-gpt>в ChatGPT</button>`;

// ---------- Генератор черновиков + обучение ----------
S.gen = LS.get('gen', []);
const GEN_MODE_LIST = [['', 'механика: микс'], ['recognize', 'узнай себя'], ['unspoken', 'невысказанная мысль'], ['debate', 'спорный тезис (с иронией)'], ['story', 'моя история']];
const GEN_MODE_HINT = { '': '', recognize: 'Узнаваемые бытовые ситуации — чтобы писали «это же про меня» и рассказывали свою версию. Твоя самая сильная механика по статистике.', unspoken: 'То, что все чувствуют, но не говорят вслух — посты, которые пересылают другу и дополняют в ответах.', debate: 'Перевёрнутое популярное убеждение, с которым хочется поспорить — через иронию, без коучинга и скандалов.', story: 'Реальная ситуация из твоей жизни → мини-истории с поворотом. ИИ не придумывает событий и цифр.' };
S.perf = LS.get('perf', null);
const REASONS = ['банально', 'не смешно', 'не мой стиль', 'слишком длинно', 'искусственный вопрос', 'суржик/кривой язык', 'уже было', 'не моя тема'];
function genHtml() {
  return `<div class="card" style="margin-bottom:12px">
    <div class="row"><h3 style="margin:0">Промпт для черновиков</h3><span class="sp"></span><span class="mut small">через твою подписку Claude / ChatGPT</span></div>
    <div class="row" style="margin-top:10px">
      <select id="gcount" style="width:auto">${[5, 10, 15].map(n => `<option ${n == LS.get('gcount', 10) ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <select id="gmode" style="width:auto">${GEN_MODE_LIST.map(([v, l]) => `<option value="${v}" ${v === LS.get('gmode', '') ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="gtopic" style="width:auto"><option value="">любые темы</option>${TOPIC_TAGS.map(t => `<option>${t}</option>`).join('')}</select>
      <input id="ghint" placeholder="пожелание: например «про понедельник», «больше колкости», «про чорну п'ятницю»" style="flex:1;min-width:200px">
    </div>
    <div id="gstoryBox" ${LS.get('gmode', '') === 'story' ? '' : 'hidden'} style="margin-top:8px"><textarea id="gstory" style="min-height:90px" placeholder="опиши реальную ситуацию из своей жизни: что было, кто что сказал, чем закончилось. ИИ найдёт поворот и сделает из неё хуки — ничего не выдумывая">${esc(LS.get('gstory', ''))}</textarea></div>
    <p class="mut small" id="gmodeHint" style="margin:8px 0 0">${GEN_MODE_HINT[LS.get('gmode', '')] || ''}</p>
    <div class="row" style="margin-top:10px">
      <button class="acc" id="gcopy">📋 Копировать промпт</button>
      <button class="ghost" id="gask">Открыть в Claude</button>${GPT('ghost')}
    </div>
    <p class="mut small" style="margin:8px 0 0">В промпт уже входят: выбранная механика, твои лучшие посты по статистике, что залетело и что нет, недавние посты (чтобы не повторяться), твои правила и выводы из оценок.</p>
    <details style="margin-top:12px" id="pasteBox"><summary>Вставить ответ Claude/ChatGPT → оценить</summary>
      <textarea id="gpaste" style="min-height:120px;margin-top:8px" placeholder="вставь сюда весь ответ — посты разделятся по строкам ---"></textarea>
      <div class="row" style="margin-top:6px"><button class="sm" id="gparse">Разобрать в черновики</button><span class="mut small">потом 👍/👎 — так сайт учит твой вкус</span></div>
    </details>
    <div id="glist" style="margin-top:6px"></div>
    <details style="margin-top:12px" id="learnBox"><summary>Чему ИИ научился</summary><div id="learnBody" class="small" style="margin-top:8px">Загрузка…</div></details>
  </div>`;
}
async function genPrompt(target) {
  let p = {}; try { p = await api('/prefs'); } catch {}
  const ps = rootPosts().filter(x => x.metrics && m(x).views >= 20);
  const best = [...ps].sort((x, y) => (m(y).er || 0) - (m(x).er || 0)).slice(0, 5).map(x => `* "${(x.text || '').replace(/\n/g, ' / ')}" (просмотры ${m(x).views}, ответы ${m(x).replies}, ER ${pct(m(x).er)})`).join('\n');
  const recent = byDate(rootPosts()).slice(0, 10).map(x => '* ' + (x.text || '').replace(/\n/g, ' / ')).join('\n');
  const flops = S.perf?.ready && S.perf.flops.length ? S.perf.flops.slice(0, 4).map(f => `* "${f.text.replace(/\n/g, ' / ')}" (ER ${pct(f.er)})`).join('\n') : '';
  const gm = $('#gmode').value, MODE_RU = { recognize: 'Механика «узнай себя»: конкретные бытовые ситуации моей аудитории её же мыслями и формулировками, чтобы хотелось написать «это же про меня». Без общих слов и мотивации.', unspoken: 'Механика «невысказанная мысль»: то, что аудитория давно чувствует, но редко говорит вслух; коротко, дерзко, через неожиданное сравнение, чтобы хотелось переслать другу.', debate: 'Механика «спорный тезис»: перевёрнутое популярное убеждение, с которым хочется поспорить, но через иронию, без коучинга и искусственных скандалов.', story: 'Механика «моя история»: найди в моей реальной ситуации самый неожиданный поворот, конфликт или ошибку и сделай мини-истории с интригой с первой строки. Не выдумывай событий, деталей и цифр.\nМоя ситуация: ' + $('#gstory').value.trim() };
  let text = `Напиши ${$('#gcount').value} разных черновиков постов для моего украинского Threads${$('#gtopic').value ? ' на тему ' + $('#gtopic').value : ''} (скилл threads-posts).${MODE_RU[gm] ? '\n' + MODE_RU[gm] : ''}${$('#ghint').value.trim() ? '\nПожелание: ' + $('#ghint').value.trim() : ''}\n\nМои лучшие посты по статистике (ориентируйся на них):\n${best || '—'}${flops ? '\n\nНе зашли (избегай такого):\n' + flops : ''}\n\nНедавние (не повторяй):\n${recent || '—'}${p.manual ? '\n\nМои правила:\n' + p.manual : ''}${p.notes ? '\n\nЧто я люблю/не люблю (по моим оценкам):\n' + p.notes : ''}\n\nКаждый пост: до 280 символов, крючок в первой строке, жизненно и психологически точно (без абсурда), с 2-3 конкретными примерами из жизни. Повод ответить давай по-разному: незаконченный список, вывод с нюансом, личное признание — вопросом заканчивай не больше трети постов. Формат ответа строго такой — посты разделены строкой ---, без нумерации:\nтекст поста\nТема: одна тема из [психологія, стосунки, айті, робота, гроші, гумор, життя, соцмережі, штучний інтелект]\nПочему: одна строка, почему захотят ответить\n---`;
  if (target === 'chatgpt') text = text.replace(' (скилл threads-posts)', '') + '\n\n' + STYLE_EXT;
  return text;
}
function parsePasted(raw) {
  const blocks = raw.split(/^\s*[-*_—]{3,}\s*$/m).map(s => s.trim()).filter(Boolean);
  return blocks.map(b => {
    let tag = '', why = '';
    const lines = b.split('\n').filter(l => {
      const t = l.match(/^\s*\**\s*(тема|topic|topic tag)\s*\**\s*[:：]\s*(.+)$/i); if (t) { tag = t[2].replace(/[*"«»]/g, '').trim().toLowerCase(); return false; }
      const w = l.match(/^\s*\**\s*(почему|чому|why)\s*\**\s*[:：]\s*(.+)$/i); if (w) { why = w[2].trim(); return false; }
      return true;
    });
    while (lines.length && (/^\s*$/.test(lines[0]) || (/[:：]\s*$/.test(lines[0]) && lines[0].length < 80))) lines.shift();
    const text = lines.join('\n').replace(/^\s*(\d+[.)]|[-•*]|#+)\s+/, '').replace(/\*\*/g, '').replace(/^["«]|["»]$/g, '').trim();
    return { text: localFix(text), topic_tag: TOPIC_TAGS.includes(tag) ? tag : '', why, score: null };
  }).filter(d => d.text.length >= 15 && !/^(вот|ось|here)\b.*:$/i.test(d.text));
}
function setupGen() {
  $('#gmode').onchange = e => { LS.set('gmode', e.target.value); $('#gstoryBox').hidden = e.target.value !== 'story'; $('#gmodeHint').textContent = GEN_MODE_HINT[e.target.value] || ''; if (e.target.value === 'story') $('#gcount').value = '5'; };
  $('#gstory').oninput = e => LS.set('gstory', e.target.value);
  $('#gcopy').onclick = async () => {
    if ($('#gmode').value === 'story' && $('#gstory').value.trim().length < 30) return toast('Опиши свою ситуацию хотя бы в паре предложений');
    copy(await genPrompt('claude'), 'Промпт скопирован — вставь в Claude, ответ потом вставь сюда для оценки');
  };
  $('#gask').onclick = async () => {
    const target = S.nextTarget || 'claude'; S.nextTarget = null;
    const w = window.open('about:blank', '_blank');
    const text = await genPrompt(target);
    const base = target === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/new';
    if (w) w.location = text.length < 6000 ? base + '?q=' + encodeURIComponent(text) : base;
    copy(text, 'Открываю и копирую промпт — ответ потом вставь сюда для оценки');
    $('#pasteBox').open = true;
  };
  $('#gparse').onclick = () => {
    const ds = parsePasted($('#gpaste').value);
    if (!ds.length) return toast('Не нашла постов — проверь, что вставлен ответ целиком');
    S.gen = [...ds.map(d => ({ ...d, id: Date.now() + Math.random(), state: 'new' })), ...S.gen.filter(g => g.state === 'new')].slice(0, 40);
    LS.set('gen', S.gen); $('#gpaste').value = ''; renderGenList(); toast(`Разобрала: ${ds.length} черновиков — оцени их`);
  };
  $('#gcount').onchange = e => LS.set('gcount', +e.target.value);
  $('#learnBox').ontoggle = e => e.target.open && loadLearn();
  renderGenList();
  pullServerDrafts();
}
async function genDrafts() {
  const b = $('#gbtn'); b.disabled = true; b.textContent = 'Пишу черновики…';
  const ps = rootPosts().filter(p => p.metrics && m(p).views >= 20);
  const best = [...ps].sort((a, c) => (m(c).er || 0) - (m(a).er || 0)).slice(0, 5).map(p => ({ text: p.text, views: m(p).views, replies: m(p).replies, er: pct(m(p).er) }));
  const recent = byDate(rootPosts()).slice(0, 12).map(p => (p.text || '').replace(/\n/g, ' / '));
  try {
    const mode = $('#gmode').value, story = $('#gstory').value.trim();
    if (mode === 'story' && story.length < 30) { toast('Опиши свою ситуацию хотя бы в паре предложений'); return; }
    const r = await api('/generate', { method: 'POST', body: { count: +$('#gcount').value, topic: $('#gtopic').value, hint: $('#ghint').value.trim(), best, recent, mode, story } });
    S.gen = [...r.drafts.map(d => ({ ...d, id: Date.now() + Math.random(), state: 'new' })), ...S.gen.filter(g => g.state === 'new')].slice(0, 40);
    LS.set('gen', S.gen); renderGenList(); toast(`Готово: ${r.drafts.length} черновиков`);
  } catch (e) { toast('Генерация: ' + e.message, 6000); }
  finally { b.disabled = false; b.textContent = '✨ Сгенерировать'; }
}
async function pullServerDrafts() {
  try {
    const q = await api('/gqueue');
    let added = 0;
    for (const d of q) if (!S.gen.some(g => g.serverId === d.id || g.text === d.text)) { S.gen.unshift({ id: Date.now() + Math.random(), serverId: d.id, text: d.text, topic_tag: d.topic_tag, why: [d.mech, d.why].filter(Boolean).join(' · '), score: null, state: 'new', fromClaude: true }); added++; }
    const ids = new Set(q.map(d => d.id));
    S.gen = S.gen.filter(g => !g.serverId || ids.has(g.serverId) || g.state !== 'new');
    LS.set('gen', S.gen); renderGenList();
    if (added) toast(`Claude подготовил ${added} черновиков — оцени их в Студии`);
  } catch {}
}
function renderGenList() {
  const box = $('#glist'); if (!box) return;
  const list = S.gen.filter(g => g.state === 'new');
  box.innerHTML = list.length ? list.map(g => {
    const a = analyzePost(g.text, g.topic_tag, null);
    return `<div class="gitem" data-g="${g.id}">
      <textarea class="gtext">${esc(g.text)}</textarea>
      <div class="row small" style="margin-top:4px">
        ${g.topic_tag ? `<span class="pill">${esc(g.topic_tag)}</span>` : ''}
        <span class="pill ${a.score >= 80 ? 'ok' : a.score >= 60 ? '' : 'warn'}" title="${esc(a.checks.filter(c => !c.ok).map(c => c.title).join('; ') || 'все проверки пройдены')}">алгоритм ${a.score}</span>
        ${g.score ? `<span class="pill" title="прогноз ИИ">прогноз ${g.score}/10</span>` : ''}
        ${g.fromClaude ? '<span class="pill lang">от Claude по расписанию</span>' : ''}<span class="mut">${esc(g.why || '')}</span>
      </div>
      <div class="row" style="margin-top:6px">
        <button class="sm" data-ok>👍 Ок</button>
        <button class="ghost sm" data-no>👎 Не ок</button>
        <button class="ghost sm" data-edit>✏️ В редактор</button>
      </div>
      <div class="chips reasons" hidden style="margin-top:6px">${REASONS.map(r => `<span class="chip" data-r="${r}">${r}</span>`).join('')}<span class="chip" data-r="">просто нет</span></div>
    </div>`;
  }).join('') : '<p class="mut small">Скопируй промпт → вставь в Claude → его ответ вставь в «Вставить ответ» выше, и черновики появятся здесь для 👍/👎.</p>';
  box.querySelectorAll('.gitem').forEach(el => {
    const g = S.gen.find(x => x.id == el.dataset.g);
    const text = () => el.querySelector('.gtext').value.trim();
    const done = st => { g.state = st; LS.set('gen', S.gen); if (g.serverId) api('/gqueue/done', { method: 'POST', body: { id: g.serverId } }).catch(() => {}); el.style.opacity = .35; setTimeout(renderGenList, 250); };
    el.querySelector('[data-ok]').onclick = () => { addDraft(text(), g.topic_tag); feedback(text(), 'ok', []); done('ok'); };
    el.querySelector('[data-no]').onclick = () => { el.querySelector('.reasons').hidden = false; };
    el.querySelectorAll('[data-r]').forEach(c => c.onclick = () => { feedback(text(), 'no', c.dataset.r ? [c.dataset.r] : []); done('no'); });
    el.querySelector('[data-edit]').onclick = () => { window.__loadEditor?.(text(), g.topic_tag); feedback(text(), 'ok', []); done('ok'); };
  });
}
function feedback(text, verdict, reasons, kind = 'post') { api('/feedback', { method: 'POST', body: { text, verdict, reasons, kind } }).catch(() => {}); }
function perfHtml() {
  const pf = S.perf;
  if (!pf) return '';
  if (!pf.ready) return `<p class="mut">Обучение на статистике начнётся, когда наберётся 4 поста старше 48 часов с 20+ просмотрами (сейчас ${pf.count || 0}).</p>`;
  const row = p => `<div style="margin:3px 0"><span class="pill">${pct(p.er)}</span> ${esc(p.text.replace(/\n/g, ' / ').slice(0, 110))}</div>`;
  return `<b>Чему научила твоя статистика</b> <span class="mut">(${pf.count} постов, медиана ER ${pct(pf.median.er)})</span>
    <div style="margin:6px 0"><span class="up">▲ Залетело — ИИ берёт за образец:</span>${pf.wins.length ? pf.wins.map(row).join('') : '<div class="mut">пока нет явных лидеров</div>'}</div>
    <div style="margin:6px 0 12px"><span class="down">▼ Не зашло — ИИ избегает:</span>${pf.flops.length ? pf.flops.map(row).join('') : '<div class="mut">явных провалов нет</div>'}</div>`;
}
async function loadLearn() {
  const box = $('#learnBody');
  try {
    const p = await api('/prefs');
    try { S.perf = await api('/perf'); LS.set('perf', S.perf); } catch {}
    box.innerHTML = `<p class="mut">Оценок: 👍 ${p.liked} · 👎 ${p.disliked}${p.learnedAt ? ' · правила обновлены ' + kyiv(p.learnedAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</p>
      ${perfHtml()}
      <b>Правила, которые ИИ вывел сам</b><div style="white-space:pre-wrap;margin:4px 0 10px">${esc(p.notes || 'Пока мало оценок — нужно хотя бы 4.')}</div>
      <label>Твои правила для ИИ (важнее всего остального)</label><textarea id="manualRules" style="min-height:90px" placeholder="например: не шутить про свекровь; больше про IT; никаких «а ви як?»">${esc(p.manual || '')}</textarea>
      <div class="row" style="margin-top:8px"><button class="sm" id="saveRules">Сохранить правила</button><button class="ghost sm" id="relearn">Переобучить сейчас</button></div>`;
    $('#saveRules').onclick = async () => { await api('/prefs', { method: 'POST', body: { manual: $('#manualRules').value } }); toast('Сохранено ✓'); };
    $('#relearn').onclick = async e => { e.target.disabled = true; e.target.textContent = 'Анализирую…'; try { await api('/learn', { method: 'POST' }); await loadLearn(); } catch (err) { toast(err.message); e.target.disabled = false; } };
  } catch (e) { box.textContent = e.message; }
}

// ---------- Студия ----------
function renderStudio() {
  const d = LS.get('draft', { text: '', tag: '' });
  $('#studio').innerHTML = `
    <h2>Студия</h2>
    ${genHtml()}
    <div class="grid two">
      <div class="card">
        <label for="ptext">Текст поста</label>
        <textarea id="ptext" placeholder="пропоную відкрити музей фраз, після яких нічого хорошого не відбувається…">${esc(d.text)}</textarea>
        <div class="counter" id="pcount"></div>
        <div class="row" style="margin-top:6px"><input id="ihint" placeholder="что улучшить (необязательно): короче, смешнее, острее концовка…" style="flex:1;min-width:180px;font-size:13px;padding:8px 10px"><button class="acc sm" id="impBtn">✨ Улучшить</button><button class="ghost sm" id="impAsk">в Claude</button>${GPT()}</div>
        <div class="variants" id="impOut"></div>
        <label for="ptag">Тема (topic tag) — одна на пост</label>
        <input id="ptag" list="tags" maxlength="50" value="${esc(d.tag)}" placeholder="например: психологія">
        <datalist id="tags">${TOPIC_TAGS.map(t => `<option value="${t}">`).join('')}</datalist>
        <div class="chips" style="margin-top:8px">${TOPIC_TAGS.map(t => `<span class="chip" data-tag="${t}">${t}</span>`).join('')}</div>
        <label for="pwhen">Когда</label>
        <input id="pwhen" type="datetime-local">
        <div class="row" style="margin-top:14px">
          <button class="acc" id="schedBtn">Запланировать</button>
          <button class="ghost" id="nowBtn">Опубликовать сейчас</button>
          <span class="sp"></span>
          <button class="ghost sm" id="saveDraft">В черновики</button>
          <button class="ghost sm" id="askClaude">Улучшить в Claude</button>${GPT()}
        </div>
        <p class="mut small">Пост уходит в Threads только по твоей кнопке. Запланированные публикует Worker в облаке — ноутбук можно закрыть.</p>
      </div>
      <div class="grid">
        <div class="card"><div class="row"><div><div class="mut small">Готовность для алгоритма</div><div class="score" id="score">—</div></div><span class="sp"></span><button class="acc sm" id="to100">Довести до 100</button></div>
          <div class="bar"><i id="scorebar" style="width:0"></i></div><ul class="check" id="checks" style="margin-top:12px"></ul></div>
        <div class="card"><h3>Лучшее время (Киев)</h3><div class="grid" id="slots"></div></div>
      </div>
    </div>
    <div class="grid two" style="margin-top:12px">
      <div class="card"><h3>Очередь</h3><div id="queue" class="mut small">Загрузка…</div></div>
      <div class="card"><h3>Черновики</h3><div id="drafts"></div></div>
    </div>`;
  const ta = $('#ptext'), tg = $('#ptag'), wh = $('#pwhen');
  const slots = bestSlots(6);
  if (slots[0]) wh.value = toLocalInput(slots[0].t);
  $('#slots').innerHTML = slots.map(s => `<div class="slot" data-t="${s.t}"><span>${kyiv(s.t, { weekday: 'long', day: 'numeric', month: 'short' })}, <b>${kyiv(s.t, { hour: '2-digit', minute: '2-digit' })}</b></span><span class="pill">${Math.round(s.sc * 100)}</span></div>`).join('') || '<p class="mut">Нет данных</p>';
  $('#slots').querySelectorAll('.slot').forEach(el => el.onclick = () => { wh.value = toLocalInput(+el.dataset.t); update(); toast('Время выбрано'); });
  $('#studio').querySelectorAll('[data-tag]').forEach(c => c.onclick = () => { tg.value = c.dataset.tag; update(); });
  function update() {
    LS.set('draft', { text: ta.value, tag: tg.value });
    const len = [...ta.value].length;
    $('#pcount').textContent = `${len} / 500`; $('#pcount').className = 'counter' + (len > 500 ? ' bad' : '');
    const r = analyzePost(ta.value, tg.value.trim(), wh.value ? fromLocalInput(wh.value) : null);
    $('#score').textContent = ta.value.trim() ? r.score : '—';
    $('#scorebar').style.width = (ta.value.trim() ? r.score : 0) + '%';
    $('#checks').innerHTML = ta.value.trim() ? r.checks.map(c => `<li><span class="i">${c.ok ? '✅' : '⚠️'}</span><span><b>${esc(c.title)}</b>${c.ok ? '' : `<br><span class="mut small">${esc(c.hint)}</span>`}</span></li>`).join('') : '<li class="mut">Начни писать — тут появится разбор</li>';
    $('#studio').querySelectorAll('[data-tag]').forEach(c => c.classList.toggle('on', c.dataset.tag === tg.value.trim()));
  }
  ta.oninput = tg.oninput = wh.oninput = update; update();
  $('#impBtn').onclick = async () => {
    const text = ta.value.trim(); if (!text) return toast('Сначала напиши или выбери черновик');
    const b = $('#impBtn'); b.disabled = true; b.textContent = 'Улучшаю…'; $('#impOut').innerHTML = '';
    try {
      const r = await api('/improve', { method: 'POST', body: { text, tag: tg.value.trim(), hint: $('#ihint').value.trim() } });
      b.textContent = 'Довожу до 100…';
      const res = await Promise.all(r.variants.map(v => polishTo100(v.text, tg.value.trim(), text, n => { b.textContent = `Довожу до 100… (правка ${n})`; }).then(p => ({ ...p, note: v.note }))));
      res.sort((x, y) => y.score - x.score);
      $('#impOut').innerHTML = res.map((v, k) => `<div class="variant"><div style="flex:1"><textarea>${esc(v.text)}</textarea><div class="small mut">${esc(v.note)} · <span class="pill ${v.score >= 100 ? 'ok' : 'warn'}">алгоритм ${v.score}</span> <span class="pill">тема: ${esc(v.tag)}</span>${v.fails.length ? ` <span class="small" style="color:var(--warn)">не дотянуто: ${esc(v.fails.map(f => f.title).join('; '))}</span>` : ''}</div></div><div class="acts"><button class="sm" data-use="${k}">Взять</button><button class="ghost sm" data-dr="${k}">В черновики</button></div></div>`).join('');
      $('#impOut').querySelectorAll('[data-use]').forEach(x => x.onclick = () => { const v = x.closest('.variant').querySelector('textarea').value.trim(); const tagv = res[+x.dataset.use].tag; feedback(text, 'no', ['улучшенная версия лучше']); feedback(v, 'ok', []); ta.value = v; if (!tg.value.trim()) tg.value = tagv; update(); $('#impOut').innerHTML = ''; toast('Текст заменён ✓'); });
      $('#impOut').querySelectorAll('[data-dr]').forEach(x => x.onclick = () => { addDraft(x.closest('.variant').querySelector('textarea').value.trim(), res[+x.dataset.dr].tag); x.disabled = true; });
    } catch (e) { $('#impOut').innerHTML = `<p class="small" style="color:var(--bad)">${esc(e.message)}</p>`; }
    finally { b.disabled = false; b.textContent = '✨ Ещё варианты'; }
  };
  $('#to100').onclick = async () => {
    const text = ta.value.trim(); if (!text) return toast('Сначала напиши текст');
    const b = $('#to100'); b.disabled = true; b.textContent = 'Довожу…';
    try {
      const p = await polishTo100(text, tg.value.trim(), null, n => { b.textContent = `Правка ${n}…`; });
      ta.value = p.text; if (!tg.value.trim()) tg.value = p.tag; update();
      toast(p.score >= 100 ? 'Готово: 100 по тексту ✓' : p.error ? `ИИ не ответил: ${p.error}. Нажми ещё раз` : `Дотянула до ${p.score}: ${p.fails.map(f => f.title).join('; ')}`, 7000);
    } finally { b.disabled = false; b.textContent = 'Довести до 100'; }
  };
  $('#impAsk').onclick = () => { const t = ta.value.trim(); if (!t) return toast('Сначала напиши текст'); askAI(`Улучши этот мой черновик для алгоритма Threads (скилл threads-posts). Сохрани мою мысль и голос, дай 3 варианта: минимальная правка, сильнее поворот, смелее.${$('#ihint').value.trim() ? '\nЧто хочу изменить: ' + $('#ihint').value.trim() : ''}\n\n"${t}"`); };
  window.__loadEditor = (text, tag) => { ta.value = text; tg.value = tag || ''; update(); ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); ta.focus(); };
  setupGen();
  const valid = () => {
    const text = ta.value.trim(), tag = tg.value.trim();
    if (!text) return toast('Пустой текст'), null;
    if ([...text].length > 500) return toast('Больше 500 символов'), null;
    if (/[.&]/.test(tag)) return toast('В теме нельзя точку и &'), null;
    return { text, topic_tag: tag };
  };
  $('#schedBtn').onclick = async () => {
    const p = valid(); if (!p) return;
    const at = fromLocalInput(wh.value);
    if (!at || at < Date.now()) return toast('Выбери время в будущем');
    if (!confirm(`Запланировать на ${kyiv(at, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}?\n\n${p.text}`)) return;
    try { await api('/queue', { method: 'POST', body: { ...p, at: new Date(at).toISOString() } }); feedback(p.text, 'ok', []); ta.value = ''; update(); toast('Запланировано ✓'); loadQueue(); }
    catch (e) { toast(e.message, 5000); }
  };
  $('#nowBtn').onclick = async () => {
    const p = valid(); if (!p) return;
    if (!confirm('Опубликовать в Threads прямо сейчас?\n\n' + p.text)) return;
    const b = $('#nowBtn'); b.disabled = true; b.textContent = 'Публикую…';
    try { const r = await api('/publish', { method: 'POST', body: p }); feedback(p.text, 'ok', []); ta.value = ''; update(); toast('Опубликовано ✓'); if (r.permalink) window.open(r.permalink, '_blank'); setTimeout(syncAll, 3000); }
    catch (e) { toast('Ошибка: ' + e.message + ' — проверь профиль, прежде чем жать снова', 7000); }
    finally { b.disabled = false; b.textContent = 'Опубликовать сейчас'; }
  };
  $('#saveDraft').onclick = () => { const p = valid(); if (!p) return; S.drafts.unshift({ id: Date.now(), ...p }); LS.set('drafts', S.drafts); ta.value = ''; update(); renderDrafts(); toast('Сохранено'); };
  $('#askClaude').onclick = () => askAI(claudeContext(ta.value.trim() ? `Улучши этот черновик для алгоритма Threads, сохрани мой стиль, дай 3 варианта:\n"${ta.value.trim()}"` : ''));
  function renderDrafts() {
    $('#drafts').innerHTML = S.drafts.length ? S.drafts.map(d => `<div class="result"><div class="t">${esc(d.text)}</div><div class="row small" style="margin-top:6px">${d.topic_tag ? `<span class="pill">${esc(d.topic_tag)}</span>` : ''}<span class="sp"></span><a href="#" data-use="${d.id}">в редактор</a><a href="#" data-imp="${d.id}">✨ улучшить</a><a href="#" data-del="${d.id}" style="color:var(--bad)">удалить</a></div></div>`).join('') : '<p class="mut small">Пусто. Сюда удобно складывать посты, которые придумал Claude.</p>';
    $('#drafts').querySelectorAll('[data-use]').forEach(a => a.onclick = e => { e.preventDefault(); const d = S.drafts.find(x => x.id == a.dataset.use); ta.value = d.text; tg.value = d.topic_tag || ''; update(); ta.focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    $('#drafts').querySelectorAll('[data-imp]').forEach(x => x.onclick = e => { e.preventDefault(); const d = S.drafts.find(y => y.id == x.dataset.imp); ta.value = d.text; tg.value = d.topic_tag || ''; update(); ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#impBtn').click(); });
    $('#drafts').querySelectorAll('[data-del]').forEach(a => a.onclick = e => { e.preventDefault(); S.drafts = S.drafts.filter(x => x.id != a.dataset.del); LS.set('drafts', S.drafts); renderDrafts(); });
  }
  window.__renderDrafts = renderDrafts;
  renderDrafts(); loadQueue();
}
const toLocalInput = t => { const d = new Date(t); const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };
const fromLocalInput = v => v ? new Date(v).getTime() : null;

async function loadQueue() {
  const box = $('#queue'); if (!box) return;
  try {
    S.queue = await api('/queue');
    const st = { scheduled: ['ждёт', ''], publishing: ['публикуется', 'warn'], published: ['опубликован', 'ok'], error: ['ошибка', 'bad'] };
    const list = [...S.queue].sort((a, b) => new Date(b.at) - new Date(a.at));
    box.innerHTML = list.length ? list.map(q => `<div class="result"><div class="meta">${kyiv(q.at, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · <span class="pill ${st[q.status]?.[1]}">${st[q.status]?.[0] || q.status}</span> ${q.topic_tag ? `<span class="pill">${esc(q.topic_tag)}</span>` : ''}</div><div class="t">${esc(q.text)}</div>
      <div class="row small" style="margin-top:6px">${q.error ? `<span style="color:var(--bad)">${esc(q.error)}</span>` : ''}${q.permalink ? `<a href="${esc(q.permalink)}" target="_blank">открыть ↗</a>` : ''}<span class="sp"></span>${q.status === 'scheduled' || q.status === 'error' || q.status === 'published' ? `<a href="#" data-cancel="${q.id}" style="color:var(--bad)">${q.status === 'scheduled' ? 'отменить' : 'убрать'}</a>` : ''}</div></div>`).join('') : '<p class="mut small">Ничего не запланировано</p>';
    box.querySelectorAll('[data-cancel]').forEach(a => a.onclick = async e => { e.preventDefault(); if (!confirm('Убрать из очереди?')) return; try { await api('/queue/' + a.dataset.cancel, { method: 'DELETE' }); loadQueue(); } catch (err) { toast(err.message); } });
  } catch (e) { box.textContent = 'Очередь недоступна: ' + e.message; }
}

// ---------- Тренды ----------
const TREND_PRESETS = {
  'IT': ['айті', 'мітинг', 'співбесіда', 'джун', 'стендап'],
  'Психология': ['психолог', 'терапія', 'тривожність', 'кордони'],
  'Отношения': ['стосунки', 'побачення', 'колишній', 'подруга'],
  'Деньги': ['гроші', 'зарплата', 'податкова', 'інфоцигани'],
  'ИИ': ['штучний інтелект', 'chatgpt', 'нейромережа'],
  'Threads': ['укртредс', 'тредс', 'підписники'],
};
const WDEF = { bs: true, ms: true, langs: [], topics: [], minLikes: 50, minReplies: 0, minF: 0, maxF: 5000, hours: 72, minChance: 6, media: 'any', sort: 'chance', clean: true, nolocal: true };
const wcfg = () => ({ ...WDEF, ...LS.get('worldCfg3', {}) });
const LANG_NAMES = { en: '🇬🇧 английский', es: '🇪🇸 испанский', de: '🇩🇪 немецкий', ja: '🇯🇵 японский', fr: '🇫🇷 французский', pt: '🇧🇷 португальский', it: '🇮🇹 итальянский', nl: '🇳🇱 нидерландский', pl: '🇵🇱 польский', ru: '🇷🇺 русский', ko: '🇰🇷 корейский', zh: '🇨🇳 китайский', tr: '🇹🇷 турецкий', sv: '🇸🇪 шведский', fi: '🇫🇮 финский', cs: '🇨🇿 чешский', da: '🇩🇰 датский', no: '🇳🇴 норвежский', nb: '🇳🇴 норвежский', uk: '🇺🇦 украинский', ca: 'каталанский', eu: 'баскский', gl: 'галисийский', el: '🇬🇷 греческий', he: '🇮🇱 иврит', ar: 'арабский', hi: '🇮🇳 хинди', id: '🇮🇩 индонезийский', th: '🇹🇭 тайский', vi: '🇻🇳 вьетнамский', hu: '🇭🇺 венгерский', ro: '🇷🇴 румынский' };
const langOf = i => ((S.tr[i.id]?.lang || i.lang || '').slice(0, 2).toLowerCase()) || '?';
const langName = c => LANG_NAMES[c] || (c === '?' ? 'язык не указан' : c);
const WTOPICS = ['стосунки', 'психологія', 'робота', 'айті', 'гроші', 'гумор', 'життя', 'соцмережі', 'ші', 'інше'];

function renderTrends() {
  const W = wcfg();
  const num = (id, label, vals, cur) => `<label class="flt"><span>${label}</span><select id="${id}">${vals.map(v => `<option value="${v[0] ?? v}" ${String(v[0] ?? v) === String(cur) ? 'selected' : ''}>${v[1] ?? v}</option>`).join('')}</select></label>`;
  $('#trends').innerHTML = `
    <div class="row"><h2>Залетело в мире</h2><span class="sp"></span><span id="wstat" class="mut small"></span><button class="ghost sm" id="wgo">↻ Найти свежее</button><button class="ghost sm" id="woff" title="Скрыть вкладку и не тратить лимит ИИ">Выключить вкладку</button></div>
    <p class="mut small" style="margin-top:-6px">Посты обычных людей из Bluesky и Mastodon, которые собрали много реакций. ИИ оценивает, есть ли у них шанс залететь в рекомендации украинского Threads (понятно ли без контекста страны, захочется ли ответить, свежо ли), отсеивает локальное и переписывает лучшие по-нашему. Threads не отдаёт лайки чужих постов через API, поэтому ищем в соседних текстовых соцсетях.</p>
    <div class="card">
      <div class="fgrid">
        ${num('f_minLikes', 'лайков от', [0, 50, 100, 200, 500, 1000, 5000], W.minLikes)}
        ${num('f_minReplies', 'комментов от', [0, 5, 10, 25, 50, 100, 500], W.minReplies)}
        ${num('f_minF', 'подписчиков от', [0, 50, 100, 500, 1000], W.minF)}
        ${num('f_maxF', 'подписчиков до', [300, 1000, 3000, 5000, 10000, 50000], W.maxF)}
        ${num('f_hours', 'свежесть', [[12, '12 часов'], [24, 'сутки'], [48, '2 дня'], [72, '3 дня']], W.hours)}
        ${num('f_minChance', 'шанс в укр. Threads от', [[0, 'любой'], [5, '5/10'], [6, '6/10'], [7, '7/10'], [8, '8/10']], W.minChance)}
        ${num('f_media', 'формат', [['any', 'любой'], ['text', 'только текст'], ['media', 'с картинкой/видео']], W.media)}
        ${num('f_sort', 'сортировка', [['chance', 'шанс залететь у нас'], ['fit', 'подходит мне'], ['talk', 'больше обсуждают'], ['noname', 'ноунейм-индекс'], ['eng', 'больше реакций'], ['fresh', 'свежее']], W.sort)}
      </div>
      <div class="row small" style="margin-top:10px;gap:14px">
        <label class="chk"><input type="checkbox" id="f_bs" ${W.bs ? 'checked' : ''}> Bluesky</label>
        <label class="chk"><input type="checkbox" id="f_ms" ${W.ms ? 'checked' : ''}> Mastodon</label>
        <label class="chk"><input type="checkbox" id="f_clean" ${W.clean ? 'checked' : ''}> без политики, войны, новостей, 18+</label>
        <label class="chk"><input type="checkbox" id="f_nolocal" ${W.nolocal ? 'checked' : ''}> без локального (фандомы, местные мемы, суть в картинке)</label>
      </div>
      <div class="row small" style="margin-top:10px"><span class="mut" style="width:70px">языки</span><div class="chips" id="f_langs"></div></div>
      <div class="row small" style="margin-top:6px"><span class="mut" style="width:70px">темы</span><div class="chips" id="f_topics">${WTOPICS.map(t => `<span class="chip ${W.topics.includes(t) ? 'on' : ''}" data-topic="${t}">${t}</span>`).join('')}</div></div>
    </div>
    <div id="wres" style="margin-top:12px"></div>
    <h2 style="margin-top:28px">Поиск в Threads</h2>
    <div class="card">
      <div class="row"><input id="tq" placeholder="слово или фраза, напр. мітинг" style="flex:2;min-width:200px">
        <select id="ttype" style="width:auto"><option value="TOP">Популярные</option><option value="RECENT">Свежие</option></select>
        <select id="tper" style="width:auto"><option value="1">24 часа</option><option value="3">3 дня</option><option value="7" selected>7 дней</option><option value="30">30 дней</option></select>
        <select id="tmode" style="width:auto"><option value="KEYWORD">по словам</option><option value="TAG">по теме</option></select>
        <button class="acc" id="tgo">Искать</button></div>
      <div class="row small" style="margin-top:10px"><label class="chk"><input type="checkbox" id="tua" checked> только украиноязычные</label></div>
      <div style="margin-top:10px">${Object.entries(TREND_PRESETS).map(([g, ws]) => `<div class="row small" style="margin:4px 0"><span class="mut" style="width:90px">${g}</span><div class="chips">${ws.map(w => `<span class="chip" data-q="${w}">${w}</span>`).join('')}</div></div>`).join('')}</div>
    </div>
    <div id="tnote"></div>
    <div class="card" id="tres" style="margin-top:12px"><div class="empty">Выбери тему или введи слово</div></div>`;
  $('#trends').querySelectorAll('[data-q]').forEach(c => c.onclick = () => { $('#tq').value = c.dataset.q; search(); });
  $('#tgo').onclick = search; $('#tq').onkeydown = e => e.key === 'Enter' && search();
  const save = () => {
    const c = wcfg();
    for (const k of ['minLikes', 'minReplies', 'minF', 'maxF', 'hours', 'minChance']) c[k] = +$('#f_' + k).value;
    c.media = $('#f_media').value; c.sort = $('#f_sort').value;
    c.bs = $('#f_bs').checked; c.ms = $('#f_ms').checked; c.clean = $('#f_clean').checked; c.nolocal = $('#f_nolocal').checked;
    LS.set('worldCfg3', c); renderWorld(); translateVisible();
  };
  $('#trends').querySelectorAll('.fgrid select, #f_bs, #f_ms, #f_clean, #f_nolocal').forEach(el => el.onchange = save);
  $('#f_topics').querySelectorAll('[data-topic]').forEach(ch => ch.onclick = () => { const c = wcfg(); const t = ch.dataset.topic; c.topics = c.topics.includes(t) ? c.topics.filter(x => x !== t) : [...c.topics, t]; LS.set('worldCfg3', c); ch.classList.toggle('on'); renderWorld(); });
  $('#wgo').onclick = () => loadWorld(true);
  $('#woff').onclick = () => { S.worldStop = true; LS.set('trendsOn', false); toast('Вкладка «Тренды» выключена — включить можно в «Подключении»', 5000); renderAll(); };
  renderWorld();
  if (!S.world || Date.now() - LS.get('worldAt', 0) > 3 * 3600e3) loadWorld(); else translateVisible();
}
function renderLangChips() {
  const box = $('#f_langs'); if (!box) return;
  const W = wcfg(), cnt = {};
  for (const i of baseFiltered(true)) { const l = langOf(i); cnt[l] = (cnt[l] || 0) + 1; }
  const langs = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
  box.innerHTML = `<span class="chip ${W.langs.length ? '' : 'on'}" data-lang="*">все</span>` + langs.map(([l, n]) => `<span class="chip ${W.langs.includes(l) ? 'on' : ''}" data-lang="${l}">${esc(langName(l))} · ${n}</span>`).join('');
  box.querySelectorAll('[data-lang]').forEach(ch => ch.onclick = () => { const c = wcfg(); const l = ch.dataset.lang; c.langs = l === '*' ? [] : c.langs.includes(l) ? c.langs.filter(x => x !== l) : [...c.langs, l]; LS.set('worldCfg3', c); renderWorld(); translateVisible(); });
}

// ---------- мировые тренды ----------
S.world = LS.get('world', null);
S.tr = LS.get('tr', {});
const POLITICS = /\b(trump|biden|harris|musk|putin|zelensk|election|congress|senate|gop|maga|democrat|republican|ukraine|russia|israel|gaza|palestin|netanyahu|nato|war|tariff|ice\b|elecci|gobierno|pp\b|psoe|vox\b|macron|merz|afd|bundestag|wahl|krieg|政府|選挙|首相|大統領|戦争|путин|выбор|война|депутат)/i;
const stripHtml = h => { const d = new DOMParser().parseFromString(String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n'), 'text/html'); return (d.body.textContent || '').trim(); };
async function loadWorld(force) {
  const st = $('#wstat'), btn = $('#wgo');
  if (btn) { btn.disabled = true; btn.textContent = 'Ищу…'; }
  const setS = t => { if ($('#wstat')) $('#wstat').textContent = t; };
  try {
    const now = Date.now(), maxAge = 72 * 3600e3;
    const items = [];
    setS('Bluesky…');
    let cursor;
    const FEEDS = [['at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot', 4], ['at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/hot-classic', 2], ['at://did:plc:wqowuobffl66jv3kpsvo7ak4/app.bsky.feed.generator/the-algorithm', 2]];
    for (const [feed, pages] of FEEDS) { cursor = undefined;
    for (let i = 0; i < pages; i++) {
      const u = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=' + feed + '&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const r = await fetch(u).then(r => r.json()).catch(() => null);
      if (!r?.feed) break;
      for (const { post: p } of r.feed) {
        if (p.record?.reply) continue;
        const text = p.record?.text || '';
        items.push({ id: 'bs:' + p.uri, src: 'Bluesky', text, lang: (p.record?.langs || [])[0] || '', likes: p.likeCount || 0, replies: p.replyCount || 0, reposts: (p.repostCount || 0) + (p.quoteCount || 0), author: p.author.handle, name: p.author.displayName || '', did: p.author.did, followers: null, url: `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split('/').pop()}`, at: p.record?.createdAt || p.indexedAt, media: !!p.embed });
      }
      cursor = r.cursor; if (!cursor) break;
    } }
    setS('Mastodon…');
    for (const inst of ['mastodon.social', 'mastodon.online', 'mas.to', 'mstdn.social', 'mastodon.world']) {
      for (const off of (inst === 'mastodon.social' ? [0, 40, 80] : [0, 40])) {
        const r = await fetch(`https://${inst}/api/v1/trends/statuses?limit=40&offset=${off}`).then(r => r.json()).catch(() => null);
        if (!Array.isArray(r) || !r.length) break;
        for (const s of r) items.push({ id: 'ms:' + s.uri, src: 'Mastodon', text: stripHtml(s.content), lang: s.language || '', likes: s.favourites_count || 0, replies: s.replies_count || 0, reposts: s.reblogs_count || 0, author: s.account.acct.includes('@') ? s.account.acct : s.account.acct + '@' + inst, name: s.account.display_name || '', followers: s.account.followers_count, url: s.url, at: s.created_at, media: !!s.media_attachments?.length });
      }
    }
    const seen = new Set();
    const junk = i => /https?:\/\/|www\./i.test(i.text) || (i.text.match(/#\S+/g) || []).length >= 3 || (i.text.match(/@\S+/g) || []).length >= 3 || (i.media && i.text.length < 60) || /^(breaking|update|news|live)\b/i.test(i.text);
    let pool = items.filter(i => !seen.has(i.id) && seen.add(i.id) && now - new Date(i.at) < maxAge && i.text.length >= 25 && i.likes + i.replies + i.reposts >= 40 && !junk(i));
    // подписчики авторов Bluesky
    setS('Проверяю авторов…');
    const dids = [...new Set(pool.filter(i => i.did).map(i => i.did))];
    const fol = {};
    for (let k = 0; k < dids.length; k += 25) {
      const r = await fetch('https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?' + dids.slice(k, k + 25).map(d => 'actors=' + encodeURIComponent(d)).join('&')).then(r => r.json()).catch(() => null);
      for (const p of r?.profiles || []) fol[p.did] = p.followersCount;
    }
    for (const i of pool) if (i.did) i.followers = fol[i.did] ?? null;
    pool = pool.filter(i => i.followers != null && i.followers <= 50000);
    S.world = pool; LS.set('world', pool); LS.set('worldAt', Date.now());
    renderWorld();
    await translateVisible();
  } catch (e) { toast('Тренды: ' + e.message, 5000); }
  finally { if ($('#wgo')) { $('#wgo').disabled = false; $('#wgo').textContent = '↻ Найти свежее'; } }
}
function baseFiltered(ignoreLang) {
  const W = wcfg(), now = Date.now();
  return (S.world || []).filter(i => {
    if (i.src === 'Bluesky' && !W.bs || i.src === 'Mastodon' && !W.ms) return false;
    if (i.likes < W.minLikes || i.replies < W.minReplies) return false;
    if (i.followers > W.maxF || i.followers < W.minF) return false;
    if (now - new Date(i.at) > W.hours * 3600e3) return false;
    if (W.media === 'text' && i.media || W.media === 'media' && !i.media) return false;
    if (langOf(i) === 'uk') return false;
    if (!ignoreLang && W.langs.length && !W.langs.includes(langOf(i))) return false;
    const t = S.tr[i.id];
    if (W.clean) { if (POLITICS.test(i.text)) return false; if (t && (['політика', 'новини'].includes(t.topic) || (t.flags || []).some(f => ['політика', 'війна', 'новини', '18+', 'реклама', 'росія'].includes(f)))) return false; }
    if (W.nolocal && t && (t.flags || []).some(f => ['локальне', 'фандом', 'картинка'].includes(f))) return false;
    if (t && t.mech != null && W.minChance && t.chance < W.minChance) return false;
    if (t && W.topics.length && !W.topics.includes(t.topic)) return false;
    return true;
  });
}
function worldFiltered() {
  const W = wcfg();
  const eng = i => i.likes + i.replies + i.reposts;
  const noname = i => (i.likes + i.replies * 3) / (i.followers + 50);
  const fit = i => S.tr[i.id]?.fit ?? 5;
  const talk = i => i.replies / (i.likes + 20);
  const chance = i => { const t = S.tr[i.id]; if (t?.chance == null) return -1; return t.chance + (t.reply - 5) * 0.3 + (t.uni - 7) * 0.2 + (t.fresh - 5) * 0.15 + Math.min(talk(i) * 4, 1.5) + Math.min(noname(i) / 4, 1); };
  const by = { chance: (a, b) => chance(b) - chance(a), talk: (a, b) => talk(b) - talk(a), fit: (a, b) => fit(b) - fit(a) || noname(b) - noname(a), noname: (a, b) => noname(b) - noname(a), eng: (a, b) => eng(b) - eng(a), replies: (a, b) => b.replies - a.replies, fresh: (a, b) => new Date(b.at) - new Date(a.at) }[W.sort] || ((a, b) => 0);
  return baseFiltered().sort(by).slice(0, 40);
}

async function translateVisible() {
  const pot = i => (i.replies * 3 + i.likes) / (i.followers + 100);
  const free = (S.me?.ai?.provider || 'workers-ai') === 'workers-ai';
  const need = baseFiltered().filter(i => S.tr[i.id]?.mech == null).sort((a, b) => pot(b) - pot(a)).slice(0, free ? 10 : 40);
  if (!need.length) { if ($('#wstat')) $('#wstat').textContent = ''; return; }
  const prov = S.me?.ai?.provider; const per = prov === 'gemini' ? 6 : prov === 'claude' ? 5 : 2; const conc = prov === 'gemini' ? 2 : 6;
  const chunks = []; for (let k = 0; k < need.length; k += per) chunks.push(need.slice(k, k + per));
  let done = 0, failed = 0;
  const st = () => { if ($('#wstat')) $('#wstat').textContent = `Перевожу: ${done} из ${need.length}…`; };
  st();
  const run = async ch => {
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 150000);
      const res = await fetch(S.worker.replace(/\/$/, '') + '/translate', { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'X-Key': S.key }, body: JSON.stringify({ items: ch.map(i => ({ id: i.id, text: i.text, likes: i.likes, replies: i.replies, media: i.media })) }) });
      clearTimeout(to);
      const r = await res.json(); if (r.error) throw new Error(r.error);
      for (const t of r) S.tr[t.id] = t;
      LS.set('tr', S.tr);
    } catch (e) { failed++; if (/лимит/i.test(e.message || '')) S.aiLimit = e.message; }
    done += ch.length; st(); renderWorld();
  };
  S.worldStop = false; let next = 0; await Promise.all(Array.from({ length: conc }, async () => { while (next < chunks.length && !S.worldStop && LS.get('trendsOn', true) && location.hash === '#trends') await run(chunks[next++]); }));
  if ($('#wstat')) $('#wstat').textContent = S.aiLimit ? 'бесплатный лимит ИИ на сегодня исчерпан' : failed ? `часть не перевелась (${failed}) — нажми «Найти свежее» ещё раз` : '';
  if (S.aiLimit) toast(S.aiLimit, 8000);
}
function renderWorld() {
  const box = $('#wres'); if (!box) return;
  renderLangChips();
  if (!S.world) { box.innerHTML = '<div class="card empty">Ищу залетевшие посты…</div>'; return; }
  const list = worldFiltered();
  if ($('#wstat') && !/Перевожу|часть|Bluesky|Mastodon|авторов/.test($('#wstat').textContent)) $('#wstat').textContent = `найдено ${list.length}`;
  box.innerHTML = list.length ? `<div class="card">${list.map(i => { const t = S.tr[i.id]; const l = langOf(i); return `
    <div class="result">
      <div class="meta"><span class="pill lang">${esc(langName(l))}</span> ${i.src} · <b>${esc(i.name || i.author)}</b> @${esc(i.author)} · ${fmt(i.followers)} подп. · ${kyiv(i.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        ${t ? `<span class="pill">${esc(t.topic)}</span>` : ''}</div>
      ${t?.chance != null ? `<div class="row small" style="margin-top:6px;gap:6px">
        <span class="pill ${t.chance >= 8 ? 'ok' : t.chance >= 6 ? '' : 'warn'}" style="font-weight:700">шанс у нас ${t.chance}/10</span>
        ${t.mech ? `<span class="pill lang" title="механика, из-за которой отвечают">${esc(t.mech)}</span>` : ''}
        <span class="pill" title="понятно без контекста страны">универсально ${t.uni}</span>
        <span class="pill" title="захочется ответить своей историей">захотят ответить ${t.reply}</span>
        <span class="pill" title="свежесть идеи">свежесть ${t.fresh}</span>
        <span class="pill" title="подходит твоему аккаунту">твоё ${t.fit}</span>
        ${(t.flags || []).map(f => `<span class="pill warn">${esc(f)}</span>`).join('')}
      </div>${t.why ? `<div class="small mut" style="margin-top:4px">${esc(t.why)}</div>` : ''}` : ''}
      ${t?.ua ? `<div class="ua"><span class="mut small">по-нашему:</span><div class="t">${esc(t.ua)}</div></div>` : ''}
      ${t ? `<div class="small" style="margin-top:6px"><span class="mut">перевод:</span> ${esc(t.uk)}</div>` : `<div class="t mut">${esc(i.text)}</div>`}
      ${t ? `<details class="small" style="margin-top:4px"><summary>оригинал (${esc(langName(l))})</summary><div class="mut" style="white-space:pre-wrap">${esc(i.text)}</div></details>` : ''}
      <div class="row small" style="margin-top:6px"><span>❤ ${fmt(i.likes)}</span><span>💬 ${fmt(i.replies)}</span><span>🔁 ${fmt(i.reposts)}</span>${i.media ? '<span class="pill">с медиа</span>' : ''}
        <a href="${esc(i.url)}" target="_blank" rel="noopener">открыть ↗</a><span class="sp"></span>
        ${t?.ua ? `<button class="ghost sm" data-uadraft="${esc(i.id)}">В черновики</button>` : ''}
        <button class="acc sm" data-adapt="${esc(i.id)}">✨ Ещё идеи</button><button class="ghost sm" data-wclaude="${esc(i.id)}">в Claude</button>${GPT()}</div>
      <div class="variants" data-out="${esc(i.id)}"></div>
    </div>`; }).join('')}</div>` : '<div class="card empty">Под эти фильтры ничего нет — ослабь фильтры или нажми «Найти свежее»</div>';
  box.querySelectorAll('[data-adapt]').forEach(b => b.onclick = () => adaptIdea(b.dataset.adapt, b));
  box.querySelectorAll('[data-uadraft]').forEach(b => b.onclick = () => { addDraft(S.tr[b.dataset.uadraft].ua, ''); b.disabled = true; b.textContent = 'В черновиках ✓'; });
  box.querySelectorAll('[data-wclaude]').forEach(b => b.onclick = () => { const i = S.world.find(x => x.id === b.dataset.wclaude); askAI(`Этот пост залетел в ${i.src} (${langName(langOf(i))}, ${fmt(i.likes)} лайков, ${fmt(i.replies)} ответов, у автора ${fmt(i.followers)} подписчиков):\n"${i.text}"\n${i.url}\n\nНе копируй — возьми механику и придумай 5 оригинальных постов для моего украинского Threads (скилл threads-posts).`); });
}
function addDraft(text, tag) { if (!text) return; S.drafts.unshift({ id: Date.now() + Math.random(), text, topic_tag: tag || '' }); LS.set('drafts', S.drafts); window.__renderDrafts?.(); toast('В черновиках Студии ✓'); }

async function adaptIdea(id, btn) {
  const i = S.world.find(x => x.id === id); const out = document.querySelector(`[data-out="${CSS.escape(id)}"]`);
  btn.disabled = true; btn.textContent = 'Думаю…';
  try {
    const r = await api('/adapt', { method: 'POST', body: { text: (S.tr[id]?.uk ? S.tr[id].uk + '\n(оригінал: ' + i.text + ')' : i.text) } });
    out.innerHTML = r.variants.map((v, k) => `<div class="variant"><textarea>${esc(v)}</textarea><div class="acts"><button class="sm" data-draft="${k}">В черновики</button><button class="ghost sm" data-cpv="${k}">Копия</button></div></div>`).join('');
    out.querySelectorAll('[data-draft]').forEach(b => b.onclick = () => { addDraft(b.closest('.variant').querySelector('textarea').value.trim(), ''); b.disabled = true; });
    out.querySelectorAll('[data-cpv]').forEach(b => b.onclick = () => copy(b.closest('.variant').querySelector('textarea').value));
  } catch (e) { out.innerHTML = `<p class="small" style="color:var(--bad)">${esc(e.message)}</p>`; }
  finally { btn.disabled = false; btn.textContent = '✨ Ещё идеи'; }
}
async function search() {
  const q = $('#tq').value.trim(); if (!q) return;
  const days = +$('#tper').value;
  const box = $('#tres'); box.innerHTML = '<div class="empty">Ищу…</div>'; $('#tnote').innerHTML = '';
  try {
    const r = await api(`/search?q=${encodeURIComponent(q)}&type=${$('#ttype').value}&mode=${$('#tmode').value}&since=${Math.floor(Date.now() / 1000 - days * 86400)}&limit=100`);
    let list = r.data;
    const own = list.filter(p => p.username === r.self).length;
    if (list.length && own === list.length) $('#tnote').innerHTML = `<div class="card" style="margin-top:12px;border-color:var(--warn)"><b>Поиск видит только твои посты.</b><p class="mut small" style="margin:4px 0 0">Так Meta ограничивает приложения без расширенного доступа к threads_keyword_search. Чтобы искать чужие посты, нужно пройти App Review в Meta Developers (Advanced Access). Пока что лучше просматривать ленту темы в самом Threads, а сюда приносить идеи.</p></div>`;
    if ($('#tua').checked) list = list.filter(p => /[іїєґ]/i.test(p.text || '') || !/[ыэъё]/i.test(p.text || '') && /[а-я]/i.test(p.text || ''));
    box.innerHTML = list.length ? list.map(p => `<div class="result"><div class="meta">@${esc(p.username)} · ${kyiv(p.timestamp, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} ${p.has_replies ? '<span class="pill ok">есть ответы</span>' : ''}</div>
      <div class="t">${esc(p.text || '')}</div><div class="row small" style="margin-top:6px"><a href="${esc(p.permalink)}" target="_blank" rel="noopener">открыть ↗</a><span class="sp"></span><a href="#" data-idea="${p.id}">идея ответа → Claude</a> <a href="#" data-gpt>→ ChatGPT</a></div></div>`).join('') : '<div class="empty">Ничего не нашлось</div>';
    box.querySelectorAll('[data-idea]').forEach(a => a.onclick = e => { e.preventDefault(); const p = list.find(x => x.id === a.dataset.idea); askAI(`Придумай 3 варианта моего ответа на этот пост в Threads (мой стиль: украинский, разговорный, со строчной, самоирония, точное наблюдение, без морализаторства). Ответ должен добавлять свой поворот, чтобы люди переходили в мой профиль.\n\n@${p.username}: "${p.text}"\n${p.permalink}`); });
  } catch (e) { box.innerHTML = /permission/i.test(e.message) ? `<div class="empty" style="text-align:left"><b>У токена нет разрешения на поиск (threads_keyword_search).</b><br>Meta Developers → приложение → «Варианты использования» → Access the Threads API → «Разрешения»: проверь, что threads_keyword_search добавлено. Потом «Настройки» → «Генератор маркеров пользователя» → <b>сгенерируй новый токен</b> и вставь его здесь: «Подключение» → «Заменить токен». Без расширенного доступа поиск всё равно покажет только твои посты.</div>` : `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}


// ---------- Ответы на комментарии ----------
S.inbox = LS.get('inbox', null);
S.done = LS.get('doneReplies', {});
async function loadInbox(force) {
  const days = LS.get('inboxDays', 14), all = LS.get('inboxAll', false);
  S.inbox = await api(`/inbox?days=${days}${all ? '&all=1' : ''}`);
  LS.set('inbox', S.inbox); LS.set('inboxAt', Date.now());
  updateBadge();
}
function pendingCount() { return (S.inbox || []).reduce((a, g) => a + g.comments.filter(c => !c.answered && !S.done[c.id]).length, 0); }
function updateBadge() { const b = $('#rbadge'); if (!b) return; const n = pendingCount(); b.hidden = !n; b.textContent = n; }
function renderReplies() {
  const days = LS.get('inboxDays', 14), all = LS.get('inboxAll', false);
  const groups = S.inbox || [];
  $('#replies').innerHTML = `
    <div class="row"><h2>Ответы на комментарии</h2><span class="sp"></span>
      <select id="rdays" style="width:auto">${[3, 7, 14, 30].map(d => `<option value="${d}" ${d == days ? 'selected' : ''}>посты за ${d} дн.</option>`).join('')}</select>
      <label style="margin:0;display:flex;gap:6px;align-items:center;color:var(--ink)" class="small"><input type="checkbox" id="rall" ${all ? 'checked' : ''} style="width:auto"> показывать отвеченные</label>
      <button class="ghost sm" id="rload">↻ Собрать комментарии</button></div>
    <p class="mut small" style="margin-top:-6px">Ответ в первый час после комментария продлевает жизнь поста в рекомендациях. Ничего не уходит без кнопки «Ответить».</p>
    <div id="rlist">${!S.inbox ? '<div class="card empty">Нажми «Собрать комментарии»</div>' : groups.length ? groups.map(g => `
      <div class="card" style="margin-bottom:12px">
        <div class="row small mut" style="margin-bottom:6px"><span>${kyiv(g.post.timestamp, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><span class="sp"></span><a href="${esc(g.post.permalink)}" target="_blank" rel="noopener">пост ↗</a></div>
        <div class="postHead">${esc(g.post.text || '')}</div>
        ${g.error ? `<p style="color:var(--bad)" class="small">${esc(g.error)}</p>` : ''}
        ${g.comments.map(c => commentHtml(g, c)).join('')}
      </div>`).join('') : '<div class="card empty">Все комментарии отвечены 🎉</div>'}</div>`;
  $('#rdays').onchange = e => { LS.set('inboxDays', +e.target.value); refreshInbox(); };
  $('#rall').onchange = e => { LS.set('inboxAll', e.target.checked); refreshInbox(); };
  $('#rload').onclick = refreshInbox;
  $('#rlist').querySelectorAll('[data-gen]').forEach(b => b.onclick = () => generate(b.dataset.gen));
  $('#rlist').querySelectorAll('[data-claude]').forEach(b => b.onclick = () => { const { g, c } = findC(b.dataset.claude); askAI(`Придумай 3 варианта моего ответа на комментарий под моим постом в Threads (используй скилл threads-posts).\n\nМой пост: "${g.post.text}"\n${c.chain.map(x => (x.mine ? 'я' : '@' + x.username) + ': "' + x.text + '"').join('\n')}\n@${c.username}: "${c.text}"`); });
  $('#rlist').querySelectorAll('[data-skip]').forEach(b => b.onclick = () => { S.done[b.dataset.skip] = 'skip'; LS.set('doneReplies', S.done); updateBadge(); b.closest('.cm').style.opacity = .4; });
  updateBadge();
}
function findC(id) { for (const g of S.inbox || []) for (const c of g.comments) if (c.id === id) return { g, c }; return {}; }
function commentHtml(g, c) {
  const done = c.answered || S.done[c.id];
  return `<div class="cm" id="cm-${c.id}" style="${done ? 'opacity:.5' : ''}">
    ${c.chain.length ? `<div class="chain">${c.chain.map(x => `<div><b>${x.mine ? 'ты' : '@' + esc(x.username)}</b>: ${esc(x.text)}</div>`).join('')}</div>` : ''}
    <div><span class="who">@${esc(c.username)}</span> <span class="mut small">· ${kyiv(c.timestamp, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${c.answered ? ' · ты уже ответила' : S.done[c.id] === 'sent' ? ' · отправлено' : ''}</span></div>
    <div style="white-space:pre-wrap;margin-top:2px">${esc(c.text)}</div>
    <div class="row" style="margin-top:8px">
      <button class="acc sm" data-gen="${c.id}">✨ Варианты ответа</button>
      <button class="ghost sm" data-claude="${c.id}">в Claude</button>${GPT()}
      ${c.permalink ? `<a class="small" href="${esc(c.permalink)}" target="_blank" rel="noopener">открыть ↗</a>` : ''}
      <span class="sp"></span>${done ? '' : `<button class="ghost sm" data-skip="${c.id}">не отвечать</button>`}
    </div>
    <input class="small" id="hint-${c.id}" placeholder="пожелание к ответу (необязательно): например «короче», «с подколом», «поддержать»" style="margin-top:8px;font-size:13px;padding:8px 10px">
    <div class="variants" id="var-${c.id}"></div>
  </div>`;
}
async function generate(id) {
  const { g, c } = findC(id); if (!c) return;
  const box = $('#var-' + id), btn = $(`[data-gen="${id}"]`);
  btn.disabled = true; btn.textContent = 'Думаю…'; box.innerHTML = '';
  try {
    const r = await api('/suggest', { method: 'POST', body: { post: g.post.text || '', comment: c.text, chain: c.chain, hint: $('#hint-' + id).value.trim() } });
    box.innerHTML = r.variants.map((v, i) => `<div class="variant"><textarea id="v-${id}-${i}">${esc(v)}</textarea><div class="acts"><button class="sm" data-send="${id}" data-i="${i}">Ответить</button><button class="ghost sm" data-cp="${id}" data-i="${i}">Копия</button></div></div>`).join('');
    box.querySelectorAll('[data-cp]').forEach(b => b.onclick = () => copy($(`#v-${id}-${b.dataset.i}`).value));
    box.querySelectorAll('[data-send]').forEach(b => b.onclick = () => sendReply(id, $(`#v-${id}-${b.dataset.i}`).value, b));
  } catch (e) { box.innerHTML = `<p class="small" style="color:var(--bad)">${esc(e.message)}</p>`; }
  finally { btn.disabled = false; btn.textContent = '✨ Ещё варианты'; }
}
async function sendReply(id, text, btn) {
  const { c } = findC(id); text = text.trim();
  if (!text) return toast('Пустой ответ');
  if ([...text].length > 500) return toast('Больше 500 символов');
  if (!confirm(`Ответить @${c.username} в Threads?\n\n${text}`)) return;
  btn.disabled = true; btn.textContent = 'Отправляю…';
  try {
    await api('/reply', { method: 'POST', body: { reply_to_id: id, text } });
    feedback(text, 'ok', [], 'reply');
    S.done[id] = 'sent'; LS.set('doneReplies', S.done); updateBadge();
    const el = $('#cm-' + id); el.style.opacity = .5; $('#var-' + id).innerHTML = `<p class="small up">Отправлено ✓ «${esc(text)}»</p>`;
    toast('Ответ отправлен ✓');
  } catch (e) { toast('Ошибка: ' + e.message + ' — проверь в Threads, прежде чем жать снова', 7000); btn.disabled = false; btn.textContent = 'Ответить'; }
}
async function refreshInbox() {
  const b = $('#rload'); if (b) { b.disabled = true; b.textContent = 'Собираю…'; }
  try { await loadInbox(); } catch (e) { toast(e.message, 5000); }
  if ((location.hash || '').slice(1) === 'replies') renderReplies();
}


// ---------- Комментирую (ответы в чужих ветках) ----------
const COMMENT_MECH_RU = `Механики комментариев, которые собирают лайки и ветки:
1. неочевидный твист — переворачивает мысль автора неожиданным, но точным углом;
2. «дополню список» — тот самый недостающий пункт, самый точный или смешной;
3. точная деталь из жизни — конкретика, в которой каждый узнаёт себя;
4. самоироничное признание — «я тот человек, который…»;
5. перевод на человеческий — одной строкой иронично подытожить суть;
6. умное «но» — мягкое несогласие с нюансом, с которым хочется поспорить.
Правила: 1-2 предложения, до 160 символов, на украинском, со строчной; коммент должен быть понятен и смешон/точен даже без поста; никаких «згодна», «так і є», эмодзи-гирлянд, саморекламы; не унижать автора; на болезненные темы — без шуток, тепло.`;
function renderComment() {
  const d = LS.get('cdraft', { text: '', author: '', hint: '' });
  $('#comment').innerHTML = `
    <h2>Комментирую чужие ветки</h2>
    <p class="mut small" style="margin-top:-6px">Самый быстрый рост для маленького аккаунта — 10-15 цепких комментов в день под свежими (до часа) постами аккаунтов крупнее тебя. Вставь текст поста — получишь 5 вариантов разных механик. Публикуешь сама.</p>
    <div class="card" style="margin-bottom:12px"><div class="row"><h3 style="margin:0">Отобранные ветки</h3><span class="sp"></span><span class="mut small" id="cqstat"></span></div>
      <p class="mut small" style="margin:4px 0 0">Сюда Claude складывает свежие ветки из твоей ленты с готовыми вариантами комментов. Открыла → вставила → «Готово».</p>
      <div id="cqueue" style="margin-top:6px"><p class="mut small">Загрузка…</p></div></div>
    <div class="grid two">
      <div class="card">
        <label>Текст чужого поста</label><textarea id="ctext" style="min-height:130px" placeholder="скопируй текст поста из Threads">${esc(d.text)}</textarea>
        <div class="row" style="margin-top:8px"><input id="cauthor" placeholder="@автор (необязательно)" value="${esc(d.author)}" style="flex:1;min-width:140px"><input id="chint" placeholder="пожелание: колко, тепло, про IT…" value="${esc(d.hint)}" style="flex:2;min-width:180px"></div>
        <div class="row" style="margin-top:10px"><button class="acc" id="cgo">✨ 5 вариантов</button><button class="ghost" id="cask">в Claude</button>${GPT('ghost')}<button class="ghost sm" id="ccopy">📋 Копировать промпт</button></div>
        <div class="variants" id="cout" style="margin-top:10px"></div>
      </div>
      <div class="card"><h3>Что делает коммент цепким</h3><ul class="recs small">
        <li><b>Неочевидный твист</b><span class="mut">переверни мысль автора под углом, о котором никто не подумал</span></li>
        <li><b>Недостающий пункт</b><span class="mut">под постом-списком — тот самый пункт, которого не хватало</span></li>
        <li><b>Точная деталь</b><span class="mut">конкретика, в которой все узнают себя («о 23:47», «третій раз за тиждень»)</span></li>
        <li><b>Самоирония</b><span class="mut">«я та людина, яка…» — лайкают и отвечают «я теж»</span></li>
        <li><b>Перевод на людську</b><span class="mut">одна строка, подытоживающая суть иронично</span></li>
        <li><b>Умное «але»</b><span class="mut">несогласие с нюансом — запускает ветку</span></li>
        <li><b>Когда</b><span class="mut">в первый час после поста и в первых 5-10 комментах — их видят все</span></li>
      </ul></div>
    </div>`;
  loadCQueue();
  const save = () => LS.set('cdraft', { text: $('#ctext').value, author: $('#cauthor').value, hint: $('#chint').value });
  ['#ctext', '#cauthor', '#chint'].forEach(s => $(s).oninput = save);
  const prompt = target => { let t = `Напиши 5 разных комментариев от моего имени под чужим постом в Threads (скилл threads-posts), каждый — по своей механике, чтобы под ним лайкали и отвечали, а люди хотели открыть мой профиль.\n\nПост${$('#cauthor').value.trim() ? ' от ' + $('#cauthor').value.trim() : ''}:\n"${$('#ctext').value.trim()}"${$('#chint').value.trim() ? '\nПожелание: ' + $('#chint').value.trim() : ''}\n\n${COMMENT_MECH_RU}\n\nФормат: комментарий, под ним строка «Механика: …», между комментариями строка ---`; if (target === 'chatgpt') t = t.replace(' (скилл threads-posts)', '') + '\n\n' + STYLE_EXT; return t; };
  $('#ccopy').onclick = () => { if (!$('#ctext').value.trim()) return toast('Вставь текст поста'); copy(prompt('claude'), 'Промпт скопирован'); };
  $('#cask').onclick = () => { if (!$('#ctext').value.trim()) return toast('Вставь текст поста'); askAI(prompt(S.nextTarget || 'claude')); };
  $('#cgo').onclick = async () => {
    const text = $('#ctext').value.trim(); if (!text) return toast('Вставь текст поста');
    const b = $('#cgo'); b.disabled = true; b.textContent = 'Думаю…'; $('#cout').innerHTML = '';
    try {
      const r = await api('/comment', { method: 'POST', body: { text, author: $('#cauthor').value.trim().replace(/^@/, ''), hint: $('#chint').value.trim() } });
      $('#cout').innerHTML = r.variants.map((v, k) => `<div class="variant"><div style="flex:1"><textarea>${esc(v.text)}</textarea><div class="small mut">${esc(v.mech)}</div></div><div class="acts"><button class="sm" data-ccp="${k}">Копия</button><button class="ghost sm" data-cno="${k}">👎</button></div></div>`).join('');
      $('#cout').querySelectorAll('[data-ccp]').forEach(x => x.onclick = () => { const v = x.closest('.variant').querySelector('textarea').value.trim(); copy(v, 'Скопировано — вставь в ответ в Threads'); feedback(v, 'ok', [], 'comment'); });
      $('#cout').querySelectorAll('[data-cno]').forEach(x => x.onclick = () => { feedback(x.closest('.variant').querySelector('textarea').value.trim(), 'no', [], 'comment'); x.closest('.variant').style.opacity = .35; });
    } catch (e) { $('#cout').innerHTML = `<p class="small" style="color:var(--bad)">${esc(e.message)} — нажми «в Claude»</p>`; }
    finally { b.disabled = false; b.textContent = '✨ Ещё 5'; }
  };
}

async function loadCQueue() {
  const box = $('#cqueue'); if (!box) return;
  let q = [];
  try { q = await api('/cqueue'); } catch (e) { box.innerHTML = `<p class="small mut">${esc(e.message)}</p>`; return; }
  const open = q.filter(x => !x.done), done = q.filter(x => x.done);
  if ($('#cqstat')) $('#cqstat').textContent = q.length ? `осталось ${open.length}, сделано ${done.length}` : '';
  const ago = t => { const h = (Date.now() - new Date(t)) / 3600e3; return h < 1 ? Math.round(h * 60) + ' мин назад' : Math.round(h) + ' ч назад'; };
  box.innerHTML = q.length ? [...open, ...done].map((x, k) => `<div class="result" style="${x.done ? 'opacity:.45' : ''}">
      <div class="meta">@${esc(x.author)} · добавлено ${ago(x.addedAt)}${x.note ? ' · ' + esc(x.note) : ''} ${x.done ? '<span class="pill ok">готово</span>' : ''}</div>
      <div class="t">${esc(x.text)}</div>
      <div class="variants">${x.variants.map(v => `<div class="variant"><div style="flex:1"><div style="padding:8px 10px;border-radius:10px;background:var(--soft)">${esc(v.text || v)}</div>${v.mech ? `<div class="small mut">${esc(v.mech)}</div>` : ''}</div><div class="acts"><button class="ghost sm" data-qcp="${esc(v.text || v)}">Копия</button></div></div>`).join('')}</div>
      <div class="row small" style="margin-top:6px"><a href="${esc(x.url)}" target="_blank" rel="noopener">открыть ветку ↗</a><span class="sp"></span>
        <a href="#" data-qdone="${esc(x.url)}" data-undo="${x.done ? 1 : ''}">${x.done ? 'вернуть' : '✓ готово'}</a><a href="#" data-qdel="${esc(x.url)}" style="color:var(--bad)">убрать</a></div></div>`).join('')
    : '<p class="mut small">Пока пусто. Попроси Claude: «пройдись по моей ленте и отбери ветки для комментов».</p>';
  box.querySelectorAll('[data-qcp]').forEach(b => b.onclick = () => { copy(b.dataset.qcp, 'Скопировано — вставь в ответ в Threads'); feedback(b.dataset.qcp, 'ok', [], 'comment'); });
  box.querySelectorAll('[data-qdone]').forEach(b => b.onclick = async e => { e.preventDefault(); await api('/cqueue/done', { method: 'POST', body: { url: b.dataset.qdone, undo: !!b.dataset.undo } }).catch(() => {}); loadCQueue(); });
  box.querySelectorAll('[data-qdel]').forEach(b => b.onclick = async e => { e.preventDefault(); await api('/cqueue/done', { method: 'POST', body: { url: b.dataset.qdel, remove: true } }).catch(() => {}); loadCQueue(); });
}

// ---------- Подключение ----------
function renderConnect() {
  const t = S.me?.token;
  $('#connect').innerHTML = `
    <h2>Подключение</h2>
    <div class="grid two">
      <div class="card">
        <label>Адрес Worker</label><input id="cw" value="${esc(S.worker)}">
        <label>Ключ доступа (придумай сама, мин. 8 символов — им сайт входит в твой Worker)</label><input id="ck" type="password" value="${esc(S.key)}" autocomplete="current-password">
        <label>Threads User Access Token (нужен только при первом подключении или замене)</label><input id="ct" type="password" placeholder="THAA…" autocomplete="off">
        <div class="row" style="margin-top:14px"><button class="acc" id="csave">Сохранить и проверить</button><button class="ghost" id="ctoken">Заменить токен</button></div>
        <div id="cstat" class="small" style="margin-top:12px">${S.me ? `✅ Подключено: <b>@${esc(S.me.me?.username)}</b>${t?.expiresAt ? ` · токен до ${kyiv(t.expiresAt, { day: 'numeric', month: 'long' })}` : ''} <br><span class="mut">Токен продлевается Worker-ом автоматически.</span>` : '<span class="mut">Не подключено</span>'}</div>
      </div>
      <div class="card">
        <h3>Где взять токен</h3>
        <ol class="steps small">
          <li>Открой <a href="https://developers.facebook.com/apps/" target="_blank">developers.facebook.com/apps</a> → своё приложение.</li>
          <li>Слева «Варианты использования» → «Access the Threads API» → <b>Настроить</b> → «Настройки».</li>
          <li>Внизу «Генератор маркеров пользователя» → у @karinella.karamel нажми <b>Сгенерировать маркер</b>.</li>
          <li>Скопируй токен (начинается на THAA) и вставь слева.</li>
        </ol>
        <p class="mut small">Токен хранится только в твоём Cloudflare Worker, не на этом сайте и не на GitHub. Ключ доступа хранится в этом браузере — на телефоне введи его один раз.</p>
      </div>
    </div>
    <h2>Вкладки</h2>
    <div class="card"><label class="chk" style="font-size:14px"><input type="checkbox" id="trendsOn" ${LS.get('trendsOn', true) ? 'checked' : ''}> Вкладка «Тренды» — поиск залетевших постов в мире с переводом через ИИ</label>
      <p class="mut small" style="margin:6px 0 0">Если выключить, вкладка пропадёт и ИИ не будет тратить лимит на перевод и оценку трендов. Включить обратно можно здесь же.</p></div>
    <h2>ИИ на сайте</h2>
    <div class="grid two">
      <div class="card">
        <div class="small" id="aistat">${(() => { const x = S.me?.ai; if (!x) return ''; return x.provider === 'gemini' ? `✅ Работает <b>Gemini</b>: пишет ${esc(x.writeModel)}, переводит ${esc(x.fastModel)}` : x.provider === 'workers-ai' ? 'Сейчас работает бесплатный <b>Cloudflare AI</b> (10 000 «нейронов» в день, слабее по качеству).' : `Сейчас работает ${esc(x.provider)}`; })()}</div>
        <div class="chips" style="margin-top:10px" id="provChips">
          <span class="chip" data-prov="gemini">Gemini (бесплатно, рекомендую)</span><span class="chip" data-prov="workers-ai">Cloudflare AI</span>
        </div>
        <div id="provForm"></div>
      </div>
      <div class="card">
        <h3>Как получить ключ Gemini</h3>
        <ol class="steps small">
          <li>Открой <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a> (вход через Google).</li>
          <li>Create API key → скопируй ключ и вставь слева.</li>
          <li>Нажми «Загрузить модели» → «Включить Gemini».</li>
        </ol>
        <p class="mut small">Бесплатно и без карты: у Gemini есть лимиты запросов в минуту и в день, для постов их хватает. На бесплатном тарифе Google может использовать запросы для улучшения своих моделей. Ключ хранится только в твоём Cloudflare Worker. Подписки ChatGPT/Claude работают через кнопки «в ChatGPT» / «в Claude».</p>
      </div>
    </div>`;
  $('#trendsOn').onchange = e => { LS.set('trendsOn', e.target.checked); renderAll(); toast(e.target.checked ? 'Вкладка «Тренды» включена' : 'Вкладка «Тренды» выключена'); };
  $('#csave').onclick = async () => {
    S.worker = $('#cw').value.trim(); S.key = $('#ck').value; LS.set('worker', S.worker); LS.set('key', S.key);
    const token = $('#ct').value.trim();
    try {
      if (token) { const info = await fetch(S.worker.replace(/\/$/, '') + '/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: S.key, token }) }).then(r => r.json()); if (info.error) throw new Error(info.error); }
      await syncAll(); toast('Готово ✓'); location.hash = '#overview';
    } catch (e) { $('#cstat').innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
  };
  const prov0 = S.me?.ai?.provider === 'workers-ai' ? 'workers-ai' : 'gemini';
  const showProv = prov => {
    $('#provChips').querySelectorAll('[data-prov]').forEach(c => c.classList.toggle('on', c.dataset.prov === prov));
    const x = S.me?.ai || {};
    const f = $('#provForm');
    if (prov === 'gemini') f.innerHTML = `
      <label>Gemini API key ${x.hasGemini ? '<span class="mut">(уже сохранён — оставь пустым, чтобы не менять)</span>' : ''}</label><input id="akey" type="password" placeholder="вставь ключ из AI Studio" autocomplete="off">
      <div class="row" style="margin-top:8px"><button class="ghost sm" id="aload">Загрузить модели</button><span class="mut small" id="aloadst"></span></div>
      <label>Модель для постов и ответов</label><select id="awrite"><option value="">— сначала загрузи модели —</option></select>
      <label>Модель для оценки и перевода трендов (полегче)</label><select id="afast"><option value="">—</option></select>
      <div class="row" style="margin-top:14px"><button class="acc" id="asave">Включить Gemini</button></div>`;
    if (prov === 'workers-ai') f.innerHTML = `<p class="small mut" style="margin-top:10px">Бесплатно, без ключей, но 10 000 «нейронов» в день (хватает на 1-2 сессии) и пишет слабее.</p><div class="row"><button class="acc" id="asave">Включить Cloudflare AI</button></div>`;
    const fill = (models, w, fa) => {
      const pickW = w || models.find(mm => /flash/.test(mm) && !/lite/.test(mm) && !/preview|exp/.test(mm)) || models.find(mm => /flash/.test(mm) && !/lite/.test(mm)) || models[0];
      const pickF = fa || models.find(mm => /flash-lite/.test(mm) && !/preview|exp/.test(mm)) || models.find(mm => /lite/.test(mm)) || pickW;
      $('#awrite').innerHTML = models.map(mm => `<option ${mm === pickW ? 'selected' : ''}>${mm}</option>`).join('');
      $('#afast').innerHTML = models.map(mm => `<option ${mm === pickF ? 'selected' : ''}>${mm}</option>`).join('');
    };
    if (prov === 'gemini') {
      $('#aload').onclick = async () => {
        $('#aloadst').textContent = 'Загружаю…';
        try { const r = await api('/aimodels', { method: 'POST', body: { provider: 'gemini', key: $('#akey').value.trim() } }); fill(r.models, x.provider === 'gemini' ? x.writeModel : '', x.provider === 'gemini' ? x.fastModel : ''); $('#aloadst').textContent = `${r.models.length} моделей`; }
        catch (e) { $('#aloadst').textContent = e.message; }
      };
      $('#akey').addEventListener('change', () => $('#akey').value.trim() && $('#aload').click());
      if (x.hasGemini) $('#aload').click();
    }
    $('#asave').onclick = async () => {
      const b = $('#asave'), label = b.textContent; b.disabled = true; b.textContent = 'Проверяю…';
      try {
        const body = { provider: prov };
        if (prov === 'gemini') { if (!$('#awrite').value) { await $('#aload').onclick(); } Object.assign(body, { key: $('#akey').value.trim(), writeModel: $('#awrite').value, fastModel: $('#afast').value }); }
        await api('/aikey', { method: 'POST', body });
        S.me = await api('/me'); LS.set('me', S.me); toast('ИИ переключён ✓'); renderConnect();
      } catch (e) { $('#aistat').innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; b.disabled = false; b.textContent = label; }
    };
  };
  $('#provChips').querySelectorAll('[data-prov]').forEach(c => c.onclick = () => showProv(c.dataset.prov));
  showProv(prov0);
  $('#ctoken').onclick = async () => {
    const token = $('#ct').value.trim(); if (!token) return toast('Вставь новый токен');
    try { await api('/token', { method: 'POST', body: { token } }); $('#ct').value = ''; await syncAll(); toast('Токен заменён ✓'); }
    catch (e) { $('#cstat').innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
  };
}

// ---------- синхронизация ----------
async function syncAll() {
  if (!S.key) { location.hash = '#connect'; return; }
  const btn = $('#refreshBtn'); btn.disabled = true; btn.textContent = '↻ Обновляю…';
  try {
    S.me = await api('/me'); LS.set('me', S.me);
    let posts = [], after = null;
    for (let i = 0; i < 6; i++) { const r = await api('/posts?limit=40' + (after ? '&after=' + after : '')); posts.push(...r.posts); after = r.next; if (!after) break; }
    S.posts = posts; LS.set('posts', posts);
    const until = Math.floor(Date.now() / 1000), since = until - 30 * 86400;
    try { S.insights = await api(`/insights?since=${since}&until=${until}`); LS.set('insights', S.insights); } catch (e) { console.warn(e); }
    try { S.history = await api('/history'); LS.set('history', S.history); } catch {}
    try { S.queue = await api('/queue'); } catch {}
    try { await loadInbox(); } catch {}
    try { S.perf = await api('/perf', { method: 'POST', body: { posts: rootPosts().map(p => ({ id: p.id, text: p.text, timestamp: p.timestamp, topic_tag: p.topic_tag, metrics: p.metrics })) } }); LS.set('perf', S.perf); } catch {}
    LS.set('syncedAt', Date.now());
  } finally { btn.disabled = false; btn.textContent = '↻ Обновить'; renderAll(); }
}
function renderAll() {
  $('#who').textContent = S.me ? `@${S.me.me?.username} · ${fmt(S.me.followers)} подписчиков` : 'не подключено';
  const trendsOn = LS.get('trendsOn', true);
  const tl = document.querySelector('#tabs a[data-tab="trends"]'); if (tl) tl.hidden = !trendsOn;
  if (!trendsOn && location.hash === '#trends') { location.hash = '#overview'; return; }
  const tab = (location.hash || '#overview').slice(1);
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === tab));
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  updateBadge();
  ({ overview: renderOverview, posts: renderPosts, replies: renderReplies, comment: renderComment, studio: renderStudio, trends: renderTrends, connect: renderConnect }[tab] || renderOverview)();
}
window.addEventListener('hashchange', renderAll);
$('#refreshBtn').onclick = () => syncAll().then(() => toast('Обновлено')).catch(e => toast(e.message, 5000));
if (!['#overview', '#posts', '#replies', '#comment', '#studio', '#trends', '#connect'].includes(location.hash)) location.hash = S.key ? '#overview' : '#connect';
renderAll();
if (S.key && Date.now() - LS.get('syncedAt', 0) > 10 * 60e3) syncAll().catch(e => toast(e.message, 5000));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

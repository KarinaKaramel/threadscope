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

function tokens(t) { return new Set(String(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 3)); }
function jaccard(a, b) { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); }

function analyzePost(text, tag, whenMs) {
  const t = text.trim(), low = t.toLowerCase();
  const lines = t.split('\n').filter(Boolean);
  const first = lines[0] || '';
  const len = [...t].length;
  const checks = [];
  const add = (ok, title, hint, w = 10) => checks.push({ ok, title, hint, w });

  add(len > 0 && len <= 500, len > 500 ? `Длина ${len}/500 — API не примет` : `Длина ${len} симв.`, 'Лимит Threads — 500 символов', 15);
  add(len > 0 && len <= 280, 'Коротко и плотно (до 280)', 'Короткие тексты дочитывают до конца — меньше «скролла мимо», это сигнал ранжирования', 8);
  add(first.length > 0 && first.length <= 100, 'Первая строка — крючок (до 100 симв.)', 'В ленте видно начало — в нём должна быть ситуация или поворот, а не разгон', 12);
  const endsQ = /\?\s*$/.test(t) || /(несіть свої|кидайте|розкажіть|пишіть|ваші варіанти|у коментар|в коментар)/i.test(low);
  add(endsQ, 'Есть конкретное приглашение ответить', 'Алгоритм предсказывает «нажмёт ли ответить» — вопрос, на который есть что рассказать из жизни, работает лучше лайк-приманок', 15);
  const bait = BAIT.find(b => low.includes(b));
  add(!bait, bait ? `Шаблонная приманка: «${bait}»` : 'Без шаблонных приманок', 'Meta понижает engagement-bait; спроси что-то конкретное вместо «що думаєте?»', 10);
  add(!!tag, tag ? `Тема: ${tag}` : 'Не выбрана тема (topic tag)', 'Одна тема на пост помещает его в ленту темы и помогает рекомендациям понять, кому тебя показывать', 12);
  add(!/#\S/.test(t), 'Без хештегов в тексте', 'В Threads работает одна тема поста, а не россыпь #хештегов', 5);
  add(!/https?:\/\//.test(t), 'Без внешних ссылок', 'Ссылки уводят из приложения; лучше ссылку в первом своём ответе', 5);
  add(!/[—«»“”]/.test(t), 'Твой стиль: «-» и прямые кавычки', 'Длинное тире и «ёлочки» выдают ИИ-текст', 5);
  const hits = Object.entries(CORE_TOPICS).filter(([, ws]) => ws.some(w => low.includes(w))).map(([k]) => k);
  add(hits.length > 0, hits.length ? `В твоей нише: ${hits.join(', ')}` : 'Тема вне твоей ниши', 'Рекомендации учат, кому тебя показывать, по повторяющимся темам — держи 3-4 постоянные', 8);
  const tk = tokens(t);
  const sim = rootPosts().slice(0, 15).map(p => ({ p, s: jaccard(tk, tokens(p.text || '')) })).sort((a, b) => b.s - a.s)[0];
  add(!sim || sim.s < 0.3, sim && sim.s >= 0.3 ? 'Похоже на недавний пост' : 'Не повторяет недавние посты', 'Оригинальность и свежесть — прямые приоритеты ранжирования', 8);
  if (whenMs) {
    const last24 = rootPosts().filter(p => Math.abs(new Date(p.timestamp) - whenMs) < 864e5).length + S.queue.filter(q => q.status === 'scheduled' && Math.abs(new Date(q.at) - whenMs) < 864e5).length;
    add(last24 < 4, `Постов в эти сутки: ${last24}`, 'Больше 3-4 в сутки — посты конкурируют друг с другом за тех же подписчиков', 5);
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
    const near = taken.filter(x => Math.abs(x - t) < 3 * 3600e3).length;
    sc *= near ? 0.55 : 1;
    slots.push({ t, sc, hour, dow });
  }
  const picked = [];
  for (const s of slots.sort((a, b) => b.sc - a.sc)) {
    if (picked.every(p => Math.abs(p.t - s.t) > 4 * 3600e3)) picked.push(s);
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
  if (days > 2) out.push({ t: `Последний пост ${Math.floor(days)} дн. назад`, d: 'Ранжирование учитывает свежесть — 1-2 поста в день стабильнее, чем всплески.' });
  const tagged = ps.filter(p => p.topic_tag).length;
  if (tagged < ps.length) out.push({ t: `Тема указана в ${tagged} из ${ps.length} постов`, d: 'Ставь одну тему на каждый пост (в Студии это поле «Тема») — так пост попадает в ленту темы.' });
  const rr = ps.reduce((a, p) => a + m(p).replies, 0);
  out.push({ t: 'Ответы — твой второй канал роста', d: `Отвечать на посты больших аккаунтов в своей нише так же полезно, как постить. Цель: 10-15 содержательных ответов в день, особенно в первый час после их публикации. Сейчас под твоими постами ${rr} ответов — отвечай каждому в первый час, это продлевает жизнь поста.` });
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
    <div class="row"><h2>Публикации</h2><span class="sp"></span><button class="ghost sm" id="csvBtn">Скачать CSV</button><button class="ghost sm" id="claudeBtn">Данные для Claude</button></div>
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
  $('#claudeBtn').onclick = () => copy(claudeContext(), 'Скопировано — вставь в чат с Claude');
}

function claudeContext(extra = '') {
  const ps = byDate(rootPosts()).slice(0, 20);
  return `Статистика моего Threads @${S.me?.me?.username || ''} (подписчиков: ${S.me?.followers ?? '?'}), время по Киеву:\n` +
    ps.map(p => { const x = m(p); return `- ${kyiv(p.timestamp, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} | просм ${x.views}, лайки ${x.likes}, ответы ${x.replies}, репосты ${x.reposts}, ER ${pct(x.er)}${p.topic_tag ? ', тема ' + p.topic_tag : ''}\n  "${(p.text || '').replace(/\n/g, ' / ')}"`; }).join('\n') +
    `\n\n${extra || 'Проанализируй, что работает, и предложи 5 новых постов в моём стиле.'}`;
}

// ---------- Студия ----------
function renderStudio() {
  const d = LS.get('draft', { text: '', tag: '' });
  $('#studio').innerHTML = `
    <h2>Студия</h2>
    <div class="grid two">
      <div class="card">
        <label for="ptext">Текст поста</label>
        <textarea id="ptext" placeholder="пропоную відкрити музей фраз, після яких нічого хорошого не відбувається…">${esc(d.text)}</textarea>
        <div class="counter" id="pcount"></div>
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
          <button class="ghost sm" id="askClaude">Задание для Claude</button>
        </div>
        <p class="mut small">Пост уходит в Threads только по твоей кнопке. Запланированные публикует Worker в облаке — ноутбук можно закрыть.</p>
      </div>
      <div class="grid">
        <div class="card"><div class="row"><div><div class="mut small">Готовность для алгоритма</div><div class="score" id="score">—</div></div><span class="sp"></span></div>
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
    try { await api('/queue', { method: 'POST', body: { ...p, at: new Date(at).toISOString() } }); ta.value = ''; update(); toast('Запланировано ✓'); loadQueue(); }
    catch (e) { toast(e.message, 5000); }
  };
  $('#nowBtn').onclick = async () => {
    const p = valid(); if (!p) return;
    if (!confirm('Опубликовать в Threads прямо сейчас?\n\n' + p.text)) return;
    const b = $('#nowBtn'); b.disabled = true; b.textContent = 'Публикую…';
    try { const r = await api('/publish', { method: 'POST', body: p }); ta.value = ''; update(); toast('Опубликовано ✓'); if (r.permalink) window.open(r.permalink, '_blank'); setTimeout(syncAll, 3000); }
    catch (e) { toast('Ошибка: ' + e.message + ' — проверь профиль, прежде чем жать снова', 7000); }
    finally { b.disabled = false; b.textContent = 'Опубликовать сейчас'; }
  };
  $('#saveDraft').onclick = () => { const p = valid(); if (!p) return; S.drafts.unshift({ id: Date.now(), ...p }); LS.set('drafts', S.drafts); ta.value = ''; update(); renderDrafts(); toast('Сохранено'); };
  $('#askClaude').onclick = () => copy(claudeContext(ta.value.trim() ? `Улучши этот черновик для алгоритма Threads, сохрани мой стиль, дай 3 варианта:\n"${ta.value.trim()}"` : ''), 'Скопировано — вставь в чат с Claude');
  function renderDrafts() {
    $('#drafts').innerHTML = S.drafts.length ? S.drafts.map(d => `<div class="result"><div class="t">${esc(d.text)}</div><div class="row small" style="margin-top:6px">${d.topic_tag ? `<span class="pill">${esc(d.topic_tag)}</span>` : ''}<span class="sp"></span><a href="#" data-use="${d.id}">в редактор</a><a href="#" data-del="${d.id}" style="color:var(--bad)">удалить</a></div></div>`).join('') : '<p class="mut small">Пусто. Сюда удобно складывать посты, которые придумал Claude.</p>';
    $('#drafts').querySelectorAll('[data-use]').forEach(a => a.onclick = e => { e.preventDefault(); const d = S.drafts.find(x => x.id == a.dataset.use); ta.value = d.text; tg.value = d.topic_tag || ''; update(); ta.focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    $('#drafts').querySelectorAll('[data-del]').forEach(a => a.onclick = e => { e.preventDefault(); S.drafts = S.drafts.filter(x => x.id != a.dataset.del); LS.set('drafts', S.drafts); renderDrafts(); });
  }
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
function renderTrends() {
  const W = LS.get('worldCfg', { minEng: 200, maxF: 3000, clean: true });
  $('#trends').innerHTML = `
    <div class="row"><h2>Залетело в мире</h2><span class="sp"></span><button class="ghost sm" id="wgo">↻ Найти свежее</button></div>
    <p class="mut small" style="margin-top:-6px">Посты обычных людей (не медиа и не звёзд) из Bluesky и Mastodon за последние 3 дня, которые собрали много реакций. Переведены на украинский, отсортированы по тому, насколько механика подходит твоему аккаунту. Threads не отдаёт лайки чужих постов через API, поэтому ищем в соседних текстовых соцсетях — там те же сюжеты, но до укр. Threads они ещё не дошли.</p>
    <div class="card"><div class="row small">
      <span class="mut">реакций от</span><select id="wmin" style="width:auto">${[50, 100, 200, 500, 1000].map(v => `<option ${v == W.minEng ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <span class="mut">подписчиков у автора до</span><select id="wmax" style="width:auto">${[500, 1000, 3000, 10000, 50000].map(v => `<option ${v == W.maxF ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label style="margin:0;display:flex;gap:6px;align-items:center;color:var(--ink)"><input type="checkbox" id="wclean" ${W.clean ? 'checked' : ''} style="width:auto"> без политики и новостей</label>
      <span class="sp"></span><span id="wstat" class="mut"></span></div></div>
    <div id="wres" style="margin-top:12px"></div>
    <h2 style="margin-top:28px">Поиск в Threads</h2>
    <div class="card">
      <div class="row"><input id="tq" placeholder="слово или фраза, напр. мітинг" style="flex:2;min-width:200px">
        <select id="ttype" style="width:auto"><option value="TOP">Популярные</option><option value="RECENT">Свежие</option></select>
        <select id="tper" style="width:auto"><option value="1">24 часа</option><option value="3">3 дня</option><option value="7" selected>7 дней</option><option value="30">30 дней</option></select>
        <select id="tmode" style="width:auto"><option value="KEYWORD">по словам</option><option value="TAG">по теме</option></select>
        <button class="acc" id="tgo">Искать</button></div>
      <div class="row small" style="margin-top:10px"><label style="margin:0;display:flex;gap:6px;align-items:center;color:var(--ink)"><input type="checkbox" id="tua" checked style="width:auto"> только украиноязычные</label></div>
      <div style="margin-top:10px">${Object.entries(TREND_PRESETS).map(([g, ws]) => `<div class="row small" style="margin:4px 0"><span class="mut" style="width:90px">${g}</span><div class="chips">${ws.map(w => `<span class="chip" data-q="${w}">${w}</span>`).join('')}</div></div>`).join('')}</div>
    </div>
    <div id="tnote"></div>
    <div class="card" id="tres" style="margin-top:12px"><div class="empty">Выбери тему или введи слово</div></div>`;
  $('#trends').querySelectorAll('[data-q]').forEach(c => c.onclick = () => { $('#tq').value = c.dataset.q; search(); });
  $('#tgo').onclick = search; $('#tq').onkeydown = e => e.key === 'Enter' && search();
  const saveW = () => { LS.set('worldCfg', { minEng: +$('#wmin').value, maxF: +$('#wmax').value, clean: $('#wclean').checked }); renderWorld(); translateVisible(); };
  $('#wmin').onchange = $('#wmax').onchange = $('#wclean').onchange = saveW;
  $('#wgo').onclick = () => loadWorld(true);
  renderWorld();
  if (!S.world || Date.now() - LS.get('worldAt', 0) > 3 * 3600e3) loadWorld(); else translateVisible();
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
    for (let i = 0; i < 4; i++) {
      const u = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const r = await fetch(u).then(r => r.json()).catch(() => null);
      if (!r?.feed) break;
      for (const { post: p } of r.feed) {
        const text = p.record?.text || '';
        items.push({ id: 'bs:' + p.uri, src: 'Bluesky', text, lang: (p.record?.langs || [])[0] || '', likes: p.likeCount || 0, replies: p.replyCount || 0, reposts: (p.repostCount || 0) + (p.quoteCount || 0), author: p.author.handle, name: p.author.displayName || '', did: p.author.did, followers: null, url: `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split('/').pop()}`, at: p.record?.createdAt || p.indexedAt, media: !!p.embed });
      }
      cursor = r.cursor; if (!cursor) break;
    }
    setS('Mastodon…');
    for (const inst of ['mastodon.social', 'mastodon.online']) {
      for (const off of [0, 40, 80]) {
        const r = await fetch(`https://${inst}/api/v1/trends/statuses?limit=40&offset=${off}`).then(r => r.json()).catch(() => null);
        if (!Array.isArray(r) || !r.length) break;
        for (const s of r) items.push({ id: 'ms:' + s.uri, src: 'Mastodon', text: stripHtml(s.content), lang: s.language || '', likes: s.favourites_count || 0, replies: s.replies_count || 0, reposts: s.reblogs_count || 0, author: s.account.acct.includes('@') ? s.account.acct : s.account.acct + '@' + inst, name: s.account.display_name || '', followers: s.account.followers_count, url: s.url, at: s.created_at, media: !!s.media_attachments?.length });
      }
    }
    const seen = new Set();
    let pool = items.filter(i => !seen.has(i.id) && seen.add(i.id) && now - new Date(i.at) < maxAge && i.text.length >= 25 && i.likes + i.replies + i.reposts >= 50);
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
function worldFiltered() {
  const W = LS.get('worldCfg', { minEng: 200, maxF: 3000, clean: true });
  return (S.world || []).filter(i => {
    const eng = i.likes + i.replies + i.reposts;
    if (eng < W.minEng || i.followers > W.maxF) return false;
    if (i.lang && /^uk/.test(i.lang)) return false;
    if (W.clean) { if (POLITICS.test(i.text)) return false; const t = S.tr[i.id]; if (t && (['політика', 'новини'].includes(t.topic) || t.fit < 3)) return false; }
    return true;
  }).sort((a, b) => {
    const fa = S.tr[a.id]?.fit ?? 5, fb = S.tr[b.id]?.fit ?? 5;
    if (fb !== fa) return fb - fa;
    return (b.likes + b.replies * 3) / (b.followers + 50) - (a.likes + a.replies * 3) / (a.followers + 50);
  }).slice(0, 40);
}
async function translateVisible() {
  const need = worldFiltered().filter(i => !S.tr[i.id]).slice(0, 40);
  if (!need.length) { if ($('#wstat')) $('#wstat').textContent = ''; return; }
  const chunks = []; for (let k = 0; k < need.length; k += 5) chunks.push(need.slice(k, k + 5));
  let done = 0, failed = 0;
  const st = () => { if ($('#wstat')) $('#wstat').textContent = `Перевожу: ${done} из ${need.length}…`; };
  st();
  const run = async ch => {
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 60000);
      const res = await fetch(S.worker.replace(/\/$/, '') + '/translate', { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'X-Key': S.key }, body: JSON.stringify({ items: ch.map(i => ({ id: i.id, text: i.text })) }) });
      clearTimeout(to);
      const r = await res.json(); if (r.error) throw new Error(r.error);
      for (const t of r) S.tr[t.id] = t;
      LS.set('tr', S.tr);
    } catch { failed++; }
    done += ch.length; st(); renderWorld();
  };
  for (let k = 0; k < chunks.length; k += 3) await Promise.all(chunks.slice(k, k + 3).map(run));
  if ($('#wstat')) $('#wstat').textContent = failed ? `часть не перевелась (${failed}) — нажми «Найти свежее» ещё раз` : '';
}
const LANGS = { en: 'англ', es: 'исп', de: 'нем', ja: 'яп', fr: 'фр', pt: 'порт', it: 'ит', nl: 'нид', pl: 'пол', ru: 'рус', ko: 'кор', zh: 'кит', tr: 'тур', sv: 'швед', fi: 'фин', cs: 'чеш' };
function renderWorld() {
  const box = $('#wres'); if (!box) return;
  if (!S.world) { box.innerHTML = '<div class="card empty">Ищу залетевшие посты…</div>'; return; }
  const list = worldFiltered();
  if ($('#wstat') && !/Перевожу|часть/.test($('#wstat').textContent)) $('#wstat').textContent = `найдено ${list.length}`;
  box.innerHTML = list.length ? `<div class="card">${list.map(i => { const t = S.tr[i.id]; return `
    <div class="result" id="w-${btoa(unescape(encodeURIComponent(i.id))).replace(/[^a-z0-9]/gi, '').slice(-16)}">
      <div class="meta">${i.src} · <b>${esc(i.name || i.author)}</b> @${esc(i.author)} · ${fmt(i.followers)} подп. · ${LANGS[(i.lang || '').slice(0, 2)] || i.lang || '?'} · ${kyiv(i.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        ${t ? `<span class="pill">${esc(t.topic)}</span> <span class="pill ${t.fit >= 7 ? 'ok' : t.fit >= 4 ? '' : 'warn'}">подходит ${t.fit}/10</span>` : ''}</div>
      <div class="t">${t ? esc(t.uk) : `<span class="mut">${esc(i.text)}</span>`}</div>
      ${t ? `<details class="small" style="margin-top:4px"><summary>оригинал</summary><div class="mut" style="white-space:pre-wrap">${esc(i.text)}</div></details>` : ''}
      <div class="row small" style="margin-top:6px"><span>❤ ${fmt(i.likes)}</span><span>💬 ${fmt(i.replies)}</span><span>🔁 ${fmt(i.reposts)}</span>${i.media ? '<span class="pill">с медиа</span>' : ''}
        <a href="${esc(i.url)}" target="_blank" rel="noopener">открыть ↗</a><span class="sp"></span>
        <button class="acc sm" data-adapt="${esc(i.id)}">✨ Идеи для меня</button><button class="ghost sm" data-wclaude="${esc(i.id)}">в Claude</button></div>
      <div class="variants" data-out="${esc(i.id)}"></div>
    </div>`; }).join('')}</div>` : '<div class="card empty">Под эти фильтры ничего нет — снизь порог реакций или подними лимит подписчиков</div>';
  box.querySelectorAll('[data-adapt]').forEach(b => b.onclick = () => adaptIdea(b.dataset.adapt, b));
  box.querySelectorAll('[data-wclaude]').forEach(b => b.onclick = () => { const i = S.world.find(x => x.id === b.dataset.wclaude); copy(`Этот пост залетел в ${i.src} (${fmt(i.likes)} лайков, ${fmt(i.replies)} ответов, у автора ${fmt(i.followers)} подписчиков):\n"${i.text}"\n${i.url}\n\nНе копируй — возьми механику и придумай 5 оригинальных постов для моего украинского Threads (скилл threads-posts).`, 'Скопировано — вставь в чат с Claude'); });
}
async function adaptIdea(id, btn) {
  const i = S.world.find(x => x.id === id); const out = document.querySelector(`[data-out="${CSS.escape(id)}"]`);
  btn.disabled = true; btn.textContent = 'Думаю…';
  try {
    const r = await api('/adapt', { method: 'POST', body: { text: (S.tr[id]?.uk ? S.tr[id].uk + '\n(оригінал: ' + i.text + ')' : i.text) } });
    out.innerHTML = r.variants.map((v, k) => `<div class="variant"><textarea>${esc(v)}</textarea><div class="acts"><button class="sm" data-draft="${k}">В черновики</button><button class="ghost sm" data-cpv="${k}">Копия</button></div></div>`).join('');
    out.querySelectorAll('[data-draft]').forEach(b => b.onclick = () => { const v = b.closest('.variant').querySelector('textarea').value.trim(); S.drafts.unshift({ id: Date.now(), text: v, topic_tag: '' }); LS.set('drafts', S.drafts); toast('В черновиках Студии ✓'); });
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
      <div class="t">${esc(p.text || '')}</div><div class="row small" style="margin-top:6px"><a href="${esc(p.permalink)}" target="_blank" rel="noopener">открыть ↗</a><span class="sp"></span><a href="#" data-idea="${p.id}">идея ответа → Claude</a></div></div>`).join('') : '<div class="empty">Ничего не нашлось</div>';
    box.querySelectorAll('[data-idea]').forEach(a => a.onclick = e => { e.preventDefault(); const p = list.find(x => x.id === a.dataset.idea); copy(`Придумай 3 варианта моего ответа на этот пост в Threads (мой стиль: украинский, разговорный, со строчной, самоирония, точное наблюдение, без морализаторства). Ответ должен добавлять свой поворот, чтобы люди переходили в мой профиль.\n\n@${p.username}: "${p.text}"\n${p.permalink}`, 'Скопировано — вставь в чат с Claude'); });
  } catch (e) { box.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
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
  $('#rlist').querySelectorAll('[data-claude]').forEach(b => b.onclick = () => { const { g, c } = findC(b.dataset.claude); copy(`Придумай 3 варианта моего ответа на комментарий под моим постом в Threads (используй скилл threads-posts).\n\nМой пост: "${g.post.text}"\n${c.chain.map(x => (x.mine ? 'я' : '@' + x.username) + ': "' + x.text + '"').join('\n')}\n@${c.username}: "${c.text}"`, 'Скопировано — вставь в чат с Claude'); });
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
      <button class="ghost sm" data-claude="${c.id}">в Claude</button>
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
    </div>`;
  $('#csave').onclick = async () => {
    S.worker = $('#cw').value.trim(); S.key = $('#ck').value; LS.set('worker', S.worker); LS.set('key', S.key);
    const token = $('#ct').value.trim();
    try {
      if (token) { const info = await fetch(S.worker.replace(/\/$/, '') + '/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: S.key, token }) }).then(r => r.json()); if (info.error) throw new Error(info.error); }
      await syncAll(); toast('Готово ✓'); location.hash = '#overview';
    } catch (e) { $('#cstat').innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
  };
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
    LS.set('syncedAt', Date.now());
  } finally { btn.disabled = false; btn.textContent = '↻ Обновить'; renderAll(); }
}
function renderAll() {
  $('#who').textContent = S.me ? `@${S.me.me?.username} · ${fmt(S.me.followers)} подписчиков` : 'не подключено';
  const tab = (location.hash || '#overview').slice(1);
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === tab));
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  updateBadge();
  ({ overview: renderOverview, posts: renderPosts, replies: renderReplies, studio: renderStudio, trends: renderTrends, connect: renderConnect }[tab] || renderOverview)();
}
window.addEventListener('hashchange', renderAll);
$('#refreshBtn').onclick = () => syncAll().then(() => toast('Обновлено')).catch(e => toast(e.message, 5000));
if (!['#overview', '#posts', '#replies', '#studio', '#trends', '#connect'].includes(location.hash)) location.hash = S.key ? '#overview' : '#connect';
renderAll();
if (S.key && Date.now() - LS.get('syncedAt', 0) > 10 * 60e3) syncAll().catch(e => toast(e.message, 5000));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

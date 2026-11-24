// Threadscope API — Cloudflare Worker
// Прокси к Threads API + отложенная публикация + ежедневные снимки статистики.
// Нужен KV namespace с привязкой TS и Cron Trigger "*/5 * * * *".

const API = 'https://graph.threads.net/v1.0';
const ALLOWED_ORIGINS = ['https://karinakaramel.github.io', 'http://localhost:8000', 'http://127.0.0.1:8000'];
const POST_FIELDS = 'id,media_type,media_product_type,text,timestamp,permalink,shortcode,is_quote_post,topic_tag';
const POST_FIELDS_SAFE = 'id,media_type,media_product_type,text,timestamp,permalink,shortcode,is_quote_post';
const MEDIA_METRICS = 'views,likes,replies,reposts,quotes,shares';

// ---------- helpers ----------
function cors(req) {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (req, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(req) } });

async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getCfg(env) { return (await env.TS.get('cfg', 'json')) || null; }
async function putCfg(env, cfg) { await env.TS.put('cfg', JSON.stringify(cfg)); }

class ApiError extends Error { constructor(msg, status, raw) { super(msg); this.status = status; this.raw = raw; } }

async function th(token, path, params = {}, method = 'GET') {
  const url = new URL(API + path);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    (method === 'GET' ? url.searchParams : body).set(k, String(v));
  }
  url.searchParams.set('access_token', token);
  const res = await fetch(url, method === 'GET' ? {} : { method, body });
  let data; try { data = await res.json(); } catch { data = {}; }
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new ApiError(e.error_user_msg || e.message || ('HTTP ' + res.status), res.status, e);
  }
  return data;
}

// ---------- domain ----------
async function fetchPosts(cfg, limit = 40, after) {
  let page;
  try {
    page = await th(cfg.token, '/me/threads', { fields: POST_FIELDS, limit, after });
  } catch (e) {
    page = await th(cfg.token, '/me/threads', { fields: POST_FIELDS_SAFE, limit, after });
  }
  const posts = (page.data || []).filter(p => p.media_type !== 'REPOST_FACADE');
  await Promise.all(posts.map(async p => {
    try {
      const ins = await th(cfg.token, `/${p.id}/insights`, { metric: MEDIA_METRICS });
      p.metrics = {};
      for (const m of ins.data || []) p.metrics[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0;
    } catch (e) { p.metrics = null; p.metricsError = e.message; }
  }));
  return { posts, next: page.paging?.cursors?.after && page.paging?.next ? page.paging.cursors.after : null };
}

async function userInsights(cfg, since, until) {
  const out = {};
  const ts = await th(cfg.token, `/${cfg.userId}/threads_insights`, { metric: 'views,likes,replies,reposts,quotes,clicks', since, until });
  for (const m of ts.data || []) {
    if (m.values) out[m.name] = { series: m.values.map(v => ({ t: v.end_time, v: v.value })), total: m.values.reduce((a, v) => a + (v.value || 0), 0) };
    else if (m.total_value) out[m.name] = { total: m.total_value.value };
    else if (m.link_total_values) out[m.name] = { total: m.link_total_values.reduce((a, l) => a + (l.value || 0), 0), links: m.link_total_values };
  }
  const fc = await th(cfg.token, `/${cfg.userId}/threads_insights`, { metric: 'followers_count' });
  out.followers_count = fc.data?.[0]?.total_value?.value ?? null;
  return out;
}

async function demographics(cfg) {
  const out = {};
  for (const b of ['country', 'city', 'age', 'gender']) {
    try {
      const r = await th(cfg.token, `/${cfg.userId}/threads_insights`, { metric: 'follower_demographics', breakdown: b });
      out[b] = r.data?.[0]?.total_value?.breakdowns?.[0]?.results?.map(x => ({ k: x.dimension_values?.[0], v: x.value })) || [];
    } catch (e) { out[b] = { error: e.message }; }
  }
  return out;
}

async function conversation(cfg, id) {
  const all = [];
  let after;
  for (let i = 0; i < 5; i++) {
    const r = await th(cfg.token, `/${id}/conversation`, { fields: 'id,text,username,timestamp,is_reply_owned_by_me,replied_to', limit: 100, after });
    all.push(...(r.data || []));
    if (!r.paging?.next) break;
    after = r.paging.cursors.after;
  }
  const others = all.filter(r => r.username && r.username !== cfg.username);
  const uniq = new Set(others.map(r => r.username));
  return { total: all.length, fromOthers: others.length, mine: all.length - others.length, uniqueParticipants: uniq.size, participants: [...uniq], replies: all };
}

async function publishNow(cfg, { text, topic_tag }) {
  const c = await th(cfg.token, '/me/threads', { media_type: 'TEXT', text, topic_tag: topic_tag || undefined }, 'POST');
  // дождаться обработки контейнера
  for (let i = 0; i < 10; i++) {
    await sleep(i === 0 ? 2000 : 3000);
    try {
      const s = await th(cfg.token, `/${c.id}`, { fields: 'status,error_message' });
      if (s.status === 'FINISHED') break;
      if (s.status === 'ERROR' || s.status === 'EXPIRED') throw new ApiError('Контейнер: ' + (s.error_message || s.status), 400);
    } catch (e) { if (e.message?.startsWith('Контейнер')) throw e; }
  }
  const p = await th(cfg.token, '/me/threads_publish', { creation_id: c.id }, 'POST');
  let permalink = null;
  try { permalink = (await th(cfg.token, `/${p.id}`, { fields: 'permalink' })).permalink; } catch {}
  return { id: p.id, permalink };
}

async function getQueue(env) { return (await env.TS.get('queue', 'json')) || []; }
async function putQueue(env, q) { await env.TS.put('queue', JSON.stringify(q)); }

async function runDue(env) {
  const cfg = await getCfg(env);
  if (!cfg?.token) return;
  const q = await getQueue(env);
  const now = Date.now();
  const due = q.filter(i => i.status === 'scheduled' && new Date(i.at).getTime() <= now);
  if (!due.length) return;
  // Сначала помечаем как "publishing", чтобы не опубликовать дважды
  for (const i of due) { i.status = 'publishing'; i.startedAt = new Date().toISOString(); }
  await putQueue(env, q);
  for (const i of due) {
    try {
      const r = await publishNow(cfg, i);
      i.status = 'published'; i.postId = r.id; i.permalink = r.permalink; i.publishedAt = new Date().toISOString();
    } catch (e) {
      i.status = 'error'; i.error = e.message;
    }
  }
  const fresh = await getQueue(env);
  const byId = Object.fromEntries(due.map(i => [i.id, i]));
  await putQueue(env, fresh.map(i => byId[i.id] || i));
}

async function dailySnapshot(env) {
  const cfg = await getCfg(env);
  if (!cfg?.token) return;
  const day = new Date().toISOString().slice(0, 10);
  if (await env.TS.get('snap:' + day)) return;
  const snap = { day, at: new Date().toISOString() };
  try {
    const fc = await th(cfg.token, `/${cfg.userId}/threads_insights`, { metric: 'followers_count' });
    snap.followers = fc.data?.[0]?.total_value?.value ?? null;
  } catch (e) { snap.error = e.message; }
  try {
    const { posts } = await fetchPosts(cfg, 40);
    snap.posts = posts.map(p => ({ id: p.id, ...(p.metrics || {}) }));
  } catch {}
  await env.TS.put('snap:' + day, JSON.stringify(snap));
}

async function maybeRefreshToken(env) {
  const cfg = await getCfg(env);
  if (!cfg?.token) return;
  const age = Date.now() - new Date(cfg.tokenRefreshedAt || 0).getTime();
  if (age < 20 * 864e5) return; // раз в ~20 дней
  try {
    const r = await th(cfg.token, '/refresh_access_token', { grant_type: 'th_refresh_token' });
    if (r.access_token) {
      cfg.token = r.access_token;
      cfg.tokenRefreshedAt = new Date().toISOString();
      cfg.tokenExpiresAt = r.expires_in ? new Date(Date.now() + r.expires_in * 1000).toISOString() : null;
      cfg.refreshError = null;
      await putCfg(env, cfg);
    }
  } catch (e) { cfg.refreshError = e.message; await putCfg(env, cfg); }
}


// ---------- ответы на комментарии ----------
const CONV_FIELDS = 'id,text,username,timestamp,permalink,replied_to,root_post,is_reply_owned_by_me,hide_status';
const CONV_FIELDS_SAFE = 'id,text,username,timestamp,replied_to,is_reply_owned_by_me';

async function convAll(cfg, id) {
  const all = []; let after, fields = CONV_FIELDS;
  for (let i = 0; i < 3; i++) {
    let r;
    try { r = await th(cfg.token, `/${id}/conversation`, { fields, limit: 100, after }); }
    catch (e) { if (fields === CONV_FIELDS_SAFE) throw e; fields = CONV_FIELDS_SAFE; r = await th(cfg.token, `/${id}/conversation`, { fields, limit: 100, after }); }
    all.push(...(r.data || []));
    if (!r.paging?.next) break;
    after = r.paging.cursors.after;
  }
  return all;
}

async function inbox(cfg, days = 14, includeAnswered = false) {
  const since = Math.floor(Date.now() / 1000 - days * 86400);
  const page = await th(cfg.token, '/me/threads', { fields: 'id,text,timestamp,permalink,media_product_type', limit: 25, since });
  const posts = (page.data || []).filter(p => p.media_product_type !== 'REPLY').slice(0, 20);
  const out = [];
  await Promise.all(posts.map(async p => {
    let conv;
    try { conv = await convAll(cfg, p.id); } catch (e) { out.push({ post: p, error: e.message, comments: [] }); return; }
    const byId = Object.fromEntries(conv.map(c => [c.id, c]));
    const mine = c => c.is_reply_owned_by_me || c.username === cfg.username;
    const answered = new Set(conv.filter(mine).map(c => c.replied_to?.id).filter(Boolean));
    const comments = conv.filter(c => !mine(c) && c.hide_status !== 'HIDDEN').map(c => {
      const chain = []; let cur = c.replied_to?.id;
      for (let i = 0; i < 4 && cur && cur !== p.id && byId[cur]; i++) { chain.unshift({ username: byId[cur].username, text: byId[cur].text, mine: mine(byId[cur]) }); cur = byId[cur].replied_to?.id; }
      return { id: c.id, username: c.username, text: c.text || '', timestamp: c.timestamp, permalink: c.permalink, answered: answered.has(c.id), chain };
    }).filter(c => includeAnswered || !c.answered);
    if (comments.length) out.push({ post: p, comments });
  }));
  out.sort((a, b) => new Date(b.post.timestamp) - new Date(a.post.timestamp));
  return out;
}

const STYLE = `Ти пишеш відповіді на коментарі під постами в Threads від імені Карини (@karinella.karamel).
Її стиль: українська, розмовна, часто з малої літери; самоіронія, точні життєві спостереження, інтелектуальний сарказм, несподіваний поворот. Коротко: 1-2 речення, до 200 символів.
Правила: тільки звичайний дефіс "-" і прямі лапки ", ніяких довгих тире, «ялинок», хештегів і емодзі-гірлянд. Без моралізаторства, без шаблонного SMM, без "дякую за коментар", без порожніх "згодна!". Не вигадуй фактів про Карину.
Мета: продовжити розмову, щоб людина захотіла відповісти ще раз (це головний сигнал для рекомендацій Threads), і щоб інші читачі захотіли зайти в профіль.
Якщо коментар про біль, депресію, терапію чи важкий досвід - відповідай тепло й бережно, як психолог зі співчуттям, без жартів над людиною.
Якщо коментар грубий або провокаційний - спокійно і дотепно, без агресії.
Відповідай мовою коментаря (якщо коментар російською - все одно українською, але м'яко).`;

function extractJson(t) {
  if (!t) return null;
  const m = String(t).match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
function aiText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  if (r.response && typeof r.response === 'object') return JSON.stringify(r.response);
  if (r.choices?.[0]?.message?.content) return r.choices[0].message.content;
  if (Array.isArray(r.output)) return r.output.flatMap(o => (o.content || []).map(c => c.text || '')).join('\n');
  if (r.result) return aiText(r.result);
  return JSON.stringify(r);
}

async function suggest(env, { post, comment, chain = [], hint = '' }) {
  const ctx = [`Пост Карини: "${post}"`, ...chain.map(c => `${c.mine ? 'Карина' : '@' + c.username}: "${c.text}"`), `Коментар, на який треба відповісти: "${comment}"`].join('\n');
  const task = `${ctx}\n${hint ? 'Побажання Карини: ' + hint + '\n' : ''}\nНапиши 3 різні варіанти відповіді: 1) продовжити жарт/думку з власним поворотом, 2) по-людськи тепло або з нюансом, 3) з конкретним питанням, на яке хочеться відповісти. Поверни ТІЛЬКИ JSON-масив з 3 рядків, без пояснень.`;
  const messages = [{ role: 'system', content: STYLE }, { role: 'user', content: task }];
  const models = [
    ['@cf/openai/gpt-oss-120b', { messages, max_tokens: 2000, reasoning: { effort: 'low' } }],
    ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages, max_tokens: 600, temperature: 0.8 }],
  ];
  let lastErr;
  for (const [m, input] of models) {
    try {
      const r = await env.AI.run(m, input);
      const arr = extractJson(aiText(r));
      if (Array.isArray(arr) && arr.length) {
        const clean = arr.map(x => String(typeof x === 'object' ? (x.text || x.reply || Object.values(x)[0]) : x).replace(/[—–]/g, '-').replace(/[«»“”„]/g, '"').trim()).filter(Boolean).slice(0, 3);
        if (clean.length) return { model: m, variants: clean };
      }
      lastErr = new Error('Модель вернула пустой ответ');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('ИИ недоступен');
}


async function aiJson(env, system, user, maxTokens = 3000) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const models = [
    ['@cf/openai/gpt-oss-120b', { messages, max_tokens: maxTokens, reasoning: { effort: 'low' } }],
    ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages, max_tokens: Math.min(maxTokens, 2000), temperature: 0.5 }],
  ];
  let lastErr;
  for (const [m, input] of models) {
    try { const arr = extractJson(aiText(await env.AI.run(m, input))); if (Array.isArray(arr) && arr.length) return arr; lastErr = new Error('Пустой ответ модели'); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}
const fixTypo = t => String(t || '').replace(/[—–]/g, '-').replace(/[«»“”„]/g, '"').trim();

async function translate(env, items) {
  const list = items.slice(0, 15).map(i => ({ id: i.id, text: String(i.text || '').slice(0, 700) }));
  const sys = 'Ти перекладач і редактор соцмереж. Перекладаєш пости з будь-яких мов на живу розмовну українську, зберігаючи жарт, гру слів (якщо гра слів не перекладається - передай сенс). Типографіка: тільки дефіс "-" і прямі лапки.';
  const user = `Для кожного поста поверни об'єкт {"id","uk","topic","fit"}:
- uk: переклад українською;
- topic: одне слово з [стосунки, психологія, робота, айті, гроші, гумор, життя, соцмережі, ші, політика, новини, інше];
- fit: 0-10, наскільки механіка поста підходить для україномовного Threads-акаунта про стосунки, психологію, роботу/IT, гроші, ШІ з самоіронією (політика і новини = 0-2).
Поверни ТІЛЬКИ JSON-масив.
${JSON.stringify(list)}`;
  const arr = await aiJson(env, sys, user, 4000);
  return arr.map(x => ({ id: String(x.id), uk: fixTypo(x.uk), topic: x.topic, fit: +x.fit || 0 }));
}

async function adapt(env, { text, hint = '' }) {
  const user = `Ось пост, який залетів в іншій країні:\n"${text}"\n${hint ? 'Побажання: ' + hint + '\n' : ''}
Не копіюй і не перекладай його. Візьми МЕХАНІКУ (чому люди хочуть відповісти) і напиши 3 оригінальні пости для українського Threads Карини на її теми, з українськими реаліями. Кожен до 280 символів, з конкретним приводом відповісти, без штучних "що думаєте?".
Поверни ТІЛЬКИ JSON-масив з 3 рядків.`;
  const arr = await aiJson(env, STYLE.replace('відповіді на коментарі під постами', 'пости'), user, 2500);
  return { variants: arr.map(x => fixTypo(typeof x === 'object' ? (x.text || Object.values(x)[0]) : x)).filter(Boolean).slice(0, 3) };
}

async function replyTo(cfg, { reply_to_id, text }) {
  const c = await th(cfg.token, '/me/threads', { media_type: 'TEXT', text, reply_to_id }, 'POST');
  for (let i = 0; i < 8; i++) {
    await sleep(i === 0 ? 1500 : 2500);
    try { const s = await th(cfg.token, `/${c.id}`, { fields: 'status,error_message' }); if (s.status === 'FINISHED') break; if (s.status === 'ERROR') throw new ApiError('Контейнер: ' + (s.error_message || 'ERROR'), 400); }
    catch (e) { if (e.message?.startsWith('Контейнер')) throw e; }
  }
  const p = await th(cfg.token, '/me/threads_publish', { creation_id: c.id }, 'POST');
  return { id: p.id };
}

// ---------- HTTP ----------
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const qs = Object.fromEntries(url.searchParams);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

    try {
      if (path === '/' ) return json(req, { ok: true, app: 'threadscope-api', configured: !!(await env.TS.get('keyhash')) });

      // Первичная настройка: задать ключ доступа и токен (только если ключа ещё нет)
      if (path === '/setup' && req.method === 'POST') {
        const existing = await env.TS.get('keyhash');
        if (existing && existing !== await sha256(body.key || '')) return json(req, { error: 'Сервер уже настроен другим ключом' }, 403);
        if (!body.key || body.key.length < 8) return json(req, { error: 'Ключ доступа — минимум 8 символов' }, 400);
        if (!body.token) return json(req, { error: 'Нужен Threads User Access Token' }, 400);
        const me = await th(body.token, '/me', { fields: 'id,username,name,threads_profile_picture_url,threads_biography' });
        await env.TS.put('keyhash', await sha256(body.key));
        await putCfg(env, { token: body.token, userId: me.id, username: me.username, tokenRefreshedAt: new Date(0).toISOString() });
        return json(req, { ok: true, me });
      }

      // Всё остальное — только с ключом
      const kh = await env.TS.get('keyhash');
      if (!kh || kh !== await sha256(req.headers.get('X-Key') || '')) return json(req, { error: 'Неверный ключ доступа' }, 401);
      const cfg = await getCfg(env);
      if (!cfg?.token) return json(req, { error: 'Токен не задан' }, 400);

      if (path === '/token' && req.method === 'POST') {
        const me = await th(body.token, '/me', { fields: 'id,username' });
        Object.assign(cfg, { token: body.token, userId: me.id, username: me.username, tokenRefreshedAt: new Date(0).toISOString(), refreshError: null });
        await putCfg(env, cfg);
        return json(req, { ok: true, me });
      }
      if (path === '/me') {
        const me = await th(cfg.token, '/me', { fields: 'id,username,name,threads_profile_picture_url,threads_biography' });
        let followers = null;
        try { followers = (await th(cfg.token, `/${cfg.userId}/threads_insights`, { metric: 'followers_count' })).data?.[0]?.total_value?.value; } catch {}
        const c2 = await getCfg(env);
        return json(req, { me, followers, token: { refreshedAt: c2.tokenRefreshedAt, expiresAt: c2.tokenExpiresAt, refreshError: c2.refreshError } });
      }
      if (path === '/posts') return json(req, await fetchPosts(cfg, Math.min(+qs.limit || 40, 45), qs.after));
      if (path === '/insights') return json(req, await userInsights(cfg, qs.since, qs.until));
      if (path === '/demographics') return json(req, await demographics(cfg));
      if (path.startsWith('/conversation/')) return json(req, await conversation(cfg, path.split('/')[2]));
      if (path === '/history') {
        const list = await env.TS.list({ prefix: 'snap:' });
        const keys = list.keys.map(k => k.name).sort().slice(-120);
        const snaps = await Promise.all(keys.map(k => env.TS.get(k, 'json')));
        return json(req, snaps.filter(Boolean).map(s => ({ day: s.day, followers: s.followers, posts: s.posts })));
      }
      if (path === '/search') {
        const r = await th(cfg.token, '/keyword_search', {
          q: qs.q, search_type: qs.type || 'TOP', search_mode: qs.mode || 'KEYWORD', media_type: qs.media_type,
          since: qs.since, until: qs.until, limit: qs.limit || 50,
          fields: 'id,text,media_type,permalink,timestamp,username,has_replies,is_quote_post,is_reply',
        });
        return json(req, { data: r.data || [], self: cfg.username });
      }
      if (path === '/publish' && req.method === 'POST') {
        if (!body.text?.trim()) return json(req, { error: 'Пустой текст' }, 400);
        return json(req, await publishNow(cfg, body));
      }
      if (path === '/inbox') return json(req, await inbox(cfg, Math.min(+qs.days || 14, 60), qs.all === '1'));
      if (path === '/suggest' && req.method === 'POST') {
        if (!body.comment) return json(req, { error: 'Нет текста комментария' }, 400);
        return json(req, await suggest(env, body));
      }
      if (path === '/translate' && req.method === 'POST') return json(req, await translate(env, body.items || []));
      if (path === '/adapt' && req.method === 'POST') return json(req, await adapt(env, body));
      if (path === '/reply' && req.method === 'POST') {
        if (!body.reply_to_id || !body.text?.trim()) return json(req, { error: 'Нужны комментарий и текст' }, 400);
        return json(req, await replyTo(cfg, body));
      }
      if (path === '/queue' && req.method === 'GET') return json(req, await getQueue(env));
      if (path === '/queue' && req.method === 'POST') {
        if (!body.text?.trim() || !body.at) return json(req, { error: 'Нужны текст и время' }, 400);
        if (new Date(body.at).getTime() < Date.now() - 60e3) return json(req, { error: 'Время уже прошло' }, 400);
        const q = await getQueue(env);
        const item = { id: crypto.randomUUID(), text: body.text, topic_tag: body.topic_tag || '', at: new Date(body.at).toISOString(), status: 'scheduled', createdAt: new Date().toISOString() };
        // чистим старые опубликованные (>30 дней)
        const keep = q.filter(i => i.status !== 'published' || Date.now() - new Date(i.publishedAt).getTime() < 30 * 864e5);
        keep.push(item);
        await putQueue(env, keep);
        return json(req, item);
      }
      if (path.startsWith('/queue/') && req.method === 'DELETE') {
        const id = path.split('/')[2];
        const q = await getQueue(env);
        const i = q.find(x => x.id === id);
        if (!i) return json(req, { error: 'Не найдено' }, 404);
        if (i.status === 'publishing') return json(req, { error: 'Уже публикуется' }, 409);
        await putQueue(env, q.filter(x => x.id !== id));
        return json(req, { ok: true });
      }
      return json(req, { error: 'Not found' }, 404);
    } catch (e) {
      return json(req, { error: e.message, details: e.raw || null }, e.status && e.status < 500 ? 400 : 502);
    }
  },

  async scheduled(event, env, ctx) {
    await runDue(env);
    const d = new Date(event.scheduledTime);
    if (d.getUTCHours() === 21 && d.getUTCMinutes() < 5) { // ~полночь по Киеву
      await dailySnapshot(env);
      await maybeRefreshToken(env);
    }
  },
};

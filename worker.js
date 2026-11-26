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
    await savePerf(env, posts);
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

// ---------- ИИ: Claude (если задан ключ) или бесплатный Workers AI ----------
const BASE_STYLE = `Ти пишеш від імені Карини (@karinella.karamel) для українського Threads.
Її стиль: українська, розмовна, часто з малої літери; самоіронія, точні життєві спостереження, несподіване порівняння, інтелектуальний сарказм, поворот у кінці. Теми: стосунки, психологія, робота/IT, гроші/інфобізнес, ШІ, соцмережі.
Правила: тільки дефіс "-" і прямі лапки ", ніяких довгих тире, «ялинок», хештегів, емодзі-гірлянд. Без моралізаторства, без шаблонного SMM, без штучних "що думаєте?", "згодні?", "а ви як?", без приманок типу "лайкни". Не вигадуй фактів про Карину. Ніякого суржику і русизмів.
Алгоритм Threads: головне - щоб людині захотілося ВІДПОВІСТИ своєю історією (колекція, незавершений список, спірна теза з нюансом, особисте зізнання), гачок у першому рядку, коротко (до 280 символів), оригінально, у її нішах.
Життєво і психологічно точно, без абсурду і перебільшень. Давай 2-3 конкретні приклади з життя (фрази, ситуації, деталі), щоб читачам хотілося доповнити своїми. НЕ закінчуй кожен пост питанням: частіше - висновок з нюансом або незавершений список; питання - лише якщо воно дуже конкретне.`;
const REPLY_STYLE = BASE_STYLE + `
Зараз ти пишеш ВІДПОВІДІ на коментарі під її постами: 1-2 речення, до 200 символів. Мета - продовжити розмову, щоб людина відповіла ще раз, а інші зайшли в профіль. Без "дякую за коментар" і порожніх "згодна!".
Якщо коментар про біль, депресію, терапію чи важкий досвід - тепло й бережно, як психолог зі співчуттям, без жартів над людиною. Якщо грубий - спокійно і дотепно.`;

function extractJson(t) {
  if (!t) return null;
  const s = String(t);
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
function aiText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (Array.isArray(r.content)) return r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (typeof r.response === 'string') return r.response;
  if (r.response && typeof r.response === 'object') return JSON.stringify(r.response);
  if (Array.isArray(r.choices)) return r.choices[0]?.message?.content || '';
  if (Array.isArray(r.output)) return r.output.flatMap(o => (o.content || []).map(c => c.text || '')).join('\n');
  if (r.result) return aiText(r.result);
  return JSON.stringify(r);
}
const fixTypo = t => String(t || '').replace(/[‐-―−]/g, '-').replace(/ /g, ' ').replace(/[«»“”„]/g, '"').trim();

async function claude(key, model, system, user, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError('Claude: ' + (data.error?.message || 'HTTP ' + res.status), res.status === 401 ? 400 : 502);
  return aiText(data);
}

async function gemini(key, model, system, user, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: Math.max(maxTokens * 2, 8192), temperature: 0.9 } });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body });
    const data = await res.json().catch(() => ({}));
    if ((res.status === 429 || res.status === 503) && attempt < 2) { await sleep(4000 * (attempt + 1)); continue; }
    if (res.status === 503) throw new ApiError('Gemini перегружен', 503);
    if (res.status === 429) throw new ApiError('Gemini: бесплатный лимит запросов на минуту/день исчерпан, подожди немного', 429);
    if (res.status === 400 && /API key/i.test(data.error?.message || '')) throw new ApiError('Gemini: неверный API-ключ', 400);
    if (!res.ok) throw new ApiError('Gemini: ' + (data.error?.message || 'HTTP ' + res.status), 502);
    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');
    if (!text && data.promptFeedback?.blockReason) throw new ApiError('Gemini отказался отвечать (' + data.promptFeedback.blockReason + ')', 400);
    return text;
  }
}
async function geminiModels(key) {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError('Gemini: ' + (data.error?.message || 'HTTP ' + res.status), 400);
  const ids = (data.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''))
    .filter(id => /^gemini/.test(id) && !/(embedding|image|tts|live|audio|veo|imagen|robotics|computer|native|aqa|vision)/.test(id));
  const ver = id => parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  return ids.sort((a, b) => (/preview|exp/.test(a) - /preview|exp/.test(b)) || ver(b) - ver(a) || a.localeCompare(b));
}
async function openai(key, model, system, user, maxTokens) {
  const h = { 'Authorization': 'Bearer ' + key, 'content-type': 'application/json' };
  let res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: h, body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
  let data = await res.json().catch(() => ({}));
  if (res.ok) return data.choices?.[0]?.message?.content || '';
  if (res.status === 401) throw new ApiError('ChatGPT: неверный API-ключ', 400);
  // запасной путь — Responses API
  res = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: h, body: JSON.stringify({ model, instructions: system, input: user, max_output_tokens: maxTokens }) });
  data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError('ChatGPT: ' + (data.error?.message || 'HTTP ' + res.status), 502);
  return data.output_text || (data.output || []).flatMap(o => (o.content || []).map(c => c.text || '')).join('\n');
}
async function openaiModels(key) {
  const res = await fetch('https://api.openai.com/v1/models', { headers: { 'Authorization': 'Bearer ' + key } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError('ChatGPT: ' + (data.error?.message || 'HTTP ' + res.status), 400);
  return (data.data || []).map(m => m.id).filter(id => /^(gpt|chat|o\d)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding|moderation|codex|instruct|cyber|law|rosalind)/.test(id)).sort().reverse();
}
const providerOf = cfg => cfg?.provider || (cfg?.anthropicKey ? 'claude' : 'workers-ai');

// tier: 'write' (посты/ответы) или 'fast' (перевод, разбор)
async function ai(env, system, user, { maxTokens = 3000, tier = 'write' } = {}) {
  const cfg = await getCfg(env);
  const prov = providerOf(cfg);
  if (prov === 'claude' && cfg.anthropicKey) {
    const model = tier === 'fast' ? (cfg.fastModel || 'claude-haiku-5-5') : (cfg.writeModel || 'claude-sonnet-5-5');
    return { text: await claude(cfg.anthropicKey, model, system, user, maxTokens), model };
  }
  if (prov === 'gemini' && cfg.geminiKey) {
    const first = tier === 'fast' ? (cfg.geminiFast || cfg.geminiWrite) : cfg.geminiWrite;
    const chain = [...new Set([first, cfg.geminiWrite, cfg.geminiFast].filter(Boolean))];
    let lastErr;
    for (const model of chain) {
      try { return { text: await gemini(cfg.geminiKey, model, system, user, maxTokens), model }; }
      catch (e) { lastErr = e; if (!/перегружен|503|high demand|лимит/i.test(e.message || '')) throw e; }
    }
    throw new ApiError('Gemini сейчас перегружен — попробуй через пару минут или нажми «в Claude»', 503);
  }
  if (prov === 'openai' && cfg.openaiKey) {
    const model = tier === 'fast' ? cfg.openaiFast : cfg.openaiWrite;
    return { text: await openai(cfg.openaiKey, model, system, user, Math.max(maxTokens, 4000)), model };
  }
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const models = [
    ['@cf/openai/gpt-oss-120b', { messages, max_tokens: Math.max(maxTokens, 4000), reasoning: { effort: 'low' } }],
    ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages, max_tokens: Math.min(maxTokens, 2000), temperature: 0.7 }],
  ];
  let lastErr;
  for (const [m, input] of models) {
    try { const t = aiText(await env.AI.run(m, input)); if (t && t.trim()) return { text: t, model: m }; lastErr = new Error('Пустой ответ модели'); } catch (e) { lastErr = e; }
  }
  if (/4006|daily free allocation/.test(lastErr?.message || '')) throw new ApiError('Бесплатный лимит ИИ на сегодня закончился (обновится в 02:00 по Киеву). Подключи Claude или ChatGPT по API-ключу, чтобы не зависеть от лимита', 429);
  throw lastErr || new Error('ИИ недоступен');
}
async function aiJson(env, system, user, opts) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try { const r = await ai(env, system, user, opts); const arr = extractJson(r.text); if (Array.isArray(arr) && arr.length) return { arr, model: r.model }; lastErr = new Error('ИИ вернул не JSON'); }
    catch (e) { lastErr = e; if (/^(Claude|ChatGPT|Gemini)/.test(e.message || '')) break; }
  }
  throw lastErr;
}
const strOf = x => fixTypo(typeof x === 'object' && x ? (x.text || x.reply || Object.values(x)[0]) : x);

// ---------- обучение на оценках ----------
async function getPrefs(env) { return (await env.TS.get('prefs', 'json')) || { liked: [], disliked: [], notes: '', manual: '', sinceLearn: 0 }; }
async function putPrefs(env, p) { await env.TS.put('prefs', JSON.stringify(p)); }
function prefsBlock(p, kind) {
  const L = p.liked.filter(x => (x.kind || 'post') === kind).slice(-12);
  const D = p.disliked.filter(x => (x.kind || 'post') === kind).slice(-12);
  let s = '';
  if (p.manual) s += `\nПравила від самої Карини (найважливіше):\n${p.manual}\n`;
  if (p.notes) s += `\nЩо ми вже знаємо про її смак:\n${p.notes}\n`;
  if (L.length) s += `\nПриклади, які їй СПОДОБАЛИСЬ:\n${L.map(x => '+ ' + x.text.replace(/\n/g, ' / ')).join('\n')}\n`;
  if (D.length) s += `\nПриклади, які вона ВІДХИЛИЛА (не повторюй такого):\n${D.map(x => '- ' + x.text.replace(/\n/g, ' / ') + (x.reasons?.length ? ` [причина: ${x.reasons.join(', ')}]` : '')).join('\n')}\n`;
  return s;
}

// ---------- обучение на реальных результатах постов ----------
function computePerf(posts) {
  const now = Date.now();
  const ps = (posts || []).filter(p => p.text && p.metrics && now - new Date(p.timestamp) > 48 * 3600e3 && now - new Date(p.timestamp) < 90 * 864e5 && (p.metrics.views || 0) >= 20)
    .map(p => { const m = p.metrics; const eng = (m.likes || 0) + (m.replies || 0) + (m.reposts || 0) + (m.quotes || 0) + (m.shares || 0); return { id: p.id, text: p.text, topic_tag: p.topic_tag || '', at: p.timestamp, views: m.views || 0, replies: m.replies || 0, likes: m.likes || 0, er: (m.views ? eng / m.views : 0) }; });
  if (ps.length < 4) return { ready: false, count: ps.length, wins: [], flops: [], updatedAt: new Date().toISOString() };
  const med = a => { const s = [...a].sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
  const mEr = med(ps.map(p => p.er)), mRep = med(ps.map(p => p.replies)), mViews = med(ps.map(p => p.views));
  const wins = ps.filter(p => p.er >= Math.max(mEr * 1.4, 0.01) && p.replies >= Math.max(1, mRep)).sort((a, b) => b.er - a.er).slice(0, 8);
  const flops = ps.filter(p => !wins.includes(p) && p.views >= 30 && (p.er <= mEr * 0.6 || (p.er === 0 && mEr > 0))).sort((a, b) => a.er - b.er).slice(0, 8);
  return { ready: true, count: ps.length, median: { er: mEr, replies: mRep, views: mViews }, wins, flops, updatedAt: new Date().toISOString() };
}
async function savePerf(env, posts) {
  const perf = computePerf(posts);
  await env.TS.put('perf', JSON.stringify(perf));
  if (perf.ready) {
    // реальные результаты сильнее «👍 за публикацию»: залетевшие — в понравившиеся, провалы — в отклонённые
    const p = await getPrefs(env);
    const pct = x => (x * 100).toFixed(1) + '%';
    for (const f of perf.flops) {
      p.liked = p.liked.filter(x => x.text !== f.text);
      if (!p.disliked.some(x => x.text === f.text)) p.disliked.push({ text: f.text, kind: 'post', reasons: [`не зайшло підписникам: ER ${pct(f.er)} при медіані ${pct(perf.median.er)}`], at: new Date().toISOString(), perf: true });
    }
    for (const wi of perf.wins) {
      p.disliked = p.disliked.filter(x => x.text !== wi.text);
      if (!p.liked.some(x => x.text === wi.text)) p.liked.push({ text: wi.text, kind: 'post', at: new Date().toISOString(), perf: true });
    }
    p.liked = p.liked.slice(-80); p.disliked = p.disliked.slice(-80);
    await putPrefs(env, p);
  }
  return perf;
}
async function getPerf(env) { return (await env.TS.get('perf', 'json')) || null; }
function perfBlock(perf, short = false) {
  if (!perf?.ready) return '';
  const pct = x => (x * 100).toFixed(1) + '%';
  const line = p => `"${p.text.replace(/\n/g, ' / ').slice(0, 220)}" (ER ${pct(p.er)}, відповідей ${p.replies}, переглядів ${p.views}${p.topic_tag ? ', тема ' + p.topic_tag : ''})`;
  const W = perf.wins.slice(0, short ? 3 : 6), F = perf.flops.slice(0, short ? 2 : 5);
  let s = `\nРЕАЛЬНА СТАТИСТИКА її постів (медіана ER ${pct(perf.median.er)}, медіана відповідей ${perf.median.replies}):\n`;
  if (W.length) s += `ЗАЛЕТІЛО (бери ці механіки, тон і теми за орієнтир):\n${W.map(p => '+ ' + line(p)).join('\n')}\n`;
  if (F.length) s += `НЕ ЗАЙШЛО (уникай таких механік і подачі):\n${F.map(p => '- ' + line(p)).join('\n')}\n`;
  return s;
}

async function learn(env) {
  const p = await getPrefs(env);
  if (p.liked.length + p.disliked.length < 4) return p;
  const user = `Ось оцінки Карини до чернеток постів і відповідей.
СПОДОБАЛОСЬ:\n${p.liked.slice(-40).map(x => '+ ' + x.text.replace(/\n/g, ' / ')).join('\n')}
НЕ СПОДОБАЛОСЬ:\n${p.disliked.slice(-40).map(x => '- ' + x.text.replace(/\n/g, ' / ') + (x.reasons?.length ? ` [${x.reasons.join(', ')}]` : '')).join('\n')}
Сформулюй 5-10 коротких конкретних правил її смаку (що робити і чого уникати), кожне з нового рядка, починаючи з "- ". Тільки правила, без вступу. Українською.`;
  try {
    const r = await ai(env, 'Ти аналітик стилю авторки соцмереж.', user, { maxTokens: 1500, tier: 'write' });
    p.notes = fixTypo(r.text).split('\n').filter(l => l.trim().startsWith('-')).slice(0, 10).join('\n') || p.notes;
    p.sinceLearn = 0; p.learnedAt = new Date().toISOString();
    await putPrefs(env, p);
  } catch {}
  return p;
}

// ---------- генерация ----------
async function suggest(env, { post, comment, chain = [], hint = '' }) {
  const p = await getPrefs(env); const perfTxt = perfBlock(await getPerf(env), true);
  const ctx = [`Пост Карини: "${post}"`, ...chain.map(c => `${c.mine ? 'Карина' : '@' + c.username}: "${c.text}"`), `Коментар, на який треба відповісти: "${comment}"`].join('\n');
  const user = `${ctx}\n${hint ? 'Побажання Карини: ' + hint + '\n' : ''}\nНапиши 3 різні варіанти відповіді: 1) продовжити жарт/думку з власним поворотом, 2) по-людськи тепло або з нюансом, 3) з конкретним питанням, на яке хочеться відповісти. Поверни ТІЛЬКИ JSON-масив з 3 рядків.`;
  const { arr, model } = await aiJson(env, REPLY_STYLE + prefsBlock(p, 'reply') + perfTxt, user, { maxTokens: 2000 });
  return { model, variants: arr.map(strOf).filter(Boolean).slice(0, 3) };
}

const GEN_MODES = {
  recognize: 'МЕХАНІКА "впізнай себе": опиши конкретні щоденні ситуації, в яких її аудиторія (стосунки, робота/IT, гроші, психологія, соцмережі) стикається з проблемою - їхніми звичними думками, страхами і формулюваннями. Кожен пост починається з впізнаваного спостереження або питання. Без загальних слів і абстрактної мотивації. Мета: щоб хотілося написати "це ж про мене" і розповісти свою версію.',
  unspoken: 'МЕХАНІКА "невисловлена думка": знайди думки, які аудиторія давно відчуває, але рідко формулює вслух. Коротко і зухвало, через несподіване порівняння і точне спостереження. Мета: щоб пост хотілося переслати другу зі словами "ось! саме про це" і щоб у коментарях додавали свої приклади.',
  debate: 'МЕХАНІКА "спірна теза": популярне переконання її аудиторії, перевернуте несподіваною заявою, з якою хочеться посперечатися. Але через іронію і нюанс, НЕ коучинговим тоном "ви все робите неправильно", без порад і штучних скандалів.',
  story: 'МЕХАНІКА "моя історія": нижче реальна ситуація з життя Карини. Знайди в ній найнесподіваніший поворот, конфлікт або помилку. Напиши мікроісторії: конкретні деталі з її розповіді, жива емоція, інтрига з першого рядка, поворот або висновок у кінці, привід для читачів розповісти схоже. СУВОРО: не вигадуй подій, деталей, людей і цифр, яких немає в її розповіді.',
};
async function generate(env, { count = 10, topic = '', hint = '', best = [], recent = [], mode = '', story = '' }) {
  const p = await getPrefs(env); const perfTxt = perfBlock(await getPerf(env), false);
  count = Math.max(3, Math.min(+count || 10, 15));
  const user = `${best.length ? 'Її пости з найкращою статистикою (на них орієнтуйся):\n' + best.map(b => `* "${b.text}" (перегляди ${b.views}, відповіді ${b.replies}, ER ${b.er})`).join('\n') + '\n' : ''}${recent.length ? 'Недавні пости (НЕ повторюй ці ідеї і механіки):\n' + recent.map(r => '* ' + r).join('\n') + '\n' : ''}
Сьогодні ${new Date().toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv', weekday: 'long', day: 'numeric', month: 'long' })} - якщо доречно, прив'яжи частину ідей до сезону, дня тижня чи актуальних буденних подій.
${topic ? 'Тема: ' + topic + '\n' : 'Теми різні, з її ніш.\n'}${hint ? 'Побажання: ' + hint + '\n' : ''}
${GEN_MODES[mode] ? GEN_MODES[mode] + '\n' : ''}${mode === 'story' && story ? 'Її розповідь:  + String(story).slice(0, 2000) + \n' : ''}Напиши ${count} РІЗНИХ чернеток постів${GEN_MODES[mode] ? ' за цією механікою (різні кути і формулювання)' : ' (різні механіки: колекція/музей, рейтинг, словник-переклад, спірна теза з нюансом, мікроісторія з поворотом, порівняння)'}. Для кожної поверни об'єкт:
{"text": пост до 280 символів, "topic_tag": одна тема з [психологія, стосунки, айті, робота, гроші, гумор, життя, соцмережі, штучний інтелект], "why": одне коротке речення чому люди захочуть відповісти, "score": твій прогноз 1-10 наскільки зайде}
Поверни ТІЛЬКИ JSON-масив.`;
  const { arr, model } = await aiJson(env, BASE_STYLE + prefsBlock(p, 'post') + perfTxt, user, { maxTokens: 5000 });
  return { model, drafts: arr.filter(x => x && (x.text || typeof x === 'string')).map(x => ({ text: strOf(x.text ?? x), topic_tag: fixTypo(x.topic_tag || ''), why: fixTypo(x.why || ''), score: +x.score || null })).slice(0, count) };
}


async function improve(env, { text, hint = '', tag = '', fix = null }) {
  const p = await getPrefs(env); const perfTxt = perfBlock(await getPerf(env), false);
  if (Array.isArray(fix) && fix.length) {
    const user = `Ось пост Карини:\n"${text}"\n${tag ? 'Тема: ' + tag + '\n' : ''}
Внеси ТІЛЬКИ ці правки, усе інше (думку, голос, жарт, поворот) збережи:\n${fix.map(f => '- ' + f).join('\n')}
Обов'язково: до 270 символів; перший рядок - гачок до 90 символів і потім перенос рядка; фінал дає привід відповісти: незавершений список прикладів, висновок з нюансом або дуже конкретне питання (не шаблонне); тільки дефіс "-" і прямі лапки; без хештегів і посилань.
Поверни ТІЛЬКИ JSON-масив з 1 об'єкта {"text": виправлений пост}.`;
    let lastRaw = '', model = '';
    for (let i = 0; i < 2; i++) {
      const r = await ai(env, BASE_STYLE + prefsBlock(p, 'post') + perfTxt, user, { maxTokens: 2000 });
      model = r.model; lastRaw = r.text || '';
      const arr = extractJson(lastRaw);
      let t = '';
      if (Array.isArray(arr) && arr.length) t = strOf(arr[0]?.text ?? arr[0]);
      if (!t) { const m = lastRaw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/); if (m) { try { t = JSON.parse('"' + m[1] + '"'); } catch {} } }
      if (!t && lastRaw && !/[\[{]/.test(lastRaw.trim()[0] || '')) t = lastRaw.trim().replace(/^["']|["']$/g, '');
      t = fixTypo(t);
      if (t && t.length > 10) return { model, variants: [{ text: t, note: '' }] };
    }
    throw new ApiError('ИИ не смог исправить текст, попробуй ещё раз', 502);
  }
  const user = `Ось чернетка поста Карини:\n"${text}"\n${tag ? 'Тема: ' + tag + '\n' : ''}${hint ? 'Що вона хоче змінити: ' + hint + '\n' : ''}
Покращ її для алгоритму Threads, зберігши її голос і головну думку (не підміняй ідею своєю). Що можна робити: сильніший гачок у першому рядку, коротше і щільніше, точніша деталь, різкіший поворот у кінці, конкретний привід відповісти (без штучних питань), прибрати воду, канцелярит, суржик, довгі тире.
Дай 3 різні варіанти: 1) мінімальна правка, 2) сильніший поворот, 3) сміливіша версія.
Поверни ТІЛЬКИ JSON-масив з 3 об'єктів {"text": покращений пост до 280 символів, "note": що змінено, коротко російською}.`;
  const { arr, model } = await aiJson(env, BASE_STYLE + prefsBlock(p, 'post') + perfTxt, user, { maxTokens: 2500 });
  return { model, variants: arr.map(x => ({ text: strOf(x.text ?? x), note: fixTypo(x.note || '') })).filter(v => v.text).slice(0, 3) };
}


const COMMENT_MECH = `Механіки коментарів, які збирають лайки і гілки:
1. неочевидний твіст - перевертає думку автора несподіваним, але точним кутом;
2. "доповню список" - той самий пункт, якого бракує, найточніший або найсмішніший;
3. точна деталь із життя - конкретика, в якій кожен впізнає себе;
4. самоіронічне зізнання - "я та людина, яка...";
5. переклад на людську - одним рядком іронічно підсумувати суть;
6. розумне "але" - м'яка незгода з нюансом, з якою хочеться посперечатися.
Правила: 1-2 речення, до 160 символів; коментар має бути зрозумілий і смішний/влучний навіть без поста (його бачать у стрічці окремо); ніякого "згодна", "так і є", "дуже влучно", ніяких емодзі-гірлянд, ніякої самореклами, не принижувати автора; на болючі теми (депресія, втрата, війна) - без жартів, тепло і по-людськи.`;
async function comment(env, { text, author = '', hint = '' }) {
  const p = await getPrefs(env); const perfTxt = perfBlock(await getPerf(env), true);
  const user = `Чужий пост${author ? ' від @' + author : ''} у Threads:\n"${text}"\n${hint ? 'Побажання Карини: ' + hint + '\n' : ''}
${COMMENT_MECH}
Напиши 5 різних коментарів від Карини, кожен за іншою механікою, щоб під ним ставили лайки і відповідали, а люди хотіли відкрити її профіль.
Поверни ТІЛЬКИ JSON-масив з 5 об'єктів {"text": коментар, "mech": назва механіки з 3-4 слів}.`;
  const { arr, model } = await aiJson(env, BASE_STYLE + prefsBlock(p, 'comment') + perfTxt, user, { maxTokens: 2500 });
  return { model, variants: arr.map(x => ({ text: strOf(x.text ?? x), mech: fixTypo(x.mech || '') })).filter(v => v.text).slice(0, 5) };
}

async function translate(env, items) {
  const list = items.slice(0, 8).map(i => ({ id: i.id, text: String(i.text || '').slice(0, 700), likes: i.likes, replies: i.replies, media: !!i.media }));
  const sys = `Ти редактор українського Threads і перекладач. Відбираєш зарубіжні пости, які можуть залетіти в РЕКОМЕНДАЦІЇ українського Threads, і переписуєш їх по-нашому.
Що залітає в укр. Threads: універсальні життєві ситуації, які зрозумілі без контексту країни (стосунки, робота/офіс/IT, гроші, психологія, побут, соцмережі, ШІ, дорослішання, батьки, друзі, самоіронія), спірні тези з нюансом, колекції/рейтинги, на які хочеться відповісти своєю історією, свіжий несподіваний поворот.
Що НЕ залітає: місцева політика і новини, локальні знаменитості, ТВ-шоу, спорт, фандоми, внутрішні меми країни, жарти, де суть у картинці, реклама, 18+, а також усе, що в українському контексті під час війни звучить недоречно або пов'язане з росією/російською культурою.
Будь СУВОРИМ критиком. Калібрування chance:
- 9-10: сильна універсальна механіка (впізнавана ситуація з поворотом, колекція "несіть свої", спірна теза з нюансом, рейтинг) - українці масово відповідатимуть своїми історіями;
- 6-8: добра ідея, але слабший поворот або вужча аудиторія;
- 3-5: просто мило/смішно, але відповідати нема чого;
- 0-2: особистий щоденник ("доброго ранку, ось мій сніданок/прибирання/мій кіт"), фото-пости, новини, знаменитості, реклама, фандоми - таке залітає лише в автора з власною аудиторією.
Типографіка: тільки дефіс "-" і прямі лапки. Без суржику і русизмів.`;
  const perf = await getPerf(env);
  const mine = perf?.ready ? `\nЩо реально працює в її акаунті (оцінюючи "fit", порівнюй з цим): ${perf.wins.slice(0, 4).map(p => '"' + p.text.replace(/\n/g, ' / ').slice(0, 140) + '"').join('; ')}${perf.flops.length ? `. Не заходить: ${perf.flops.slice(0, 3).map(p => '"' + p.text.replace(/\n/g, ' / ').slice(0, 100) + '"').join('; ')}` : ''}\n` : '';
  const user = mine + `Для кожного поста поверни об'єкт:
{"id", "lang": ISO-код мови оригіналу,
 "uk": точний переклад українською,
 "ua": переписаний "по-нашому" пост для українського Threads - та сама механіка, але звучить так, ніби його написала українка: розмовно, з малої літери, до 280 символів, з поворотом; універсально і цікаво, НЕ перевантажуй локальними брендами - українські реалії тільки якщо вони підсилюють жарт,
 "topic": одне з [стосунки, психологія, робота, айті, гроші, гумор, життя, соцмережі, ші, політика, новини, інше],
 "uni": 0-10 наскільки зрозуміло українцю без контексту країни оригіналу,
 "reply": 0-10 наскільки українцям захочеться ВІДПОВІСТИ своєю історією (головний сигнал алгоритму Threads),
 "fresh": 0-10 наскільки ідея свіжа і не банальна,
 "fit": 0-10 наскільки підходить акаунту про стосунки, психологію, роботу/IT, гроші, ШІ з самоіронією,
 "mech": механіка одним-двома словами з [впізнавана ситуація, спірна теза, колекція, рейтинг, порівняння, словник-переклад, мікроісторія з поворотом, абсурд, немає] ("немає" для щоденника, новин, просто фото),
 "flags": масив з [політика, війна, новини, локальне, фандом, картинка, 18+, сумне, реклама, росія] - що з цього є,
 "chance": 0-10 загальний шанс, що версія "ua" залетить в рекомендації українського Threads (враховуй усе вище; будь суворим, 8+ лише для справді сильних),
 "why": одне коротке речення українською - чому залетить або чому ні}
Поверни ТІЛЬКИ JSON-масив.
${JSON.stringify(list)}`;
  const { arr } = await aiJson(env, sys, user, { maxTokens: 6000, tier: 'fast' });
  const n = v => Math.max(0, Math.min(10, +v || 0));
  return arr.map(x => ({ id: String(x.id), lang: String(x.lang || '').toLowerCase().slice(0, 5), uk: fixTypo(x.uk), ua: fixTypo(x.ua), topic: x.topic, uni: n(x.uni), reply: n(x.reply), fresh: n(x.fresh), fit: n(x.fit), chance: n(x.chance), flags: Array.isArray(x.flags) ? x.flags.slice(0, 6) : [], mech: fixTypo(x.mech || ''), why: fixTypo(x.why) })).map(t => (/немає/.test(t.mech) ? { ...t, chance: Math.min(t.chance, 3) } : t));
}

async function adapt(env, { text, hint = '' }) {
  const p = await getPrefs(env); const perfTxt = perfBlock(await getPerf(env), false);
  const user = `Ось пост, який залетів в іншій країні:\n"${text}"\n${hint ? 'Побажання: ' + hint + '\n' : ''}
Не копіюй і не перекладай його дослівно. Зрозумій, ЧОМУ люди на нього реагують (механіка), і напиши 3 оригінальні пости для українського Threads Карини з тією ж механікою, але з українськими реаліями і на її теми. Кожен до 280 символів, з конкретним приводом відповісти.
Поверни ТІЛЬКИ JSON-масив з 3 рядків.`;
  const { arr, model } = await aiJson(env, BASE_STYLE + prefsBlock(p, 'post') + perfTxt, user, { maxTokens: 2500 });
  return { model, variants: arr.map(strOf).filter(Boolean).slice(0, 3) };
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
  async fetch(req, env, ctx) {
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
        return json(req, { me, followers, token: { refreshedAt: c2.tokenRefreshedAt, expiresAt: c2.tokenExpiresAt, refreshError: c2.refreshError }, ai: { provider: providerOf(c2), writeModel: { openai: c2.openaiWrite, gemini: c2.geminiWrite }[providerOf(c2)] || (c2.writeModel || 'claude-sonnet-5-5'), fastModel: { openai: c2.openaiFast, gemini: c2.geminiFast }[providerOf(c2)] || (c2.fastModel || 'claude-haiku-5-5'), hasGemini: !!c2.geminiKey, hasClaude: !!c2.anthropicKey, hasOpenai: !!c2.openaiKey } });
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
      if (path === '/improve' && req.method === 'POST') { if (!body.text?.trim()) return json(req, { error: 'Пустой текст' }, 400); return json(req, await improve(env, body)); }
      if (path === '/perf' && req.method === 'POST') return json(req, await savePerf(env, body.posts || []));
      if (path === '/perf' && req.method === 'GET') return json(req, (await getPerf(env)) || { ready: false });
      if (path === '/comment' && req.method === 'POST') { if (!body.text?.trim()) return json(req, { error: 'Вставь текст поста' }, 400); return json(req, await comment(env, body)); }
      if (path === '/generate' && req.method === 'POST') return json(req, await generate(env, body));
      if (path === '/prefs' && req.method === 'GET') { const p = await getPrefs(env); return json(req, { liked: p.liked.length, disliked: p.disliked.length, notes: p.notes, manual: p.manual, learnedAt: p.learnedAt || null }); }
      if (path === '/prefs' && req.method === 'POST') { const p = await getPrefs(env); p.manual = String(body.manual || '').slice(0, 3000); await putPrefs(env, p); return json(req, { ok: true }); }
      if (path === '/learn' && req.method === 'POST') { const p = await learn(env); return json(req, { notes: p.notes, learnedAt: p.learnedAt || null }); }
      if (path === '/feedback' && req.method === 'POST') {
        if (!body.text?.trim()) return json(req, { error: 'Нет текста' }, 400);
        const p = await getPrefs(env);
        const item = { text: String(body.text).slice(0, 600), kind: ['reply', 'comment'].includes(body.kind) ? body.kind : 'post', reasons: (body.reasons || []).slice(0, 5), at: new Date().toISOString() };
        const key = body.verdict === 'ok' ? 'liked' : 'disliked';
        p[key] = [...p[key].filter(x => x.text !== item.text), item].slice(-80);
        p.sinceLearn = (p.sinceLearn || 0) + 1;
        await putPrefs(env, p);
        if (p.sinceLearn >= 8) ctx.waitUntil(learn(env));
        return json(req, { ok: true, liked: p.liked.length, disliked: p.disliked.length });
      }
      if (path === '/aimodels' && req.method === 'POST' && body.provider === 'gemini') {
        const key = body.key || cfg.geminiKey;
        if (!key) return json(req, { error: 'Нужен API-ключ Gemini' }, 400);
        return json(req, { models: await geminiModels(key) });
      }
      if (path === '/aimodels' && req.method === 'POST') {
        const key = body.key || cfg.openaiKey;
        if (!key) return json(req, { error: 'Нужен API-ключ OpenAI' }, 400);
        return json(req, { models: await openaiModels(key) });
      }
      if (path === '/aikey' && req.method === 'POST') {
        const prov = body.provider || 'claude';
        if (prov === 'workers-ai' || body.remove) { cfg.provider = 'workers-ai'; await putCfg(env, cfg); return json(req, { ok: true, provider: 'workers-ai' }); }
        if (prov === 'claude') {
          const writeModel = body.writeModel || 'claude-sonnet-5-5', fastModel = body.fastModel || 'claude-haiku-5-5';
          const key = body.key || cfg.anthropicKey;
          if (!key) return json(req, { error: 'Нужен API-ключ Anthropic' }, 400);
          if (body.key) await claude(body.key, fastModel, 'Відповідай одним словом.', 'Скажи "так".', 20);
          Object.assign(cfg, { provider: 'claude', writeModel, fastModel, anthropicKey: key });
        }
        if (prov === 'gemini') {
          const key = body.key || cfg.geminiKey;
          if (!key) return json(req, { error: 'Нужен API-ключ Gemini' }, 400);
          if (!body.writeModel) return json(req, { error: 'Выбери модель' }, 400);
          await gemini(key, body.fastModel || body.writeModel, 'Відповідай одним словом.', 'Скажи "так".', 50);
          Object.assign(cfg, { provider: 'gemini', geminiKey: key, geminiWrite: body.writeModel, geminiFast: body.fastModel || body.writeModel });
        }
        if (prov === 'openai') {
          const key = body.key || cfg.openaiKey;
          if (!key) return json(req, { error: 'Нужен API-ключ OpenAI' }, 400);
          if (!body.writeModel || !body.fastModel) return json(req, { error: 'Выбери модели' }, 400);
          await openai(key, body.fastModel, 'Відповідай одним словом.', 'Скажи "так".', 50);
          Object.assign(cfg, { provider: 'openai', openaiKey: key, openaiWrite: body.writeModel, openaiFast: body.fastModel });
        }
        await putCfg(env, cfg);
        return json(req, { ok: true, provider: cfg.provider });
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

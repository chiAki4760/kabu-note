(() => {
'use strict';

const TAGS = ['決算', '業界動向', '為替・金利', '規制・政策', '株主還元', 'その他'];
const TAG_RULES = [
  ['決算', /決算|業績|増益|減益|最高益|上方修正|下方修正|通期|四半期/],
  ['株主還元', /配当|増配|自社株|株主優待|株式分割/],
  ['為替・金利', /円安|円高|為替|金利|日銀|利上げ|利下げ|FRB|ドル/],
  ['規制・政策', /規制|関税|制裁|補助金|法案|政策|税制|政府/],
  ['業界動向', /運賃|市況|需要|供給|価格|業界|受注|販売|出荷|着工/],
];
const RANGES = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '全部': 99999 };
const KIND = { company: '会社', sector: '業界', market: '市場' };
const CLOSE_TIME = '15:30';
const PAGE = 40;

const state = {
  cfg: null, prices: {}, news: {}, updated: '',
  tab: null, range: '6M', compare: false, sel: null,
  kind: 'all', tag: 'all', shown: PAGE, draft: { date: '', text: '' }, addDraft: { code: '', name: '', sector: '' },
  pdraft: { dir: '', days: 5, text: '' }, ai: { mode: 'all', q: '' }, ma: false,
};
const DIRS = { up: '上がる', flat: '横ばい', down: '下がる' };
const FLAT = 0.02; // 横ばい＝±2%以内

// ---------- 保存（この端末のみ） ----------
const store = {
  get(key, def) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 保存できない環境では何もしない */ }
  },
};
let memos = store.get('kabu.memos', []);
let tagOverride = store.get('kabu.tags', {});
let preds = store.get('kabu.preds', []);

// ---------- ユーティリティ ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => v == null ? '—' : v.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
const pct = v => v == null || !isFinite(v) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
const cls = v => v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '';
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const guessTag = t => { for (const [tag, re] of TAG_RULES) if (re.test(t)) return tag; return 'その他'; };
const tagOf = n => tagOverride[n.id] || guessTag(n.title);
const fmtDate = d => d.slice(2).replace(/-/g, '/');

function addDay(d) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}
const effDate = n => n.published.slice(11) >= CLOSE_TIME ? addDay(n.published.slice(0, 10)) : n.published.slice(0, 10);

// ---------- 株価系列 ----------
function mkSeries(raw) {
  const s = (raw && raw.series) || [];
  return { dates: s.map(r => r[0]), closes: s.map(r => r[1]) };
}
function firstOnOrAfter(dates, d) {
  for (let i = 0; i < dates.length; i++) if (dates[i] >= d) return i;
  return -1;
}
function lastOnOrBefore(dates, d) {
  for (let i = dates.length - 1; i >= 0; i--) if (dates[i] <= d) return i;
  return -1;
}
// ニュース公開後の値動き：直前の終値を基準に、当日・3日目・5日目の終値の変化率
function reaction(series, eff) {
  const i = firstOnOrAfter(series.dates, eff);
  if (i < 1) return null;
  const base = series.closes[i - 1];
  const at = k => (i + k - 1 < series.closes.length ? series.closes[i + k - 1] / base - 1 : null);
  return { idx: i, r1: at(1), r3: at(3), r5: at(5) };
}
// 直近 n 営業日の騰落率の平均と標準偏差（不偏）。z = (その日の騰落率 − 平均) / 標準偏差
function retStats(series, endIdx, n = 250) {
  const c = series.closes, e = endIdx == null ? c.length - 1 : endIdx;
  const r = [];
  for (let i = Math.max(1, e - n + 1); i <= e; i++) r.push(c[i] / c[i - 1] - 1);
  if (r.length < 20) return null;
  const m = mean(r);
  const sd = Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1));
  return { m, sd };
}
const zOf = (series, i) => {
  if (i < 1) return null;
  const st = retStats(series, i - 1);
  return st && st.sd ? (series.closes[i] / series.closes[i - 1] - 1 - st.m) / st.sd : null;
};
const zTxt = z => z == null ? '' : `z=${z >= 0 ? '+' : ''}${z.toFixed(1)}`;
function movingAvg(vals, k) {
  let sum = 0;
  return vals.map((v, i) => { sum += v; if (i >= k) sum -= vals[i - k]; return i >= k - 1 ? sum / k : null; });
}

function alignTo(dates, ms) {
  let j = 0, last = null;
  return dates.map(d => {
    while (j < ms.dates.length && ms.dates[j] <= d) { last = ms.closes[j]; j++; }
    return last;
  }).map((v, _, a) => v == null ? a.find(x => x != null) : v);
}

// ---------- チャート ----------
function drawChart(el, o) {
  const n = o.dates.length;
  if (n < 2) { el.innerHTML = '<div class="empty">株価データがまだありません。</div>'; return; }
  const W = Math.max(280, el.clientWidth || 340), H = 250, L = 6, R = 48, T = 10, B = 44;
  const cmp = !!(o.mkt && o.compare);
  const a = cmp ? o.vals.map(v => v / o.vals[0] * 100) : o.vals;
  const b = cmp ? o.mkt.map(v => v / o.mkt[0] * 100) : null;
  const all = a.concat(b || [], o.ma && !cmp ? o.ma : []).filter(v => v != null);
  let min = Math.min(...all), max = Math.max(...all);
  const pad = (max - min) * 0.06 || 1;
  min -= pad; max += pad;
  const x = i => L + (W - L - R) * i / (n - 1);
  const y = v => T + (H - T - B) * (1 - (v - min) / (max - min));
  const path = arr => arr.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join('');
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="株価チャート">`;
  for (let k = 0; k <= 3; k++) {
    const v = min + (max - min) * k / 3, yy = y(v);
    s += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1"/>`;
    s += `<text x="${W - R + 4}" y="${yy + 4}" font-size="10" fill="var(--sub)">${cmp ? v.toFixed(0) : num(max - min > 100 ? Math.round(v) : Math.round(v * 10) / 10)}</text>`;
  }
  [0, Math.round((n - 1) / 2), n - 1].forEach((i, k) => {
    s += `<text x="${x(i)}" y="${H - B + 14}" font-size="10" fill="var(--sub)" text-anchor="${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}">${fmtDate(o.dates[i])}</text>`;
  });
  if (b) s += `<path d="${path(b)}" fill="none" stroke="var(--market)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  if (o.ma && !cmp) {
    const seg = o.ma.map((v, i) => v == null ? '' : (i && o.ma[i - 1] != null ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join('');
    if (seg) s += `<path d="${seg}" fill="none" stroke="var(--ma)" stroke-width="1.5"/>`;
  }
  s += `<path d="${path(a)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>`;
  o.markers.forEach((m, i) => {
    if (m.news) s += `<circle cx="${x(i)}" cy="${H - 16}" r="${3 + Math.min(m.news, 4)}" fill="var(--news)" opacity=".85"/>`;
    if (m.memo) s += `<path d="M${x(i)} ${H - 11}l5 6-5 6-5-6z" fill="var(--memo)"/>`;
  });
  if (o.selIdx != null && o.selIdx >= 0) {
    s += `<line x1="${x(o.selIdx)}" x2="${x(o.selIdx)}" y1="${T}" y2="${H - B}" stroke="var(--text)" stroke-width="1" stroke-dasharray="2 2"/>`;
    s += `<circle cx="${x(o.selIdx)}" cy="${y(a[o.selIdx])}" r="4" fill="var(--accent)"/>`;
  }
  s += `<line id="cur" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--sub)" stroke-width="1" visibility="hidden"/></svg>`;
  el.innerHTML = s;
  const svg = el.firstChild, cur = svg.querySelector('#cur');
  const idxAt = ev => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) * W / r.width;
    return Math.max(0, Math.min(n - 1, Math.round((px - L) / (W - L - R) * (n - 1))));
  };
  svg.addEventListener('pointermove', ev => {
    const i = idxAt(ev);
    cur.setAttribute('x1', x(i)); cur.setAttribute('x2', x(i)); cur.setAttribute('visibility', 'visible');
    o.onHover(i);
  });
  svg.addEventListener('click', ev => o.onSelect(idxAt(ev)));
}

// ---------- データ読み込み ----------
async function getJson(path) {
  try {
    const r = await fetch(path + '?t=' + Date.now(), { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
async function load() {
  const cfg = await getJson('data/config.json');
  if (!cfg) { $('#view').innerHTML = '<div class="card">設定ファイル（data/config.json）を読み込めませんでした。</div>'; return; }
  state.cfg = cfg;
  const jobs = [];
  cfg.stocks.forEach(s => jobs.push(getJson(`data/prices/${s.code}.json`).then(r => state.prices[s.code] = r),
    getJson(`data/news/${s.code}.json`).then(r => state.news[s.code] = r)));
  cfg.market.indices.forEach(i => jobs.push(getJson(`data/prices/${i.key}.json`).then(r => state.prices[i.key] = r)));
  jobs.push(getJson('data/news/market.json').then(r => state.news.market = r));
  await Promise.all(jobs);
  state.updated = Object.values(state.prices).concat(Object.values(state.news))
    .map(r => (r && r.updated) || '').sort().pop();
  state.tab = cfg.stocks[0].code;
  draw();
}

// ---------- 画面 ----------
function tabsHtml() {
  const t = state.cfg.stocks.map(s => `<button type="button" data-act="tab" data-v="${s.code}" class="${state.tab === s.code ? 'on' : ''}">${esc(s.name)}</button>`);
  t.push(`<button type="button" data-act="tab" data-v="market" class="${state.tab === 'market' ? 'on' : ''}">市場全体</button>`);
  t.push(`<button type="button" data-act="tab" data-v="learn" class="${state.tab === 'learn' ? 'on' : ''}">📐 学習</button>`);
  t.push(`<button type="button" data-act="tab" data-v="add" class="${state.tab === 'add' ? 'on' : ''}">＋銘柄を追加</button>`);
  return t.join('');
}

function ctxFor(tab) {
  const topix = mkSeries(state.prices.topix);
  if (tab === 'market') {
    const news = ((state.news.market && state.news.market.items) || []);
    return { series: topix, mkt: null, news, topix };
  }
  const news = ((state.news[tab] && state.news[tab].items) || []);
  return { series: mkSeries(state.prices[tab]), mkt: topix, news, topix };
}

function rangeSlice(series) {
  const n = series.dates.length;
  if (!n) return 0;
  const last = new Date(series.dates[n - 1] + 'T00:00:00Z');
  last.setUTCDate(last.getUTCDate() - RANGES[state.range]);
  const from = last.toISOString().slice(0, 10);
  const i = firstOnOrAfter(series.dates, from);
  return i < 0 ? 0 : i;
}

function newsHtml(n, c) {
  const eff = effDate(n);
  const r = reaction(c.series, eff);
  const m = c.mkt ? reaction(c.mkt, eff) : null;
  const rets = r ? [['当日', 'r1'], ['3日', 'r3'], ['5日', 'r5']].map(([lb, k]) => {
    const ex = m && r[k] != null && m[k] != null ? r[k] - m[k] : null;
    return `<span>${lb} <b class="${cls(r[k])}">${pct(r[k])}</b>${ex != null ? ` <small class="${cls(ex)}">(市場比${pct(ex)})</small>` : ''}</span>`;
  }).join('') : '<span class="sub">値動きは未確定</span>';
  const tag = tagOf(n);
  const opts = TAGS.map(t => `<option${t === tag ? ' selected' : ''}>${t}</option>`).join('');
  return `<div class="news-item"><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>
    <div class="meta">${n.published.replace('T', ' ')} ・ ${esc(n.source)} ・ ${KIND[n.kind] || ''}
      ・ <select data-act="tagSel" data-id="${n.id}" aria-label="タグ">${opts}</select>
      <button type="button" class="del" data-act="memoFrom" data-id="${n.id}">📝 メモ</button></div>
    <div class="rets">${rets}</div></div>`;
}

function statsHtml(c) {
  const rows = {};
  c.news.forEach(n => {
    const r = reaction(c.series, effDate(n));
    if (!r || r.r5 == null) return;
    const m = c.mkt ? reaction(c.mkt, effDate(n)) : null;
    [tagOf(n), '全体'].forEach(k => {
      const o = rows[k] = rows[k] || { n: 0, r1: [], r5: [], ex: [] };
      o.n++; o.r1.push(r.r1); o.r5.push(r.r5);
      if (m && m.r5 != null) o.ex.push(r.r5 - m.r5);
    });
  });
  const keys = ['全体'].concat(TAGS).filter(k => rows[k]);
  if (!keys.length) return '<div class="empty">5営業日分の値動きがそろったニュースが増えると、タグごとの平均がここに出ます。</div>';
  const tr = keys.map(k => `<tr><td>${k}</td><td>${rows[k].n}</td><td class="${cls(mean(rows[k].r1))}">${pct(mean(rows[k].r1))}</td><td class="${cls(mean(rows[k].r5))}">${pct(mean(rows[k].r5))}</td><td class="${cls(mean(rows[k].ex))}">${pct(mean(rows[k].ex))}</td></tr>`).join('');
  return `<table><tr><th>タグ</th><th>件数</th><th>当日</th><th>5日</th><th>5日(市場比)</th></tr>${tr}</table>
    <p class="sub">件数が少ないうちは偶然の影響が大きいので、傾向をつかむ目安として見てください。</p>`;
}

function memoHtml(tab, c) {
  const list = memos.filter(m => m.code === tab).sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
  const s = c.series, last = s.closes.length - 1;
  const items = list.map(m => {
    const i = lastOnOrBefore(s.dates, m.date);
    let chg = null, ex = null;
    if (i >= 0 && last > i) {
      chg = s.closes[last] / s.closes[i] - 1;
      if (c.mkt) { const j = lastOnOrBefore(c.mkt.dates, m.date); if (j >= 0 && j < c.mkt.closes.length - 1) ex = chg - (c.mkt.closes.at(-1) / c.mkt.closes[j] - 1); }
    }
    return `<div class="memo"><div class="sub">${m.date}　メモ日の終値から現在まで <b class="${cls(chg)}">${pct(chg)}</b>${ex != null ? ` <span class="${cls(ex)}">(市場比${pct(ex)})</span>` : ''}</div>
      <p>${esc(m.text)}</p><button type="button" class="del" data-act="memoDel" data-id="${m.id}">削除</button></div>`;
  }).join('');
  const d = state.draft.date || state.sel || s.dates[last] || '';
  return `<div class="card"><h2>📝 メモ（仮説と答え合わせ）</h2>
    <div class="row"><input type="date" id="mDate" value="${d}"></div>
    <textarea id="mText" placeholder="例：円安でこの会社の収益は増えるはず → 数日後の値動きで確認する">${esc(state.draft.text)}</textarea>
    <div class="row"><button type="button" data-act="memoAdd" class="on">メモを保存</button></div>
    <div style="margin-top:8px">${items || '<div class="empty">まだメモはありません。</div>'}</div></div>`;
}

// ---------- 予測と答え合わせ ----------
// 基準日の終値から days 営業日後の終値で判定。期間に届いていなければ途中経過を返す。
function predResult(p, c) {
  const s = c.series, last = s.closes.length - 1;
  const i = lastOnOrBefore(s.dates, p.date);
  if (i < 0 || last < 0) return null;
  const t = i + p.days, done = t <= last, k = done ? t : last;
  const chg = k > i ? s.closes[k] / s.closes[i] - 1 : null;
  let ex = null;
  if (c.mkt && chg != null) {
    const a = lastOnOrBefore(c.mkt.dates, s.dates[i]), b = lastOnOrBefore(c.mkt.dates, s.dates[k]);
    if (a >= 0 && b > a) ex = chg - (c.mkt.closes[b] / c.mkt.closes[a] - 1);
  }
  const hit = done && chg != null ? (p.dir === 'up' ? chg > 0 : p.dir === 'down' ? chg < 0 : Math.abs(chg) <= FLAT) : null;
  return { done, left: t - last, chg, ex, hit, end: s.dates[k] };
}

function predLine(p, r) {
  const head = `${p.date}の終値から${p.days}営業日で「${DIRS[p.dir]}」`;
  if (!r) return head;
  const res = r.chg == null ? '' : `${r.done ? '結果' : '途中経過'}（${r.end}まで）${pct(r.chg)}${r.ex != null ? `（市場比${pct(r.ex)}）` : ''}`;
  return `${head}　${r.done ? (r.hit ? '当たり' : '外れ') : `判定まであと${r.left}営業日`}　${res}`;
}

function predHtml(tab, c) {
  const s = c.series, base = s.dates[s.dates.length - 1] || '';
  const d = state.pdraft;
  const list = preds.filter(p => p.code === tab).sort((a, b) => b.created - a.created);
  let done = 0, hits = 0;
  const items = list.map(p => {
    const r = predResult(p, c);
    if (r && r.done) { done++; if (r.hit) hits++; }
    const badge = !r ? '' : r.done ? `<span class="badge ${r.hit ? 'hit' : 'miss'}">${r.hit ? '当たり' : '外れ'}</span>` : `<span class="badge wait">あと${r.left}営業日</span>`;
    const res = r && r.chg != null ? `<div class="sub">${r.done ? '結果' : '途中経過'}（${r.end}まで） <b class="${cls(r.chg)}">${pct(r.chg)}</b>${r.ex != null ? ` <span class="${cls(r.ex)}">(市場比${pct(r.ex)})</span>` : ''}</div>` : '';
    return `<div class="memo"><div class="row">${badge}<span class="sub">${p.date}の終値から${p.days}営業日で「<b>${DIRS[p.dir]}</b>」</span></div>
      ${res}${p.reason ? `<p>${esc(p.reason)}</p>` : ''}<button type="button" class="del" data-act="predDel" data-id="${p.id}">削除</button></div>`;
  }).join('');
  const dirBtns = Object.entries(DIRS).map(([k, lb]) => `<button type="button" data-act="pDir" data-v="${k}" class="${d.dir === k ? 'on' : ''}">${lb}</button>`).join('');
  return `<div class="card"><h2>🎯 予測と答え合わせ</h2>
    <p class="sub">最新の終値（${base || '—'}）から見て、この先どう動くと思うかを残します。期間がたつと、自動で当たり・外れが出ます。横ばいは±2%以内、上がる・下がるはプラスかマイナスかで判定します。</p>
    ${done ? `<div>これまで <b>${hits} / ${done}</b> 件 当たり</div>` : ''}
    <div class="row" style="margin-top:6px">${dirBtns}
      <select id="pDays" aria-label="期間"><option value="5"${d.days == 5 ? ' selected' : ''}>5営業日後</option><option value="20"${d.days == 20 ? ' selected' : ''}>20営業日後</option></select></div>
    <textarea id="pText" style="margin-top:6px" placeholder="理由：例）運賃の上昇が続いているので、決算への期待が高まりそう">${esc(d.text)}</textarea>
    <div class="row"><button type="button" data-act="predAdd" class="on">予測を保存</button><span class="sub" id="pMsg"></span></div>
    <div style="margin-top:8px">${items || '<div class="empty">まだ予測はありません。</div>'}</div></div>`;
}

// ---------- Claudeに聞く文章 ----------
const AI_MODES = {
  all: '期間全体の値動きとニュースの解説、今後の見方',
  day: 'チャートで選んだ日の値動きの解説',
  review: '自分の予測とメモの振り返り',
};

function aiHtml(tab) {
  const a = state.ai;
  const opts = Object.entries(AI_MODES).map(([k, lb]) => `<option value="${k}"${a.mode === k ? ' selected' : ''}>${lb}${k === 'day' ? (state.sel ? `（${state.sel}）` : '（先にチャートをタップ）') : ''}</option>`).join('');
  return `<div class="card"><h2>🤖 Claudeと考える</h2>
    <p class="sub">この画面の株価・ニュース・メモ・予測をまとめた文章を作ります。コピーして Claude のアプリに貼り付けると、解説してもらえます。株価はチャートで選んでいる期間（今は${state.range}）の分を入れます。</p>
    <label class="sub">聞きたいこと<br><select id="aiMode">${opts}</select></label>
    <label class="sub" style="display:block;margin-top:6px">自分の考えや質問（なくても大丈夫）<br><textarea id="aiQ" placeholder="例：決算のニュースなのに、あまり動かなかったのはなぜ？">${esc(a.q)}</textarea></label>
    <div class="row"><button type="button" class="on" data-act="aiCopy">文章をコピー</button><a class="btn" href="https://claude.ai/new" target="_blank" rel="noopener">Claudeを開く</a></div>
    <p class="sub" id="aiMsg"></p>
    <details id="aiBox" hidden><summary class="sub">作った文章を見る</summary><textarea id="aiText" readonly class="aitext"></textarea></details></div>`;
}

function buildPrompt(tab, c, mode, q) {
  const stock = state.cfg.stocks.find(x => x.code === tab);
  const name = stock ? `${stock.name}（${stock.code}・${stock.sector}）` : '市場全体（TOPIXの代わりにTOPIX連動ETF 1306 を使用）';
  const s = c.series, last = s.closes.length - 1;
  if (last < 1) return null;
  const from = rangeSlice(s);
  const mktChg = (d1, d2) => {
    if (!c.mkt) return null;
    const a = lastOnOrBefore(c.mkt.dates, d1), b = lastOnOrBefore(c.mkt.dates, d2);
    return a >= 0 && b > a ? c.mkt.closes[b] / c.mkt.closes[a] - 1 : null;
  };
  const chgOver = k => last - k >= 0 ? [s.closes[last] / s.closes[last - k] - 1, mktChg(s.dates[last - k], s.dates[last])] : null;
  const fmtChg = o => o ? `${pct(o[0])}${o[1] != null ? `（市場 ${pct(o[1])}）` : ''}` : '—';
  const L = [];

  L.push('私は株の勉強をしています。「ニュースで起きたことに株価がどう反応したか」を学び、「この先の動きをどう考えればよいか」という考え方を身につけたいです。売買の判断を求めているのではありません。');
  L.push('以下は、自分用の学習アプリ「株ノート」に記録したデータです。');
  L.push('', '## お願い');
  if (mode === 'day') {
    L.push(`${state.sel} の値動きについて、次のことを解説してください。`,
      '1. その日の値動きは、その日のニュースへの反応と言えそうか、それとも市場全体の動きによるものか',
      '2. 当日・3日後・5日後の動きの流れから読み取れること（すぐに織り込まれたのか、後から効いてきたのか など）',
      '3. 似たニュースが今後出たときに、何を確かめれば反応を考えやすくなるか');
  } else if (mode === 'review') {
    L.push('私の予測とメモを振り返って、次のことを教えてください。',
      '1. 予測やメモの考え方で、良かった点と見落としていた点',
      '2. 当たり・外れは、考え方が正しかったからなのか、偶然の要素が大きいのか',
      '3. 次に予測を立てるときに意識するとよいこと');
  } else {
    L.push('次のことを解説してください。',
      '1. 期間全体の値動きの流れ。市場全体の動きと、この銘柄だけの動きを分けて',
      '2. 値動きが大きかったニュースと小さかったニュース、その違いの理由として考えられること',
      '3. タグ別の平均から言えること・まだ言えないこと',
      '4. この先を考えるときに注目するとよい材料と、上振れ・下振れのシナリオ（それぞれ、何が起きたらそのシナリオに近づくか）',
      '5. 私が次に記録・観察するとよいこと');
  }
  if (q && q.trim()) L.push('', '私の考え・質問：', q.trim());
  L.push('', '## 守ってほしいこと',
    '- 買う・売る・持ち続けるといった売買の判断や推奨はしないでください。',
    '- 「上がる」「下がる」と言い切らず、「この条件ならこう、別の条件ならこう」というシナリオの形で説明してください。',
    '- データの件数が少ないときは、そのことと偶然の可能性をはっきり書いてください。',
    '- 下のデータにない事実（決算の数字や別のニュースなど）を使うときは、データにない情報だと分かるように書き、確かでないことは推測と明記してください。',
    '- 専門用語には短い説明をつけ、スマホで読みやすい長さにしてください。');

  L.push('', '## 銘柄', name);
  L.push('', `## 株価（${s.dates[from]}〜${s.dates[last]}）`);
  L.push(`最新の終値：${num(s.closes[last])}（${s.dates[last]}）`);
  const per = [s.closes[last] / s.closes[from] - 1, mktChg(s.dates[from], s.dates[last])];
  L.push(`期間の変化：${fmtChg(per)}`, `直近1週間：${fmtChg(chgOver(5))}　1か月：${fmtChg(chgOver(21))}`);
  if (c.mkt) L.push('「市場」はTOPIX連動ETF(1306)の同じ期間の変化です。');

  // 終値の推移：選んだ日の解説は前後10営業日を毎日、それ以外は最大約60行に間引く
  let idx = [];
  if (mode === 'day' && state.sel) {
    const i = s.dates.indexOf(state.sel);
    for (let k = Math.max(0, i - 10); k <= Math.min(last, i + 10); k++) idx.push(k);
  } else {
    const step = Math.max(1, Math.ceil((last - from + 1) / 60));
    for (let k = last; k >= from; k -= step) idx.unshift(k);
  }
  const mAt = d => { if (!c.mkt) return null; const j = lastOnOrBefore(c.mkt.dates, d); return j >= 0 ? c.mkt.closes[j] : null; };
  L.push('', `### 終値の推移${idx.length > 1 && idx[1] - idx[0] > 1 ? `（${idx[1] - idx[0]}営業日おき）` : ''}`);
  idx.forEach(k => { const m = mAt(s.dates[k]); L.push(`${s.dates[k]}　${num(s.closes[k])}${m != null ? `　市場 ${num(m)}` : ''}`); });

  // ニュース
  const fromDate = s.dates[from];
  // 同じ営業日のニュースは値動きが共通なので、日ごとにまとめる（同じ話題の記事が並びすぎないように）
  const rank = n => (n.kind === 'company' ? 0 : 2) + (tagOf(n) === 'その他' ? 1 : 0);
  const dayBlock = (d, list, maxTitles) => {
    const r = reaction(s, d), m = c.mkt ? reaction(c.mkt, d) : null;
    const rr = r ? `当日${pct(r.r1)} 3日${pct(r.r3)} 5日${pct(r.r5)}${m && r.r5 != null && m.r5 != null ? `（5日の市場比${pct(r.r5 - m.r5)}）` : ''}` : '値動き未確定';
    const top = list.slice().sort((a, b) => rank(a) - rank(b)).slice(0, maxTitles);
    return [`- ${d}｜${rr}｜ニュース${list.length}件`]
      .concat(top.map(n => `  ・[${KIND[n.kind] || ''}・${tagOf(n)}] ${n.title}（${n.source || ''}）`))
      .concat(list.length > top.length ? [`  ・ほか${list.length - top.length}件`] : []);
  };
  const byDay = new Map();
  c.news.forEach(n => {
    const i = firstOnOrAfter(s.dates, effDate(n));
    const d = i >= 0 ? s.dates[i] : effDate(n);
    if (d < fromDate) return;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(n);
  });
  let days = [...byDay.keys()].sort().reverse();
  if (mode === 'day' && state.sel) {
    const list = byDay.get(state.sel) || [];
    L.push('', `## ${state.sel} に反映されたニュース（${list.length}件）`);
    L.push(...(list.length ? dayBlock(state.sel, list, 15) : ['（記録なし）']));
    days = days.filter(d => d !== state.sel);
  }
  const DMAX = mode === 'day' ? 10 : 20;
  const total = days.reduce((k, d) => k + byDay.get(d).length, 0);
  let shown = days.slice(0, DMAX);
  if (mode === 'day' && state.sel) {
    // 選んだ日に近い日を優先して、日付順に並べ直す
    const t0 = Date.parse(state.sel);
    shown = days.slice().sort((a, b) => Math.abs(Date.parse(a) - t0) - Math.abs(Date.parse(b) - t0)).slice(0, DMAX).sort().reverse();
  }
  L.push('', `## ${mode === 'day' ? 'ほかの日のニュース' : 'ニュース'}（期間内${days.length}日・${total}件${days.length > DMAX ? `。${mode === 'day' ? '選んだ日に近い' : '新しい'}${DMAX}日分` : ''}）`);
  L.push('日付はニュースが株価に反映される営業日です（15:30以降や休日のニュースは次の営業日）。値動きは、その前日の終値を基準にした当日・3営業日後・5営業日後の変化で、同じ日のニュースは共通です。タグはアプリの自動判定なので、ずれていることがあります。');
  L.push(...(shown.length ? shown.flatMap(d => dayBlock(d, byDay.get(d), 3)) : ['（記録なし）']));

  // タグ別の平均
  const rows = {};
  c.news.forEach(n => {
    const r = reaction(s, effDate(n));
    if (!r || r.r5 == null) return;
    const m = c.mkt ? reaction(c.mkt, effDate(n)) : null;
    [tagOf(n), '全体'].forEach(k => {
      const o = rows[k] = rows[k] || { n: 0, r1: [], r5: [], ex: [] };
      o.n++; o.r1.push(r.r1); o.r5.push(r.r5);
      if (m && m.r5 != null) o.ex.push(r.r5 - m.r5);
    });
  });
  const keys = ['全体'].concat(TAGS).filter(k => rows[k]);
  L.push('', '## タグ別の平均（5営業日分そろったニュースのみ、全期間）');
  L.push(...(keys.length ? keys.map(k => `- ${k}：${rows[k].n}件　当日${pct(mean(rows[k].r1))}　5日${pct(mean(rows[k].r5))}${rows[k].ex.length ? `　5日の市場比${pct(mean(rows[k].ex))}` : ''}`) : ['（まだありません）']));

  // メモ
  const ms = memos.filter(m => m.code === tab).sort((a, b) => a.date.localeCompare(b.date));
  L.push('', `## 私のメモ（${ms.length}件）`);
  L.push(...(ms.length ? ms.map(m => {
    const i = lastOnOrBefore(s.dates, m.date);
    const chg = i >= 0 && last > i ? s.closes[last] / s.closes[i] - 1 : null;
    return `- ${m.date}（その日の終値から現在まで ${pct(chg)}）${m.text.replace(/\s*\n\s*/g, ' / ')}`;
  }) : ['（なし）']));

  // 予測
  const ps = preds.filter(p => p.code === tab).sort((a, b) => a.created - b.created);
  L.push('', `## 私の予測と答え合わせ（${ps.length}件）`);
  if (ps.length) L.push('判定：横ばい＝±2%以内、上がる・下がる＝プラスかマイナスか。');
  L.push(...(ps.length ? ps.map(p => `- ${predLine(p, predResult(p, c))}${p.reason ? `　理由：${p.reason.replace(/\s*\n\s*/g, ' / ')}` : ''}`) : ['（なし）']));
  return L.join('\n');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 下の方法を試す */ }
  try {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select(); t.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  } catch (e) { return false; }
}

function selectedHtml(tab, c) {
  const s = c.series;
  if (!state.sel) return '<div class="card"><div class="sub">チャートをタップすると、その日のニュースとメモがここに出ます。</div></div>';
  const i = s.dates.indexOf(state.sel);
  const day = c.news.filter(n => {
    const j = firstOnOrAfter(s.dates, effDate(n));
    return j === i;
  });
  const ms = memos.filter(m => m.code === tab && m.date === state.sel);
  const prev = i > 0 ? s.closes[i] / s.closes[i - 1] - 1 : null;
  return `<div class="card"><h2>${state.sel} の記録</h2>
    <div>終値 <b>${num(s.closes[i])}</b> <span class="${cls(prev)}">(前日比 ${pct(prev)})</span> ${zTxt(zOf(s, i))}</div>
    <p class="sub">z は、その日の動きが直近1年のふだんの動き（標準偏差）の何倍かを表します。±2を超えると大きめ、±3を超えるとかなり珍しい動きです。</p>
    <p class="sub">15:30以降に出たニュースと休日のニュースは、次の営業日に入ります。</p>
    ${day.length ? day.map(n => newsHtml(n, c)).join('') : '<div class="empty">この日のニュースは記録されていません。</div>'}
    ${ms.map(m => `<div class="memo"><span class="tag">メモ</span><p>${esc(m.text)}</p></div>`).join('')}</div>`;
}

function chartCard(id, title, c, extra) {
  return `<div class="card"><h2>${title}</h2>${extra || ''}
    <div class="row">${Object.keys(RANGES).map(r => `<button type="button" data-act="range" data-v="${r}" class="${state.range === r ? 'on' : ''}">${r}</button>`).join('')}
    ${c.mkt ? `<button type="button" data-act="cmp" class="${state.compare ? 'on' : ''}">市場と比較</button>` : ''}
    <button type="button" data-act="ma" class="${state.ma ? 'on' : ''}">25日移動平均</button></div>
    <div class="readout" id="ro-${id}">&nbsp;</div><div class="chart" id="chart-${id}"></div>
    <div class="legend"><span><i class="dot" style="background:var(--accent)"></i>株価${state.compare && c.mkt ? '（開始日=100）' : ''}</span>
    ${state.compare && c.mkt ? '<span><i class="dot" style="background:var(--market)"></i>TOPIX連動ETF（開始日=100）</span>' : ''}
    ${state.ma && !(state.compare && c.mkt) ? '<span><i class="dot" style="background:var(--ma)"></i>25日移動平均</span>' : ''}
    <span><i class="dot" style="background:var(--news)"></i>ニュースあり</span><span><i class="dot" style="background:var(--memo)"></i>メモあり</span></div></div>`;
}

function mountChart(id, tab, c) {
  const s = c.series, from = rangeSlice(s);
  const dates = s.dates.slice(from), vals = s.closes.slice(from);
  const ma = state.ma ? movingAvg(s.closes, 25).slice(from) : null;
  const mkt = c.mkt ? alignTo(dates, c.mkt) : null;
  const markers = new Map();
  const mark = (d, key) => {
    const i = firstOnOrAfter(dates, d);
    if (i < 0) return;
    const m = markers.get(i) || { news: 0, memo: 0 };
    m[key]++; markers.set(i, m);
  };
  c.news.forEach(n => mark(effDate(n), 'news'));
  memos.filter(m => m.code === tab).forEach(m => mark(m.date, 'memo'));
  const ro = $('#ro-' + id);
  const read = i => {
    const prev = i > 0 ? vals[i] / vals[i - 1] - 1 : null;
    let t = `${dates[i]}　終値 ${num(vals[i])}　前日比 <b class="${cls(prev)}">${pct(prev)}</b> <small>${zTxt(zOf(s, from + i))}</small>`;
    if (state.compare && mkt) t += `　市場 ${num(mkt[i])}`;
    ro.innerHTML = t;
  };
  drawChart($('#chart-' + id), {
    dates, vals, mkt, ma, compare: state.compare, markers,
    selIdx: state.sel ? dates.indexOf(state.sel) : null,
    onHover: read,
    onSelect: i => { state.sel = dates[i]; state.draft.date = dates[i]; draw(); $('#selected') && $('#selected').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); },
  });
  if (dates.length) read(dates.length - 1);
}

function stockView(stock) {
  const c = ctxFor(stock.code), s = c.series, last = s.closes.length - 1;
  const prev = last > 0 ? s.closes[last] / s.closes[last - 1] - 1 : null;
  const head = `<div class="card"><div class="sub">${stock.code} ・ ${esc(stock.sector)}</div>
    <div><span class="price">${num(s.closes[last])}</span><span class="chg ${cls(prev)}">${pct(prev)}</span> <span class="sub">${zTxt(zOf(s, last))}</span></div>
    <div class="sub">${s.dates[last] ? s.dates[last] + ' 終値' : '株価データはまだありません（GitHub の Actions「update-data」を実行すると取得されます）'}</div></div>`;
  let items = c.news.filter(n => (state.kind === 'all' || n.kind === state.kind) && (state.tag === 'all' || tagOf(n) === state.tag));
  const total = items.length;
  items = items.slice(0, state.shown);
  const chip = (act, v, label, cur) => `<button type="button" data-act="${act}" data-v="${v}" class="${cur === v ? 'on' : ''}">${label}</button>`;
  const list = `<div class="card"><h2>📰 ニュース（${total}件）</h2>
    <div class="row">${chip('kind', 'all', 'すべて', state.kind)}${chip('kind', 'company', '会社', state.kind)}${chip('kind', 'sector', '業界', state.kind)}</div>
    <div class="row" style="margin-top:6px"><select data-act="tagFilter"><option value="all">タグ：すべて</option>${TAGS.map(t => `<option${state.tag === t ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
    <div style="margin-top:8px">${items.length ? items.map(n => newsHtml(n, c)).join('') : '<div class="empty">ニュースはまだありません。</div>'}</div>
    ${total > items.length ? '<div class="row"><button type="button" data-act="more">もっと見る</button></div>' : ''}</div>`;
  return head + chartCard('main', `${esc(stock.name)} のチャート`, c) + `<div id="selected">${selectedHtml(stock.code, c)}</div>`
    + `<div class="card"><h2>📊 ニュースのあとの値動き（タグ別の平均）</h2>${statsHtml(c)}</div>` + aiHtml(stock.code)
    + list + predHtml(stock.code, c) + memoHtml(stock.code, c);
}

function marketView() {
  const c = ctxFor('market');
  const cards = state.cfg.market.indices.map(ix => {
    const s = mkSeries(state.prices[ix.key]), last = s.closes.length - 1;
    const chg = k => last - k >= 0 ? s.closes[last] / s.closes[last - k] - 1 : null;
    return `<div class="card"><div class="sub">${esc(ix.name)}</div><div><span class="price">${num(s.closes[last])}</span><span class="chg ${cls(chg(1))}">${pct(chg(1))}</span></div>
      <div class="sub">1週間 <b class="${cls(chg(5))}">${pct(chg(5))}</b> ・ 1か月 <b class="${cls(chg(21))}">${pct(chg(21))}</b></div></div>`;
  }).join('');
  const items = c.news.slice(0, state.shown);
  const list = `<div class="card"><h2>📰 市場全体のニュース（${c.news.length}件）</h2>${items.length ? items.map(n => newsHtml(n, c)).join('') : '<div class="empty">ニュースはまだありません。</div>'}
    ${c.news.length > items.length ? '<div class="row"><button type="button" data-act="more">もっと見る</button></div>' : ''}</div>`;
  return cards + chartCard('main', 'TOPIX連動ETF(1306) のチャート', Object.assign({}, c, { mkt: null }))
    + `<div id="selected">${selectedHtml('market', c)}</div>` + aiHtml('market') + list + predHtml('market', c) + memoHtml('market', c);
}

function addView() {
  const d = state.addDraft;
  return `<div class="card"><h2>＋ 銘柄を追加</h2>
    <p class="sub">国内株の証券コード・名前・業種を入れて「GitHubで申請」を押すと、GitHubの画面が開きます。緑の「Create」を押すと、1〜2分で株価とニュースが取得され、アプリを開き直すとタブに増えます。</p>
    <label class="sub">証券コード（4桁）<br><input type="text" id="aCode" inputmode="text" maxlength="4" placeholder="例：7203" value="${esc(d.code)}"></label>
    <label class="sub">名前（ニュース検索に使います。正式名称がおすすめ）<br><input type="text" id="aName" maxlength="30" placeholder="例：トヨタ自動車" value="${esc(d.name)}"></label>
    <label class="sub">業種（業界ニュース検索に使います）<br><input type="text" id="aSector" maxlength="20" placeholder="例：自動車" value="${esc(d.sector)}"></label>
    <div class="row" style="margin-top:8px"><button type="button" class="on" data-act="addOpen">GitHubで申請</button></div>
    <p class="sub" id="addMsg"></p>
    <p class="sub">登録済み：${state.cfg.stocks.map(x => esc(x.name) + '(' + x.code + ')').join('、')}</p></div>`;
}

function draw() {
  if (!state.cfg) return;
  const text = $('#mText');
  if (text) state.draft.text = text.value;
  const pt = $('#pText'), aq = $('#aiQ');
  if (pt) state.pdraft.text = pt.value;
  if (aq) state.ai.q = aq.value;
  const y = window.scrollY;
  $('#tabs').innerHTML = tabsHtml();
  $('#updated').textContent = state.updated ? '更新 ' + state.updated.replace('T', ' ') : '';
  if (state.tab === 'add') { $('#view').innerHTML = addView(); window.scrollTo(0, y); return; }
  if (state.tab === 'learn') {
    $('#view').innerHTML = window.KN.learn ? window.KN.learn.html() : '<div class="card">読み込み中です。</div>';
    if (window.KN.learn) window.KN.learn.mount();
    window.scrollTo(0, y);
    return;
  }
  const stock = state.cfg.stocks.find(s => s.code === state.tab);
  $('#view').innerHTML = stock ? stockView(stock) : marketView();
  mountChart('main', state.tab, ctxFor(state.tab));
  window.scrollTo(0, y);
}

// ---------- 操作 ----------
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-act]');
  if (!b || b.tagName === 'SELECT') return;
  const v = b.dataset.v, act = b.dataset.act;
  if (act === 'tab') { Object.assign(state, { tab: v, sel: null, kind: 'all', tag: 'all', shown: PAGE }); state.draft = { date: '', text: '' }; state.pdraft.text = ''; state.ai.q = ''; }
  else if (act === 'aiCopy') {
    const mode = $('#aiMode').value, msg = $('#aiMsg');
    state.ai = { mode, q: $('#aiQ').value };
    if (mode === 'day' && !state.sel) { msg.textContent = '先にチャートをタップして、解説してほしい日を選んでください。'; return; }
    const text = buildPrompt(state.tab, ctxFor(state.tab), mode, state.ai.q);
    if (!text) { msg.textContent = '株価データがまだないため、文章を作れません。'; return; }
    $('#aiText').value = text;
    $('#aiBox').hidden = false;
    copyText(text).then(ok => {
      msg.textContent = ok ? `コピーしました（${text.length.toLocaleString()}文字）。「Claudeを開く」から新しいチャットに貼り付けて送ってください。`
        : 'コピーできませんでした。下の「作った文章を見る」を開き、長押しで全選択してコピーしてください。';
      if (!ok) $('#aiBox').open = true;
    });
    return;
  }
  else if (act === 'pDir') state.pdraft.dir = state.pdraft.dir === v ? '' : v;
  else if (act === 'predAdd') {
    const s = ctxFor(state.tab).series, base = s.dates[s.dates.length - 1];
    const d = state.pdraft, reason = ($('#pText').value || '').trim();
    if (!d.dir) { $('#pMsg').textContent = '上がる・横ばい・下がるのどれかを選んでください。'; return; }
    if (!base) { $('#pMsg').textContent = '株価データがまだありません。'; return; }
    preds.push({ id: 'p' + Date.now().toString(36), code: state.tab, date: base, dir: d.dir, days: Number(d.days) || 5, reason, created: Date.now() });
    store.set('kabu.preds', preds);
    state.pdraft = { dir: '', days: d.days, text: '' };
    $('#pText').value = '';
  } else if (act === 'predDel') {
    if (!confirm('この予測を削除しますか？')) return;
    preds = preds.filter(p => p.id !== b.dataset.id);
    store.set('kabu.preds', preds);
  }
  else if (act === 'addOpen') {
    const d = state.addDraft = { code: $('#aCode').value.trim().toUpperCase(), name: $('#aName').value.trim(), sector: $('#aSector').value.trim() };
    const msg = $('#addMsg');
    if (!/^[0-9]{3}[0-9A-Z]$/.test(d.code)) { msg.textContent = '証券コードは4桁で入力してください（例：7203）。'; return; }
    if (!d.name || !d.sector) { msg.textContent = '名前と業種を入力してください。'; return; }
    if (state.cfg.stocks.some(x => x.code === d.code)) { msg.textContent = d.code + ' はすでに登録されています。'; return; }
    const url = `https://github.com/${state.cfg.repo}/issues/new?title=${encodeURIComponent('銘柄追加 ' + d.code)}&body=${encodeURIComponent(`コード: ${d.code}\n名前: ${d.name}\n業種: ${d.sector}\n`)}`;
    msg.textContent = 'GitHubの画面が開きます。緑の「Create」を押してください。';
    window.open(url, '_blank', 'noopener');
    return;
  }
  else if (act.startsWith('L')) { if (!(window.KN.learn && window.KN.learn.click(act, b))) return; }
  else if (act === 'ma') state.ma = !state.ma;
  else if (act === 'range') state.range = v;
  else if (act === 'cmp') state.compare = !state.compare;
  else if (act === 'kind') { state.kind = v; state.shown = PAGE; }
  else if (act === 'more') state.shown += PAGE;
  else if (act === 'memoAdd') {
    const text = ($('#mText').value || '').trim(), date = $('#mDate').value;
    if (!text || !date) return;
    memos.push({ id: Date.now().toString(36), code: state.tab, date, text, created: Date.now() });
    store.set('kabu.memos', memos);
    state.draft.text = '';
    $('#mText').value = ''; // draw() が入力欄の内容を下書きに戻さないように
  } else if (act === 'memoDel') {
    if (!confirm('このメモを削除しますか？')) return;
    memos = memos.filter(m => m.id !== b.dataset.id);
    store.set('kabu.memos', memos);
  } else if (act === 'memoFrom') {
    const all = Object.values(state.news).flatMap(r => (r && r.items) || []);
    const n = all.find(x => x.id === b.dataset.id);
    if (!n) return;
    state.draft = { date: effDate(n), text: `【ニュース】${n.title}\n仮説：` };
  } else return;
  draw();
  if (act === 'memoFrom') { const t = $('#mText'); if (t) { t.scrollIntoView({ block: 'center' }); t.focus(); } }
});
document.addEventListener('change', ev => {
  const e = ev.target;
  if (e.dataset.lact) { if (window.KN.learn && window.KN.learn.change(e)) draw(); return; }
  if (e.dataset.act === 'tagSel') { tagOverride[e.dataset.id] = e.value; store.set('kabu.tags', tagOverride); draw(); }
  else if (e.id === 'mDate') state.draft.date = e.value;
  else if (e.id === 'pDays') state.pdraft.days = Number(e.value) || 5;
  else if (e.id === 'aiMode') state.ai.mode = e.value;
  else if (e.dataset.act === 'tagFilter') { state.tag = e.value; state.shown = PAGE; draw(); }
});

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ memos, tags: tagOverride, preds, ahp: store.get('kabu.ahp', null) }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'kabu-note-memos.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#importFile').addEventListener('change', async ev => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    const have = new Set(memos.map(m => m.id));
    (d.memos || []).forEach(m => { if (m && m.id && !have.has(m.id)) memos.push(m); });
    Object.assign(tagOverride, d.tags || {});
    const haveP = new Set(preds.map(p => p.id));
    (d.preds || []).forEach(p => { if (p && p.id && !haveP.has(p.id)) preds.push(p); });
    if (d.ahp && !store.get('kabu.ahp', null)) store.set('kabu.ahp', d.ahp);
    store.set('kabu.memos', memos); store.set('kabu.tags', tagOverride); store.set('kabu.preds', preds);
    draw();
    alert('読み込みました。');
  } catch (e) { alert('読み込めませんでした。'); }
  ev.target.value = '';
});
let rz, lastW = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastW) return;
  lastW = window.innerWidth;
  clearTimeout(rz); rz = setTimeout(draw, 200);
});

// 学習タブ（learn.js）から使う道具
window.KN = Object.assign(window.KN || {}, {
  state, store, $, esc, num, pct, cls, mean, mkSeries, firstOnOrAfter, lastOnOrBefore,
  reaction, effDate, tagOf, TAGS, KIND, DIRS, FLAT, ctxFor, predResult, retStats, draw,
  preds: () => preds,
});

load();
})();

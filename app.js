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
};

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
  const all = a.concat(b || []).filter(v => v != null);
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
    <div>終値 <b>${num(s.closes[i])}</b> <span class="${cls(prev)}">(前日比 ${pct(prev)})</span></div>
    <p class="sub">15:30以降に出たニュースと休日のニュースは、次の営業日に入ります。</p>
    ${day.length ? day.map(n => newsHtml(n, c)).join('') : '<div class="empty">この日のニュースは記録されていません。</div>'}
    ${ms.map(m => `<div class="memo"><span class="tag">メモ</span><p>${esc(m.text)}</p></div>`).join('')}</div>`;
}

function chartCard(id, title, c, extra) {
  return `<div class="card"><h2>${title}</h2>${extra || ''}
    <div class="row">${Object.keys(RANGES).map(r => `<button type="button" data-act="range" data-v="${r}" class="${state.range === r ? 'on' : ''}">${r}</button>`).join('')}
    ${c.mkt ? `<button type="button" data-act="cmp" class="${state.compare ? 'on' : ''}">市場と比較</button>` : ''}</div>
    <div class="readout" id="ro-${id}">&nbsp;</div><div class="chart" id="chart-${id}"></div>
    <div class="legend"><span><i class="dot" style="background:var(--accent)"></i>株価${state.compare && c.mkt ? '（開始日=100）' : ''}</span>
    ${state.compare && c.mkt ? '<span><i class="dot" style="background:var(--market)"></i>TOPIX連動ETF（開始日=100）</span>' : ''}
    <span><i class="dot" style="background:var(--news)"></i>ニュースあり</span><span><i class="dot" style="background:var(--memo)"></i>メモあり</span></div></div>`;
}

function mountChart(id, tab, c) {
  const s = c.series, from = rangeSlice(s);
  const dates = s.dates.slice(from), vals = s.closes.slice(from);
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
    let t = `${dates[i]}　終値 ${num(vals[i])}　前日比 <b class="${cls(prev)}">${pct(prev)}</b>`;
    if (state.compare && mkt) t += `　市場 ${num(mkt[i])}`;
    ro.innerHTML = t;
  };
  drawChart($('#chart-' + id), {
    dates, vals, mkt, compare: state.compare, markers,
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
    <div><span class="price">${num(s.closes[last])}</span><span class="chg ${cls(prev)}">${pct(prev)}</span></div>
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
    + `<div class="card"><h2>📊 ニュースのあとの値動き（タグ別の平均）</h2>${statsHtml(c)}</div>` + list + memoHtml(stock.code, c);
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
    + `<div id="selected">${selectedHtml('market', c)}</div>` + list + memoHtml('market', c);
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
  const y = window.scrollY;
  $('#tabs').innerHTML = tabsHtml();
  $('#updated').textContent = state.updated ? '更新 ' + state.updated.replace('T', ' ') : '';
  if (state.tab === 'add') { $('#view').innerHTML = addView(); window.scrollTo(0, y); return; }
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
  if (act === 'tab') { Object.assign(state, { tab: v, sel: null, kind: 'all', tag: 'all', shown: PAGE }); state.draft = { date: '', text: '' }; }
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
  if (e.dataset.act === 'tagSel') { tagOverride[e.dataset.id] = e.value; store.set('kabu.tags', tagOverride); draw(); }
  else if (e.id === 'mDate') state.draft.date = e.value;
  else if (e.dataset.act === 'tagFilter') { state.tag = e.value; state.shown = PAGE; draw(); }
});

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ memos, tags: tagOverride }, null, 1)], { type: 'application/json' });
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
    store.set('kabu.memos', memos); store.set('kabu.tags', tagOverride);
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

load();
})();

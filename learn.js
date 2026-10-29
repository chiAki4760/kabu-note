// 📐 学習タブ：放送大学「身近な統計」「問題解決の数理」の内容を、株ノートのデータで試す
(() => {
'use strict';
const K = () => window.KN;

// ---------- 状態（この端末に保存） ----------
const SAVE = 'kabu.learn';
const L = Object.assign({
  sec: 'dist', code: null, period: '1Y', x: 'topix', y: null, test: 'all',
  budget: 1000000, picks: null, horizon: 20, obj: 'mv', lam: 10,
}, load(SAVE, {}));
function load(key, def) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 保存できない環境では何もしない */ } }
const persist = () => save(SAVE, L);

// ---------- 小さな道具 ----------
const sum = a => a.reduce((s, v) => s + v, 0);
const avg = a => a.length ? sum(a) / a.length : null;
const sdev = a => { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(sum(a.map(v => (v - m) ** 2)) / (a.length - 1)); };
const p2 = v => v == null || !isFinite(v) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
const p1 = v => v == null || !isFinite(v) ? '—' : (v * 100).toFixed(1) + '%';
const yen = v => '¥' + Math.round(v).toLocaleString('ja-JP');
const f2 = v => v == null || !isFinite(v) ? '—' : v.toFixed(2);
const f3 = v => v == null || !isFinite(v) ? '—' : v.toFixed(3);
function quantile(sorted, p) { // 線形補間（Excel の QUARTILE.INC と同じ）
  const h = (sorted.length - 1) * p, lo = Math.floor(h);
  return lo + 1 < sorted.length ? sorted[lo] + (h - lo) * (sorted[lo + 1] - sorted[lo]) : sorted[lo];
}
const npdf = (x, m, s) => Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI));
// t分布の両側95%点（自由度1〜30）。31以上は1.96で近似
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131,
  2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
const t95 = df => df >= 1 && df <= 30 ? T95[df - 1] : 1.96;
function niceStep(range, count) {
  const raw = range / Math.max(1, count), e = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
}
const lecture = t => `<span class="lec">${t}</span>`;

// ---------- データ ----------
function keys(withIndex = true) {
  const st = K().state;
  const ks = st.cfg.stocks.map(s => s.code);
  return withIndex ? ks.concat(st.cfg.market.indices.map(i => i.key)) : ks;
}
function nameOf(k) {
  const st = K().state, s = st.cfg.stocks.find(x => x.code === k);
  if (s) return s.name;
  const i = st.cfg.market.indices.find(x => x.key === k);
  return i ? i.name : k;
}
const series = k => K().mkSeries(K().state.prices[k]);
const periodN = () => L.period === '1Y' ? 250 : 1e9;
// 毎日の騰落率（前日の終値からの変化率）
function rets(k) {
  const s = series(k), n = s.closes.length, out = { dates: [], r: [] };
  for (let i = Math.max(1, n - periodN()); i < n; i++) {
    if (s.closes[i - 1] > 0 && s.closes[i] > 0) { out.dates.push(s.dates[i]); out.r.push(s.closes[i] / s.closes[i - 1] - 1); }
  }
  return out;
}
// 複数の銘柄で、そろって値がある日だけの騰落率
function aligned(ks) {
  const maps = ks.map(k => { const r = rets(k), m = new Map(); r.dates.forEach((d, i) => m.set(d, r.r[i])); return m; });
  const dates = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
  return { dates, cols: maps.map(m => dates.map(d => m.get(d))) };
}
function describe(r) {
  const a = r.slice().sort((x, y) => x - y), n = a.length, m = avg(a), s = sdev(a);
  const m2 = sum(a.map(v => (v - m) ** 2)) / n, m3 = sum(a.map(v => (v - m) ** 3)) / n, m4 = sum(a.map(v => (v - m) ** 4)) / n;
  return { n, mean: m, sd: s, min: a[0], max: a[n - 1], q1: quantile(a, 0.25), med: quantile(a, 0.5), q3: quantile(a, 0.75),
    skew: m3 / Math.pow(m2, 1.5), kurt: m4 / (m2 * m2) - 3, sorted: a };
}
function periodLabel(dates) { return dates.length ? `${dates[0]}〜${dates[dates.length - 1]}（${dates.length}日）` : '—'; }
function newsOnDay(k, date) {
  const st = K().state, items = ((k === 'topix' || k === 'n225') ? st.news.market : st.news[k]);
  const s = series(k === 'n225' ? 'topix' : k);
  const i = s.dates.indexOf(date);
  return ((items && items.items) || []).filter(n => K().firstOnOrAfter(s.dates, K().effDate(n)) === i);
}

// ---------- SVG ----------
function svg(W, H, inner, label) { return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}" class="lsvg">${inner}</svg>`; }
const txt = (x, y, t, a = 'middle', extra = '') => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="10" fill="var(--sub)" text-anchor="${a}" ${extra}>${t}</text>`;
const ln = (x1, y1, x2, y2, c = 'var(--line)', w = 1, extra = '') => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${c}" stroke-width="${w}" ${extra}/>`;
function xTicks(lo, hi, X, H, B, fmt, count = 6) {
  const st = niceStep(hi - lo, count);
  let s = '';
  for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-12; v += st) s += ln(X(v), H - B, X(v), H - B + 4, 'var(--sub)') + txt(X(v), H - B + 15, fmt(v));
  return s;
}
function yTicks(lo, hi, Y, L0, R, W, fmt, count = 4) {
  const st = niceStep(hi - lo, count);
  let s = '';
  for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-12; v += st) s += ln(L0, Y(v), W - R, Y(v)) + txt(L0 - 4, Y(v) + 3, fmt(v), 'end');
  return s;
}
const pctTick = v => (Math.abs(v) < 1e-12 ? 0 : v * 100).toFixed(Math.abs(v) < 0.02 && v !== 0 ? 1 : 0) + '%';

// ================================================================
// 分布（身近な統計 第3〜5回、第8回）
// ================================================================
function histogram(r, d) {
  const W = 340, H = 220, L0 = 32, R = 8, T = 10, B = 30;
  let w = Math.max(0.0025, Math.round(d.sd / 2 / 0.0025) * 0.0025);
  while ((d.max - d.min) / w > 60) w *= 2;
  const lo = Math.floor(d.min / w) * w, hi = Math.ceil(d.max / w) * w + (d.max % w === 0 ? w : 0);
  const nb = Math.max(1, Math.round((hi - lo) / w)), cnt = new Array(nb).fill(0);
  r.forEach(v => { cnt[Math.min(nb - 1, Math.floor((v - lo) / w + 1e-9))]++; });
  const curve = [];
  for (let k = 0; k <= 120; k++) { const x = lo + (hi - lo) * k / 120; curve.push([x, d.n * w * npdf(x, d.mean, d.sd)]); }
  const ymax = Math.max(...cnt, ...curve.map(c => c[1])) * 1.08;
  const X = v => L0 + (W - L0 - R) * (v - lo) / (hi - lo), Y = v => T + (H - T - B) * (1 - v / ymax);
  let s = yTicks(0, ymax, Y, L0, R, W, v => Math.round(v));
  cnt.forEach((c, i) => {
    if (!c) return;
    const x0 = X(lo + i * w), x1 = X(lo + (i + 1) * w);
    s += `<rect x="${(x0 + 0.5).toFixed(1)}" y="${Y(c).toFixed(1)}" width="${Math.max(1, x1 - x0 - 1).toFixed(1)}" height="${(Y(0) - Y(c)).toFixed(1)}" fill="var(--accent)" opacity=".75"/>`;
  });
  s += `<path d="${curve.map((c, i) => (i ? 'L' : 'M') + X(c[0]).toFixed(1) + ' ' + Y(c[1]).toFixed(1)).join('')}" fill="none" stroke="var(--news)" stroke-width="2"/>`;
  s += ln(X(d.mean), T, X(d.mean), H - B, 'var(--text)', 1, 'stroke-dasharray="3 3"');
  s += ln(L0, H - B, W - R, H - B, 'var(--sub)') + xTicks(lo, hi, X, H, B, pctTick);
  return { svg: svg(W, H, s, '騰落率のヒストグラム'), w };
}

function boxplots(list) {
  const W = 340, rowH = 30, L0 = 92, R = 10, T = 6, B = 24, H = T + B + rowH * list.length;
  const lo = Math.min(...list.map(o => o.d.min)), hi = Math.max(...list.map(o => o.d.max));
  const X = v => L0 + (W - L0 - R) * (v - lo) / (hi - lo);
  let s = '';
  s += ln(X(0), T, X(0), H - B, 'var(--line)', 1);
  list.forEach((o, i) => {
    const d = o.d, y = T + rowH * i + rowH / 2, iqr = d.q3 - d.q1;
    const wl = d.sorted.find(v => v >= d.q1 - 1.5 * iqr), wh = [...d.sorted].reverse().find(v => v <= d.q3 + 1.5 * iqr);
    s += txt(L0 - 6, y + 3, o.name.length > 8 ? o.name.slice(0, 8) + '…' : o.name, 'end');
    s += ln(X(wl), y, X(d.q1), y, 'var(--sub)') + ln(X(d.q3), y, X(wh), y, 'var(--sub)');
    s += ln(X(wl), y - 5, X(wl), y + 5, 'var(--sub)') + ln(X(wh), y - 5, X(wh), y + 5, 'var(--sub)');
    s += `<rect x="${X(d.q1).toFixed(1)}" y="${y - 8}" width="${Math.max(1, X(d.q3) - X(d.q1)).toFixed(1)}" height="16" fill="var(--accent)" fill-opacity=".18" stroke="var(--accent)"/>`;
    s += ln(X(d.med), y - 8, X(d.med), y + 8, 'var(--accent)', 2);
    d.sorted.filter(v => v < wl || v > wh).forEach(v => { s += `<circle cx="${X(v).toFixed(1)}" cy="${y}" r="2" fill="var(--news)"/>`; });
  });
  s += ln(L0, H - B, W - R, H - B, 'var(--sub)') + xTicks(lo, hi, X, H, B, pctTick, 5);
  return svg(W, H, s, '箱ひげ図');
}

function distView() {
  const k = L.code && keys().includes(L.code) ? L.code : keys()[0];
  L.code = k;
  const R = rets(k);
  if (R.r.length < 30) return '<div class="card">データが足りません。</div>';
  const d = describe(R.r), h = histogram(R.r, d);
  const within1 = R.r.filter(v => Math.abs(v - d.mean) <= d.sd).length / d.n;
  const zc = [1, 2, 3].map(t => R.r.filter(v => Math.abs((v - d.mean) / d.sd) >= t).length);
  const normP = [0.3173, 0.0455, 0.0027];
  const heavy = zc[2] > d.n * normP[2] * 2;
  const mkt = rets('topix'), mm = new Map(mkt.dates.map((x, i) => [x, mkt.r[i]]));
  const top = R.r.map((v, i) => ({ d: R.dates[i], v, z: (v - d.mean) / d.sd })).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 8);
  const isIndex = !K().state.cfg.stocks.some(s => s.code === k);
  const topRows = top.map(t => {
    const ns = newsOnDay(k, t.d);
    const title = ns.length ? K().esc(ns[0].title.length > 34 ? ns[0].title.slice(0, 34) + '…' : ns[0].title) + (ns.length > 1 ? ` ほか${ns.length - 1}件` : '') : '<span class="sub">記録なし</span>';
    const jump = isIndex ? t.d : `<button type="button" class="link" data-act="Ljump" data-code="${k}" data-date="${t.d}">${t.d}</button>`;
    return `<tr><td>${jump}</td><td class="${K().cls(t.v)}">${p2(t.v)}</td><td>${f2(t.z)}</td><td>${k === 'topix' ? '' : p2(mm.get(t.d))}</td><td class="l">${title}</td></tr>`;
  }).join('');
  const opts = keys().map(x => `<option value="${x}"${x === k ? ' selected' : ''}>${K().esc(nameOf(x))}</option>`).join('');
  const all = keys().map(x => ({ name: nameOf(x), d: describe(rets(x).r) })).filter(o => o.d.n > 30);

  return `<div class="card"><h2>毎日の騰落率の分布 ${lecture('身近な統計 第3〜5回')}</h2>
    <div class="row"><select data-lact="Lcode" aria-label="銘柄">${opts}</select>${periodBtns()}</div>
    <p class="sub">期間：${periodLabel(R.dates)}。1日ごとの「前日の終値からの変化率」を集めて、度数分布（ヒストグラム）にしました。オレンジの線は、平均と標準偏差が同じ正規分布です。点線は平均です。</p>
    ${h.svg}
    <p class="sub">階級の幅は ${(h.w * 100).toFixed(2)}%（標準偏差の約半分）です。</p>
    <table class="kv">
      <tr><th>日数</th><td>${d.n}</td><th>平均</th><td>${p2(d.mean)}</td></tr>
      <tr><th>中央値</th><td>${p2(d.med)}</td><th>標準偏差</th><td>${p2(d.sd).replace('+', '')}</td></tr>
      <tr><th>最小</th><td>${p2(d.min)}</td><th>最大</th><td>${p2(d.max)}</td></tr>
      <tr><th>第1四分位</th><td>${p2(d.q1)}</td><th>第3四分位</th><td>${p2(d.q3)}</td></tr>
      <tr><th>歪度</th><td>${f2(d.skew)}</td><th>尖度</th><td>${f2(d.kurt)}</td></tr>
    </table>
    <p class="sub">標準偏差は不偏分散（n−1で割る）から求めています。四分位数は Excel の QUARTILE.INC と同じ計算です。尖度は正規分布を0とした値（超過尖度）で、プラスが大きいほど「ふだんは小さく動き、ときどき大きく動く」分布です。</p>
    <p>平均±1標準偏差（${p2(d.mean - d.sd)}〜${p2(d.mean + d.sd)}）に入った日は <b>${p1(within1)}</b> でした。正規分布なら約68%です。</p></div>

  <div class="card"><h2>zスコアで見る「珍しい動き」 ${lecture('身近な統計 第5・8回')}</h2>
    <p class="sub">z ＝（その日の騰落率 − 平均）÷ 標準偏差。平均から標準偏差の何倍離れているかを表します。</p>
    <table><tr><th>動きの大きさ</th><th>実際の日数</th><th>割合</th><th>正規分布なら</th></tr>
      ${[0, 1, 2].map(i => `<tr><td>|z| ≥ ${i + 1}</td><td>${zc[i]}日</td><td>${p1(zc[i] / d.n)}</td><td>${p1(normP[i])}（${(d.n * normP[i]).toFixed(1)}日）</td></tr>`).join('')}</table>
    <p>${heavy ? `|z|≥3 の日が、正規分布の予想（${(d.n * normP[2]).toFixed(1)}日）より多く <b>${zc[2]}日</b> ありました。株価では、正規分布が考えるより極端な動きが起きやすいことが知られています（「裾が厚い」と言います）。` : `|z|≥3 の日は ${zc[2]}日で、正規分布の予想（${(d.n * normP[2]).toFixed(1)}日）と大きくは違いません。`}</p>
    <h3>大きく動いた日（|z| の大きい順）</h3>
    <div class="scroll"><table><tr><th>日付</th><th>騰落率</th><th>z</th><th>${k === 'topix' ? '' : '市場'}</th><th class="l">その日のニュース</th></tr>${topRows}</table></div>
    <p class="sub">${isIndex ? '' : '日付をタップすると、その日のチャートとニュースを開きます。'}市場も同じ日に大きく動いていれば、ニュースより市場全体の影響が大きかった可能性があります。</p></div>

  <div class="card"><h2>箱ひげ図で比べる ${lecture('身近な統計 第4回')}</h2>
    <p class="sub">箱は第1〜第3四分位、箱の中の線は中央値、ひげは箱の端から四分位範囲の1.5倍までに入る最小・最大、オレンジの点はそれより外の値（外れ値）です。期間：${L.period === '1Y' ? '直近1年' : '全部'}。</p>
    ${boxplots(all)}
    <table><tr><th>銘柄</th><th>標準偏差</th><th>四分位範囲</th><th>外れ値</th></tr>
    ${all.map(o => { const iqr = o.d.q3 - o.d.q1; return `<tr><td>${K().esc(o.name)}</td><td>${p2(o.d.sd).replace('+', '')}</td><td>${p2(iqr).replace('+', '')}</td><td>${o.d.sorted.filter(v => v < o.d.q1 - 1.5 * iqr || v > o.d.q3 + 1.5 * iqr).length}日</td></tr>`; }).join('')}</table></div>`;
}
function periodBtns() {
  return ['1Y', '全部'].map(p => `<button type="button" data-act="Lperiod" data-v="${p}" class="${L.period === p ? 'on' : ''}">${p === '1Y' ? '直近1年' : '全部（約2年）'}</button>`).join('');
}

// ================================================================
// 相関・回帰（身近な統計 第13回、問題解決の数理 第13回）
// ================================================================
function regress(x, y) {
  const mx = avg(x), my = avg(y);
  let sxy = 0, sxx = 0, syy = 0;
  x.forEach((v, i) => { sxy += (v - mx) * (y[i] - my); sxx += (v - mx) ** 2; syy += (y[i] - my) ** 2; });
  const b = sxy / sxx, a = my - b * mx, r = sxy / Math.sqrt(sxx * syy);
  return { a, b, r, r2: r * r, n: x.length };
}
function scatter(x, y, g) {
  const W = 340, H = 300, L0 = 36, R = 10, T = 10, B = 30;
  const ext = a => { const s = a.slice().sort((p, q) => p - q); return [s[0], s[s.length - 1]]; };
  const [x0, x1] = ext(x), [y0, y1] = ext(y);
  const px = (x1 - x0) * 0.05, py = (y1 - y0) * 0.05;
  const lx = x0 - px, hx = x1 + px, ly = y0 - py, hy = y1 + py;
  const X = v => L0 + (W - L0 - R) * (v - lx) / (hx - lx), Y = v => T + (H - T - B) * (1 - (v - ly) / (hy - ly));
  let s = yTicks(ly, hy, Y, L0, R, W, pctTick, 5);
  if (lx < 0 && hx > 0) s += ln(X(0), T, X(0), H - B, 'var(--sub)', 1, 'opacity=".5"');
  x.forEach((v, i) => { s += `<circle cx="${X(v).toFixed(1)}" cy="${Y(y[i]).toFixed(1)}" r="2.2" fill="var(--accent)" opacity=".45"/>`; });
  const yl = g.a + g.b * lx, yh = g.a + g.b * hx;
  s += `<line x1="${X(lx)}" y1="${Y(yl)}" x2="${X(hx)}" y2="${Y(yh)}" stroke="var(--news)" stroke-width="2" clip-path="url(#clipS)"/>`;
  s += `<clipPath id="clipS"><rect x="${L0}" y="${T}" width="${W - L0 - R}" height="${H - T - B}"/></clipPath>`;
  s += ln(L0, H - B, W - R, H - B, 'var(--sub)') + xTicks(lx, hx, X, H, B, pctTick, 5);
  return svg(W, H, s, '散布図');
}
function corrView() {
  const ks = keys();
  if (!ks.includes(L.x)) L.x = 'topix';
  if (!L.y || !ks.includes(L.y) || L.y === L.x) L.y = ks.find(k => k !== L.x);
  const A = aligned([L.x, L.y]), x = A.cols[0], y = A.cols[1];
  if (x.length < 20) return '<div class="card">データが足りません。</div>';
  const g = regress(x, y);
  const sel = (act, v) => `<select data-lact="${act}">${ks.map(k => `<option value="${k}"${k === v ? ' selected' : ''}>${K().esc(nameOf(k))}</option>`).join('')}</select>`;
  const strength = r => { const a = Math.abs(r); return a >= 0.7 ? '強い' : a >= 0.4 ? '中くらいの' : a >= 0.2 ? '弱い' : 'ほとんどない'; };
  const isMkt = L.x === 'topix' || L.x === 'n225';
  // 相関行列
  const M = aligned(ks), n = ks.length;
  const R = ks.map((_, i) => ks.map((__, j) => regress(M.cols[i], M.cols[j]).r));
  const cell = v => `<td style="background:rgba(31,95,168,${(Math.abs(v) * 0.55).toFixed(2)})">${f2(v)}</td>`;
  const short = k => { const s = nameOf(k); return s.length > 5 ? s.slice(0, 5) : s; };
  return `<div class="card"><h2>散布図と回帰直線 ${lecture('身近な統計 第13回／問題解決の数理 第13回')}</h2>
    <div class="row"><span class="sub">横軸(x)</span>${sel('Lx', L.x)}</div>
    <div class="row" style="margin-top:4px"><span class="sub">縦軸(y)</span>${sel('Ly', L.y)}</div>
    <div class="row" style="margin-top:4px">${periodBtns()}</div>
    <p class="sub">1つの点が1日です。両方に値がある ${g.n}日（${A.dates[0]}〜${A.dates[A.dates.length - 1]}）の騰落率を並べました。オレンジの線は最小二乗法で求めた回帰直線です。</p>
    ${scatter(x, y, g)}
    <table class="kv">
      <tr><th>相関係数 r</th><td>${f3(g.r)}</td><th>寄与率 R²</th><td>${f3(g.r2)}</td></tr>
      <tr><th>回帰直線</th><td colspan="3">y ＝ ${(g.a * 100).toFixed(3)}% ＋ ${g.b.toFixed(3)} × x</td></tr>
    </table>
    <p>${K().esc(nameOf(L.x))}と${K().esc(nameOf(L.y))}の間には<b>${strength(g.r)}${g.r >= 0 ? '正の' : '負の'}相関</b>があります（r＝${f2(g.r)}）。
      ${K().esc(nameOf(L.x))}が1%動いた日、${K().esc(nameOf(L.y))}は平均して約${g.b.toFixed(2)}%動いています。</p>
    ${isMkt ? `<p class="sub">x が市場のとき、傾き（${g.b.toFixed(2)}）を<b>β（ベータ）</b>と呼びます。1より大きければ市場より大きく動きやすい銘柄です。寄与率 ${p1(g.r2)} は「毎日の動きのうち、市場の動きで説明できる割合」の目安で、残りの ${p1(1 - g.r2)} はその会社のニュースなど、市場以外の要因です。</p>` : '<p class="sub">似た業種の銘柄どうしは相関が高くなりやすく、両方を持っても値動きのばらつきはあまり減りません（「配分の最適化」で確かめられます）。</p>'}
    <p class="sub">相関があっても、片方がもう片方の原因とは限りません。どちらも市場全体の動きに引っぱられているだけ、ということもあります。</p></div>
  <div class="card"><h2>相関係数の一覧</h2>
    <p class="sub">すべての銘柄に値がある ${M.dates.length}日で計算。色が濃いほど相関が強いことを表します。</p>
    <div class="scroll"><table class="mat"><tr><th></th>${ks.map(k => `<th>${K().esc(short(k))}</th>`).join('')}</tr>
    ${ks.map((k, i) => `<tr><th>${K().esc(short(k))}</th>${R[i].map(cell).join('')}</tr>`).join('')}</table></div></div>`;
}

// ================================================================
// 検定（身近な統計 第7・10・11回）
// ================================================================
const condOf = (dir, c) => dir === 'up' ? c > 0 : dir === 'down' ? c < 0 : Math.abs(c) <= K().FLAT;
// 予測した日より前のデータで、その予測（方向と期間）が当たる割合＝偶然でも当たる確率の目安
function baseRate(p) {
  const s = K().ctxFor(p.code).series, end = K().lastOnOrBefore(s.dates, p.date);
  let n = 0, h = 0;
  for (let i = 0; i + p.days <= end; i++) { n++; if (condOf(p.dir, s.closes[i + p.days] / s.closes[i] - 1)) h++; }
  return n ? h / n : null;
}
function binom(n, q) {
  const pmf = new Array(n + 1).fill(0);
  if (q <= 0) { pmf[0] = 1; return pmf; }
  if (q >= 1) { pmf[n] = 1; return pmf; }
  let lp = n * Math.log(1 - q);
  pmf[0] = Math.exp(lp);
  for (let k = 0; k < n; k++) { lp += Math.log((n - k) / (k + 1)) + Math.log(q / (1 - q)); pmf[k + 1] = Math.exp(lp); }
  return pmf;
}
function binomChart(pmf, hits) {
  const n = pmf.length - 1, W = 340, H = 160, L0 = 30, R = 8, T = 8, B = 26;
  const ymax = Math.max(...pmf) * 1.1, bw = (W - L0 - R) / (n + 1);
  const X = k => L0 + bw * k, Y = v => T + (H - T - B) * (1 - v / ymax);
  let s = yTicks(0, ymax, Y, L0, R, W, v => (v * 100).toFixed(0) + '%', 3);
  pmf.forEach((v, k) => { s += `<rect x="${(X(k) + 1).toFixed(1)}" y="${Y(v).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${(Y(0) - Y(v)).toFixed(1)}" fill="${k >= hits ? 'var(--news)' : 'var(--market)'}" opacity=".85"/>`; });
  const step = Math.max(1, Math.ceil((n + 1) / 12));
  for (let k = 0; k <= n; k += step) s += txt(X(k) + bw / 2, H - B + 14, k);
  s += ln(L0, H - B, W - R, H - B, 'var(--sub)');
  return svg(W, H, s, '二項分布');
}
function testView() {
  const KN = K();
  // ---- 予測の当たり ----
  const ps = KN.preds().map(p => ({ p, r: KN.predResult(p, KN.ctxFor(p.code)) })).filter(o => o.r && o.r.done);
  let predHtml;
  if (!ps.length) {
    predHtml = `<p>答え合わせが済んだ予測はまだありません。各銘柄の「🎯 予測と答え合わせ」で予測を残すと、期間がたったものからここで集計されます。</p>
      <p class="sub">ここでは「予測が当たった回数は、偶然（でたらめ）に予測した場合と比べて多いと言えるか」を二項分布で調べます。10件くらいたまると、意味のある比較になってきます。</p>`;
  } else {
    const n = ps.length, hits = ps.filter(o => o.r.hit).length;
    const rates = ps.map(o => baseRate(o.p)).filter(v => v != null), q = avg(rates);
    const pmf = binom(n, q), pval = sum(pmf.slice(hits));
    predHtml = `<table class="kv"><tr><th>答え合わせ済み</th><td>${n}件</td><th>当たり</th><td>${hits}件（${p1(hits / n)}）</td></tr>
      <tr><th>偶然で当たる確率 q</th><td>${p1(q)}</td><th>偶然なら平均</th><td>${(n * q).toFixed(1)}件</td></tr>
      <tr><th>p値</th><td colspan="3">${pval < 0.001 ? '0.001未満' : f3(pval)}（偶然だけで ${hits}件以上当たる確率）</td></tr></table>
      ${binomChart(pmf, hits)}
      <p class="sub">グラフは、当たる確率が q の予測を ${n}回したときの当たり数の分布（二項分布）です。オレンジが「実際の当たり数以上」の部分で、その合計が p値です。</p>
      <p>${n < 10 ? 'まだ件数が少ないので、はっきりしたことは言えません。' : ''}${pval < 0.05 ? `p値が0.05より小さいので、有意水準5%で「偶然だけでは説明しにくい」と言えます。` : `p値が0.05以上なので、「偶然でも起こりうる範囲」です（予測の力がない、と決まったわけではありません）。`}</p>
      <p class="sub">q は、それぞれの予測について「予測した日より前のデータで、同じ方向・同じ期間の予測が当たっていた割合」を平均したものです。たとえば上がる日が多かった銘柄では、「上がる」と言うだけでも当たりやすいので、その分を差し引いて比べるためです。</p>`;
  }
  // ---- タグ別の信頼区間 ----
  const stocks = KN.state.cfg.stocks.map(s => s.code);
  if (L.test !== 'all' && !stocks.includes(L.test)) L.test = 'all';
  const target = L.test === 'all' ? stocks : [L.test];
  const rows = {}, seen = new Set();
  target.forEach(code => {
    const c = KN.ctxFor(code), s = c.series;
    c.news.forEach(n => {
      const eff = KN.effDate(n), r = KN.reaction(s, eff), m = c.mkt ? KN.reaction(c.mkt, eff) : null;
      if (!r || r.r5 == null || !m || m.r5 == null) return;
      const day = s.dates[r.idx], ex = r.r5 - m.r5, tag = KN.tagOf(n);
      [[tag, `${code}|${day}|${tag}`], ['全体', `${code}|${day}`]].forEach(([k, key]) => {
        if (seen.has(key)) return;
        seen.add(key);
        (rows[k] = rows[k] || []).push(ex);
      });
    });
  });
  const order = ['全体'].concat(KN.TAGS).filter(k => rows[k]);
  const trs = order.map(k => {
    const a = rows[k], n = a.length, m = avg(a), sd = sdev(a);
    if (n < 2) return `<tr><td class="l">${k}</td><td>${n}</td><td>${p2(m)}</td><td colspan="3" class="sub">2日以上で計算</td></tr>`;
    const se = sd / Math.sqrt(n), t = t95(n - 1), lo = m - t * se, hi = m + t * se;
    const verdict = lo > 0 ? '<b class="up">プラス</b>' : hi < 0 ? '<b class="down">マイナス</b>' : '区別できない';
    return `<tr><td class="l">${k}</td><td>${n}</td><td class="${KN.cls(m)}">${p2(m)}</td><td>${p2(se).replace('+', '')}</td><td>${p2(lo)}<br>〜${p2(hi)}</td><td>${verdict}</td></tr>`;
  }).join('');
  const opts = `<option value="all"${L.test === 'all' ? ' selected' : ''}>すべての銘柄をまとめる</option>` + stocks.map(c => `<option value="${c}"${L.test === c ? ' selected' : ''}>${KN.esc(nameOf(c))}</option>`).join('');
  return `<div class="card"><h2>予測は偶然より当たっているか ${lecture('身近な統計 第7・11回')}</h2>${predHtml}</div>
  <div class="card"><h2>ニュースのあとの値動きは0と区別できるか ${lecture('身近な統計 第10・11回')}</h2>
    <div class="row"><select data-lact="Ltest">${opts}</select></div>
    <p class="sub">ニュースのあと5営業日の「市場比」（銘柄の変化 − 市場の変化）の平均と、その95%信頼区間です。区間が0をまたいでいれば、「平均は0（市場と同じ）」という帰無仮説を有意水準5%で否定できません。</p>
    ${order.length ? `<div class="scroll"><table><tr><th class="l">タグ</th><th>日数</th><th>平均</th><th>標準誤差</th><th>95%信頼区間</th><th>判定</th></tr>${trs}</table></div>` : '<div class="empty">5営業日分の値動きがそろったニュースがまだありません。</div>'}
    <p class="sub">判定の「プラス／マイナス」は、区間全体が0より上／下にあり、市場と比べて平均的に上がった／下がったと言えることを表します。同じ日に同じタグのニュースが何件あっても、値動きは同じなので1日として数えています。信頼区間は t分布（自由度30以下）または 1.96（31以上）で求めました。ただし、近い日どうしの5日間は期間が重なっていて、データが互いに独立という前提が完全には成り立たないため、区間は実際より狭めに出ている可能性があります。タグは自動判定なので、ずれていることもあります。</p></div>`;
}

// ================================================================
// 配分の最適化（問題解決の数理 第1・2・9・12・14回）
// ================================================================
function projCappedSimplex(v) { // {w ≥ 0, Σw ≤ 1} への射影
  const c = v.map(x => Math.max(0, x));
  if (sum(c) <= 1) return c;
  const u = v.slice().sort((a, b) => b - a);
  let css = 0, theta = 0;
  u.forEach((x, i) => { css += x; const t = (css - 1) / (i + 1); if (x - t > 0) theta = t; });
  return v.map(x => Math.max(0, x - theta));
}
function quad(S, w) { let q = 0; for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) q += w[i] * S[i][j] * w[j]; return q; }
function contSolve(mu, S, lam) { // 最急降下法（射影つき）で連続の最適解を求める
  const n = mu.length, tr = sum(S.map((r, i) => r[i]));
  const step = lam > 0 ? 1 / (lam * tr) : 1000;
  let w = new Array(n).fill(0), it = 0;
  for (; it < 20000; it++) {
    const g = mu.map((m, i) => m - lam * sum(S[i].map((s, j) => s * w[j])));
    const nw = projCappedSimplex(w.map((x, i) => x + step * g[i]));
    const diff = Math.max(...nw.map((x, i) => Math.abs(x - w[i])));
    w = nw;
    if (diff < 1e-10) break;
  }
  return { w, it: it + 1 };
}
function optimize() {
  const KN = K(), stocks = KN.state.cfg.stocks.map(s => s.code);
  let picks = (L.picks || stocks.slice(0, 3)).filter(c => stocks.includes(c));
  if (!picks.length) picks = stocks.slice(0, 3);
  L.picks = picks;
  const A = aligned(picks);
  const B = Math.max(0, Number(L.budget) || 0), H = Number(L.horizon) || 20, lam = L.obj === 'lin' ? 0 : Number(L.lam);
  const price = picks.map(c => { const s = series(c); return s.closes[s.closes.length - 1]; });
  const unit = price.map(p => p * 100);
  const n = picks.length;
  const mu1 = A.cols.map(avg), N = A.dates.length;
  const S1 = A.cols.map((a, i) => A.cols.map((b, j) => { const ma = mu1[i], mb = mu1[j]; return sum(a.map((v, k) => (v - ma) * (b[k] - mb))) / (N - 1); }));
  const mu = mu1.map(v => v * H), S = S1.map(r => r.map(v => v * H));
  const evalLots = lots => {
    const amt = lots.map((k, i) => k * unit[i]), w = amt.map(a => B ? a / B : 0);
    const E = sum(w.map((x, i) => x * mu[i])), V = quad(S, w);
    return { lots, amt, cash: B - sum(amt), E, sd: Math.sqrt(Math.max(0, V)), U: E - lam / 2 * V };
  };
  const maxL = unit.map(u => Math.floor(B / u));
  const space = maxL.reduce((p, m) => p * (m + 1), 1);
  const res = { picks, price, unit, mu, S, mu1, N, A, B, H, lam, maxL, space };
  if (N < 30) { res.err = 'データがそろっている日が少なすぎます。'; return res; }
  if (space > 3e6) { res.err = '組み合わせが多すぎて、この端末で全部を調べると時間がかかりすぎます。資金を減らすか、銘柄を減らしてください。'; return res; }
  // 全探索：予算内のすべての単元数の組み合わせを調べる
  let best = null, count = 0;
  const pts = [], lots = new Array(n).fill(0);
  (function rec(i, rest) {
    if (i === n) {
      const o = evalLots(lots.slice()); count++;
      if (!best || o.U > best.U + 1e-15) best = o;
      pts.push([o.sd, o.E]);
      return;
    }
    for (let k = 0; k * unit[i] <= rest + 1e-6; k++) { lots[i] = k; rec(i + 1, rest - k * unit[i]); }
    lots[i] = 0;
  })(0, B);
  // 欲張り法：1円あたりの効用の増え方が一番大きい銘柄を、1単元ずつ買い足す
  const g = new Array(n).fill(0);
  let cur = evalLots(g.slice()), steps = 0;
  for (;;) {
    let bi = -1, bv = 0;
    for (let i = 0; i < n; i++) {
      if (sum(g.map((k, j) => k * unit[j])) + unit[i] > B + 1e-6) continue;
      const t = g.slice(); t[i]++;
      const v = (evalLots(t).U - cur.U) / unit[i];
      if (v > bv + 1e-18) { bv = v; bi = i; }
    }
    if (bi < 0) break;
    g[bi]++; cur = evalLots(g.slice()); steps++;
  }
  // 連続緩和（端数の株も買えるとしたら）
  const cs = contSolve(mu, S, lam);
  const cw = cs.w, cV = quad(S, cw), cE = sum(cw.map((x, i) => x * mu[i]));
  Object.assign(res, { best, greedy: cur, count, pts, cont: { w: cw, E: cE, sd: Math.sqrt(cV), U: cE - lam / 2 * cV, it: cs.it, amt: cw.map(x => x * B) } });
  return res;
}
function frontierChart(o) {
  const W = 340, H = 240, L0 = 40, R = 10, T = 10, B = 30;
  let pts = o.pts;
  if (pts.length > 4000) { const st = Math.ceil(pts.length / 4000); pts = pts.filter((_, i) => i % st === 0); }
  const marks = [[o.cont.sd, o.cont.E], [o.greedy.sd, o.greedy.E], [o.best.sd, o.best.E]];
  const all = pts.concat(marks);
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const lx = 0, hx = Math.max(...xs) * 1.08 || 0.01;
  let ly = Math.min(0, ...ys), hy = Math.max(0, ...ys);
  const pad = (hy - ly) * 0.08 || 0.005; ly -= pad; hy += pad;
  const X = v => L0 + (W - L0 - R) * (v - lx) / (hx - lx), Y = v => T + (H - T - B) * (1 - (v - ly) / (hy - ly));
  let s = yTicks(ly, hy, Y, L0, R, W, pctTick, 5);
  s += ln(L0, Y(0), W - R, Y(0), 'var(--sub)', 1, 'opacity=".6"');
  pts.forEach(p => { s += `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="1.6" fill="var(--market)" opacity=".5"/>`; });
  s += `<path d="M${X(o.cont.sd).toFixed(1)} ${(Y(o.cont.E) - 7).toFixed(1)}l6 10h-12z" fill="var(--memo)"/>`;
  s += `<rect x="${(X(o.greedy.sd) - 5).toFixed(1)}" y="${(Y(o.greedy.E) - 5).toFixed(1)}" width="10" height="10" fill="none" stroke="var(--news)" stroke-width="2"/>`;
  s += `<circle cx="${X(o.best.sd).toFixed(1)}" cy="${Y(o.best.E).toFixed(1)}" r="5" fill="var(--accent)"/>`;
  s += ln(L0, H - B, W - R, H - B, 'var(--sub)') + xTicks(lx, hx, X, H, B, pctTick, 5);
  return svg(W, H, s, 'リスクとリターン');
}
function optView() {
  const KN = K(), stocks = KN.state.cfg.stocks.map(s => s.code), o = optimize();
  const picks = o.picks;
  const checks = stocks.map(c => `<label class="chk"><input type="checkbox" data-lact="Lpick" value="${c}"${picks.includes(c) ? ' checked' : ''}> ${KN.esc(nameOf(c))}</label>`).join('');
  const objBtn = (v, lb) => `<button type="button" data-act="Lobj" data-v="${v}" class="${L.obj === v ? 'on' : ''}">${lb}</button>`;
  const hz = [[20, '約1か月（20営業日）'], [60, '約3か月（60営業日）'], [250, '約1年（250営業日）']].map(([v, lb]) => `<option value="${v}"${Number(L.horizon) === v ? ' selected' : ''}>${lb}</option>`).join('');
  const head = `<div class="card"><h2>資金の配分を最適化する ${lecture('問題解決の数理 第1・2・9・12・14回')}</h2>
    <p class="sub">手持ちの資金の範囲で、選んだ銘柄を何単元（1単元＝100株）ずつ買えば効用が最大になるかを求めます。各銘柄の期待リターンとばらつきは、過去の毎日の騰落率から推定します。</p>
    <label class="sub">資金（円）<br><input type="number" inputmode="numeric" step="10000" min="0" data-lact="Lbudget" value="${o.B}"></label>
    <div class="sub" style="margin-top:6px">銘柄</div><div class="row">${checks}</div>
    <div class="sub" style="margin-top:6px">推定に使う期間</div><div class="row">${periodBtns()}</div>
    <label class="sub" style="display:block;margin-top:6px">見通す期間<br><select data-lact="Lhorizon">${hz}</select></label>
    <div class="sub" style="margin-top:6px">効用（目的関数）</div><div class="row">${objBtn('lin', '期待リターン最大（線形）')}${objBtn('mv', '期待リターン − λ×ばらつき（非線形）')}</div>
    ${L.obj === 'mv' ? `<label class="sub" style="display:block;margin-top:6px">λ（リスクをどれだけ嫌うか）：<b>${o.lam}</b><br><input type="range" min="0" max="60" step="1" data-lact="Llam" value="${o.lam}" style="width:100%"></label>` : ''}
    </div>`;
  if (!picks.length) return head + '<div class="card">銘柄を1つ以上選んでください。</div>';
  const estRows = picks.map((c, i) => `<tr><td class="l">${KN.esc(nameOf(c))}</td><td>${KN.num(o.price[i])}</td><td>${yen(o.unit[i])}</td><td class="${KN.cls(o.mu[i])}">${p2(o.mu[i])}</td><td>${p2(Math.sqrt(o.S[i][i])).replace('+', '')}</td><td>${o.maxL[i]}</td></tr>`).join('');
  const est = `<div class="card"><h2>推定した値（${o.H}営業日あたり）</h2>
    <p class="sub">「上限」は資金だけで買える最大の単元数です。${o.A.dates[0]}〜${o.A.dates[o.A.dates.length - 1]} の ${o.N}日分から計算。期待リターン＝毎日の平均×${o.H}、ばらつき（標準偏差）＝毎日の標準偏差×√${o.H} です（毎日の動きが互いに独立と仮定）。</p>
    <div class="scroll"><table><tr><th class="l">銘柄</th><th>株価</th><th>1単元</th><th>期待リターン</th><th>標準偏差</th><th>上限</th></tr>${estRows}</table></div></div>`;
  if (o.err) return head + est + `<div class="card">${o.err}</div>`;
  if (o.maxL.every(m => m === 0)) return head + est + `<div class="card">この資金では、どの銘柄も1単元（100株）買えません。資金を増やすか、株価の低い銘柄を選んでください。</div>`;
  const U = v => (v * 100).toFixed(2);
  const methods = [['<b>全探索</b>', o.best, false], ['欲張り法', o.greedy, false], ['連続緩和', o.cont, true]];
  const short = c => { const nm = nameOf(c); return KN.esc(nm.length > 5 ? nm.slice(0, 5) : nm); };
  const lotsTable = `<table><tr><th class="l">買う量</th>${picks.map(c => `<th>${short(c)}</th>`).join('')}</tr>
    ${methods.map(([lb, r, isCont]) => `<tr><td class="l">${lb}</td>${picks.map((_, i) => `<td>${isCont ? `${(r.w[i] * 100).toFixed(1)}%` : `${r.lots[i]}単元`}<br><span class="sub">${yen(isCont ? r.amt[i] : r.amt[i])}</span></td>`).join('')}</tr>`).join('')}</table>`;
  const sumTable = `<table><tr><th class="l">方法</th><th>現金</th><th>期待<br>リターン</th><th>標準<br>偏差</th><th>効用</th></tr>
    ${methods.map(([lb, r, isCont]) => `<tr><td class="l">${lb}</td><td>${yen(isCont ? o.B * (1 - sum(r.w)) : r.cash)}</td><td class="${KN.cls(r.E)}">${p2(r.E)}<br><span class="sub">${yen(r.E * o.B)}</span></td><td>${p2(r.sd).replace('+', '')}</td><td>${U(r.U)}</td></tr>`).join('')}</table>`;
  const same = o.greedy.lots.every((k, i) => k === o.best.lots[i]);
  const linNote = L.obj === 'lin'
    ? `<p>線形の効用では、期待リターンが一番高い銘柄だけに資金を集める答えになりやすい（${o.cont.w.filter(x => x > 1e-6).length <= 1 ? '連続で解いた答えも1銘柄に集中' : ''}）ことを確かめてみましょう。線形最適化では、最適解が実行可能領域の「端の点（頂点）」に出るためです。期待リターンがすべてマイナスなら、何も買わない（現金のまま）のが最適になります。</p>`
    : `<p>λ を 0 にすると線形と同じになり、λ を大きくするほどばらつきの小さい組み合わせが選ばれます。λ を動かして、最適な組み合わせ（青い点）が散布図の上をどう移るか見てみましょう。</p>`;
  const result = `<div class="card"><h2>結果</h2>
    <div class="scroll">${lotsTable}</div>
    <div class="scroll" style="margin-top:8px">${sumTable}</div>
    <p class="sub">効用 ＝ 期待リターン${o.lam ? ` − ${o.lam}/2 × 分散` : ''}（%で表示）。期待リターンと標準偏差は資金全体に対する割合で、現金のリターンは0としています。</p>
    <p><b>全探索</b>：予算内に収まる単元数の組み合わせ ${o.count.toLocaleString()}通りをすべて調べて、効用が最大のものを選びました（組み合わせ最適化、第14回）。組み合わせが多い問題では、分枝限定法で見込みのない枝を切りながら探します。</p>
    <p><b>欲張り法</b>：何も持っていない状態から、「1円あたりの効用の増え方」が一番大きい銘柄を1単元ずつ買い足し、増えなくなったら止めます（${o.greedy.lots.reduce((a, b) => a + b, 0)}回）。${same ? '今回は最適解と同じ答えになりました。' : '<b>今回は最適解と違う答えになりました。</b>その場その場で一番よいものを選んでも、全体で一番よいとは限らない例です。'}</p>
    <p><b>連続緩和</b>：100株単位の制約をなくし、端数の株も買えるとして解いた答えです。${L.obj === 'lin' ? '線形最適化（第1・2回）の答えにあたります。' : '効用が二次式なので非線形最適化（第12回）で、最急降下法（制約を守るよう射影しながら）を'+ o.cont.it + '回くり返して求めました。'}単元の制約があるとこの答えにぴったりは合わせられないので、整数の答えとの差が生まれます。</p>
    ${linNote}
    ${frontierChart(o)}
    <div class="legend"><span><i class="dot" style="background:var(--market)"></i>買える組み合わせ</span><span><i class="dot" style="background:var(--accent)"></i>最適解</span><span><i class="dot" style="background:var(--news)"></i>欲張り法</span><span><i class="dot" style="background:var(--memo)"></i>連続緩和</span></div>
    <p class="sub">横軸は標準偏差（リスク）、縦軸は期待リターンです。同じリスクなら上にあるほど良い組み合わせで、点の集まりの左上のふちを「効率的フロンティア」と呼びます。</p></div>`;
  const caution = `<div class="card sub">この計算は、過去の平均やばらつきが将来も続くと仮定した学習用のものです。実際の値動きはこの通りにはならず、手数料・配当・税金も考えていません。売買を判断するためのものではありません。答え合わせをしたいときは、各銘柄の「🎯 予測と答え合わせ」に予測として残しておくと、期間がたったあとに確かめられます。</div>`;
  return head + est + result + caution;
}

// ================================================================
// AHP（問題解決の数理 第6回）
// ================================================================
const SCALE = ['9', '7', '5', '3', '1', '1/3', '1/5', '1/7', '1/9'];
const WORD = { 9: '極めて', 7: 'かなり', 5: 'はっきり', 3: 'やや' };
const val = s => s.includes('/') ? 1 / Number(s.split('/')[1]) : Number(s);
function ahpState() {
  const stocks = K().state.cfg.stocks.map(s => s.code);
  const a = load('kabu.ahp', null) || {};
  const st = {
    crit: Array.isArray(a.crit) && a.crit.length === 3 ? a.crit : ['値動きの安定性', '業績・成長への期待', 'ニュースへの反応の分かりやすさ'],
    alts: Array.isArray(a.alts) ? a.alts.filter(c => stocks.includes(c)) : [],
    cmp: a.cmp || {},
  };
  stocks.forEach(c => { if (st.alts.length < 3 && !st.alts.includes(c)) st.alts.push(c); });
  st.alts = st.alts.slice(0, 3);
  return st;
}
function ahpWeights(Mx) { // 幾何平均法で重みを求め、整合度 CI を計算する
  const n = Mx.length;
  const gm = Mx.map(r => Math.pow(r.reduce((p, v) => p * v, 1), 1 / n)), s = sum(gm), w = gm.map(v => v / s);
  const lmax = avg(Mx.map((r, i) => sum(r.map((v, j) => v * w[j])) / w[i]));
  const ci = (lmax - n) / (n - 1);
  return { w, lmax, ci, cr: ci / 0.58 };
}
function matFrom(items, getVal) {
  const n = items.length, M = items.map(() => new Array(n).fill(1));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const v = getVal(i, j); M[i][j] = v; M[j][i] = 1 / v; }
  return M;
}
function pairSel(key, cur, A, B, verb) {
  const opts = SCALE.map(s => {
    const v = val(s);
    const lb = v === 1 ? '同じくらい（1）' : v > 1 ? `${A}が${WORD[v]}${verb}（${s}）` : `${B}が${WORD[1 / v]}${verb}（${s.split('/')[1]}）`;
    return `<option value="${s}"${s === cur ? ' selected' : ''}>${K().esc(lb)}</option>`;
  }).join('');
  return `<div class="pair"><div class="sub">${K().esc(A)} と ${K().esc(B)}</div><select data-lact="Lcmp" data-key="${key}">${opts}</select></div>`;
}
const ciNote = r => r.ci <= 0.1 ? `<span class="up">整合性あり</span>` : `<b class="down">矛盾が大きめ</b>（一対比較を見直す）`;
function bars(names, w) {
  return `<div class="bars">${names.map((nm, i) => `<div class="bar"><span>${K().esc(nm)}</span><i style="width:${(w[i] * 100).toFixed(1)}%"></i><b>${(w[i] * 100).toFixed(1)}%</b></div>`).join('')}</div>`;
}
function ahpView() {
  const KN = K(), st = ahpState(), stocks = KN.state.cfg.stocks.map(s => s.code);
  const names = st.alts.map(nameOf);
  const g = (k) => st.cmp[k] || '1';
  const cKey = (i, j) => `c:${i}-${j}`;
  const aKey = (ci, i, j) => `a:${ci}:${st.alts[i]}-${st.alts[j]}`;
  const C = ahpWeights(matFrom(st.crit, (i, j) => val(g(cKey(i, j)))));
  const loc = st.crit.map((_, ci) => ahpWeights(matFrom(st.alts, (i, j) => val(g(aKey(ci, i, j))))));
  const total = st.alts.map((_, a) => sum(st.crit.map((__, ci) => C.w[ci] * loc[ci].w[a])));
  const B = Math.max(0, Number(L.budget) || 0);
  const alloc = st.alts.map((c, i) => { const s = series(c), u = s.closes[s.closes.length - 1] * 100, k = Math.floor(total[i] * B / u); return { k, amt: k * u }; });
  const altSel = i => `<select data-lact="Lalt" data-i="${i}">${stocks.map(c => `<option value="${c}"${st.alts[i] === c ? ' selected' : ''}>${KN.esc(nameOf(c))}</option>`).join('')}</select>`;
  const pairs = [[0, 1], [0, 2], [1, 2]];
  return `<div class="card"><h2>階層分析法（AHP）で3銘柄を比べる ${lecture('問題解決の数理 第6回')}</h2>
    <p class="sub">「目標（どの銘柄に重みを置くか）→ 評価基準 → 代替案（銘柄）」の3階層に分け、2つずつ比べた結果（一対比較）から重みを計算します。数字にしにくい「内容の良し悪し」を、自分の主観で比べて数字にする方法です。</p>
    <h3>① 評価基準（自由に書きかえられます）</h3>
    ${st.crit.map((c, i) => `<input type="text" data-lact="Lcrit" data-i="${i}" value="${KN.esc(c)}" maxlength="20" aria-label="評価基準${i + 1}">`).join('')}
    <h3>② 代替案（銘柄）</h3><div class="row">${[0, 1, 2].map(altSel).join('')}</div>
    ${new Set(st.alts).size < 3 ? '<p class="down">3つとも違う銘柄を選んでください。</p>' : ''}</div>

  <div class="card"><h2>③ 評価基準どうしの一対比較</h2>
    <p class="sub">目標に対して、どちらの基準がどのくらい重要か。1＝同じくらい、3＝やや、5＝はっきり、7＝かなり、9＝極めて重要。</p>
    ${pairs.map(([i, j]) => pairSel(cKey(i, j), g(cKey(i, j)), st.crit[i], st.crit[j], '重要')).join('')}
    ${bars(st.crit, C.w)}
    <p class="sub">λmax＝${f3(C.lmax)}、整合度 CI＝${f3(C.ci)}：${ciNote(C)}</p></div>

  ${st.crit.map((c, ci) => `<div class="card"><h2>④-${ci + 1} 「${KN.esc(c)}」で銘柄を比べる</h2>
    ${pairs.map(([i, j]) => pairSel(aKey(ci, i, j), g(aKey(ci, i, j)), names[i], names[j], '良い')).join('')}
    ${bars(names, loc[ci].w)}
    <p class="sub">CI＝${f3(loc[ci].ci)}：${ciNote(loc[ci])}</p></div>`).join('')}

  <div class="card"><h2>⑤ 総合評価</h2>
    <p class="sub">総合評価 ＝ Σ（基準の重み × その基準での銘柄の重み）</p>
    <div class="scroll"><table><tr><th class="l">銘柄</th>${st.crit.map((c, ci) => `<th>${KN.esc(c.slice(0, 6))}<br><span class="sub">${p1(C.w[ci])}</span></th>`).join('')}<th>総合</th></tr>
    ${names.map((nm, a) => `<tr><td class="l">${KN.esc(nm)}</td>${loc.map(l => `<td>${p1(l.w[a])}</td>`).join('')}<td><b>${p1(total[a])}</b></td></tr>`).join('')}</table></div>
    ${bars(names, total)}
    <h3>この比率で資金（${yen(B)}）を分けると</h3>
    <table>${st.alts.map((c, i) => `<tr><td class="l">${KN.esc(names[i])}</td><td>${yen(total[i] * B)}</td><td>→ ${alloc[i].k}単元（${yen(alloc[i].amt)}）</td></tr>`).join('')}
      <tr><td class="l">現金</td><td></td><td>${yen(B - sum(alloc.map(a => a.amt)))}</td></tr></table>
    <p class="sub">資金は「配分の最適化」で入れた金額を使っています。100株単位に切り捨てるため、比率どおりにはなりません。AHPは主観をもとにした重み、「配分の最適化」は過去の値動きをもとにした計算なので、両方の答えを比べてみると、自分の見方と数字のずれが分かります。</p>
    <p class="sub">重みは幾何平均法で求めています（固有ベクトル法で求める教科書もあり、値が少しだけ違うことがあります）。CI＝(λmax − n)/(n − 1) で、0.1以下（0.15以下とする場合も）なら一対比較に大きな矛盾はないとされます。3項目のときの CR（＝CI÷0.58）は ${f3(C.cr)} です。</p></div>`;
}

// ================================================================
// 画面・操作
// ================================================================
const SECS = [['dist', '分布'], ['corr', '相関・回帰'], ['test', '検定'], ['opt', '配分の最適化'], ['ahp', 'AHP']];
function html() {
  const KN = K();
  if (!KN.state.cfg) return '';
  const body = { dist: distView, corr: corrView, test: testView, opt: optView, ahp: ahpView }[L.sec] || distView;
  persist();
  return `<div class="card"><h2>📐 学習</h2>
    <p class="sub">放送大学「身近な統計」「問題解決の数理」で学ぶ方法を、株ノートのデータで試すページです。見出しの横に、対応する授業の回を書いています。結果は学習用で、売買を判断するためのものではありません。</p>
    <div class="row">${SECS.map(([k, lb]) => `<button type="button" data-act="Lsec" data-v="${k}" class="${L.sec === k ? 'on' : ''}">${lb}</button>`).join('')}</div></div>` + body();
}
function click(act, b) {
  const v = b.dataset.v, st = K().state;
  if (act === 'Lsec') L.sec = v;
  else if (act === 'Lperiod') L.period = v;
  else if (act === 'Lobj') L.obj = v;
  else if (act === 'Ljump') {
    Object.assign(st, { tab: b.dataset.code, sel: b.dataset.date, range: '全部', kind: 'all', tag: 'all' });
    setTimeout(() => { const el = document.getElementById('selected'); if (el) el.scrollIntoView({ block: 'start' }); }, 0);
  } else return false;
  persist();
  return true;
}
function change(e) {
  const a = e.dataset.lact;
  if (a === 'Lcode') L.code = e.value;
  else if (a === 'Lx') L.x = e.value;
  else if (a === 'Ly') L.y = e.value;
  else if (a === 'Ltest') L.test = e.value;
  else if (a === 'Lbudget') L.budget = Math.max(0, Math.round(Number(e.value) || 0));
  else if (a === 'Lhorizon') L.horizon = Number(e.value) || 20;
  else if (a === 'Llam') L.lam = Number(e.value) || 0;
  else if (a === 'Lpick') {
    const set = new Set(L.picks || []);
    if (e.checked) set.add(e.value); else set.delete(e.value);
    L.picks = K().state.cfg.stocks.map(s => s.code).filter(c => set.has(c));
  } else if (a === 'Lcrit' || a === 'Lalt' || a === 'Lcmp') {
    const st = ahpState();
    if (a === 'Lcrit') st.crit[Number(e.dataset.i)] = e.value.trim() || `基準${Number(e.dataset.i) + 1}`;
    else if (a === 'Lalt') st.alts[Number(e.dataset.i)] = e.value;
    else st.cmp[e.dataset.key] = e.value;
    save('kabu.ahp', st);
  } else return false;
  persist();
  return true;
}

window.KN = window.KN || {};
window.KN.learn = { html, mount() {}, click, change, _test: { describe, regress, binom, contSolve, projCappedSimplex, ahpWeights, matFrom, optimize, aligned, L } };
})();

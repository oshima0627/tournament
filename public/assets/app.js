/* ===========================================================
 * 対戦表メーカー
 * - トーナメント（勝ち抜き）とリーグ（総当たり）に対応
 * - 参加者は何名でもOK。トーナメントでは不戦勝の人数を選べる
 * - 共有URLは閲覧専用。データはブラウザ内にのみ保存する
 * 依存ライブラリなし・ビルド不要
 *
 * 仕様は docs/requirements.md を参照（機能IDは F-01〜F-23）
 * =========================================================== */
'use strict';

/* ---------- 小さなユーティリティ ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

let _uid = 0;
const newId = () => 'p' + (++_uid).toString(36) + Math.random().toString(36).slice(2, 6);

/* トーナメント表のレイアウト定数（style.css の :root と一致させること） */
const LAYOUT = {
  MATCH_W: 210,   // 対戦カードの幅
  SLOT_H: 36,     // 1名分の高さ
  V_GAP: 22,      // カード同士の縦の間隔
  COL_GAP: 64,    // ラウンド間の横の間隔
  LABEL_H: 26,    // ラウンド名の高さ
  THIRD_GAP: 46,  // 3位決定戦を置くための余白
  BORDER: 1,      // カードの枠線。実際の描画高さに含まれるので計算にも入れる
};
// 枠線を数え落とすと、カードが計算より数px高くなって表全体がはみ出す
LAYOUT.MATCH_H = LAYOUT.SLOT_H * 2 + LAYOUT.BORDER * 2;
LAYOUT.SEED_H = LAYOUT.SLOT_H + LAYOUT.BORDER * 2;

const STORAGE_KEY = 'tournament-maker:v1';
const MAX_PLAYERS = 32;          // 動作保証の上限（要件 7.2）
const POINTS = { win: 3, draw: 1, lose: 0 };  // リーグの勝点（要件 6.7）

/** 共有URLで開かれた場合は閲覧専用。記録も保存もしない（要件 F-21） */
let viewOnly = false;

/* ===========================================================
 * 状態
 * =========================================================== */

function createDefaultState() {
  const names = ['Aチーム', 'Bチーム', 'Cチーム', 'Dチーム', 'Eチーム', 'Fチーム'];
  const players = names.map((name) => ({ id: newId(), name }));
  return {
    version: 2,
    title: '対戦表',
    players,                 // [{id, name}] この並び順がそのまま配置になる
    format: 'tournament',    // 'tournament' | 'league'
    byes: 'min',             // 1回戦の不戦勝の人数: 'min' | 'full' | 数値
    thirdPlace: true,
    showScore: false,
    zoom: 100,
    results: {},             // 試合ID -> { w: 参加者ID|'draw'|null, s: { 参加者ID: 得点 } }
  };
}

function createEmptyState() {
  const s = createDefaultState();
  s.title = '';
  s.players = [];
  s.results = {};
  return s;
}

let state = createDefaultState();

/** 保存された値を安全に取り込む（壊れたデータで落ちないように） */
function sanitize(raw) {
  const base = createDefaultState();
  if (!raw || typeof raw !== 'object') return base;

  const players = Array.isArray(raw.players)
    ? raw.players
        .map((p) => (typeof p === 'string' ? { id: newId(), name: p } : p))
        .filter((p) => p && typeof p.name === 'string')
        .map((p) => ({ id: typeof p.id === 'string' ? p.id : newId(), name: p.name }))
    : base.players;

  const ids = new Set(players.map((p) => p.id));

  const results = {};
  if (raw.results && typeof raw.results === 'object') {
    for (const [mid, r] of Object.entries(raw.results)) {
      if (!r || typeof r !== 'object') continue;
      const scores = {};
      if (r.s && typeof r.s === 'object') {
        for (const [pid, v] of Object.entries(r.s)) {
          if (ids.has(pid) && Number.isFinite(Number(v))) scores[pid] = Number(v);
        }
      }
      const winner = r.w === 'draw' ? 'draw' : (ids.has(r.w) ? r.w : null);
      if (winner || Object.keys(scores).length) results[mid] = { w: winner, s: scores };
    }
  }

  const byes = raw.byes === 'full' || Number.isFinite(Number(raw.byes))
    ? (raw.byes === 'full' ? 'full' : Math.max(0, Math.floor(Number(raw.byes))))
    : 'min';

  return {
    version: 2,
    title: typeof raw.title === 'string' ? raw.title : base.title,
    players,
    format: raw.format === 'league' ? 'league' : 'tournament',
    byes,
    thirdPlace: !!raw.thirdPlace,
    showScore: !!raw.showScore,
    zoom: clamp(Number(raw.zoom) || 100, 40, 150),
    results,
  };
}

/** ブラケットに入れる参加者IDの配列（リストの並び順＝配置順） */
function entrantIds() {
  return state.players.map((p) => p.id);
}

function nameOf(id) {
  const p = state.players.find((x) => x.id === id);
  return p ? p.name : '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ===========================================================
 * トーナメント：ブラケットの構築
 *
 * 各ラウンドは「そのラウンドに残っている枠」の一覧。
 * 上から2つずつ組んで対戦（match）にし、余った枠は不戦勝で通過する。
 *   kind: 'match' … 2人が戦うカード
 *         'seed'  … 1回戦の不戦勝（カードに名前だけ表示）
 *         'pass'  … 2回戦以降の不戦勝（線だけで次のラウンドへ）
 * =========================================================== */

/** 1回戦の不戦勝として選べる人数の一覧（参加人数と同じ偶奇の値のみ） */
function byeChoices(n) {
  const out = [];
  for (let b = n % 2; b <= n - 2; b += 2) out.push(b);
  return out;
}

/** 2の累乗の枠にきれいに収まる不戦勝の人数 */
function fullByeCount(n) {
  let size = 2;
  while (size < n) size *= 2;
  return size - n;
}

/** 設定から実際の不戦勝の人数を決める（人数が変わっても破綻しないよう丸める） */
function byeCount(n) {
  const choices = byeChoices(n);
  if (!choices.length) return 0;
  if (state.byes === 'min') return choices[0];
  if (state.byes === 'full') return fullByeCount(n);
  const want = Number(state.byes);
  if (!Number.isFinite(want)) return choices[0];
  return choices.reduce((best, c) => (Math.abs(c - want) < Math.abs(best - want) ? c : best), choices[0]);
}

function buildBracket(ids) {
  const n = ids.length;
  if (n < 2) return null;

  const rounds = [];

  // 1回戦：上から2人ずつ対戦、リストの下の b 人が不戦勝（シード）
  const b = byeCount(n);
  const matchCount = (n - b) / 2;
  const total = matchCount + b;

  // シードは縦方向に散らして配置する（最後は必ず一番下になる）
  const seedSlots = new Set();
  for (let i = 0; i < b; i++) seedSlots.add(Math.ceil(((i + 1) * total) / b) - 1);

  const first = [];
  let np = 0;                 // 対戦に入れる参加者の位置
  let ns = n - b;             // シードに入れる参加者の位置
  for (let slot = 0; slot < total; slot++) {
    const id = `0-${first.length}`;
    if (seedSlots.has(slot)) {
      first.push({ id, round: 0, index: first.length, kind: 'seed', src: [{ t: 'p', v: ids[ns++] }] });
    } else {
      first.push({
        id, round: 0, index: first.length, kind: 'match',
        src: [{ t: 'p', v: ids[np++] }, { t: 'p', v: ids[np++] }],
      });
    }
  }
  rounds.push(first);

  // 2回戦以降：勝者を上から2つずつ組み、余った1つは不戦勝で通過
  for (let r = 1; rounds[r - 1].length > 1; r++) {
    const prev = rounds[r - 1];
    const cur = [];
    for (let i = 0; i + 1 < prev.length; i += 2) {
      cur.push({
        id: `${r}-${cur.length}`, round: r, index: cur.length, kind: 'match',
        src: [{ t: 'n', v: prev[i].id }, { t: 'n', v: prev[i + 1].id }],
      });
    }
    if (prev.length % 2 === 1) {
      cur.push({
        id: `${r}-${cur.length}`, round: r, index: cur.length, kind: 'pass',
        src: [{ t: 'n', v: prev[prev.length - 1].id }],
      });
    }
    rounds.push(cur);
  }

  return { rounds, n, byes: b, labels: roundLabels(rounds) };
}

/** 各ラウンドの名前（決勝／準決勝／準々決勝／n回戦） */
function roundLabels(rounds) {
  const R = rounds.length;
  return rounds.map((round, r) => {
    const matches = round.filter((nd) => nd.kind === 'match').length;
    if (r === R - 1) return '決勝';
    if (r === R - 2 && matches === 2) return '準決勝';
    if (r === R - 3 && matches === 4) return '準々決勝';
    return `${r + 1}回戦`;
  });
}

/**
 * 出場者が変わって無効になった記録を整理する。
 * 勝者だけを取り消し、その試合に関係なくなった得点も捨てる。
 */
function pruneResult(nodeId, players) {
  const rec = state.results[nodeId];
  if (!rec) return null;
  if (rec.w && rec.w !== 'draw' && !players.includes(rec.w)) rec.w = null;
  if (rec.s) {
    for (const pid of Object.keys(rec.s)) if (!players.includes(pid)) delete rec.s[pid];
  }
  if (!rec.w && (!rec.s || Object.keys(rec.s).length === 0)) {
    delete state.results[nodeId];
    return null;
  }
  return rec;
}

/** 記録済みの勝敗を反映して、各枠の出場者・勝者・敗者を確定させる */
function resolveBracket(br) {
  const info = {};

  for (const round of br.rounds) {
    for (const nd of round) {
      const players = nd.src.map((s) => (s.t === 'p' ? s.v : (info[s.v] ? info[s.v].winner : null)));
      let winner = null;
      let loser = null;

      if (nd.kind === 'match') {
        const present = players.filter(Boolean);
        const stored = pruneResult(nd.id, present);
        if (present.length === 2 && stored && stored.w && stored.w !== 'draw') {
          winner = stored.w;
          loser = players.find((p) => p && p !== winner) || null;
        }
      } else {
        winner = players[0] || null;   // シード／不戦勝はそのまま通過
        delete state.results[nd.id];   // 対戦ではないので勝敗の記録は持たない
      }

      info[nd.id] = { node: nd, players, winner, loser };
    }
  }

  /* 3位決定戦
   * 決勝に上がる2つの枠が「どちらも対戦」なら準決勝の敗者が2人いるので試合を組む。
   * 片方が不戦勝で上がってきた場合は敗者が1人しかいないため、その人が自動的に第3位。 */
  let third = null;
  let autoThird = null;
  const R = br.rounds.length;
  const finalNode = br.rounds[R - 1][0];
  const feeders = finalNode.src.map((s) => (s.t === 'n' ? info[s.v] : null));
  const semis = feeders.filter((f) => f && f.node.kind === 'match');

  if (semis.length === 2) {
    const players = semis.map((f) => f.loser || null);
    const present = players.filter(Boolean);
    const stored = pruneResult('tp', present);
    if (state.thirdPlace) {
      const winner = present.length === 2 && stored && stored.w && stored.w !== 'draw' ? stored.w : null;
      const loser = winner ? players.find((p) => p && p !== winner) || null : null;
      const node = { id: 'tp', round: R - 1, index: 0, kind: 'match', third: true, src: [] };
      third = { node, players, winner, loser };
      info.tp = third;
    }
  } else {
    delete state.results.tp;
    if (semis.length === 1) autoThird = semis[0].loser || null;
  }

  // 現在のブラケットに存在しない枠の記録は捨てる
  const valid = new Set(br.rounds.flat().map((nd) => nd.id));
  valid.add('tp');
  for (const id of Object.keys(state.results)) if (!valid.has(id)) delete state.results[id];

  return { info, third, autoThird, semis };
}

/* ===========================================================
 * トーナメント：座標計算（画面描画・画像書き出しで共用）
 * =========================================================== */

function nodeHeight(nd) {
  if (nd.kind === 'match') return LAYOUT.MATCH_H;
  if (nd.kind === 'seed') return LAYOUT.SEED_H;
  return 0;                       // pass はカードを描かない（線だけ）
}

function computeLayout(br, hasThird) {
  const { MATCH_W, MATCH_H, COL_GAP, V_GAP, LABEL_H, THIRD_GAP } = LAYOUT;
  const pos = {};

  // 1回戦は上から順に並べる（シードは「シード」ラベルの分だけ余白を足す）
  let y = LABEL_H;
  for (const nd of br.rounds[0]) {
    const h = nodeHeight(nd);
    if (nd.kind === 'seed') y += 8;
    pos[nd.id] = { x: 0, top: y, cy: y + h / 2, h };
    y += h + V_GAP;
  }
  let height = y - V_GAP;

  // 2回戦以降は「前の枠の中点」に置く
  for (let r = 1; r < br.rounds.length; r++) {
    for (const nd of br.rounds[r]) {
      const x = r * (MATCH_W + COL_GAP);
      const h = nodeHeight(nd);
      const cs = nd.src.map((s) => pos[s.v].cy);
      const cy = cs.reduce((a, b) => a + b, 0) / cs.length;
      pos[nd.id] = { x, top: cy - h / 2, cy, h };
    }
  }

  const R = br.rounds.length;
  const finalPos = pos[br.rounds[R - 1][0].id];
  const champ = { x: finalPos.x + MATCH_W + COL_GAP, cy: finalPos.cy };
  const width = champ.x + 210;

  if (hasThird) {
    const top = height + THIRD_GAP;
    pos.tp = { x: finalPos.x, top, cy: top + MATCH_H / 2, h: MATCH_H };
    height = top + MATCH_H;
  }

  return { pos, width, height, champ };
}

/* ===========================================================
 * リーグ（総当たり）
 * =========================================================== */

/** 2人の組み合わせから、並び順に依存しない試合IDを作る */
function leagueMatchId(a, b) {
  return a < b ? `L:${a}:${b}` : `L:${b}:${a}`;
}

/** 全対戦の一覧と、記録の解決結果を返す */
function resolveLeague() {
  const ids = entrantIds();
  if (ids.length < 2) return null;

  const matches = [];
  const byId = {};
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const id = leagueMatchId(ids[i], ids[j]);
      const rec = pruneResult(id, [ids[i], ids[j]]);
      const winner = rec && rec.w ? rec.w : null;
      const m = { id, a: ids[i], b: ids[j], rec, winner };
      matches.push(m);
      byId[id] = m;
    }
  }

  // 現在の組み合わせに存在しない記録は捨てる
  for (const id of Object.keys(state.results)) {
    if (id.startsWith('L:') && !byId[id]) delete state.results[id];
  }

  return { matches, byId, ids };
}

/**
 * 順位表を作る（要件 6.7）。
 * 勝点 → 得失点差 → 総得点 の順に比較し、それでも並ぶ場合は同順位とする。
 * 得失点は「両者の得点が入力されている試合」だけを集計する。
 */
function leagueStandings(league) {
  const rows = new Map(state.players.map((p) => ({
    id: p.id, name: p.name, win: 0, draw: 0, lose: 0, pt: 0, gf: 0, ga: 0, played: 0,
  })).map((r) => [r.id, r]));

  for (const m of league.matches) {
    if (!m.winner) continue;
    const A = rows.get(m.a);
    const B = rows.get(m.b);
    if (!A || !B) continue;
    A.played++; B.played++;
    if (m.winner === 'draw') { A.draw++; B.draw++; }
    else if (m.winner === m.a) { A.win++; B.lose++; }
    else { B.win++; A.lose++; }

    const sa = m.rec && m.rec.s ? m.rec.s[m.a] : undefined;
    const sb = m.rec && m.rec.s ? m.rec.s[m.b] : undefined;
    if (Number.isFinite(sa) && Number.isFinite(sb)) {
      A.gf += sa; A.ga += sb;
      B.gf += sb; B.ga += sa;
    }
  }

  const list = [...rows.values()];
  for (const r of list) {
    r.pt = r.win * POINTS.win + r.draw * POINTS.draw + r.lose * POINTS.lose;
    r.gd = r.gf - r.ga;
  }
  list.sort((a, b) => b.pt - a.pt || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name, 'ja'));

  const tied = (a, b) => a.pt === b.pt && a.gd === b.gd && a.gf === b.gf;
  list.forEach((r, i) => { r.rank = i > 0 && tied(list[i - 1], r) ? list[i - 1].rank : i + 1; });
  return list;
}

/* ===========================================================
 * 描画
 * =========================================================== */

const dom = {
  bracket: $('#bracket'),
  league: $('#league'),
  scale: $('#bracket-scale'),
  emptyMsg: $('#empty-msg'),
  results: $('#results'),
  boardTitle: $('#board-title'),
};

let current = null; // 直近の描画結果（画像書き出しで再利用）

function isTournament() {
  return state.format === 'tournament';
}

function render() {
  renderPlayerList();
  renderBoard();
  renderResults();
  syncControls();
  save();
}

function syncControls() {
  $('#title').value = state.title;
  $('#player-count').textContent = state.players.length;
  $('#format').value = state.format;
  $('#tournament-opts').hidden = !isTournament();
  $('#league-opts').hidden = isTournament();
  $('#opt-third').checked = state.thirdPlace;
  $('#opt-score').checked = state.showScore;
  $('#zoom').value = state.zoom;
  $('#zoom-label').textContent = state.zoom + '%';
  dom.boardTitle.textContent = state.title;
  document.title = state.title ? `${state.title} | 対戦表メーカー` : '対戦表メーカー';

  syncByeSelect();

  const n = state.players.length;
  const warn = $('#size-warning');
  warn.hidden = n <= MAX_PLAYERS;
  warn.textContent = `${MAX_PLAYERS}名を超えています。動作保証の対象外です（表示が重くなることがあります）。`;

  $('#league-hint').textContent = n >= 2
    ? `全${(n * (n - 1)) / 2}試合になります。`
    : '';

  $('#foot-hint').innerHTML = isTournament()
    ? '操作方法：対戦表の名前を<b>タップ</b>すると勝者になります。もう一度タップで取り消せます。'
    : '操作方法：星取表のマスを<b>タップ</b>すると記録欄が開きます。';
}

/** 不戦勝の人数の選択肢を、そのときの参加人数に合わせて作り直す */
function syncByeSelect() {
  const sel = $('#bye-count');
  const hint = $('#bye-hint');
  const n = state.players.length;
  sel.innerHTML = '';

  if (n < 2) {
    sel.disabled = true;
    hint.textContent = '';
    return;
  }
  sel.disabled = false;

  const choices = byeChoices(n);
  const min = choices[0];
  const full = fullByeCount(n);
  const actual = byeCount(n);

  for (const b of choices) {
    const note = [];
    if (b === min) note.push('最少');
    if (b === full) note.push('2の累乗の枠');
    const opt = document.createElement('option');
    opt.value = b === min ? 'min' : b === full ? 'full' : String(b);
    opt.textContent = `${b}名${note.length ? `（${note.join('・')}）` : ''}`;
    sel.appendChild(opt);
  }
  const cur = actual === min ? 'min' : actual === full ? 'full' : String(actual);
  sel.value = cur;
  state.byes = cur;

  const matches = (n - actual) / 2;
  hint.textContent = actual === 0
    ? `1回戦は${matches}試合。全員が1回戦から出場します。`
    : `1回戦は${matches}試合。リスト下位の${actual}名が1回戦を免除されます。`;
}

/* ---------- 参加者リスト ---------- */
function renderPlayerList() {
  const list = $('#player-list');
  list.innerHTML = '';
  state.players.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'player-row';
    const icon = (id) => `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;
    li.innerHTML = `
      <span class="no">${i + 1}</span>
      <input class="input" type="text" value="" aria-label="参加者${i + 1}の名前">
      <button type="button" class="icon-btn up" title="上へ" aria-label="${i + 1}番目を上へ移動">${icon('i-up')}</button>
      <button type="button" class="icon-btn down" title="下へ" aria-label="${i + 1}番目を下へ移動">${icon('i-down')}</button>
      <button type="button" class="icon-btn remove" title="削除" aria-label="${i + 1}番目を削除">${icon('i-close')}</button>`;
    const input = $('input', li);
    input.value = p.name;
    input.addEventListener('input', () => { p.name = input.value; renderBoard(); renderResults(); save(); });
    $('.up', li).addEventListener('click', () => movePlayer(i, -1));
    $('.down', li).addEventListener('click', () => movePlayer(i, 1));
    $('.remove', li).addEventListener('click', () => removePlayer(p.id));
    list.appendChild(li);
  });
}

/* ---------- 対戦表 ---------- */
function renderBoard() {
  const enough = state.players.length >= 2;
  dom.emptyMsg.hidden = enough;
  dom.bracket.hidden = !enough || !isTournament();
  dom.league.hidden = !enough || isTournament();

  if (!enough) {
    current = null;
    dom.bracket.innerHTML = '';
    dom.league.innerHTML = '';
    dom.scale.style.width = '';
    dom.scale.style.height = '0px';
    return;
  }
  if (isTournament()) renderBracket();
  else renderLeague();
}

function renderBracket() {
  const br = buildBracket(entrantIds());
  dom.bracket.innerHTML = '';
  dom.league.innerHTML = '';

  const { info, third, autoThird, semis } = resolveBracket(br);
  const layout = computeLayout(br, !!third);
  current = { kind: 'tournament', br, info, third, autoThird, semis, layout };

  dom.bracket.style.width = layout.width + 'px';
  dom.bracket.style.height = layout.height + 'px';

  // 接続線
  const svgns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgns, 'svg');
  svg.setAttribute('class', 'lines');
  svg.setAttribute('width', layout.width);
  svg.setAttribute('height', layout.height);
  for (const { d, done } of connectorPaths(br, info, layout)) {
    const path = document.createElementNS(svgns, 'path');
    path.setAttribute('d', d);
    if (done) path.setAttribute('class', 'done');
    svg.appendChild(path);
  }
  dom.bracket.appendChild(svg);

  // ラウンド名
  br.rounds.forEach((round, r) => {
    const label = document.createElement('div');
    label.className = 'round-label';
    label.textContent = br.labels[r];
    label.style.left = layout.pos[round[0].id].x + 'px';
    label.style.top = '0px';
    dom.bracket.appendChild(label);
  });

  // 各枠
  for (const round of br.rounds) {
    for (const nd of round) {
      const p = layout.pos[nd.id];
      if (nd.kind === 'pass') {
        dom.bracket.appendChild(tagEl('不戦勝', p.x, p.cy - 22, true));
        continue;
      }
      if (nd.kind === 'seed') dom.bracket.appendChild(tagEl('シード', p.x, p.top - 20, false));
      dom.bracket.appendChild(matchEl(info[nd.id], layout));
    }
  }

  // 3位決定戦
  if (third) {
    const tp = layout.pos.tp;
    dom.bracket.appendChild(tagEl('3位決定戦', tp.x, tp.top - 20, false));
    dom.bracket.appendChild(matchEl(third, layout));
  }

  // 優勝カード
  const finalInfo = info[br.rounds[br.rounds.length - 1][0].id];
  const champ = document.createElement('div');
  champ.className = 'champion';
  champ.style.left = layout.champ.x + 'px';
  champ.style.top = (layout.champ.cy - 28) + 'px';
  champ.innerHTML = '<span class="label">優勝</span><span class="who"></span>';
  $('.who', champ).textContent = finalInfo.winner ? nameOf(finalInfo.winner) : '—';
  dom.bracket.appendChild(champ);

  applyZoom();
}

/** カードの外に置く小さなラベル */
function tagEl(text, x, top, center) {
  const tag = document.createElement('div');
  tag.className = 'match-tag' + (center ? ' center' : '');
  tag.textContent = text;
  tag.style.left = x + 'px';
  tag.style.top = top + 'px';
  return tag;
}

/** カード1枚（対戦 or シード）を作る */
function matchEl(mi, layout) {
  const nd = mi.node;
  const p = layout.pos[nd.id];
  const box = document.createElement('div');
  const ready = nd.kind === 'match' && mi.players.filter(Boolean).length === 2;
  const isNext = ready && !mi.winner;      // 次にやる試合（要件 F-11）

  box.className = 'match'
    + (nd.third ? ' third' : '')
    + (nd.kind === 'seed' ? ' seed' : '')
    + (isNext ? ' next' : '');
  box.style.left = p.x + 'px';
  box.style.top = p.top + 'px';

  if (isNext) {
    const badge = document.createElement('span');
    badge.className = 'next-badge';
    badge.textContent = '次の試合';
    box.appendChild(badge);
  }

  const selectable = ready && !viewOnly;

  mi.players.forEach((pid) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isWinner = pid && nd.kind === 'match' && pid === mi.winner;
    const isLoser = pid && mi.winner && pid !== mi.winner;

    btn.className = 'slot'
      + (isWinner ? ' win' : '')
      + (isLoser ? ' lose' : '')
      + (pid ? '' : ' empty')
      + (selectable ? '' : ' disabled');

    const label = pid ? nameOf(pid) : '未定';
    btn.innerHTML = '<span class="mark"></span><span class="nm"></span>';
    $('.mark', btn).textContent = isWinner ? '✔' : '';
    $('.nm', btn).textContent = label;
    btn.title = selectable && pid ? `${label} を勝者にする` : '';

    if (state.showScore && pid && nd.kind === 'match') {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'score';
      input.min = '0';
      input.step = '1';
      input.value = (state.results[nd.id]?.s?.[pid] ?? '');
      input.placeholder = '-';
      input.disabled = viewOnly;
      input.setAttribute('aria-label', `${label} のスコア`);
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('change', () => setScore(nd.id, pid, input.value, input));
      btn.appendChild(input);
    }

    if (selectable) btn.addEventListener('click', () => toggleWinner(nd.id, pid));
    box.appendChild(btn);
  });

  return box;
}

/** 枠と枠をつなぐ線（dy: 縦方向のオフセット。画像書き出しで使う） */
function connectorPaths(br, info, layout, dy = 0) {
  const out = [];
  const { MATCH_W, COL_GAP } = LAYOUT;

  for (let r = 1; r < br.rounds.length; r++) {
    for (const nd of br.rounds[r]) {
      const self = layout.pos[nd.id];
      const midX = self.x - COL_GAP / 2;
      for (const src of nd.src) {
        const child = layout.pos[src.v];
        out.push({
          d: `M ${child.x + MATCH_W} ${child.cy + dy} H ${midX} V ${self.cy + dy} H ${self.x}`,
          done: !!(info[src.v] && info[src.v].winner),
        });
      }
      if (nd.kind === 'pass') {
        out.push({
          d: `M ${self.x} ${self.cy + dy} H ${self.x + MATCH_W}`,
          done: !!info[nd.id].winner,
        });
      }
    }
  }

  const finalNode = br.rounds[br.rounds.length - 1][0];
  const fp = layout.pos[finalNode.id];
  out.push({
    d: `M ${fp.x + MATCH_W} ${fp.cy + dy} H ${layout.champ.x}`,
    done: !!info[finalNode.id].winner,
  });
  return out;
}

/* ---------- リーグ（星取表） ---------- */
function renderLeague() {
  dom.bracket.innerHTML = '';
  dom.league.innerHTML = '';

  const league = resolveLeague();
  current = { kind: 'league', league };

  const players = state.players;
  const table = document.createElement('table');
  table.className = 'cross';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.appendChild(th('', 'corner'));
  players.forEach((p, i) => hr.appendChild(th(`${i + 1}`, '', p.name)));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  players.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.appendChild(th(`${i + 1}. ${row.name}`, 'rowhead', row.name));

    players.forEach((col, j) => {
      const td = document.createElement('td');
      if (i === j) {
        td.className = 'self';
        tr.appendChild(td);
        return;
      }
      const m = league.byId[leagueMatchId(row.id, col.id)];
      const btn = document.createElement('button');
      btn.type = 'button';

      let mark = '未';
      let cls = 'todo';
      if (m.winner === 'draw') { mark = '△'; cls = 'draw'; }
      else if (m.winner === row.id) { mark = '○'; cls = 'win'; }
      else if (m.winner === col.id) { mark = '●'; cls = 'lose'; }

      btn.className = 'cell ' + cls;
      btn.innerHTML = '<span class="mk"></span>';
      $('.mk', btn).textContent = mark;

      const sr = m.rec && m.rec.s ? m.rec.s[row.id] : undefined;
      const sc = m.rec && m.rec.s ? m.rec.s[col.id] : undefined;
      if (state.showScore && Number.isFinite(sr) && Number.isFinite(sc)) {
        const s = document.createElement('span');
        s.className = 'sc';
        s.textContent = `${sr}-${sc}`;
        btn.appendChild(s);
      }

      btn.title = `${row.name} 対 ${col.name}`;
      if (!viewOnly) btn.addEventListener('click', () => openRecord(row.id, col.id));
      td.appendChild(btn);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  dom.league.appendChild(table);

  const done = league.matches.filter((m) => m.winner).length;
  const note = document.createElement('p');
  note.className = 'league-note';
  note.textContent = `○ 勝ち ／ ● 負け ／ △ 引き分け ／ 未 未消化（${done} / ${league.matches.length} 試合が終了）`;
  dom.league.appendChild(note);

  applyZoom();
}

function th(text, cls, title) {
  const el = document.createElement('th');
  el.scope = 'col';
  if (cls) el.className = cls;
  el.textContent = text;
  if (title) el.title = title;
  return el;
}

/* ---------- 結果 ---------- */
function renderResults() {
  dom.results.innerHTML = '';
  if (!current) return;
  if (current.kind === 'league') renderLeagueResults();
  else renderTournamentResults();
}

function podiumEl(items) {
  const podium = document.createElement('div');
  podium.className = 'podium';
  items.forEach(([rank, who], i) => {
    const div = document.createElement('div');
    div.className = `podium-item p${i + 1}`;
    div.innerHTML = '<div class="rank"></div><div class="who"></div>';
    $('.rank', div).textContent = rank;
    $('.who', div).textContent = who || '—';
    podium.appendChild(div);
  });
  return podium;
}

function renderTournamentResults() {
  const { br, info, third, autoThird, semis } = current;
  const R = br.rounds.length;
  const finalInfo = info[br.rounds[R - 1][0].id];

  const items = [
    ['優勝', finalInfo.winner ? nameOf(finalInfo.winner) : null],
    ['準優勝', finalInfo.loser ? nameOf(finalInfo.loser) : null],
  ];
  if (third) items.push(['第3位', third.winner ? nameOf(third.winner) : null]);
  else if (semis.length === 1) items.push(['第3位', autoThird ? nameOf(autoThird) : null]);
  else if (semis.length === 2) {
    const losers = semis.map((f) => f.loser).filter(Boolean);
    items.push(['ベスト4', losers.length ? losers.map(nameOf).join(' / ') : null]);
  }
  dom.results.appendChild(podiumEl(items));

  const stats = computeStats(br, info, third, autoThird);
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.className = 'records';
  table.innerHTML = `
    <caption>戦績（${stats.length}名）</caption>
    <thead><tr>
      <th style="width:44px">順</th><th>参加者</th>
      <th class="num">勝</th><th class="num">敗</th><th>状況</th>
    </tr></thead><tbody></tbody>`;
  const tbody = $('tbody', table);
  stats.forEach((s, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="num">${i + 1}</td><td class="who"></td>
      <td class="num win-n">${s.win}</td><td class="num lose-n">${s.lose}</td>
      <td class="status ${s.statusClass}"></td>`;
    $('.who', tr).textContent = s.name;
    $('.status', tr).textContent = s.status;
    tbody.appendChild(tr);
  });
  wrap.appendChild(table);
  dom.results.appendChild(wrap);
}

/** 参加者ごとの勝敗と最終状況を集計する（トーナメント） */
function computeStats(br, info, third, autoThird) {
  const R = br.rounds.length;
  const stats = new Map();
  for (const p of state.players) {
    stats.set(p.id, {
      id: p.id, name: p.name, win: 0, lose: 0, lostRound: null,
      status: '出場中', statusClass: 'alive', rankKey: 5,
    });
  }

  const all = br.rounds.flat().filter((nd) => nd.kind === 'match').map((nd) => info[nd.id]);
  if (third) all.push(third);

  for (const mi of all) {
    if (!mi.winner) continue;
    const w = stats.get(mi.winner);
    if (w) w.win++;
    if (mi.loser) {
      const l = stats.get(mi.loser);
      if (l) {
        l.lose++;
        if (!mi.node.third) l.lostRound = mi.node.round;
      }
    }
  }

  const finalInfo = info[br.rounds[R - 1][0].id];
  for (const s of stats.values()) {
    if (finalInfo.winner === s.id) {
      s.status = '優勝'; s.statusClass = 'champ'; s.rankKey = 0;
    } else if (finalInfo.loser === s.id) {
      s.status = '準優勝'; s.statusClass = ''; s.rankKey = 1;
    } else if ((third && third.winner === s.id) || (!third && autoThird === s.id)) {
      s.status = '第3位'; s.statusClass = ''; s.rankKey = 2;
    } else if (s.lostRound !== null) {
      s.status = `${br.labels[s.lostRound]}敗退`;
      s.statusClass = '';
      s.rankKey = 10 + (R - s.lostRound);
    }
  }

  return [...stats.values()].sort((a, b) =>
    a.rankKey - b.rankKey || b.win - a.win || a.name.localeCompare(b.name, 'ja'));
}

function renderLeagueResults() {
  const rows = leagueStandings(current.league);
  const allDone = current.league.matches.every((m) => m.winner);

  const nameByRank = (r) => rows.filter((x) => x.rank === r).map((x) => x.name).join(' / ') || null;
  dom.results.appendChild(podiumEl([
    ['優勝', allDone ? nameByRank(1) : null],
    ['第2位', allDone ? nameByRank(2) : null],
    ['第3位', allDone ? nameByRank(3) : null],
  ]));

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.className = 'records';
  table.innerHTML = `
    <caption>順位表（${rows.length}名・勝点 → 得失点差 → 総得点）</caption>
    <thead><tr>
      <th style="width:44px">順位</th><th>参加者</th><th class="num">勝点</th>
      <th class="num">勝</th><th class="num">分</th><th class="num">敗</th>
      <th class="num">得点</th><th class="num">失点</th><th class="num">得失点差</th>
    </tr></thead><tbody></tbody>`;
  const tbody = $('tbody', table);
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="num">${r.rank}</td><td class="who"></td>
      <td class="num"><b>${r.pt}</b></td>
      <td class="num win-n">${r.win}</td><td class="num">${r.draw}</td><td class="num lose-n">${r.lose}</td>
      <td class="num">${r.gf}</td><td class="num">${r.ga}</td>
      <td class="num">${r.gd > 0 ? '+' : ''}${r.gd}</td>`;
    $('.who', tr).textContent = r.name;
    tbody.appendChild(tr);
  });
  wrap.appendChild(table);
  dom.results.appendChild(wrap);

  if (!allDone) {
    const p = document.createElement('p');
    p.className = 'league-note';
    p.textContent = '※ 全試合が終わると優勝者が確定します。';
    dom.results.appendChild(p);
  }
}

/* ===========================================================
 * 操作
 * =========================================================== */

function toggleWinner(nodeId, playerId) {
  const cur = state.results[nodeId];
  if (cur && cur.w === playerId) {
    delete state.results[nodeId];
    if (cur.s && Object.keys(cur.s).length) state.results[nodeId] = { w: null, s: cur.s };
  } else {
    state.results[nodeId] = { w: playerId, s: (cur && cur.s) || {} };
  }
  renderBoard();
  renderResults();
  save();
}

/** 得点は0以上の整数のみ受け付ける（要件 F-15） */
function setScore(nodeId, playerId, value, input) {
  const rec = state.results[nodeId] || (state.results[nodeId] = { w: null, s: {} });
  rec.s = rec.s || {};

  if (value === '' || value === null) {
    delete rec.s[playerId];
  } else {
    const num = Math.max(0, Math.floor(Number(value)));
    if (!Number.isFinite(num)) {
      delete rec.s[playerId];
      if (input) input.value = '';
    } else {
      rec.s[playerId] = num;
      if (input && String(num) !== String(value)) input.value = String(num);
    }
  }
  if (!rec.w && Object.keys(rec.s).length === 0) delete state.results[nodeId];
  save();
}

/* ---------- リーグの記録欄 ---------- */
let recording = null;   // { a, b } 記録欄で開いている対戦

function openRecord(a, b) {
  if (viewOnly) return;
  recording = { a, b };
  const id = leagueMatchId(a, b);
  const rec = state.results[id];

  $('#rec-name-a').textContent = nameOf(a);
  $('#rec-name-b').textContent = nameOf(b);
  $('#rec-win-a').textContent = `${nameOf(a)} の勝ち`;
  $('#rec-win-b').textContent = `${nameOf(b)} の勝ち`;

  const showScore = state.showScore;
  $('#rec-score-a').hidden = !showScore;
  $('#rec-score-b').hidden = !showScore;
  $('#rec-score-a').value = rec && rec.s && Number.isFinite(rec.s[a]) ? rec.s[a] : '';
  $('#rec-score-b').value = rec && rec.s && Number.isFinite(rec.s[b]) ? rec.s[b] : '';

  $('#record-overlay').hidden = false;
}

function closeRecord() {
  $('#record-overlay').hidden = true;
  recording = null;
}

/** 記録欄の内容を保存する。winner が null なら未記録に戻す */
function commitRecord(winner) {
  if (!recording) return;
  const { a, b } = recording;
  const id = leagueMatchId(a, b);

  const readScore = (sel) => {
    const v = $(sel).value;
    if (v === '') return undefined;
    const num = Math.max(0, Math.floor(Number(v)));
    return Number.isFinite(num) ? num : undefined;
  };

  if (winner === null) {
    delete state.results[id];
  } else {
    const s = {};
    if (state.showScore) {
      const sa = readScore('#rec-score-a');
      const sb = readScore('#rec-score-b');
      if (sa !== undefined) s[a] = sa;
      if (sb !== undefined) s[b] = sb;
    } else {
      const prev = state.results[id];
      if (prev && prev.s) Object.assign(s, prev.s);
    }
    state.results[id] = { w: winner, s };
  }

  closeRecord();
  renderBoard();
  renderResults();
  save();
}

function addPlayer(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  state.players.push({ id: newId(), name: trimmed });
  render();
}

function removePlayer(id) {
  state.players = state.players.filter((p) => p.id !== id);
  for (const [mid, r] of Object.entries(state.results)) {
    if (r.w === id) r.w = null;
    if (r.s) delete r.s[id];
    if (!r.w && (!r.s || !Object.keys(r.s).length)) delete state.results[mid];
  }
  render();
}

function movePlayer(index, delta) {
  const to = index + delta;
  if (to < 0 || to >= state.players.length) return;
  const [p] = state.players.splice(index, 1);
  state.players.splice(to, 0, p);
  render();
}

function applyBulk(text) {
  const names = text
    .split(/[\n,、，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) {
    toast('参加者名が読み取れませんでした');
    return;
  }
  // 同じ名前は既存のIDを引き継いで、可能な限り勝敗を残す
  const pool = new Map();
  for (const p of state.players) {
    if (!pool.has(p.name)) pool.set(p.name, []);
    pool.get(p.name).push(p);
  }
  state.players = names.map((name) => {
    const reuse = pool.get(name);
    if (reuse && reuse.length) return reuse.shift();
    return { id: newId(), name };
  });
  render();
  toast(`${names.length}名で作成しました`);
}

const hasResults = () => Object.keys(state.results).length > 0;

/** 組み合わせ抽選（Fisher–Yates） */
function shuffleOrder() {
  if (state.players.length < 2) return;
  if (hasResults() && !confirm('抽選すると、記録済みの勝敗はすべて消えます。よろしいですか？')) return;

  const list = state.players.slice();
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  state.players = list;
  state.results = {};
  render();
  toast('組み合わせを抽選しました');
}

function changeFormat(next) {
  if (next === state.format) return;
  if (hasResults() && !confirm('形式を変えると、記録済みの勝敗はすべて消えます。よろしいですか？')) {
    $('#format').value = state.format;
    return;
  }
  state.format = next;
  state.results = {};
  render();
}

function resetResults() {
  state.results = {};
  render();
  toast('勝敗をリセットしました');
}

function newTournament() {
  state = createEmptyState();
  render();
  $('#add-input').focus();
  toast('新しい大会を作成しました');
}

function applyZoom() {
  const z = state.zoom / 100;
  dom.scale.style.transform = `scale(${z})`;
  if (current && current.kind === 'tournament') {
    dom.scale.style.width = current.layout.width * z + 'px';
    dom.scale.style.height = current.layout.height * z + 'px';
  } else {
    // 星取表は中身の実サイズが決まってから縮尺を反映する
    dom.scale.style.width = '';
    dom.scale.style.height = '';
    const rect = dom.league.getBoundingClientRect();
    if (rect.height) dom.scale.style.height = rect.height * z + 'px';
  }
}

/* ===========================================================
 * 保存・読み込み・書き出し
 * =========================================================== */

function save() {
  if (viewOnly) return;   // 共有URLの閲覧が、見る人自身の大会を上書きしないようにする
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) { /* プライベートモードなどでは無視 */ }
}

function load() {
  const shared = readHash();
  if (shared) {
    state = sanitize(shared);
    viewOnly = true;
    document.body.classList.add('view-only');
    $('#view-banner').hidden = false;
    return;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = sanitize(JSON.parse(raw));
  } catch (_) { /* 壊れていたら初期値のまま */ }
}

function encodeState() {
  const json = JSON.stringify(state);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeState(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** 閲覧専用の共有URL（#v=...）を読む。壊れていても落とさない */
function readHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h.startsWith('v=')) return null;
  try {
    return decodeState(h.slice(2));
  } catch (_) {
    return null;
  }
}

function shareUrl() {
  const url = `${location.origin}${location.pathname}#v=${encodeState()}`;
  const done = () => toast('閲覧用のURLをコピーしました');
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(done, () => window.prompt('このURLをコピーしてください', url));
  } else {
    window.prompt('このURLをコピーしてください', url);
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename() {
  return (state.title || 'taisenhyo').replace(/[\\/:*?"<>|]/g, '_');
}

function exportJson() {
  download(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), safeFilename() + '.json');
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state = sanitize(JSON.parse(String(reader.result)));
      render();
      toast('読み込みました');
    } catch (_) {
      toast('読み込めませんでした');
    }
  };
  reader.readAsText(file);
}

/* ---------- 画像書き出し（トーナメントのみ） ---------- */
function truncate(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function buildSvg() {
  if (!current || current.kind !== 'tournament') return null;
  const { br, info, third, layout } = current;
  const { MATCH_W, SLOT_H } = LAYOUT;
  const W = layout.width;
  const H = layout.height + 46;
  const OY = 40; // タイトル分の余白

  const parts = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<text x="${W / 2}" y="27" text-anchor="middle" font-size="21" font-family="serif" letter-spacing="1" fill="#17191c">${escapeXml(state.title)}</text>`);

  for (const { d, done } of connectorPaths(br, info, layout, OY)) {
    parts.push(`<path d="${d}" fill="none" stroke="${done ? '#1c6b47' : '#d2cec6'}" stroke-width="1.5"/>`);
  }

  br.rounds.forEach((round, r) => {
    const x = layout.pos[round[0].id].x;
    parts.push(`<text x="${x + MATCH_W / 2}" y="${OY + 14}" text-anchor="middle" font-size="11" font-weight="bold" letter-spacing="1.6" fill="#7b7f86">${escapeXml(br.labels[r])}</text>`);
  });

  const tag = (text, x, y, center) => parts.push(
    `<text x="${center ? x + MATCH_W / 2 : x}" y="${y}"${center ? ' text-anchor="middle"' : ''} font-size="11" font-weight="bold" letter-spacing="1.2" fill="#a8acb2">${escapeXml(text)}</text>`);

  const drawCard = (mi) => {
    const nd = mi.node;
    const p = layout.pos[nd.id];
    const y = p.top + OY;
    parts.push(`<rect x="${p.x}" y="${y}" width="${MATCH_W}" height="${p.h}" rx="5" fill="#ffffff" stroke="#d2cec6"${nd.third ? ' stroke-dasharray="5 4"' : ''}/>`);
    if (mi.players.length === 2) {
      const mid = y + p.h / 2;
      parts.push(`<line x1="${p.x}" y1="${mid}" x2="${p.x + MATCH_W}" y2="${mid}" stroke="#e7e4de"/>`);
    }
    mi.players.forEach((pid, i) => {
      const sy = y + LAYOUT.BORDER + i * SLOT_H;
      const isWin = pid && nd.kind === 'match' && pid === mi.winner;
      const isLose = pid && mi.winner && pid !== mi.winner;
      const label = pid ? nameOf(pid) : '未定';
      if (isWin) parts.push(`<rect x="${p.x + 1}" y="${sy + (i === 0 ? 1 : 0)}" width="${MATCH_W - 2}" height="${SLOT_H - 1}" fill="#ecf4ef"/>`);
      const color = isWin ? '#12583a' : isLose ? '#a8acb2' : pid ? '#17191c' : '#a8acb2';
      parts.push(`<text x="${p.x + 24}" y="${sy + SLOT_H / 2 + 5}" font-size="14" fill="${color}"${isWin ? ' font-weight="bold"' : ''}${isLose ? ' text-decoration="line-through"' : ''}>${escapeXml(truncate(label, 15))}</text>`);
      if (isWin) parts.push(`<text x="${p.x + 8}" y="${sy + SLOT_H / 2 + 5}" font-size="11" fill="#1c6b47">✔</text>`);
      const score = state.results[nd.id]?.s?.[pid];
      if (state.showScore && pid && score !== undefined) {
        parts.push(`<text x="${p.x + MATCH_W - 10}" y="${sy + SLOT_H / 2 + 5}" text-anchor="end" font-size="13" fill="${color}">${escapeXml(score)}</text>`);
      }
    });
  };

  for (const round of br.rounds) {
    for (const nd of round) {
      const p = layout.pos[nd.id];
      if (nd.kind === 'pass') { tag('不戦勝', p.x, p.cy + OY - 8, true); continue; }
      if (nd.kind === 'seed') tag('シード', p.x, p.top + OY - 7, false);
      drawCard(info[nd.id]);
    }
  }
  if (third) {
    tag('3位決定戦', layout.pos.tp.x, layout.pos.tp.top + OY - 7, false);
    drawCard(third);
  }

  const finalInfo = info[br.rounds[br.rounds.length - 1][0].id];
  const cx = layout.champ.x;
  const cy = layout.champ.cy + OY;
  parts.push(`<rect x="${cx}" y="${cy - 28}" width="190" height="56" rx="5" fill="#ffffff" stroke="#8a6a1f"/>`);
  parts.push(`<text x="${cx + 16}" y="${cy - 8}" font-size="10" font-weight="bold" letter-spacing="2.2" fill="#8a6a1f">優勝</text>`);
  parts.push(`<text x="${cx + 16}" y="${cy + 16}" font-size="18" font-family="serif" fill="#17191c">${escapeXml(truncate(finalInfo.winner ? nameOf(finalInfo.winner) : '—', 12))}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">${parts.join('')}</svg>`;
}

function exportSvg() {
  const svg = buildSvg();
  if (!svg) return toast(imageHint());
  download(new Blob([svg], { type: 'image/svg+xml' }), safeFilename() + '.svg');
}

function exportPng() {
  const svg = buildSvg();
  if (!svg) return toast(imageHint());
  const scale = 2;
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) download(blob, safeFilename() + '.png');
      else toast('PNGを作成できませんでした');
    }, 'image/png');
  };
  img.onerror = () => toast('PNGを作成できませんでした');
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function imageHint() {
  if (state.players.length < 2) return '先に参加者を追加してください';
  return '画像の書き出しはトーナメントのみ対応しています（リーグは印刷をご利用ください）';
}

/* ---------- トースト ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ===========================================================
 * イベント登録
 * =========================================================== */

function bindEvents() {
  $('#title').addEventListener('input', (e) => {
    state.title = e.target.value;
    dom.boardTitle.textContent = state.title;
    document.title = state.title ? `${state.title} | 対戦表メーカー` : '対戦表メーカー';
    save();
  });

  $('#add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#add-input');
    addPlayer(input.value);
    input.value = '';
    input.focus();
  });

  $('#btn-bulk-apply').addEventListener('click', () => applyBulk($('#bulk-text').value));
  $('#btn-shuffle').addEventListener('click', shuffleOrder);
  $('#format').addEventListener('change', (e) => changeFormat(e.target.value));

  $('#bye-count').addEventListener('change', (e) => {
    state.byes = e.target.value === 'min' || e.target.value === 'full' ? e.target.value : Number(e.target.value);
    render();
  });

  $('#opt-third').addEventListener('change', (e) => { state.thirdPlace = e.target.checked; render(); });
  $('#opt-score').addEventListener('change', (e) => { state.showScore = e.target.checked; render(); });

  $('#zoom').addEventListener('input', (e) => {
    state.zoom = Number(e.target.value);
    $('#zoom-label').textContent = state.zoom + '%';
    applyZoom();
    save();
  });

  $('#btn-reset-results').addEventListener('click', () => {
    if (hasResults() && confirm('記録した勝敗をすべて消しますか？')) resetResults();
  });
  $('#btn-new').addEventListener('click', () => {
    if (confirm('現在の内容をすべて破棄して、新しい大会を始めますか？')) newTournament();
  });

  $('#btn-share').addEventListener('click', shareUrl);
  $('#btn-export-json').addEventListener('click', exportJson);
  $('#btn-import-json').addEventListener('click', () => $('#file-json').click());
  $('#file-json').addEventListener('change', (e) => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = '';
  });
  $('#btn-export-png').addEventListener('click', exportPng);
  $('#btn-export-svg').addEventListener('click', exportSvg);
  $('#btn-print').addEventListener('click', () => window.print());
  $('#btn-toggle-panel').addEventListener('click', () => $('#panel').classList.toggle('hidden'));

  // リーグの記録欄
  $('#rec-win-a').addEventListener('click', () => commitRecord(recording && recording.a));
  $('#rec-win-b').addEventListener('click', () => commitRecord(recording && recording.b));
  $('#rec-draw').addEventListener('click', () => commitRecord('draw'));
  $('#rec-clear').addEventListener('click', () => commitRecord(null));
  $('#rec-close').addEventListener('click', closeRecord);
  $('#record-overlay').addEventListener('click', (e) => { if (e.target.id === 'record-overlay') closeRecord(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRecord(); });

  window.addEventListener('resize', applyZoom);
}

/**
 * Service Worker を登録して、通信が切れてもリロードできるようにする（要件 7.4）。
 * file:// で直接開いた場合や未対応ブラウザでは登録できないが、動作には影響しない。
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 登録できなくても続行する */ });
  });
}

/* ===========================================================
 * 起動
 * =========================================================== */
load();
bindEvents();
render();
registerServiceWorker();

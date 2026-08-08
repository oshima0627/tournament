/* ===========================================================
 * トーナメント表メーカー
 * - 参加者は何名でもOK（2の累乗でない場合は自動でシード／不戦勝）
 * - 名前をクリックするだけで勝敗を記録
 * - localStorage / URL / JSON / PNG / SVG / 印刷 に対応
 * 依存ライブラリなし・ビルド不要
 * =========================================================== */
'use strict';

/* ---------- 小さなユーティリティ ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

let _uid = 0;
const newId = () => 'p' + (++_uid).toString(36) + Math.random().toString(36).slice(2, 6);

/* トーナメント表のレイアウト定数（style.css の :root と一致させること） */
const LAYOUT = {
  MATCH_W: 210,   // 対戦カードの幅
  SLOT_H: 36,     // 1名分の高さ
  V_GAP: 22,      // 1回戦のカード同士の縦の間隔
  COL_GAP: 64,    // ラウンド間の横の間隔
  LABEL_H: 26,    // ラウンド名の高さ
  THIRD_GAP: 46,  // 3位決定戦を置くための余白
};
LAYOUT.MATCH_H = LAYOUT.SLOT_H * 2;

const STORAGE_KEY = 'tournament-maker:v1';

/* ===========================================================
 * 状態
 * =========================================================== */

function createDefaultState() {
  const names = ['Aチーム', 'Bチーム', 'Cチーム', 'Dチーム', 'Eチーム', 'Fチーム'];
  const players = names.map((name) => ({ id: newId(), name }));
  return {
    version: 1,
    title: 'トーナメント表',
    players,          // [{id, name}] この並び順がそのままブラケットの配置になる
    thirdPlace: true,
    showScore: false,
    zoom: 100,
    results: {},      // matchId -> { w: playerId|null, s: { playerId: number } }
  };
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
      const winner = ids.has(r.w) ? r.w : null;
      if (winner || Object.keys(scores).length) results[mid] = { w: winner, s: scores };
    }
  }

  return {
    version: 1,
    title: typeof raw.title === 'string' ? raw.title : base.title,
    players,
    thirdPlace: !!raw.thirdPlace,
    showScore: !!raw.showScore,
    zoom: clamp(Number(raw.zoom) || 100, 40, 150),
    results,
  };
}

/* ===========================================================
 * ブラケットの構築
 * =========================================================== */

/**
 * サイズ size のトーナメントにおける「スロット順のシード番号」を返す。
 * 例) size=8 -> [1,8,4,5,2,7,3,6]（強いシード同士が決勝まで当たらない標準配置）
 */
function seedSlots(size) {
  let arr = [1];
  while (arr.length < size) {
    const n = arr.length * 2;
    const next = [];
    for (const s of arr) {
      next.push(s);
      next.push(n + 1 - s);
    }
    arr = next;
  }
  return arr;
}

/** ブラケットに入れる参加者IDの配列（リストの並び順＝シード順） */
function entrantIds() {
  return state.players.map((p) => p.id);
}

/**
 * トーナメントの骨組みを作る。
 * 参加者が2の累乗でない場合、上位シードが自動的に1回戦免除（不戦勝）になる。
 */
function buildBracket(ids) {
  const n = ids.length;
  if (n < 2) return null;

  let size = 2;
  while (size < n) size *= 2;

  const slotPlayers = seedSlots(size).map((seed) => (seed <= n ? ids[seed - 1] : null));

  const rounds = [];
  const first = [];
  for (let i = 0; i < size / 2; i++) {
    first.push({
      id: `0-${i}`, round: 0, index: i,
      src: [{ t: 'p', v: slotPlayers[i * 2] }, { t: 'p', v: slotPlayers[i * 2 + 1] }],
    });
  }
  rounds.push(first);

  for (let r = 1; rounds[r - 1].length > 1; r++) {
    const prev = rounds[r - 1];
    const cur = [];
    for (let i = 0; i < prev.length / 2; i++) {
      cur.push({
        id: `${r}-${i}`, round: r, index: i,
        src: [{ t: 'm', v: prev[i * 2].id }, { t: 'm', v: prev[i * 2 + 1].id }],
      });
    }
    rounds.push(cur);
  }

  return { rounds, size, n };
}

/**
 * 記録済みの勝敗を反映して各試合の出場者・勝者・敗者を確定させる。
 * 参加者の入れ替えなどで無効になった結果はここで自動的に破棄する。
 */
/**
 * 出場者が変わって無効になった記録を整理する。
 * 勝者だけを取り消し、その試合に関係なくなったスコアも捨てる。
 * 記録が空になったら削除する。
 */
function pruneResult(matchId, players) {
  const rec = state.results[matchId];
  if (!rec) return null;
  if (rec.w && !players.includes(rec.w)) rec.w = null;
  if (rec.s) {
    for (const pid of Object.keys(rec.s)) if (!players.includes(pid)) delete rec.s[pid];
  }
  if (!rec.w && (!rec.s || Object.keys(rec.s).length === 0)) {
    delete state.results[matchId];
    return null;
  }
  return rec;
}

function resolveBracket(br) {
  const info = {};

  for (const round of br.rounds) {
    for (const m of round) {
      const players = m.src.map((s) => (s.t === 'p' ? s.v : (info[s.v] ? info[s.v].winner : null)));
      const present = players.filter(Boolean);
      const stored = pruneResult(m.id, present);

      let winner = null;
      let bye = false;

      if (present.length === 2) {
        if (stored && stored.w) winner = stored.w;
      } else if (m.round === 0 && present.length === 1) {
        // 1回戦で相手がいない場合のみ不戦勝で自動的に勝ち上がる
        winner = present[0];
        bye = true;
      }

      const loser = winner && present.length === 2 ? players.find((p) => p && p !== winner) : null;
      info[m.id] = { match: m, players, winner, loser, bye, decided: !!winner };
    }
  }

  // 3位決定戦（準決勝の敗者同士）
  let third = null;
  const R = br.rounds.length;
  if (state.thirdPlace && R >= 2) {
    const sf = br.rounds[R - 2];
    const players = [info[sf[0].id].loser || null, info[sf[1].id].loser || null];
    const present = players.filter(Boolean);
    const stored = pruneResult('tp', present);
    const winner = present.length === 2 && stored && stored.w ? stored.w : null;
    const loser = winner ? players.find((p) => p && p !== winner) : null;
    const match = { id: 'tp', round: R - 1, index: 0, third: true, src: [] };
    third = { match, players, winner, loser, bye: false, decided: !!winner };
    info.tp = third;
  }

  // 現在のブラケットに存在しない試合の記録は捨てる
  // （人数が減ったあとも古い結果が残り続けるのを防ぐ。3位決定戦はON/OFFで消えないよう残す）
  const valid = new Set(br.rounds.flat().map((m) => m.id));
  valid.add('tp');
  for (const id of Object.keys(state.results)) if (!valid.has(id)) delete state.results[id];

  return { info, third };
}

/* ===========================================================
 * 座標計算（HTML描画・SVG書き出しで共用）
 * =========================================================== */

function computeLayout(br, hasThird) {
  const { MATCH_W, MATCH_H, SLOT_H, V_GAP, COL_GAP, LABEL_H, THIRD_GAP } = LAYOUT;
  const pos = {};

  br.rounds.forEach((round, r) => {
    round.forEach((m, i) => {
      const x = r * (MATCH_W + COL_GAP);
      let cy;
      if (r === 0) {
        cy = LABEL_H + i * (MATCH_H + V_GAP) + MATCH_H / 2;
      } else {
        const a = pos[br.rounds[r - 1][i * 2].id].cy;
        const b = pos[br.rounds[r - 1][i * 2 + 1].id].cy;
        cy = (a + b) / 2;
      }
      pos[m.id] = { x, cy, top: cy - MATCH_H / 2 };
    });
  });

  const rounds = br.rounds.length;
  let width = rounds * MATCH_W + (rounds - 1) * COL_GAP;
  let height = LABEL_H + br.rounds[0].length * (MATCH_H + V_GAP) - V_GAP;

  // 優勝カードは決勝の右側に置く
  const finalPos = pos[br.rounds[rounds - 1][0].id];
  const champ = { x: finalPos.x + MATCH_W + COL_GAP, cy: finalPos.cy };
  width = champ.x + 190;

  if (hasThird) {
    const x = finalPos.x;
    const top = height + THIRD_GAP;
    pos.tp = { x, cy: top + MATCH_H / 2, top };
    height = top + MATCH_H;
  }

  return { pos, width, height, champ, slotH: SLOT_H, matchW: MATCH_W, matchH: MATCH_H };
}

/** ラウンド名（決勝／準決勝／準々決勝／n回戦） */
function roundLabel(r, total) {
  const fromEnd = total - 1 - r;
  if (fromEnd === 0) return '決勝';
  if (fromEnd === 1) return '準決勝';
  if (fromEnd === 2) return '準々決勝';
  return `${r + 1}回戦`;
}

/* ===========================================================
 * 描画
 * =========================================================== */

const dom = {
  bracket: $('#bracket'),
  scale: $('#bracket-scale'),
  emptyMsg: $('#empty-msg'),
  results: $('#results'),
  boardTitle: $('#board-title'),
};

let current = null; // { br, info, third, layout } 直近の描画結果（書き出しで再利用）

function nameOf(id) {
  const p = state.players.find((x) => x.id === id);
  return p ? p.name : '';
}

function render() {
  renderPlayerList();
  renderBracket();
  renderResults();
  syncControls();
  save();
}

function syncControls() {
  $('#title').value = state.title;
  $('#player-count').textContent = state.players.length;
  $('#opt-third').checked = state.thirdPlace;
  $('#opt-score').checked = state.showScore;
  $('#zoom').value = state.zoom;
  $('#zoom-label').textContent = state.zoom + '%';
  dom.boardTitle.textContent = state.title;
  document.title = state.title ? `${state.title} | トーナメント表メーカー` : 'トーナメント表メーカー';
}

/* ---------- 参加者リスト ---------- */
function renderPlayerList() {
  const list = $('#player-list');
  list.innerHTML = '';
  state.players.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'player-row';
    li.innerHTML = `
      <span class="no">${i + 1}</span>
      <input class="input" type="text" value="" aria-label="参加者${i + 1}の名前">
      <button type="button" class="icon-btn up" title="上へ">↑</button>
      <button type="button" class="icon-btn down" title="下へ">↓</button>
      <button type="button" class="icon-btn remove" title="削除">✕</button>`;
    const input = $('input', li);
    input.value = p.name;
    input.addEventListener('input', () => { p.name = input.value; renderBracket(); renderResults(); save(); });
    $('.up', li).addEventListener('click', () => movePlayer(i, -1));
    $('.down', li).addEventListener('click', () => movePlayer(i, 1));
    $('.remove', li).addEventListener('click', () => removePlayer(p.id));
    list.appendChild(li);
  });
}

/* ---------- トーナメント表 ---------- */
function renderBracket() {
  const ids = entrantIds();
  const br = buildBracket(ids);
  dom.bracket.innerHTML = '';

  if (!br) {
    current = null;
    dom.emptyMsg.hidden = false;
    dom.scale.style.height = '0px';
    return;
  }
  dom.emptyMsg.hidden = true;

  const { info, third } = resolveBracket(br);
  const layout = computeLayout(br, !!third);
  current = { br, info, third, layout };

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
    label.textContent = roundLabel(r, br.rounds.length);
    label.style.left = layout.pos[round[0].id].x + 'px';
    label.style.top = '0px';
    dom.bracket.appendChild(label);
  });

  // 対戦カード
  for (const round of br.rounds) {
    for (const m of round) dom.bracket.appendChild(matchEl(info[m.id], layout));
  }
  if (third) {
    const tp = layout.pos.tp;
    const tag = document.createElement('div');
    tag.className = 'match-tag';
    tag.textContent = '3位決定戦';
    tag.style.left = tp.x + 'px';
    tag.style.top = (tp.top - 20) + 'px';
    dom.bracket.appendChild(tag);
    dom.bracket.appendChild(matchEl(third, layout));
  }

  // 優勝カード
  const finalInfo = info[br.rounds[br.rounds.length - 1][0].id];
  const champ = document.createElement('div');
  champ.className = 'champion';
  champ.style.left = layout.champ.x + 'px';
  champ.style.top = (layout.champ.cy - 22) + 'px';
  champ.innerHTML = `<span class="cup">🏆</span><span><span class="label">優勝</span><br>${
    finalInfo.winner ? escapeHtml(nameOf(finalInfo.winner)) : '—'}</span>`;
  dom.bracket.appendChild(champ);

  applyZoom();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 対戦カード1枚を作る */
function matchEl(mi, layout) {
  const p = layout.pos[mi.match.id];
  const box = document.createElement('div');
  box.className = 'match' + (mi.match.third ? ' third' : '');
  box.style.left = p.x + 'px';
  box.style.top = p.top + 'px';

  mi.players.forEach((pid, slot) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isWinner = pid && pid === mi.winner;
    const isLoser = pid && mi.winner && pid !== mi.winner;
    const selectable = !!pid && mi.players.filter(Boolean).length === 2;

    btn.className = 'slot'
      + (isWinner ? ' win' : '')
      + (isLoser ? ' lose' : '')
      + (!pid ? (mi.bye ? ' bye' : ' empty') : '')
      + (selectable ? '' : ' disabled');

    const label = pid ? nameOf(pid) : (mi.bye ? '不戦勝' : '未定');
    btn.innerHTML = `<span class="mark">${isWinner ? '✔' : ''}</span><span class="nm"></span>`;
    $('.nm', btn).textContent = label;
    btn.title = pid ? `${label} を勝者にする` : '';

    if (state.showScore && pid) {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'score';
      input.value = (state.results[mi.match.id]?.s?.[pid] ?? '');
      input.placeholder = '-';
      input.setAttribute('aria-label', `${label} のスコア`);
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('change', () => setScore(mi.match.id, pid, input.value));
      btn.appendChild(input);
    }

    if (selectable) btn.addEventListener('click', () => toggleWinner(mi.match.id, pid));
    box.appendChild(btn);
  });

  return box;
}

/** ラウンド間の接続線（dy: 縦方向のオフセット。画像書き出しで使う） */
function connectorPaths(br, info, layout, dy = 0) {
  const out = [];
  const { MATCH_W } = LAYOUT;
  for (let r = 1; r < br.rounds.length; r++) {
    for (const m of br.rounds[r]) {
      const parent = layout.pos[m.id];
      const midX = parent.x - LAYOUT.COL_GAP / 2;
      for (const src of m.src) {
        const child = layout.pos[src.v];
        const done = !!(info[src.v] && info[src.v].winner);
        out.push({
          d: `M ${child.x + MATCH_W} ${child.cy + dy} H ${midX} V ${parent.cy + dy} H ${parent.x}`,
          done,
        });
      }
    }
  }
  // 決勝 → 優勝カード
  const finalMatch = br.rounds[br.rounds.length - 1][0];
  const fp = layout.pos[finalMatch.id];
  out.push({
    d: `M ${fp.x + MATCH_W} ${fp.cy + dy} H ${layout.champ.x}`,
    done: !!info[finalMatch.id].winner,
  });
  return out;
}

/* ---------- 結果パネル ---------- */
function renderResults() {
  dom.results.innerHTML = '';
  if (!current) return;

  const { br, info, third } = current;
  const R = br.rounds.length;
  const finalInfo = info[br.rounds[R - 1][0].id];

  // 表彰台
  const podium = document.createElement('div');
  podium.className = 'podium';
  const items = [
    ['優勝', finalInfo.winner, 'p1'],
    ['準優勝', finalInfo.loser, 'p2'],
  ];
  if (R >= 2) {
    if (state.thirdPlace) {
      items.push(['第3位', third && third.winner, 'p3']);
    } else {
      const sf = br.rounds[R - 2];
      const losers = [info[sf[0].id].loser, info[sf[1].id].loser].filter(Boolean);
      items.push(['ベスト4', losers.length ? losers.map(nameOf).join(' / ') : null, 'p3']);
    }
  }
  for (const [rank, who, cls] of items) {
    const div = document.createElement('div');
    div.className = 'podium-item ' + cls;
    const name = !who ? '—' : (typeof who === 'string' && state.players.some((p) => p.id === who) ? nameOf(who) : who);
    div.innerHTML = `<div class="rank">${rank}</div><div class="who"></div>`;
    $('.who', div).textContent = name;
    podium.appendChild(div);
  }
  dom.results.appendChild(podium);

  // 戦績表
  const stats = computeStats(br, info, third);
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

/** 参加者ごとの勝敗と最終状況を集計する */
function computeStats(br, info, third) {
  const R = br.rounds.length;
  const stats = new Map();
  for (const p of state.players) {
    stats.set(p.id, { id: p.id, name: p.name, win: 0, lose: 0, lostRound: null, status: '出場中', statusClass: 'alive', rankKey: 0 });
  }

  const all = br.rounds.flat().map((m) => info[m.id]);
  if (third) all.push(third);

  for (const mi of all) {
    if (!mi.winner) continue;
    const w = stats.get(mi.winner);
    if (w && !mi.bye) w.win++;             // 不戦勝は勝ち数に数えない
    if (mi.loser) {
      const l = stats.get(mi.loser);
      if (l) {
        l.lose++;
        if (!mi.match.third) l.lostRound = mi.match.round;
      }
    }
  }

  const finalInfo = info[br.rounds[R - 1][0].id];
  for (const s of stats.values()) {
    if (finalInfo.winner === s.id) {
      s.status = '優勝'; s.statusClass = 'champ'; s.rankKey = 0;
    } else if (finalInfo.loser === s.id) {
      s.status = '準優勝'; s.statusClass = ''; s.rankKey = 1;
    } else if (third && third.winner === s.id) {
      s.status = '第3位'; s.statusClass = ''; s.rankKey = 2;
    } else if (s.lostRound !== null) {
      s.status = `${roundLabel(s.lostRound, R)}敗退`;
      s.statusClass = '';
      s.rankKey = 10 + (R - s.lostRound);
    } else {
      s.status = '出場中'; s.statusClass = 'alive'; s.rankKey = 5;
    }
  }

  return [...stats.values()].sort((a, b) =>
    a.rankKey - b.rankKey || b.win - a.win || a.name.localeCompare(b.name, 'ja'));
}

/* ===========================================================
 * 操作
 * =========================================================== */

function toggleWinner(matchId, playerId) {
  const cur = state.results[matchId];
  if (cur && cur.w === playerId) {
    delete state.results[matchId];        // 同じ人をもう一度押したら取り消し
  } else {
    state.results[matchId] = { w: playerId, s: (cur && cur.s) || {} };
  }
  renderBracket();
  renderResults();
  save();
}

function setScore(matchId, playerId, value) {
  const rec = state.results[matchId] || (state.results[matchId] = { w: null, s: {} });
  rec.s = rec.s || {};
  if (value === '' || value === null) delete rec.s[playerId];
  else rec.s[playerId] = Number(value);
  if (!rec.w && Object.keys(rec.s).length === 0) delete state.results[matchId];
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

/** 組み合わせ抽選（Fisher–Yates） */
function shuffleOrder() {
  if (state.players.length < 2) return;
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

function resetResults() {
  state.results = {};
  render();
  toast('勝敗をリセットしました');
}

function applyZoom() {
  const z = state.zoom / 100;
  dom.scale.style.transform = `scale(${z})`;
  if (current) {
    dom.scale.style.width = current.layout.width * z + 'px';
    dom.scale.style.height = current.layout.height * z + 'px';
  }
}

/* ===========================================================
 * 保存・読み込み・書き出し
 * =========================================================== */

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) { /* プライベートモードなどでは無視 */ }
}

function load() {
  const fromHash = readHash();
  if (fromHash) {
    state = sanitize(fromHash);
    history.replaceState(null, '', location.pathname + location.search);
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

function readHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h.startsWith('t=')) return null;
  try {
    return decodeState(h.slice(2));
  } catch (_) {
    return null;
  }
}

function shareUrl() {
  const url = `${location.origin}${location.pathname}#t=${encodeState()}`;
  navigator.clipboard?.writeText(url).then(
    () => toast('URLをコピーしました'),
    () => window.prompt('このURLをコピーしてください', url)
  );
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
  return (state.title || 'tournament').replace(/[\\/:*?"<>|]/g, '_');
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

/* ---------- 画像書き出し（自前でSVGを組み立てる） ---------- */
function buildSvg() {
  if (!current) return null;
  const { br, info, third, layout } = current;
  const { MATCH_W, MATCH_H, SLOT_H } = LAYOUT;
  const W = layout.width;
  const H = layout.height + 46;
  const OY = 40; // タイトル分の余白

  const parts = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<text x="${W / 2}" y="26" text-anchor="middle" font-size="20" font-weight="bold" fill="#1d2430">${escapeXml(state.title)}</text>`);

  for (const { d, done } of connectorPaths(br, info, layout, OY)) {
    parts.push(`<path d="${d}" fill="none" stroke="${done ? '#16a34a' : '#b9c3d6'}" stroke-width="2"/>`);
  }

  br.rounds.forEach((round, r) => {
    const x = layout.pos[round[0].id].x;
    parts.push(`<text x="${x + MATCH_W / 2}" y="${OY + 14}" text-anchor="middle" font-size="12" font-weight="bold" fill="#6b7688">${escapeXml(roundLabel(r, br.rounds.length))}</text>`);
  });

  const drawMatch = (mi, tag) => {
    const p = layout.pos[mi.match.id];
    const y = p.top + OY;
    if (tag) parts.push(`<text x="${p.x}" y="${y - 6}" font-size="11" font-weight="bold" fill="#6b7688">${escapeXml(tag)}</text>`);
    parts.push(`<rect x="${p.x}" y="${y}" width="${MATCH_W}" height="${MATCH_H}" rx="8" fill="#ffffff" stroke="#b9c3d6"${mi.match.third ? ' stroke-dasharray="5 4"' : ''}/>`);
    parts.push(`<line x1="${p.x}" y1="${y + SLOT_H}" x2="${p.x + MATCH_W}" y2="${y + SLOT_H}" stroke="#d9dfeb"/>`);
    mi.players.forEach((pid, i) => {
      const sy = y + i * SLOT_H;
      const isWin = pid && pid === mi.winner;
      const isLose = pid && mi.winner && pid !== mi.winner;
      const label = pid ? nameOf(pid) : (mi.bye ? '不戦勝' : '未定');
      if (isWin) parts.push(`<rect x="${p.x + 1}" y="${sy + (i === 0 ? 1 : 0)}" width="${MATCH_W - 2}" height="${SLOT_H - 1}" fill="#e8f7ee"/>`);
      const color = isWin ? '#10692f' : isLose ? '#94a3b8' : pid ? '#1d2430' : '#a8b1c1';
      parts.push(`<text x="${p.x + 24}" y="${sy + SLOT_H / 2 + 5}" font-size="14" fill="${color}"${isWin ? ' font-weight="bold"' : ''}${isLose ? ' text-decoration="line-through"' : ''}>${escapeXml(truncate(label, 15))}</text>`);
      if (isWin) parts.push(`<text x="${p.x + 8}" y="${sy + SLOT_H / 2 + 5}" font-size="12" fill="#16a34a">✔</text>`);
      const score = state.results[mi.match.id]?.s?.[pid];
      if (state.showScore && pid && score !== undefined) {
        parts.push(`<text x="${p.x + MATCH_W - 10}" y="${sy + SLOT_H / 2 + 5}" text-anchor="end" font-size="13" fill="${color}">${escapeXml(score)}</text>`);
      }
    });
  };

  for (const round of br.rounds) for (const m of round) drawMatch(info[m.id], null);
  if (third) drawMatch(third, '3位決定戦');

  const finalInfo = info[br.rounds[br.rounds.length - 1][0].id];
  const cx = layout.champ.x;
  const cy = layout.champ.cy + OY;
  parts.push(`<rect x="${cx}" y="${cy - 24}" width="180" height="48" rx="10" fill="#fffbe9" stroke="#d9a300" stroke-width="2"/>`);
  parts.push(`<text x="${cx + 14}" y="${cy - 6}" font-size="10" font-weight="bold" fill="#d9a300">優勝</text>`);
  parts.push(`<text x="${cx + 14}" y="${cy + 14}" font-size="15" font-weight="bold" fill="#1d2430">${escapeXml(truncate(finalInfo.winner ? nameOf(finalInfo.winner) : '—', 13))}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">${parts.join('')}</svg>`;
}

function truncate(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function exportSvg() {
  const svg = buildSvg();
  if (!svg) return toast('先に参加者を追加してください');
  download(new Blob([svg], { type: 'image/svg+xml' }), safeFilename() + '.svg');
}

function exportPng() {
  const svg = buildSvg();
  if (!svg) return toast('先に参加者を追加してください');
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

/* ---------- トースト ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ===========================================================
 * イベント登録
 * =========================================================== */

function bindEvents() {
  $('#title').addEventListener('input', (e) => {
    state.title = e.target.value;
    dom.boardTitle.textContent = state.title;
    document.title = state.title ? `${state.title} | トーナメント表メーカー` : 'トーナメント表メーカー';
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
  $('#btn-clear-players').addEventListener('click', () => {
    if (!state.players.length || !confirm('参加者をすべて削除しますか？')) return;
    state.players = [];
    state.results = {};
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
    if (Object.keys(state.results).length && confirm('記録した勝敗をすべて消しますか？')) resetResults();
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

  window.addEventListener('hashchange', () => {
    const s = readHash();
    if (s) {
      state = sanitize(s);
      history.replaceState(null, '', location.pathname + location.search);
      render();
    }
  });
}

/* ===========================================================
 * 起動
 * =========================================================== */
load();
bindEvents();
render();

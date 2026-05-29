// =============================================================
// 메인 앱 (Phase 2: Supabase 연동)
// - 데이터 소스: point_events 테이블 (Supabase)
// - 사용자 식별: URL hash (#slug)
// - 저장: 모든 변경은 RPC로 즉시 반영, 로컬은 캐시만
// =============================================================

let data         = null;          // data.json (활동 정의)
let userSlug     = null;          // 현재 URL slug
let userNickname = null;          // 현재 사용자 닉네임

// state.history: { 'bucket:id': [{id: uuid, occurred_at: 'YYYY-MM-DD'}, ...] }
// state[bucket][id]: 현재 기간 카운트 (history에서 derive)
let state = { limited: {}, daily: {}, monthly: {}, history: {} };

// ─── 날짜 유틸 ────────────────────────────────────────────
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function getDatePart(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ─── 데이터 로드 ──────────────────────────────────────────
async function loadDataJson() {
  try {
    const res = await fetch('data.json');
    data = await res.json();
  } catch (e) {
    alert('data.json 로드 실패. 로컬 서버(Live Server)로 실행해주세요.');
    console.error(e);
  }
}

async function loadUserData(slug) {
  const result = await callRpc('get_my_data', { p_slug: slug });
  userSlug     = slug;
  userNickname = result.nickname || null;

  // events → state.history 재구성
  state.history = {};
  for (const ev of (result.events || [])) {
    const key = historyKey(ev.bucket, ev.activity_id);
    if (!state.history[key]) state.history[key] = [];
    state.history[key].push({ id: ev.id, occurred_at: ev.occurred_at });
  }
  recomputeCounters();
}

// ─── 카운터 재계산 (history에서 derive) ───────────────────
function recomputeCounters() {
  const td = todayKey();
  const mk = monthKey();
  state.limited = {};
  state.daily   = {};
  state.monthly = {};
  for (const key of Object.keys(state.history)) {
    const [bucket, id] = key.split(':');
    let count = 0;
    for (const entry of state.history[key]) {
      const date = entry.occurred_at;
      if (bucket === 'limited') count++;
      else if (bucket === 'daily'   && date === td)             count++;
      else if (bucket === 'monthly' && date.startsWith(mk))     count++;
    }
    if (state[bucket]) state[bucket][id] = count;
  }
}

// ─── 헬퍼 ─────────────────────────────────────────────────
function historyKey(bucket, id) { return `${bucket}:${id}`; }
function getHistory(bucket, id) { return state.history[historyKey(bucket, id)] || []; }
function getLimitedCount(id)    { return state.limited[id] || 0; }

function getActivity(bucket, id) {
  const list = data[bucket];
  if (!list) return null;
  return list.find(x => x.id === id) || null;
}

function isCurrentPeriod(bucket, dateStr) {
  if (bucket === 'limited') return true;
  if (bucket === 'daily')   return dateStr === todayKey();
  if (bucket === 'monthly') return dateStr.startsWith(monthKey());
  return false;
}

// ─── 변경 작업 (모두 RPC 호출 후 로컬 반영) ───────────────
async function changeCount(bucket, id, delta, max) {
  const activity = getActivity(bucket, id);
  if (!activity) return;
  const key   = historyKey(bucket, id);
  const list  = state.history[key] || (state.history[key] = []);

  if (delta > 0) {
    const current = state[bucket][id] || 0;
    if (current >= max) return;
    const dateStr = todayKey();
    try {
      const newId = await callRpc('add_point_event', {
        p_slug:        userSlug,
        p_bucket:      bucket,
        p_activity_id: id,
        p_occurred_at: dateStr,
        p_point:       activity.point,
      });
      list.push({ id: newId, occurred_at: dateStr });
    } catch (e) { alert(`저장 실패: ${e.message}`); return; }

  } else if (delta < 0 && list.length > 0) {
    // 가장 최근 (occurred_at 기준) 1건 제거
    const sorted = [...list].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    const last = sorted[sorted.length - 1];
    try {
      await callRpc('delete_point_event', { p_slug: userSlug, p_event_id: last.id });
      state.history[key] = list.filter(e => e.id !== last.id);
    } catch (e) { alert(`삭제 실패: ${e.message}`); return; }
  } else {
    return;
  }

  recomputeCounters();
  render();
}

async function addPastEntry(bucket, id, max, dateString) {
  const activity = getActivity(bucket, id);
  if (!activity) return;
  if (isCurrentPeriod(bucket, dateString)) {
    const current = state[bucket][id] || 0;
    if (current >= max) { alert('이미 최대치예요. 더 추가할 수 없어요.'); return; }
  }
  try {
    const newId = await callRpc('add_point_event', {
      p_slug:        userSlug,
      p_bucket:      bucket,
      p_activity_id: id,
      p_occurred_at: dateString,
      p_point:       activity.point,
    });
    const key = historyKey(bucket, id);
    if (!state.history[key]) state.history[key] = [];
    state.history[key].push({ id: newId, occurred_at: dateString });
  } catch (e) { alert(`저장 실패: ${e.message}`); return; }

  recomputeCounters();
  render();
}

async function deleteHistoryEntry(bucket, id, eventId) {
  const key = historyKey(bucket, id);
  const arr = state.history[key];
  if (!arr || arr.length === 0) return;
  try {
    await callRpc('delete_point_event', { p_slug: userSlug, p_event_id: eventId });
    state.history[key] = arr.filter(e => e.id !== eventId);
  } catch (e) { alert(`삭제 실패: ${e.message}`); return; }
  recomputeCounters();
  render();
}

// ─── 집계 (history 기반) ──────────────────────────────────
function calcTotal() {
  let total = 0, today = 0, month = 0;
  const td = todayKey();
  const mk = monthKey();

  const pointMap = {};
  data.limited.forEach(a => { pointMap['limited:' + a.id] = a.point; });
  data.daily  .forEach(a => { pointMap['daily:'   + a.id] = a.point; });
  data.monthly.forEach(a => { pointMap['monthly:' + a.id] = a.point; });

  for (const key of Object.keys(state.history)) {
    const point = pointMap[key];
    if (!point) continue;
    for (const entry of state.history[key]) {
      total += point;
      if (entry.occurred_at === td)            today += point;
      if (entry.occurred_at.startsWith(mk))    month += point;
    }
  }
  return { total, today, month };
}

function formatPoint(n) { return n.toLocaleString() + 'P'; }

// ─── 렌더 ─────────────────────────────────────────────────
function renderSummary() {
  const t = calcTotal();
  document.getElementById('totalPoints').textContent = formatPoint(t.total);
  document.getElementById('todayPoints').textContent = formatPoint(t.today);
  document.getElementById('monthPoints').textContent = formatPoint(t.month);

  const done = data.limited.filter(a => getLimitedCount(a.id) >= a.max).length;
  document.getElementById('limitedDone').textContent  = done;
  document.getElementById('limitedTotal').textContent = data.limited.length;
}

const expanded = new Set();

function makeItem(activity, bucket, maxKey) {
  const max     = activity[maxKey];
  const count   = state[bucket][activity.id] || 0;
  const done    = count >= max;
  const key     = historyKey(bucket, activity.id);
  const history = getHistory(bucket, activity.id);
  const isOpen  = expanded.has(key);

  const li = document.createElement('li');
  li.className = 'activity-item' + (done ? ' done' : '') + (isOpen ? ' open' : '');

  const sortedHistory = [...history].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const historyHtml = sortedHistory.length
    ? sortedHistory.map((e, i) =>
        `<li><span class="hist-text">${i + 1}. ${e.occurred_at}</span><button class="hist-del" data-action="del-hist" data-event-id="${e.id}" title="이 기록 삭제">×</button></li>`
      ).reverse().join('')
    : '<li class="empty">아직 요청한 기록이 없어요.</li>';

  li.innerHTML = `
    <div class="activity-row">
      <div class="activity-info" data-action="toggle">
        <div class="activity-name">${activity.name} <span class="chev">${isOpen ? '▾' : '▸'}</span></div>
        <div class="activity-meta">${activity.note}</div>
        <div class="activity-point">${formatPoint(activity.point)} × ${max}회</div>
      </div>
      <div class="counter">
        <button data-action="dec" ${count <= 0 ? 'disabled' : ''}>-</button>
        <div class="count">${count} / ${max}</div>
        <button data-action="inc" ${count >= max ? 'disabled' : ''}>+</button>
      </div>
    </div>
    <div class="history" ${isOpen ? '' : 'hidden'}>
      <div class="history-title">포인트 요청 (${history.length}건) · 승인 대기중</div>
      <ul class="history-list">${historyHtml}</ul>
      <div class="history-add">
        <input type="date" data-action="past-time" />
        <button data-action="add-past" ${bucket === 'limited' && count >= max ? 'disabled' : ''}>지난 요청 추가</button>
      </div>
    </div>
  `;

  li.querySelector('[data-action=inc]').addEventListener('click', () => changeCount(bucket, activity.id, 1, max));
  li.querySelector('[data-action=dec]').addEventListener('click', () => changeCount(bucket, activity.id, -1, max));
  li.querySelector('[data-action=toggle]').addEventListener('click', () => {
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
    render();
  });
  const dateInput = li.querySelector('[data-action=past-time]');
  if (dateInput) {
    dateInput.addEventListener('click', () => { try { dateInput.showPicker && dateInput.showPicker(); } catch (e) {} });
    dateInput.addEventListener('focus', () => { try { dateInput.showPicker && dateInput.showPicker(); } catch (e) {} });
  }
  li.querySelectorAll('[data-action=del-hist]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryEntry(bucket, activity.id, btn.dataset.eventId);
    });
  });
  const addBtn = li.querySelector('[data-action=add-past]');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const input = li.querySelector('[data-action=past-time]');
      const val = input.value;
      if (!val) { alert('날짜를 선택해주세요.'); return; }
      addPastEntry(bucket, activity.id, max, val);
    });
  }
  return li;
}

function renderLists() {
  const limitedEl = document.getElementById('limitedList');
  const dailyEl   = document.getElementById('dailyList');
  const monthlyEl = document.getElementById('monthlyList');
  const usageEl   = document.getElementById('usageList');

  limitedEl.innerHTML = '';
  data.limited.forEach(a => limitedEl.appendChild(makeItem(a, 'limited', 'max')));

  dailyEl.innerHTML = '';
  data.daily.forEach(a => dailyEl.appendChild(makeItem(a, 'daily', 'perDay')));

  monthlyEl.innerHTML = '';
  data.monthly.forEach(a => monthlyEl.appendChild(makeItem(a, 'monthly', 'perMonth')));

  usageEl.innerHTML = '';
  data.usage.forEach(u => {
    const li = document.createElement('li');
    li.className = 'usage-item';
    li.innerHTML = `<span class="usage-name">${u.name}</span><span class="usage-limit">한도 ${formatPoint(u.limit)}</span>`;
    usageEl.appendChild(li);
  });
}

function render() { renderSummary(); renderLists(); }

// ─── UI 셋업 ──────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });
}

function setupReset() {
  document.getElementById('resetBtn').addEventListener('click', async () => {
    if (!confirm('모든 활동 기록을 초기화할까요? (복구 불가)')) return;
    await bulkDelete(Object.values(state.history).flat().map(e => e.id));
  });
  document.getElementById('resetTodayBtn').addEventListener('click', async () => {
    if (!confirm('오늘 입력한 기록만 초기화할까요?')) return;
    const td = todayKey();
    const ids = Object.values(state.history).flat()
      .filter(e => e.occurred_at === td)
      .map(e => e.id);
    await bulkDelete(ids);
  });
}

async function bulkDelete(eventIds) {
  if (eventIds.length === 0) return;
  let failed = 0;
  for (const id of eventIds) {
    try { await callRpc('delete_point_event', { p_slug: userSlug, p_event_id: id }); }
    catch (e) { failed++; console.error(e); }
  }
  // 다시 로드 (안전하게 서버 기준으로 동기화)
  await loadUserData(userSlug);
  render();
  if (failed > 0) alert(`${failed}건 삭제 실패`);
}

function setupDateLabels() {
  document.getElementById('todayDate').textContent = todayKey();
  document.getElementById('thisMonth').textContent = monthKey();
}

// ─── 환영 화면 ────────────────────────────────────────────
function setupWelcome() {
  document.getElementById('directGoBtn').addEventListener('click', () => {
    const slug = document.getElementById('directSlug').value.trim();
    if (!slug) return;
    location.hash = slug;
    location.reload();
  });

  document.getElementById('findBtn').addEventListener('click', async () => {
    const naverId  = document.getElementById('findNaverId').value.trim();
    const nickname = document.getElementById('findNickname').value.trim();
    const errEl    = document.getElementById('findError');
    errEl.hidden = true;

    if (!naverId || !nickname) {
      errEl.textContent = '네이버ID와 닉네임을 모두 입력하세요.';
      errEl.hidden = false;
      return;
    }
    try {
      const slug = await callRpc('find_my_url', { p_naver_id: naverId, p_nickname: nickname });
      if (!slug) throw new Error('URL을 찾을 수 없습니다.');
      location.hash = slug;
      location.reload();
    } catch (e) {
      const msg = e.message.includes('not found')   ? '일치하는 URL을 찾을 수 없습니다.'
                : e.message.includes('ambiguous')   ? '동일 정보로 등록된 URL이 여러 개입니다. 관리자에게 문의하세요.'
                : e.message.includes('required')    ? '네이버ID와 닉네임을 모두 입력하세요.'
                : `오류: ${e.message}`;
      errEl.textContent = msg;
      errEl.hidden = false;
    }
  });
}

function showWelcome() {
  document.getElementById('appLoading').hidden = true;
  document.getElementById('appBody').hidden    = true;
  document.getElementById('welcome').hidden    = false;
  setupWelcome();
}

function showApp() {
  document.getElementById('appLoading').hidden = true;
  document.getElementById('welcome').hidden    = true;
  document.getElementById('appBody').hidden    = false;

  const info     = document.getElementById('userInfo');
  const nickEl   = document.getElementById('userNickname');
  const slugEl   = document.getElementById('userSlugLabel');
  nickEl.textContent = userNickname ? `${userNickname} 님` : '(닉네임 없음)';
  slugEl.textContent = `#${userSlug}`;
  info.hidden = false;
}

// ─── 초기화 ───────────────────────────────────────────────
async function init() {
  const slug = (location.hash || '').replace(/^#/, '').trim();

  await loadDataJson();
  if (!data) return;

  if (!slug) { showWelcome(); return; }

  try {
    await loadUserData(slug);
  } catch (e) {
    const msg = e.message.includes('not found')
      ? '유효하지 않은 URL입니다. URL을 다시 확인하거나 아래에서 본인 URL을 찾아주세요.'
      : `데이터 로드 실패: ${e.message}`;
    showWelcome();
    const errEl = document.getElementById('findError');
    errEl.textContent = msg;
    errEl.hidden = false;
    return;
  }

  setupTabs();
  setupReset();
  setupDateLabels();
  showApp();
  render();
}

// 해시 변경 시 재로드
window.addEventListener('hashchange', () => location.reload());

init();

const STORAGE_KEY = 'jw-points-v1';

let data = null;
let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (!s.history) s.history = {};
      return s;
    }
  } catch (e) {}
  return { limited: {}, daily: {}, monthly: {}, dailyDate: '', monthlyKey: '', history: {} };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {}
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function resetIfNeeded() {
  const td = todayKey();
  const mk = monthKey();
  if (state.dailyDate !== td) {
    state.daily = {};
    state.dailyDate = td;
  }
  if (state.monthlyKey !== mk) {
    state.monthly = {};
    state.monthlyKey = mk;
  }
  saveState();
}

async function loadData() {
  try {
    const res = await fetch('data.json');
    data = await res.json();
  } catch (e) {
    alert('data.json 로드 실패. 로컬 서버(예: VS Code Live Server)로 실행해주세요.');
    console.error(e);
  }
}

function getLimitedCount(id) {
  return state.limited[id] || 0;
}
function getDailyCount(id) {
  return state.daily[id] || 0;
}
function getMonthlyCount(id) {
  return state.monthly[id] || 0;
}

function historyKey(bucket, id) {
  return `${bucket}:${id}`;
}

function getHistory(bucket, id) {
  return state.history[historyKey(bucket, id)] || [];
}

function changeCount(bucket, id, delta, max) {
  const current = state[bucket][id] || 0;
  const next = Math.max(0, Math.min(max, current + delta));
  if (next === current) return;
  state[bucket][id] = next;
  const key = historyKey(bucket, id);
  if (!state.history[key]) state.history[key] = [];
  if (delta > 0) {
    state.history[key].push(new Date().toISOString());
  } else if (delta < 0 && state.history[key].length > 0) {
    state.history[key].sort();
    state.history[key].pop();
  }
  saveState();
  render();
}

function addPastEntry(bucket, id, max, dateString) {
  const key = historyKey(bucket, id);
  if (!state.history[key]) state.history[key] = [];
  if (isCurrentPeriod(bucket, dateString)) {
    const current = state[bucket][id] || 0;
    if (current >= max) {
      alert('이미 최대치예요. 더 추가할 수 없어요.');
      return;
    }
    state[bucket][id] = current + 1;
  }
  state.history[key].push(dateString);
  state.history[key].sort();
  saveState();
  render();
}

function deleteHistoryEntry(bucket, id, value) {
  const key = historyKey(bucket, id);
  const arr = state.history[key];
  if (!arr || arr.length === 0) return;
  const idx = arr.indexOf(value);
  if (idx === -1) return;
  arr.splice(idx, 1);
  if (isCurrentPeriod(bucket, value)) {
    state[bucket][id] = Math.max(0, (state[bucket][id] || 0) - 1);
  }
  saveState();
  render();
}

function formatTime(value) {
  return getDatePart(value);
}

function getDatePart(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isCurrentPeriod(bucket, value) {
  if (bucket === 'limited') return true;
  const date = getDatePart(value);
  if (bucket === 'daily') return date === todayKey();
  if (bucket === 'monthly') return date.startsWith(monthKey());
  return false;
}

function calcTotal() {
  let limited = 0, daily = 0, monthly = 0;
  data.limited.forEach(a => { limited += getLimitedCount(a.id) * a.point; });
  data.daily.forEach(a => { daily += getDailyCount(a.id) * a.point; });
  data.monthly.forEach(a => { monthly += getMonthlyCount(a.id) * a.point; });
  return { limited, daily, monthly, total: limited + daily + monthly };
}

function formatPoint(n) {
  return n.toLocaleString() + 'P';
}

function renderSummary() {
  const t = calcTotal();
  document.getElementById('totalPoints').textContent = formatPoint(t.total);
  document.getElementById('todayPoints').textContent = formatPoint(t.daily);
  document.getElementById('monthPoints').textContent = formatPoint(t.daily + t.monthly);

  const done = data.limited.filter(a => getLimitedCount(a.id) >= a.max).length;
  document.getElementById('limitedDone').textContent = done;
  document.getElementById('limitedTotal').textContent = data.limited.length;
}

const expanded = new Set();

function makeItem(activity, bucket, maxKey) {
  const max = activity[maxKey];
  const count = state[bucket][activity.id] || 0;
  const done = count >= max;
  const key = historyKey(bucket, activity.id);
  const history = getHistory(bucket, activity.id);
  const isOpen = expanded.has(key);

  const li = document.createElement('li');
  li.className = 'activity-item' + (done ? ' done' : '') + (isOpen ? ' open' : '');

  const sortedHistory = [...history].sort();
  const historyHtml = sortedHistory.length
    ? sortedHistory.map((iso, i) => `<li><span class="hist-text">${i + 1}. ${formatTime(iso)}</span><button class="hist-del" data-action="del-hist" data-iso="${iso}" title="이 기록 삭제">×</button></li>`).reverse().join('')
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
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    render();
  });
  const dateInput = li.querySelector('[data-action=past-time]');
  if (dateInput) {
    dateInput.addEventListener('click', () => {
      try { dateInput.showPicker && dateInput.showPicker(); } catch (e) {}
    });
    dateInput.addEventListener('focus', () => {
      try { dateInput.showPicker && dateInput.showPicker(); } catch (e) {}
    });
  }
  li.querySelectorAll('[data-action=del-hist]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const iso = btn.dataset.iso;
      deleteHistoryEntry(bucket, activity.id, iso);
    });
  });
  const addBtn = li.querySelector('[data-action=add-past]');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const input = li.querySelector('[data-action=past-time]');
      const val = input.value;
      if (!val) {
        alert('날짜를 선택해주세요.');
        return;
      }
      addPastEntry(bucket, activity.id, max, val);
    });
  }
  return li;
}

function renderLists() {
  const limitedEl = document.getElementById('limitedList');
  const dailyEl = document.getElementById('dailyList');
  const monthlyEl = document.getElementById('monthlyList');
  const usageEl = document.getElementById('usageList');

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

function render() {
  renderSummary();
  renderLists();
}

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
  document.getElementById('resetBtn').addEventListener('click', () => {
    if (confirm('모든 활동 기록을 초기화할까요?')) {
      state = { limited: {}, daily: {}, monthly: {}, dailyDate: todayKey(), monthlyKey: monthKey(), history: {} };
      saveState();
      render();
    }
  });
  document.getElementById('resetTodayBtn').addEventListener('click', () => {
    if (!confirm('오늘 입력한 기록만 초기화할까요?')) return;
    const td = todayKey();
    Object.keys(state.history).forEach(key => {
      const [bucket, id] = key.split(':');
      const arr = state.history[key];
      const before = arr.length;
      state.history[key] = arr.filter(v => getDatePart(v) !== td);
      const removed = before - state.history[key].length;
      if (removed > 0 && (bucket === 'limited' || bucket === 'monthly')) {
        state[bucket][id] = Math.max(0, (state[bucket][id] || 0) - removed);
      }
    });
    state.daily = {};
    saveState();
    render();
  });
}

function setupDateLabels() {
  document.getElementById('todayDate').textContent = todayKey();
  document.getElementById('thisMonth').textContent = monthKey();
}

async function init() {
  await loadData();
  if (!data) return;
  resetIfNeeded();
  setupTabs();
  setupReset();
  setupDateLabels();
  render();
}

init();

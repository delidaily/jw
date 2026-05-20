const STORAGE_KEY = 'jw-points-v1';

let data = null;
let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { limited: {}, daily: {}, monthly: {}, dailyDate: '', monthlyKey: '' };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

function changeCount(bucket, id, delta, max) {
  const current = state[bucket][id] || 0;
  const next = Math.max(0, Math.min(max, current + delta));
  state[bucket][id] = next;
  saveState();
  render();
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

function makeItem(activity, bucket, maxKey) {
  const max = activity[maxKey];
  const count = state[bucket][activity.id] || 0;
  const done = count >= max;

  const li = document.createElement('li');
  li.className = 'activity-item' + (done ? ' done' : '');

  li.innerHTML = `
    <div class="activity-info">
      <div class="activity-name">${activity.name}</div>
      <div class="activity-meta">${activity.note}</div>
      <div class="activity-point">${formatPoint(activity.point)} × ${max}회</div>
    </div>
    <div class="counter">
      <button data-action="dec" ${count <= 0 ? 'disabled' : ''}>-</button>
      <div class="count">${count} / ${max}</div>
      <button data-action="inc" ${count >= max ? 'disabled' : ''}>+</button>
    </div>
  `;

  li.querySelector('[data-action=inc]').addEventListener('click', () => changeCount(bucket, activity.id, 1, max));
  li.querySelector('[data-action=dec]').addEventListener('click', () => changeCount(bucket, activity.id, -1, max));
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
      state = { limited: {}, daily: {}, monthly: {}, dailyDate: todayKey(), monthlyKey: monthKey() };
      saveState();
      render();
    }
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

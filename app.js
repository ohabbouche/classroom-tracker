// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const SUBJECTS = ['Spelling', 'Grammar', 'English', 'Maths', 'Handwriting'];
const TL_SCORE = { red: 1, amber: 2, green: 3 };
const TL_EMOJI = { red: '🔴', amber: '🟡', green: '🟢' };
const SETTINGS_KEY = 'ct_settings_v1';
const EXPANDED_KEY = 'ct_expanded';

// ─── STATE ─────────────────────────────────────────────────────────────────────
let S = {
  view: 'loading',          // loading | setup | daily | overview | reports | settings
  date: todayStr(),
  students: [],
  studentsSha: null,
  dailyLog: null,
  logSha: null,
  logDates: null,           // Set of date strings that have log files
  overviewMonth: null,      // { year, month } for the calendar
  reportPeriodStart: '',
  reportPeriodEnd: '',
  savedReports: null,       // loaded report data for current period
  savedReportsSha: null,
  settings: loadSettings(),
  expanded: new Set(),      // studentIds currently expanded
  saveTimer: null,
  savePending: false,
};

// ─── UTILITIES ─────────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function parseLocalDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(str) {
  const d = parseLocalDate(str);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtDateShort(str) {
  const d = parseLocalDate(str);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function dayName(str) {
  return parseLocalDate(str).toLocaleDateString('en-GB', { weekday: 'long' });
}

function shortDayName(str) {
  return parseLocalDate(str).toLocaleDateString('en-GB', { weekday: 'short' });
}

function shiftDate(str, delta) {
  const d = parseLocalDate(str);
  d.setDate(d.getDate() + delta);
  return d.toISOString().split('T')[0];
}

function initials(name) {
  return name.split(' ').map(p => p[0]).join('').toUpperCase().slice(0, 2);
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ─── SETTINGS ──────────────────────────────────────────────────────────────────
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch { return {}; }
}

function saveSettingsToStorage() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings));
}

function isSetupDone() {
  const s = S.settings;
  return !!(s.ghToken && s.dataOwner && s.dataRepo && s.claudeKey);
}

// ─── GITHUB API ────────────────────────────────────────────────────────────────
async function ghGet(path) {
  const { ghToken, dataOwner, dataRepo } = S.settings;
  const url = `https://api.github.com/repos/${dataOwner}/${dataRepo}/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `token ${ghToken}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });
  if (res.status === 404) return { content: null, sha: null };
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.message || `GitHub error ${res.status}`);
  }
  const data = await res.json();
  return {
    content: JSON.parse(atob(data.content.replace(/\s/g, ''))),
    sha: data.sha,
  };
}

async function ghPut(path, content, sha, message) {
  const { ghToken, dataOwner, dataRepo } = S.settings;
  const url = `https://api.github.com/repos/${dataOwner}/${dataRepo}/contents/${path}`;
  const body = { message, content: btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2)))) };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${ghToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.message || `GitHub write error ${res.status}`);
  }
  const data = await res.json();
  return data.content.sha;
}

async function ghList(path) {
  const { ghToken, dataOwner, dataRepo } = S.settings;
  const url = `https://api.github.com/repos/${dataOwner}/${dataRepo}/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `token ${ghToken}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });
  if (res.status === 404) return [];
  if (!res.ok) return [];
  return await res.json();
}

// ─── DATA LAYER ────────────────────────────────────────────────────────────────
async function loadStudents() {
  const { content, sha } = await ghGet('data/students.json');
  S.studentsSha = sha;
  S.students = content?.students || [];
}

async function persistStudents() {
  S.studentsSha = await ghPut(
    'data/students.json',
    { students: S.students },
    S.studentsSha,
    'Update students'
  );
}

function emptyLog(date) {
  return { date, entries: {} };
}

function ensureEntry(studentId) {
  if (!S.dailyLog.entries[studentId]) {
    S.dailyLog.entries[studentId] = {
      absentAllDay: false,
      lessons: Object.fromEntries(SUBJECTS.map(s => [s, { traffic: null, note: '' }])),
    };
  }
  return S.dailyLog.entries[studentId];
}

async function loadDailyLog() {
  const { content, sha } = await ghGet(`data/logs/${S.date}.json`);
  S.logSha = sha;
  S.dailyLog = content || emptyLog(S.date);
}

async function flushLog() {
  if (!S.dailyLog) return;
  S.logSha = await ghPut(
    `data/logs/${S.date}.json`,
    S.dailyLog,
    S.logSha,
    `Log ${S.date}`
  );
  if (S.logDates) S.logDates.add(S.date);
}

async function loadLogDates() {
  const files = await ghList('data/logs');
  S.logDates = new Set(
    files.filter(f => f.name.endsWith('.json')).map(f => f.name.replace('.json', ''))
  );
}

async function loadLogsForPeriod(start, end) {
  const files = await ghList('data/logs');
  const inRange = files.filter(f => {
    const d = f.name.replace('.json', '');
    return d >= start && d <= end;
  });
  const results = await Promise.all(
    inRange.map(f => ghGet(`data/logs/${f.name}`))
  );
  return results.map(r => r.content).filter(Boolean);
}

async function loadSavedReports(periodKey) {
  const { content, sha } = await ghGet(`data/reports/${periodKey}.json`);
  S.savedReportsSha = sha;
  S.savedReports = content || null;
  return content;
}

async function persistReports(periodKey, data) {
  S.savedReportsSha = await ghPut(
    `data/reports/${periodKey}.json`,
    data,
    S.savedReportsSha,
    `Reports ${periodKey}`
  );
  S.savedReports = data;
}

// ─── AUTO-SAVE ─────────────────────────────────────────────────────────────────
function scheduleSave() {
  S.savePending = true;
  setSavePill('pending');
  if (S.saveTimer) clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(doSave, 1800);
}

async function doSave() {
  S.saveTimer = null;
  setSavePill('saving');
  try {
    await flushLog();
    S.savePending = false;
    setSavePill('saved');
    setTimeout(() => setSavePill('idle'), 2000);
  } catch (e) {
    setSavePill('error');
    showToast('⚠️ Save failed — check connection');
    console.error(e);
  }
}

function setSavePill(state) {
  const el = document.getElementById('save-pill');
  if (!el) return;
  const map = { idle: '', pending: '...', saving: '↑', saved: 'Saved ✓', error: 'Error!' };
  el.textContent = map[state] || '';
  el.className = 'save-pill' + (state === 'saved' ? ' saved' : state === 'error' ? ' error' : '');
}

// ─── CLAUDE API ────────────────────────────────────────────────────────────────
async function callClaude(prompt) {
  const proxyUrl = S.settings.claudeProxyUrl || 'https://claude-proxy.omar-habbouche.workers.dev/';
  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      'x-api-key': S.settings.claudeKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || `Claude error ${res.status}`);
  }
  const data = await res.json();
  return data.content[0].text.trim();
}

// ─── REPORT GENERATION ─────────────────────────────────────────────────────────
function calcSubjectStats(student, logs) {
  const stats = {};
  for (const sub of SUBJECTS) {
    stats[sub] = { green: 0, amber: 0, red: 0, notes: [], scoreTotal: 0, scored: 0 };
  }
  let absent = 0;

  for (const log of logs) {
    const entry = log.entries?.[student.id];
    if (!entry) continue;
    if (entry.absentAllDay) { absent++; continue; }
    for (const sub of SUBJECTS) {
      const lesson = entry.lessons?.[sub];
      if (!lesson) continue;
      if (lesson.traffic) {
        stats[sub][lesson.traffic]++;
        stats[sub].scoreTotal += TL_SCORE[lesson.traffic];
        stats[sub].scored++;
      }
      if (lesson.note?.trim()) stats[sub].notes.push(lesson.note.trim());
    }
  }

  for (const sub of SUBJECTS) {
    stats[sub].avg = stats[sub].scored > 0
      ? stats[sub].scoreTotal / stats[sub].scored : 0;
  }

  return { stats, absent };
}

function pickTopSubjects(stats, exclude = []) {
  const ranked = SUBJECTS
    .filter(s => !exclude.includes(s))
    .map(s => ({ subject: s, avg: stats[s].avg, scored: stats[s].scored }))
    .sort((a, b) => b.avg - a.avg || b.scored - a.scored);

  if (ranked.length >= 2) return [ranked[0].subject, ranked[1].subject];
  // fallback: allow previously-used subjects if not enough candidates
  const all = SUBJECTS.map(s => ({ subject: s, avg: stats[s].avg }))
    .sort((a, b) => b.avg - a.avg);
  return [all[0].subject, all[1].subject];
}

function buildPrompt(student, stats, absent, topTwo, previousSubjects) {
  const subSummary = SUBJECTS.map(sub => {
    const st = stats[sub];
    const total = st.green + st.amber + st.red;
    if (total === 0) return `${sub}: no lessons recorded`;
    const perc = s => total > 0 ? Math.round((st[s] / total) * 100) : 0;
    let line = `${sub}: ${perc('green')}% green, ${perc('amber')}% amber, ${perc('red')}% red (${total} lessons)`;
    if (st.notes.length) line += `\n  Notes: ${st.notes.slice(0, 4).join(' | ')}`;
    return line;
  }).join('\n');

  return `You are writing an end-of-term school report for a primary school student. Use warm, professional language appropriate for parents of a primary school child. Write in third person using the student's first name.

Student: ${student.name.split(' ')[0]}
Days absent this period: ${absent}

Subject performance (traffic light: green = achieved well, amber = developing, red = needs more support):
${subSummary}

Previous report featured subjects (MUST NOT use these in Paragraph 2): ${previousSubjects.length ? previousSubjects.join(', ') : 'None — this is the first report'}
Paragraph 2 must feature: ${topTwo[0]} and ${topTwo[1]}

Write exactly 3 paragraphs totalling approximately 200 words. No headings, no bullet points — flowing prose only.

Paragraph 1 — Social skills & learning behaviours (exactly 3 sentences):
  • Sentence 1: Social and emotional development (how the student interacts with peers, emotional maturity)
  • Sentence 2: Commitment to learning (engagement, enthusiasm, attitude to lessons)
  • Sentence 3: Work ethic and independence (how they tackle tasks on their own)
  Infer tone from performance data — mostly green suggests strong engagement; more red suggests areas needing encouragement.

Paragraph 2 — Knowledge areas (exactly 4 sentences: 2 per subject):
  Write 2 sentences about ${topTwo[0]}, then 2 sentences about ${topTwo[1]}.
  Use specific achievements or skills demonstrated. Draw on any teacher notes provided.

Paragraph 3 — Personal achievements & encouragement:
  Highlight what makes this student unique or special.
  End with a warm, forward-looking statement about their continued growth.

Output the three paragraphs only. No preamble, no sign-off.`;
}

// ─── TOAST ─────────────────────────────────────────────────────────────────────
function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ─── RENDER HELPERS ─────────────────────────────────────────────────────────────
function setView(view) {
  S.view = view;
  render();
}

function render() {
  const app = document.getElementById('app');
  if (S.view === 'loading') {
    app.innerHTML = `<div class="loading-screen"><div class="spinner"></div><p>Loading...</p></div>`;
    return;
  }
  if (S.view === 'setup') { app.innerHTML = renderSetup(); attachSetupEvents(); return; }

  app.innerHTML = `
    <header class="app-header">
      <h1>📚 Class Tracker</h1>
      <div class="header-right">
        <span id="save-pill" class="save-pill"></span>
        <button class="header-btn" id="hdr-settings" title="Settings">⚙️</button>
      </div>
    </header>
    <main class="main-content" id="main-content">
      ${S.view === 'daily'    ? renderDaily()    : ''}
      ${S.view === 'overview' ? renderOverview() : ''}
      ${S.view === 'reports'  ? renderReports()  : ''}
      ${S.view === 'settings' ? renderSettings() : ''}
    </main>
    <nav class="tab-bar">
      ${tabBtn('daily',    '📋', 'Daily')}
      ${tabBtn('overview', '📅', 'Overview')}
      ${tabBtn('reports',  '📝', 'Reports')}
    </nav>
  `;

  document.getElementById('hdr-settings').onclick = () => setView('settings');
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      const v = btn.dataset.view;
      if (v === 'overview' && !S.logDates) {
        btn.disabled = true;
        loadLogDates().then(() => { btn.disabled = false; setView(v); });
      } else {
        setView(v);
      }
    };
  });

  if (S.view === 'daily')    attachDailyEvents();
  if (S.view === 'overview') attachOverviewEvents();
  if (S.view === 'reports')  attachReportEvents();
  if (S.view === 'settings') attachSettingsEvents();
}

function tabBtn(view, icon, label) {
  return `<button class="tab-btn${S.view === view ? ' active' : ''}" data-view="${view}">
    <span class="tab-icon">${icon}</span>${esc(label)}
  </button>`;
}

// ─── SETUP VIEW ────────────────────────────────────────────────────────────────
function renderSetup() {
  const s = S.settings;
  return `
    <div class="setup-wrap">
      <div class="setup-hero">
        <div class="logo">📚</div>
        <h2>Class Tracker Setup</h2>
        <p>Connect your GitHub data repository and Claude API key to get started.</p>
      </div>

      <div class="setup-section">
        <div class="setup-section-title">🐙 GitHub Data Storage</div>
        <div class="form-row">
          <label>GitHub Personal Access Token</label>
          <input type="password" id="s-token" value="${esc(s.ghToken || '')}" placeholder="ghp_xxxxxxxxxxxx" autocomplete="off">
          <div class="form-hint">Needs <strong>repo</strong> scope. Create at GitHub → Settings → Developer settings → Personal access tokens.</div>
        </div>
        <div class="form-row">
          <label>GitHub Username</label>
          <input type="text" id="s-owner" value="${esc(s.dataOwner || '')}" placeholder="your-github-username" autocomplete="off" autocapitalize="none">
        </div>
        <div class="form-row">
          <label>Data Repository Name</label>
          <input type="text" id="s-repo" value="${esc(s.dataRepo || '')}" placeholder="classroom-tracker-data" autocomplete="off" autocapitalize="none">
          <div class="form-hint">This should be a <strong>private</strong> repository you create on GitHub.</div>
        </div>
      </div>

      <div class="setup-section">
        <div class="setup-section-title">🤖 Claude AI (for reports)</div>
        <div class="form-row">
          <label>Anthropic API Key</label>
          <input type="password" id="s-claude" value="${esc(s.claudeKey || '')}" placeholder="sk-ant-xxxxxxxxxxxx" autocomplete="off">
          <div class="form-hint">Get a key at console.anthropic.com. Only used when generating end-of-term reports.</div>
        </div>
        <div class="form-row">
          <label>Cloudflare Proxy URL</label>
          <input type="text" id="s-proxy" value="${esc(s.claudeProxyUrl || '')}" placeholder="https://claude-proxy.YOUR-NAME.workers.dev" autocomplete="off" autocapitalize="none">
          <div class="form-hint">A free Cloudflare Worker that lets the app call the AI. See the setup guide (Step 6b).</div>
        </div>
      </div>

      <button class="btn btn-primary" id="setup-save">Save &amp; Continue →</button>
      <p style="text-align:center;font-size:12px;color:var(--text-muted);margin-top:12px;">
        All settings are stored only on this device.
      </p>
    </div>
  `;
}

function attachSetupEvents() {
  document.getElementById('setup-save').onclick = async () => {
    const token = document.getElementById('s-token').value.trim();
    const owner = document.getElementById('s-owner').value.trim();
    const repo  = document.getElementById('s-repo').value.trim();
    const claude = document.getElementById('s-claude').value.trim();
    const proxy  = document.getElementById('s-proxy').value.trim();

    if (!token || !owner || !repo || !claude) {
      showToast('Please fill in all fields');
      return;
    }

    S.settings = { ...S.settings, ghToken: token, dataOwner: owner, dataRepo: repo, claudeKey: claude, claudeProxyUrl: proxy };
    saveSettingsToStorage();

    setView('loading');
    try {
      await loadStudents();
      await loadDailyLog();
      setView('daily');
    } catch (e) {
      showToast('⚠️ Could not connect — check your settings');
      setView('setup');
    }
  };
}

// ─── DAILY VIEW ────────────────────────────────────────────────────────────────
function renderDaily() {
  const isToday = S.date === todayStr();
  const parts = fmtDate(S.date).split(', ');

  if (!S.dailyLog || !S.students) {
    return `<div class="loading-screen"><div class="spinner"></div><p>Loading...</p></div>`;
  }

  const cards = S.students.length === 0
    ? `<div class="empty-state"><div class="ei">👩‍🏫</div><p>No students yet.<br>Go to Settings to add students.</p></div>`
    : S.students.map(st => renderStudentCard(st)).join('');

  return `
    <div class="date-nav">
      <button class="date-nav-btn" id="prev-day">&#8249;</button>
      <div>
        <div class="date-display">
          <span class="day-name">${dayName(S.date)}</span>
          <span class="full-date">${fmtDateShort(S.date)}</span>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button class="today-btn${isToday ? '' : ' visible'}" id="go-today">Today</button>
        <button class="date-nav-btn" id="next-day">&#8250;</button>
      </div>
    </div>
    <div class="student-list" id="student-list">${cards}</div>
  `;
}

function renderStudentCard(student) {
  const entry = S.dailyLog?.entries?.[student.id];
  const absent = entry?.absentAllDay || false;
  const expanded = S.expanded.has(student.id);

  const dots = absent
    ? `<span class="absent-badge">Absent</span>`
    : SUBJECTS.map(sub => {
        const tl = entry?.lessons?.[sub]?.traffic || 'none';
        return `<span class="tl-dot ${tl}"></span>`;
      }).join('');

  const lessonsHtml = absent ? '' : SUBJECTS.map(sub => {
    const lesson = entry?.lessons?.[sub] || { traffic: null, note: '' };
    return `
      <div class="lesson-row">
        <div class="lesson-name">${esc(sub)}</div>
        <div class="traffic-btns">
          ${['red','amber','green'].map(tl => `
            <button class="tl-btn ${tl}-btn${lesson.traffic === tl ? ' selected' : ''}"
              data-student="${esc(student.id)}" data-subject="${esc(sub)}" data-tl="${tl}">
              ${TL_EMOJI[tl]} ${tl.charAt(0).toUpperCase() + tl.slice(1)}
            </button>`).join('')}
        </div>
        <textarea class="note-area" placeholder="Optional note…"
          data-student="${esc(student.id)}" data-subject="${esc(sub)}"
          rows="1">${esc(lesson.note || '')}</textarea>
      </div>
    `;
  }).join('');

  return `
    <div class="student-card${expanded ? ' expanded' : ''}${absent ? ' student-absent' : ''}" data-id="${esc(student.id)}">
      <div class="student-header">
        <div class="student-avatar">${esc(initials(student.name))}</div>
        <div class="student-name">${esc(student.name)}</div>
        <div class="student-summary">${dots}</div>
        <span class="chevron">⌄</span>
      </div>
      <div class="lessons-panel">
        <div class="absent-row">
          <label for="abs-${esc(student.id)}">Mark as absent today</label>
          <label class="toggle-switch">
            <input type="checkbox" id="abs-${esc(student.id)}"
              data-student="${esc(student.id)}" ${absent ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="lessons-fields${absent ? ' lessons-disabled' : ''}" data-for="${esc(student.id)}">
          ${lessonsHtml}
        </div>
      </div>
    </div>
  `;
}

function attachDailyEvents() {
  document.getElementById('prev-day')?.addEventListener('click', async () => {
    if (S.savePending) await doSave();
    S.date = shiftDate(S.date, -1);
    S.expanded.clear();
    setView('loading');
    await loadDailyLog();
    setView('daily');
  });

  document.getElementById('next-day')?.addEventListener('click', async () => {
    if (S.date >= todayStr()) return;
    if (S.savePending) await doSave();
    S.date = shiftDate(S.date, 1);
    S.expanded.clear();
    setView('loading');
    await loadDailyLog();
    setView('daily');
  });

  document.getElementById('go-today')?.addEventListener('click', async () => {
    if (S.savePending) await doSave();
    S.date = todayStr();
    S.expanded.clear();
    setView('loading');
    await loadDailyLog();
    setView('daily');
  });

  // Student card expand/collapse
  document.querySelectorAll('.student-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const card = hdr.closest('.student-card');
      const id = card.dataset.id;
      if (S.expanded.has(id)) S.expanded.delete(id);
      else S.expanded.add(id);
      card.classList.toggle('expanded');
    });
  });

  // Absent toggle
  document.querySelectorAll('.absent-row input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', e => {
      const id = e.target.dataset.student;
      const entry = ensureEntry(id);
      entry.absentAllDay = e.target.checked;
      // Update the lessons area disabled state
      const fieldsEl = document.querySelector(`.lessons-fields[data-for="${id}"]`);
      if (fieldsEl) fieldsEl.classList.toggle('lessons-disabled', e.target.checked);
      // Update header dots
      const card = document.querySelector(`.student-card[data-id="${id}"]`);
      if (card) {
        card.classList.toggle('student-absent', e.target.checked);
        const summaryEl = card.querySelector('.student-summary');
        if (summaryEl) {
          summaryEl.innerHTML = e.target.checked
            ? '<span class="absent-badge">Absent</span>'
            : SUBJECTS.map(sub => {
                const tl = entry.lessons?.[sub]?.traffic || 'none';
                return `<span class="tl-dot ${tl}"></span>`;
              }).join('');
        }
      }
      scheduleSave();
    });
  });

  // Traffic light buttons
  document.querySelectorAll('.tl-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const { student, subject, tl } = btn.dataset;
      const entry = ensureEntry(student);
      const current = entry.lessons[subject].traffic;
      entry.lessons[subject].traffic = current === tl ? null : tl;
      // Update buttons in this row
      const row = btn.closest('.lesson-row');
      row.querySelectorAll('.tl-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.tl === entry.lessons[subject].traffic);
      });
      // Update header summary dots
      updateHeaderDots(student);
      scheduleSave();
    });
  });

  // Note textareas
  let noteTimer = null;
  document.querySelectorAll('.note-area').forEach(ta => {
    ta.addEventListener('input', e => {
      const { student, subject } = ta.dataset;
      const entry = ensureEntry(student);
      entry.lessons[subject].note = ta.value;
      if (noteTimer) clearTimeout(noteTimer);
      noteTimer = setTimeout(scheduleSave, 500);
    });
  });
}

function updateHeaderDots(studentId) {
  const entry = S.dailyLog?.entries?.[studentId];
  if (!entry || entry.absentAllDay) return;
  const card = document.querySelector(`.student-card[data-id="${studentId}"]`);
  if (!card) return;
  const summaryEl = card.querySelector('.student-summary');
  if (!summaryEl) return;
  summaryEl.innerHTML = SUBJECTS.map(sub => {
    const tl = entry.lessons?.[sub]?.traffic || 'none';
    return `<span class="tl-dot ${tl}"></span>`;
  }).join('');
}

// ─── OVERVIEW VIEW ─────────────────────────────────────────────────────────────
function renderOverview() {
  if (!S.overviewMonth) {
    const d = parseLocalDate(S.date);
    S.overviewMonth = { year: d.getFullYear(), month: d.getMonth() };
  }
  const { year, month } = S.overviewMonth;
  const monthName = new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const today = todayStr();

  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month + 1, 0);
  const startDow = (firstDay.getDay() + 6) % 7; // Mon=0
  const totalDays = lastDay.getDate();

  const headers = ['M','T','W','T','F','S','S'].map(d =>
    `<div class="cal-cell header">${d}</div>`).join('');

  let cells = Array(startDow).fill('<div class="cal-cell empty"></div>');

  for (let d = 1; d <= totalDays; d++) {
    const str = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const hasData = S.logDates?.has(str);
    const isToday = str === today;
    const isFuture = str > today;
    const isCurrent = str === S.date;
    let cls = 'cal-cell day';
    if (hasData) cls += ' has-data';
    if (isToday) cls += ' today';
    if (isFuture) cls += ' future';
    cells.push(`<div class="${cls}" data-date="${str}" title="${fmtDate(str)}">${d}</div>`);
  }

  return `
    <div class="overview-wrap">
      <div class="month-nav">
        <button class="date-nav-btn" id="prev-month">&#8249;</button>
        <h3>${monthName}</h3>
        <button class="date-nav-btn" id="next-month">&#8250;</button>
      </div>
      <div class="cal-grid">
        ${headers}
        ${cells.join('')}
      </div>
      <div class="overview-legend">
        <div class="legend-item">
          <div class="legend-dot" style="background:var(--primary-light);border:1px solid #a5b4fc;"></div>
          Log recorded
        </div>
        <div class="legend-item">
          <div class="legend-dot" style="background:var(--card);border:2px solid var(--primary);"></div>
          Today
        </div>
      </div>
      <div style="padding:16px 0;text-align:center;color:var(--text-muted);font-size:13px;">
        Tap a date to jump to it in the Daily view.
      </div>
    </div>
  `;
}

function attachOverviewEvents() {
  document.getElementById('prev-month')?.addEventListener('click', () => {
    let { year, month } = S.overviewMonth;
    month--; if (month < 0) { month = 11; year--; }
    S.overviewMonth = { year, month };
    render();
  });
  document.getElementById('next-month')?.addEventListener('click', () => {
    let { year, month } = S.overviewMonth;
    month++; if (month > 11) { month = 0; year++; }
    S.overviewMonth = { year, month };
    render();
  });
  document.querySelectorAll('.cal-cell.day:not(.future)').forEach(cell => {
    cell.addEventListener('click', async () => {
      const date = cell.dataset.date;
      if (!date) return;
      if (S.savePending) await doSave();
      S.date = date;
      S.expanded.clear();
      setView('loading');
      await loadDailyLog();
      setView('daily');
    });
  });
}

// ─── REPORTS VIEW ──────────────────────────────────────────────────────────────
function renderReports() {
  const start = S.reportPeriodStart;
  const end   = S.reportPeriodEnd;

  const savedHtml = S.savedReports?.reports
    ? S.savedReports.reports.map(r => {
        const student = S.students.find(s => s.id === r.studentId);
        if (!student) return '';
        return `
          <div class="report-card">
            <div class="report-card-header">
              <h3>${esc(student.name)}</h3>
              <div class="report-actions">
                <button class="btn btn-ghost btn-sm" data-copy="${esc(r.studentId)}">Copy</button>
              </div>
            </div>
            <div class="report-text">${esc(r.text)}</div>
            <div class="report-subjects">
              ${r.highlightedSubjects?.map(s => `<span class="subject-tag">${esc(s)}</span>`).join('') || ''}
            </div>
          </div>
        `;
      }).join('')
    : '';

  return `
    <div class="reports-wrap">
      <div class="period-selector">
        <label>Report Period</label>
        <div class="period-inputs">
          <div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Start date</div>
            <input type="date" id="period-start" value="${esc(start)}" max="${todayStr()}">
          </div>
          <div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">End date</div>
            <input type="date" id="period-end" value="${esc(end)}" max="${todayStr()}">
          </div>
        </div>
        <button class="btn btn-primary" id="generate-btn">
          Generate Reports for All Students
        </button>
        <div class="generate-info">
          Generates AI reports for all ${S.students.length} students using daily log data.
          Previously generated reports for this period will be overwritten.
        </div>
      </div>

      <div id="gen-progress"></div>

      ${savedHtml ? `
        <div style="font-size:13px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.7px;padding:4px 0 10px;">
          ${S.savedReports?.periodLabel ? esc(S.savedReports.periodLabel) : 'Saved Reports'}
        </div>
        ${savedHtml}
      ` : ''}
    </div>
  `;
}

function attachReportEvents() {
  document.getElementById('period-start')?.addEventListener('change', e => {
    S.reportPeriodStart = e.target.value;
  });
  document.getElementById('period-end')?.addEventListener('change', e => {
    S.reportPeriodEnd = e.target.value;
  });

  document.getElementById('generate-btn')?.addEventListener('click', runGeneration);

  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.copy;
      const report = S.savedReports?.reports?.find(r => r.studentId === id);
      if (!report) return;
      const student = S.students.find(s => s.id === id);
      const text = `${student?.name || ''}\n\n${report.text}`;
      navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard'));
    });
  });
}

async function runGeneration() {
  const start = S.reportPeriodStart;
  const end   = S.reportPeriodEnd;

  if (!start || !end) { showToast('Please set a start and end date'); return; }
  if (start >= end) { showToast('End date must be after start date'); return; }
  if (S.students.length === 0) { showToast('No students to generate reports for'); return; }

  const periodKey = `${start}_${end}`;

  // Load logs for period
  const progress = document.getElementById('gen-progress');
  progress.innerHTML = `
    <div class="setup-section" style="margin-bottom:14px;">
      <div class="setup-section-title">⚡ Generating Reports</div>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">
        Loading logs from ${fmtDateShort(start)} to ${fmtDateShort(end)}...
      </p>
      <div id="progress-list"></div>
    </div>
  `;

  let logs;
  try {
    logs = await loadLogsForPeriod(start, end);
  } catch (e) {
    showToast('Failed to load logs: ' + e.message);
    progress.innerHTML = '';
    return;
  }

  if (logs.length === 0) {
    progress.innerHTML = `<div class="empty-state"><p>No daily logs found for this period.<br>Make sure you have recorded some lessons first.</p></div>`;
    return;
  }

  // Load previous reports to get previous highlighted subjects
  let prevReports = null;
  try {
    // Try to find previous period's report file
    const files = await ghList('data/reports');
    const sorted = files.filter(f => f.name.endsWith('.json')).map(f => f.name.replace('.json', '')).sort();
    const prevKey = sorted.filter(k => k < periodKey).pop();
    if (prevKey) {
      const { content } = await ghGet(`data/reports/${prevKey}.json`);
      prevReports = content;
    }
  } catch (e) { /* no previous reports */ }

  const results = [];
  const progressList = document.getElementById('progress-list');

  for (let i = 0; i < S.students.length; i++) {
    const student = S.students[i];
    const pct = Math.round((i / S.students.length) * 100);

    progressList.innerHTML = S.students.map((st, idx) => {
      let status, statusCls;
      if (idx < i) { status = 'Done ✓'; statusCls = 'done'; }
      else if (idx === i) { status = '<span class="inline-spinner"></span>'; statusCls = ''; }
      else { status = 'Waiting'; statusCls = ''; }
      return `<div class="progress-row">
        <div class="progress-name">${esc(st.name.split(' ')[0])}</div>
        <div class="progress-bar-wrap"><div class="progress-fill" style="width:${idx < i ? 100 : idx === i ? 50 : 0}%"></div></div>
        <div class="progress-status ${statusCls}">${status}</div>
      </div>`;
    }).join('');

    try {
      const { stats, absent } = calcSubjectStats(student, logs);
      const prevHighlighted = prevReports?.reports?.find(r => r.studentId === student.id)?.highlightedSubjects || [];
      const topTwo = pickTopSubjects(stats, prevHighlighted);
      const prompt = buildPrompt(student, stats, absent, topTwo, prevHighlighted);
      const text = await callClaude(prompt);
      results.push({ studentId: student.id, text, highlightedSubjects: topTwo });
    } catch (e) {
      results.push({ studentId: student.id, text: `[Error generating report: ${e.message}]`, highlightedSubjects: [] });
    }
  }

  // Mark all done
  progressList.innerHTML = S.students.map(st => `
    <div class="progress-row">
      <div class="progress-name">${esc(st.name.split(' ')[0])}</div>
      <div class="progress-bar-wrap"><div class="progress-fill" style="width:100%"></div></div>
      <div class="progress-status done">Done ✓</div>
    </div>
  `).join('');

  const reportData = {
    periodKey,
    periodLabel: `${fmtDateShort(start)} – ${fmtDateShort(end)}`,
    generatedAt: todayStr(),
    reports: results,
  };

  try {
    await persistReports(periodKey, reportData);
    showToast('✅ Reports saved!');
    S.savedReports = reportData;
    render();
  } catch (e) {
    showToast('Reports generated but save failed: ' + e.message);
  }
}

// ─── SETTINGS VIEW ─────────────────────────────────────────────────────────────
function renderSettings() {
  const s = S.settings;
  const studentRows = S.students.map((st, i) => `
    <div class="student-mgmt-row" data-id="${esc(st.id)}">
      <span class="student-mgmt-num">${i + 1}</span>
      <span class="student-mgmt-name">${esc(st.name)}</span>
      <div style="display:flex;gap:6px;">
        <button class="icon-btn" title="Move up" data-up="${esc(st.id)}" ${i === 0 ? 'disabled style="opacity:0.3"' : ''}>↑</button>
        <button class="icon-btn" title="Move down" data-dn="${esc(st.id)}" ${i === S.students.length-1 ? 'disabled style="opacity:0.3"' : ''}>↓</button>
        <button class="icon-btn" title="Remove" data-del="${esc(st.id)}" style="color:var(--red)">✕</button>
      </div>
    </div>
  `).join('');

  return `
    <div class="setup-wrap">
      <div class="setup-section">
        <div class="setup-section-title">👩‍🏫 Students (${S.students.length})</div>
        <div class="student-mgmt-list">${studentRows}</div>
        <div class="add-student-row">
          <input type="text" id="new-name" placeholder="Full name" autocomplete="off">
          <button class="btn btn-secondary btn-sm" id="add-student-btn">Add</button>
        </div>
      </div>

      <div class="setup-section">
        <div class="setup-section-title">🔑 API Keys & Connection</div>
        <div class="form-row">
          <label>GitHub Token</label>
          <input type="password" id="cfg-token" value="${esc(s.ghToken || '')}" autocomplete="off">
        </div>
        <div class="form-row">
          <label>GitHub Username</label>
          <input type="text" id="cfg-owner" value="${esc(s.dataOwner || '')}" autocomplete="off" autocapitalize="none">
        </div>
        <div class="form-row">
          <label>Data Repository Name</label>
          <input type="text" id="cfg-repo" value="${esc(s.dataRepo || '')}" autocomplete="off" autocapitalize="none">
        </div>
        <div class="form-row">
          <label>Anthropic API Key</label>
          <input type="password" id="cfg-claude" value="${esc(s.claudeKey || '')}" autocomplete="off">
        </div>
        <div class="form-row">
          <label>Cloudflare Proxy URL</label>
          <input type="text" id="cfg-proxy" value="${esc(s.claudeProxyUrl || '')}" placeholder="https://claude-proxy.YOUR-NAME.workers.dev" autocomplete="off" autocapitalize="none">
          <div class="form-hint">Required for report generation. See setup guide for how to create this.</div>
        </div>
        <button class="btn btn-primary" id="save-cfg" style="margin-top:4px;">Save Changes</button>
      </div>

      <div style="padding-bottom:20px;text-align:center;font-size:12px;color:var(--text-muted);">
        Class Tracker • Settings stored on this device only
      </div>
    </div>
  `;
}

function attachSettingsEvents() {
  // Add student
  const addBtn = document.getElementById('add-student-btn');
  const nameInput = document.getElementById('new-name');

  const doAdd = async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    if (S.students.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      showToast('Student already exists');
      return;
    }
    addBtn.disabled = true;
    S.students.push({ id: crypto.randomUUID(), name });
    try {
      await persistStudents();
      nameInput.value = '';
      showToast(`${name} added`);
      render();
    } catch (e) {
      S.students.pop();
      showToast('Failed to save: ' + e.message);
    } finally {
      if (addBtn) addBtn.disabled = false;
    }
  };

  addBtn?.addEventListener('click', doAdd);
  nameInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });

  // Delete student
  document.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.del;
      const student = S.students.find(s => s.id === id);
      if (!student) return;
      if (!confirm(`Remove ${student.name}? Their log data will remain but they won't appear in the daily view.`)) return;
      S.students = S.students.filter(s => s.id !== id);
      try {
        await persistStudents();
        showToast(`${student.name} removed`);
        render();
      } catch (e) {
        showToast('Failed to save: ' + e.message);
      }
    });
  });

  // Move up
  document.querySelectorAll('[data-up]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.up;
      const idx = S.students.findIndex(s => s.id === id);
      if (idx <= 0) return;
      [S.students[idx-1], S.students[idx]] = [S.students[idx], S.students[idx-1]];
      await persistStudents().catch(() => {});
      render();
    });
  });

  // Move down
  document.querySelectorAll('[data-dn]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.dn;
      const idx = S.students.findIndex(s => s.id === id);
      if (idx >= S.students.length - 1) return;
      [S.students[idx+1], S.students[idx]] = [S.students[idx], S.students[idx+1]];
      await persistStudents().catch(() => {});
      render();
    });
  });

  // Save config
  document.getElementById('save-cfg')?.addEventListener('click', async () => {
    const token  = document.getElementById('cfg-token').value.trim();
    const owner  = document.getElementById('cfg-owner').value.trim();
    const repo   = document.getElementById('cfg-repo').value.trim();
    const claude = document.getElementById('cfg-claude').value.trim();
    const proxy  = document.getElementById('cfg-proxy').value.trim();
    if (!token || !owner || !repo || !claude) { showToast('All fields required'); return; }
    S.settings = { ...S.settings, ghToken: token, dataOwner: owner, dataRepo: repo, claudeKey: claude, claudeProxyUrl: proxy };
    saveSettingsToStorage();
    showToast('Settings saved');
  });
}

// ─── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  setView('loading');

  if (!isSetupDone()) {
    setView('setup');
    return;
  }

  try {
    await Promise.all([loadStudents(), loadDailyLog()]);
    setView('daily');
  } catch (e) {
    console.error('Init failed:', e);
    showToast('⚠️ Could not load data — check settings');
    setView('setup');
  }
}

init();

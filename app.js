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
  classrooms: [],
  classroomsSha: null,
  activeClassroom: 'all',   // 'all' or classroom id — filters daily view
  reportClassroom: 'all',   // 'all' or classroom id — filters reports student list
  dailyLog: null,
  logSha: null,
  logDates: null,           // Set of date strings that have log files
  overviewMonth: null,      // { year, month } for the calendar
  reportPeriodStart: '',
  reportPeriodEnd: '',
  savedReports: null,
  savedReportsSha: null,
  allReportPeriods: null,   // [{key, label, sha}] listed from GitHub
  settings: loadSettings(),
  expanded: new Set(),
  saveTimer: null,
  savePending: false,
  selectedStudents: null,
  editingStudentId: null,
};

// ─── UTILITIES ─────────────────────────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
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
  const [y, m, d] = str.split('-').map(Number);
  const date = new Date(y, m - 1, d + delta);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
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

async function ghDelete(path, sha, message) {
  const { ghToken, dataOwner, dataRepo } = S.settings;
  const url = `https://api.github.com/repos/${dataOwner}/${dataRepo}/contents/${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `token ${ghToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.message || `GitHub delete error ${res.status}`);
  }
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

async function loadClassrooms() {
  const { content, sha } = await ghGet('data/classrooms.json');
  S.classroomsSha = sha;
  S.classrooms = content?.classrooms || [];
}

async function persistClassrooms() {
  S.classroomsSha = await ghPut(
    'data/classrooms.json',
    { classrooms: S.classrooms },
    S.classroomsSha,
    'Update classrooms'
  );
}

function emptyLog(date) {
  return { date, entries: {} };
}

function ensureEntry(studentId) {
  if (!S.dailyLog.entries[studentId]) {
    S.dailyLog.entries[studentId] = {
      absentAllDay: false,
      behaviour: '',
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
  const path = `data/reports/${periodKey}.json`;
  const { sha } = await ghGet(path);
  S.savedReportsSha = await ghPut(path, data, sha, `Reports ${periodKey}`);
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
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
    if (res.ok) {
      const data = await res.json();
      return data.content[0].text.trim();
    }
    const e = await res.json().catch(() => ({}));
    const msg = e.error?.message || '';
    const isOverloaded = res.status === 529 || res.status === 503 || msg.toLowerCase().includes('overload');
    if (isOverloaded && attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 4000 * attempt)); // 4s, 8s, 12s
      continue;
    }
    throw new Error(msg || `Claude error ${res.status}`);
  }
}

// ─── REPORT GENERATION ─────────────────────────────────────────────────────────
function calcSubjectStats(student, logs) {
  const stats = {};
  for (const sub of SUBJECTS) {
    stats[sub] = { green: 0, amber: 0, red: 0, notes: [], scoreTotal: 0, scored: 0 };
  }
  let absent = 0;
  const behaviourNotes = [];

  for (const log of logs) {
    const entry = log.entries?.[student.id];
    if (!entry) continue;
    if (entry.absentAllDay) { absent++; continue; }
    if (entry.behaviour?.trim()) behaviourNotes.push(entry.behaviour.trim());
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

  return { stats, absent, behaviourNotes };
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

function buildPrompt(student, stats, absent, topTwo, previousSubjects, behaviourNotes = []) {
  const firstName = student.name.split(' ')[0];
  const gender = student.gender || 'other';
  const he   = gender === 'male' ? 'He'   : gender === 'female' ? 'She'   : 'They';
  const his  = gender === 'male' ? 'his'  : gender === 'female' ? 'her'   : 'their';
  const him  = gender === 'male' ? 'him'  : gender === 'female' ? 'her'   : 'them';

  const subSummary = SUBJECTS.map(sub => {
    const st = stats[sub];
    const total = st.green + st.amber + st.red;
    if (total === 0) return `${sub}: no data recorded — treat as average/expected performance`;
    const breakdown = [
      st.green > 0 ? `${st.green} green` : '',
      st.amber > 0 ? `${st.amber} amber` : '',
      st.red   > 0 ? `${st.red} red`     : '',
    ].filter(Boolean).join(', ');
    let line = `${sub}: ${breakdown} out of ${total} sessions`;
    if (st.notes.length) line += `\n  Teacher notes: "${st.notes.slice(0, 4).join('" | "')}"`;
    return line;
  }).join('\n');

  // Derive overall learning behaviour tone from aggregate data
  const allScored = SUBJECTS.reduce((n, s) => n + stats[s].scored, 0);
  const allGreen  = SUBJECTS.reduce((n, s) => n + stats[s].green, 0);
  const allRed    = SUBJECTS.reduce((n, s) => n + stats[s].red, 0);
  let overallTone;
  if (allScored === 0) {
    overallTone = 'average — no traffic light data was recorded this period';
  } else {
    const greenPct = allGreen / allScored;
    const redPct   = allRed   / allScored;
    if (greenPct >= 0.6)      overallTone = 'generally positive — majority of sessions recorded as green';
    else if (redPct >= 0.4)   overallTone = 'mixed — a notable number of sessions recorded as red, suggesting areas needing support';
    else                      overallTone = 'average — a typical mix of green and amber sessions';
  }

  return `You are writing an end-of-term school report for a primary school student. Write in third person using the student's first name. Use professional, measured language suitable for parents.

STRICT RULES — read carefully before writing:
1. Base every sentence ONLY on the data provided below. Do not invent, assume, or embellish details about personality, friendships, classroom behaviour, or social interactions that are not evidenced in the data.
2. Where no traffic light data exists for a subject, treat it as average/expected performance — do not praise or criticise it.
3. Where teacher notes exist, you may reference them specifically. Where they do not, keep statements general.
4. Match the tone to the data. If performance is average, say so in a neutral way. Reserve positive language for genuinely good data (mostly green). If data is mixed, reflect that honestly.
5. Do not use words like "exceptional", "outstanding", "always", "brilliant", or similar superlatives unless the data strongly supports it.

Student: ${firstName}
Pronouns: ${he}/${his}/${him}
Days absent this period: ${absent}
Overall learning behaviour tone (use this to calibrate Paragraph 1): ${overallTone}
${behaviourNotes.length ? `Teacher behaviour notes (${behaviourNotes.length} recorded):\n${behaviourNotes.slice(0,6).map(n=>`  - "${n}"`).join('\n')}` : 'Behaviour notes: none recorded — do not comment specifically on behaviour in Paragraph 1 beyond what the performance data implies.'}

Subject performance data:
${subSummary}

Previous report featured subjects — DO NOT use these in Paragraph 2: ${previousSubjects.length ? previousSubjects.join(', ') : 'None — this is the first report'}
Paragraph 2 must focus on: ${topTwo[0]} and ${topTwo[1]}

Write exactly 3 paragraphs totalling approximately 200 words. Flowing prose only — no headings or bullet points.

Paragraph 1 — Learning behaviours (exactly 3 sentences, use ${he}/${his}/${him} pronouns throughout):
  • Sentence 1: General approach to learning this term, calibrated to the overall tone.
  • Sentence 2: Effort and engagement, grounded in the traffic light pattern. If behaviour notes exist, you may draw on them here.
  • Sentence 3: Work habits and independence — keep general if no specific data supports detail.
  Do not mention peer relationships, friendships, or social behaviour unless a teacher behaviour note directly references it.

Paragraph 2 — Subject knowledge (exactly 4 sentences: 2 per subject):
  2 sentences on ${topTwo[0]}, then 2 sentences on ${topTwo[1]}.
  Reference the actual session counts and any teacher notes. If data is limited, write that the student is working at an expected level.

Paragraph 3 — Encouragement (2–3 sentences):
  A forward-looking close. Acknowledge effort or progress where the data supports it. End with an encouraging statement about the term ahead. Do not overstate achievement.

Output the three paragraphs only.`;
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

  // Filter students by active classroom
  const visibleStudents = S.activeClassroom === 'all'
    ? S.students
    : S.students.filter(s => s.classroomId === S.activeClassroom);

  const cards = visibleStudents.length === 0
    ? `<div class="empty-state"><div class="ei">👩‍🏫</div><p>${S.students.length === 0 ? 'No students yet.<br>Go to Settings to add students.' : 'No students in this classroom.'}</p></div>`
    : visibleStudents.map(st => renderStudentCard(st)).join('');

  const classroomTabs = S.classrooms.length > 0 ? `
    <div style="padding:8px 10px;background:var(--card);border-bottom:1px solid var(--border);">
      <select id="cls-select" style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:10px;
        font-size:14px;font-weight:600;font-family:inherit;background:var(--bg);color:var(--text);">
        <option value="all"${S.activeClassroom === 'all' ? ' selected' : ''}>All Students</option>
        ${S.classrooms.map(c => `
          <option value="${esc(c.id)}"${S.activeClassroom === c.id ? ' selected' : ''}>${esc(c.name)}</option>
        `).join('')}
      </select>
    </div>
  ` : '';

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
    ${classroomTabs}
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

  const behaviourVal = entry?.behaviour || '';
  const behaviourRow = absent ? '' : `
    <div class="lesson-row" style="border-left:3px solid var(--primary);">
      <div class="lesson-name" style="color:var(--primary);">Overall Behaviour</div>
      <textarea class="note-area behaviour-input" placeholder="Notes on behaviour today (optional)…"
        data-student="${esc(student.id)}" rows="2">${esc(behaviourVal)}</textarea>
    </div>
  `;

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
          ${behaviourRow}
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

  // Classroom dropdown filter
  document.getElementById('cls-select')?.addEventListener('change', e => {
    S.activeClassroom = e.target.value;
    render();
  });

  // Note textareas (subject-level)
  let noteTimer = null;
  document.querySelectorAll('.note-area:not(.behaviour-input)').forEach(ta => {
    ta.addEventListener('input', () => {
      const { student, subject } = ta.dataset;
      const entry = ensureEntry(student);
      entry.lessons[subject].note = ta.value;
      if (noteTimer) clearTimeout(noteTimer);
      noteTimer = setTimeout(scheduleSave, 500);
    });
  });

  // Behaviour textareas
  document.querySelectorAll('.behaviour-input').forEach(ta => {
    ta.addEventListener('input', () => {
      const entry = ensureEntry(ta.dataset.student);
      entry.behaviour = ta.value;
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

  // Default selection: students in the active classroom (or all)
  if (!S.selectedStudents) {
    const pool = S.reportClassroom === 'all'
      ? S.students
      : S.students.filter(s => s.classroomId === S.reportClassroom);
    S.selectedStudents = new Set(pool.map(s => s.id));
  }

  const selCount = S.selectedStudents.size;
  const studentCheckboxes = S.students.map(st => `
    <label class="student-check-row" style="display:flex;align-items:center;gap:10px;padding:8px 10px;
      background:var(--bg);border-radius:8px;border:1px solid var(--border);cursor:pointer;">
      <input type="checkbox" class="student-sel-cb" value="${esc(st.id)}"
        ${S.selectedStudents.has(st.id) ? 'checked' : ''}
        style="width:18px;height:18px;cursor:pointer;accent-color:var(--primary);">
      <span style="font-size:14px;font-weight:500;">${esc(st.name)}</span>
    </label>
  `).join('');

  const savedHtml = S.savedReports?.reports
    ? S.savedReports.reports.map(r => {
        const student = S.students.find(s => s.id === r.studentId);
        if (!student) return '';
        const isError = r.text.startsWith('[Error');
        return `
          <div class="report-card" style="${isError ? 'border-color:var(--red);' : ''}">
            <div class="report-card-header">
              <h3>${esc(student.name)}</h3>
              <div class="report-actions">
                ${!isError ? `<button class="btn btn-ghost btn-sm" data-copy="${esc(r.studentId)}">Copy</button>` : ''}
              </div>
            </div>
            <div class="report-text" style="${isError ? 'color:var(--red);font-style:italic;' : ''}">${esc(r.text)}</div>
            ${!isError && r.highlightedSubjects?.length ? `
              <div class="report-subjects" style="margin-top:10px;">
                <span style="font-size:11px;color:var(--text-muted);margin-right:6px;">Subjects featured:</span>
                ${r.highlightedSubjects.map(s => `<span class="subject-tag">${esc(s)}</span>`).join('')}
              </div>` : ''}
          </div>
        `;
      }).join('')
    : '';

  // Saved report periods listing
  const periodsHtml = S.allReportPeriods && S.allReportPeriods.length > 0 ? `
    <div class="period-selector" style="margin-bottom:0;">
      <label>Saved Report Periods</label>
      ${S.allReportPeriods.map(p => `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">
          <div style="flex:1;font-size:14px;">${esc(p.label)}</div>
          <button class="btn btn-ghost btn-sm" data-load-period="${esc(p.key)}">Load</button>
          <button class="btn btn-danger btn-sm" data-del-period="${esc(p.key)}" data-del-period-sha="${esc(p.sha)}">Delete</button>
        </div>
      `).join('')}
    </div>
  ` : '';

  const clsFilterHtml = S.classrooms.length > 0 ? `
    <div style="margin-bottom:12px;">
      <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px;">Filter by Classroom</div>
      <select id="rep-cls-select" style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:10px;
        font-size:14px;font-weight:600;font-family:inherit;background:var(--bg);color:var(--text);">
        <option value="all"${S.reportClassroom === 'all' ? ' selected' : ''}>All Students</option>
        ${S.classrooms.map(c => `
          <option value="${esc(c.id)}"${S.reportClassroom === c.id ? ' selected' : ''}>${esc(c.name)}</option>
        `).join('')}
      </select>
    </div>
  ` : '';

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
        <div style="display:flex;gap:8px;margin-bottom:10px;">
          <button class="btn btn-secondary" id="load-reports-btn" style="flex:1;">Load Saved Reports</button>
          <button class="btn btn-ghost" id="list-periods-btn" style="flex:1;">Browse All Periods</button>
        </div>
      </div>
      ${periodsHtml}

      <div class="period-selector" style="margin-top:-4px;">
        ${clsFilterHtml}
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <label style="margin-bottom:0;">Select Students</label>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-ghost btn-sm" id="sel-all-btn">All</button>
            <button class="btn btn-ghost btn-sm" id="sel-none-btn">None</button>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:12px;">
          ${studentCheckboxes}
        </div>
        <button class="btn btn-primary" id="generate-btn" ${selCount === 0 ? 'disabled' : ''}>
          Generate Reports for ${selCount === S.students.length ? 'All' : selCount} Student${selCount === 1 ? '' : 's'}
        </button>
        <div class="generate-info" style="margin-top:8px;">
          Uses daily log data to write AI reports. A 2-second gap is added between each student to avoid overload errors.
        </div>
      </div>

      <div id="gen-progress"></div>

      ${savedHtml ? `
        <div style="font-size:13px;font-weight:700;color:var(--text-muted);text-transform:uppercase;
          letter-spacing:0.7px;padding:4px 0 10px;margin-top:4px;">
          ${S.savedReports?.periodLabel ? esc(S.savedReports.periodLabel) : 'Reports'}
          <span style="font-weight:400;text-transform:none;letter-spacing:0;">
            — generated ${S.savedReports?.generatedAt ? fmtDateShort(S.savedReports.generatedAt) : ''}
          </span>
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

  // Load reports for the selected date range
  document.getElementById('load-reports-btn')?.addEventListener('click', async () => {
    const start = S.reportPeriodStart;
    const end   = S.reportPeriodEnd;
    if (!start || !end) { showToast('Set a start and end date first'); return; }
    const btn = document.getElementById('load-reports-btn');
    btn.disabled = true; btn.textContent = 'Loading…';
    try {
      await loadSavedReports(`${start}_${end}`);
      if (!S.savedReports) showToast('No saved reports found for this period');
      render();
    } catch (e) { showToast('Could not load: ' + e.message); }
    finally { if (btn) { btn.disabled = false; btn.textContent = 'Load Saved Reports'; } }
  });

  // Browse / list all saved report periods
  document.getElementById('list-periods-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('list-periods-btn');
    btn.disabled = true; btn.textContent = 'Loading…';
    try {
      const files = await ghList('data/reports');
      S.allReportPeriods = await Promise.all(
        files.filter(f => f.name.endsWith('.json')).map(async f => {
          const key = f.name.replace('.json', '');
          const [startPart, endPart] = key.split('_');
          const label = startPart && endPart ? `${fmtDateShort(startPart)} – ${fmtDateShort(endPart)}` : key;
          return { key, label, sha: f.sha };
        })
      );
      S.allReportPeriods.sort((a, b) => b.key.localeCompare(a.key));
      render();
    } catch (e) { showToast('Could not list periods: ' + e.message); }
    finally { if (btn) { btn.disabled = false; btn.textContent = 'Browse All Periods'; } }
  });

  // Load a specific period from the browse list
  document.querySelectorAll('[data-load-period]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.loadPeriod;
      btn.disabled = true; btn.textContent = 'Loading…';
      try {
        await loadSavedReports(key);
        const [s, e] = key.split('_');
        S.reportPeriodStart = s || ''; S.reportPeriodEnd = e || '';
        render();
      } catch (err) { showToast('Could not load: ' + err.message); }
      finally { if (btn) { btn.disabled = false; btn.textContent = 'Load'; } }
    });
  });

  // Delete a report period
  document.querySelectorAll('[data-del-period]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.delPeriod;
      const sha = btn.dataset.delPeriodSha;
      const [s, e] = key.split('_');
      const label = s && e ? `${fmtDateShort(s)} – ${fmtDateShort(e)}` : key;
      if (!confirm(`Permanently delete reports for ${label}?`)) return;
      btn.disabled = true; btn.textContent = '…';
      try {
        await ghDelete(`data/reports/${key}.json`, sha, `Delete reports ${key}`);
        S.allReportPeriods = S.allReportPeriods?.filter(p => p.key !== key) || null;
        if (S.savedReports?.periodKey === key) S.savedReports = null;
        showToast('Reports deleted');
        render();
      } catch (err) { showToast('Delete failed: ' + err.message); }
      finally { if (btn) { btn.disabled = false; btn.textContent = 'Delete'; } }
    });
  });

  // Classroom dropdown filter for reports
  document.getElementById('rep-cls-select')?.addEventListener('change', e => {
    S.reportClassroom = e.target.value;
    S.selectedStudents = null; // reset selection to match new classroom
    render();
  });

  // Select all / none
  document.getElementById('sel-all-btn')?.addEventListener('click', () => {
    const pool = S.reportClassroom === 'all'
      ? S.students
      : S.students.filter(s => s.classroomId === S.reportClassroom);
    S.selectedStudents = new Set(pool.map(s => s.id));
    render();
  });
  document.getElementById('sel-none-btn')?.addEventListener('click', () => {
    S.selectedStudents = new Set();
    render();
  });

  // Individual checkboxes
  document.querySelectorAll('.student-sel-cb').forEach(cb => {
    cb.addEventListener('change', e => {
      if (e.target.checked) S.selectedStudents.add(e.target.value);
      else S.selectedStudents.delete(e.target.value);
      // Update generate button label without full re-render
      const genBtn = document.getElementById('generate-btn');
      if (genBtn) {
        const n = S.selectedStudents.size;
        genBtn.disabled = n === 0;
        genBtn.textContent = `Generate Reports for ${n === S.students.length ? 'All' : n} Student${n === 1 ? '' : 's'}`;
      }
    });
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
  if (!S.selectedStudents || S.selectedStudents.size === 0) { showToast('No students selected'); return; }

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

  const targetStudents = S.students.filter(s => S.selectedStudents.has(s.id));
  const results = [];
  const progressList = document.getElementById('progress-list');
  const statusMap = {}; // studentId -> { status, cls }
  targetStudents.forEach(s => { statusMap[s.id] = { status: 'Waiting', cls: '' }; });

  function renderProgressList() {
    progressList.innerHTML = targetStudents.map(st => {
      const { status, cls } = statusMap[st.id];
      const width = cls === 'done' ? 100 : status.includes('spinner') ? 50 : 0;
      return `<div class="progress-row">
        <div class="progress-name">${esc(st.name.split(' ')[0])}</div>
        <div class="progress-bar-wrap"><div class="progress-fill" style="width:${width}%"></div></div>
        <div class="progress-status ${cls}">${status}</div>
      </div>`;
    }).join('');
  }

  for (let i = 0; i < targetStudents.length; i++) {
    const student = targetStudents[i];

    statusMap[student.id] = { status: '<span class="inline-spinner"></span>', cls: '' };
    renderProgressList();

    // 2-second gap between calls to avoid overloaded errors (skip before first)
    if (i > 0) await new Promise(r => setTimeout(r, 2000));

    try {
      const { stats, absent, behaviourNotes } = calcSubjectStats(student, logs);
      const prevHighlighted = prevReports?.reports?.find(r => r.studentId === student.id)?.highlightedSubjects || [];
      const topTwo = pickTopSubjects(stats, prevHighlighted);
      const prompt = buildPrompt(student, stats, absent, topTwo, prevHighlighted, behaviourNotes);
      const text = await callClaude(prompt);
      results.push({ studentId: student.id, text, highlightedSubjects: topTwo });
      statusMap[student.id] = { status: 'Done ✓', cls: 'done' };
    } catch (e) {
      results.push({ studentId: student.id, text: `[Error generating report: ${e.message}]`, highlightedSubjects: [] });
      statusMap[student.id] = { status: 'Error', cls: 'error' };
    }
    renderProgressList();
  }

  // Merge new results with any existing reports for other students
  const existingReports = S.savedReports?.reports || [];
  const newIds = new Set(results.map(r => r.studentId));
  const merged = [
    ...existingReports.filter(r => !newIds.has(r.studentId)),
    ...results,
  ];

  const reportData = {
    periodKey,
    periodLabel: `${fmtDateShort(start)} – ${fmtDateShort(end)}`,
    generatedAt: todayStr(),
    reports: merged,
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

  const genderIcon = g => g === 'male' ? '♂' : g === 'female' ? '♀' : '⚬';
  const clsName = id => S.classrooms.find(c => c.id === id)?.name || '';

  const studentRows = S.students.map((st, i) => {
    const isEditing = S.editingStudentId === st.id;
    if (isEditing) {
      return `
        <div class="student-mgmt-row" style="flex-direction:column;align-items:stretch;gap:8px;padding:12px;" data-id="${esc(st.id)}">
          <div style="font-size:12px;font-weight:700;color:var(--primary);text-transform:uppercase;letter-spacing:0.5px;">Editing ${esc(st.name)}</div>
          <input type="text" id="edit-name-${esc(st.id)}" value="${esc(st.name)}"
            style="padding:10px 12px;border:1.5px solid var(--primary);border-radius:10px;font-size:15px;font-family:inherit;background:white;color:var(--text);">
          <div style="display:flex;gap:7px;">
            <select id="edit-gender-${esc(st.id)}"
              style="flex:1;padding:10px 12px;border:1.5px solid var(--border);border-radius:10px;font-size:14px;font-family:inherit;background:var(--bg);color:var(--text);">
              <option value="">Gender…</option>
              <option value="male" ${st.gender === 'male' ? 'selected' : ''}>Male</option>
              <option value="female" ${st.gender === 'female' ? 'selected' : ''}>Female</option>
              <option value="other" ${st.gender === 'other' ? 'selected' : ''}>Other / prefer not to say</option>
            </select>
            <select id="edit-cls-${esc(st.id)}"
              style="flex:1;padding:10px 12px;border:1.5px solid var(--border);border-radius:10px;font-size:14px;font-family:inherit;background:var(--bg);color:var(--text);">
              <option value="">No classroom</option>
              ${S.classrooms.map(c => `<option value="${esc(c.id)}" ${st.classroomId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div style="display:flex;gap:7px;">
            <button class="btn btn-primary btn-sm" style="flex:1;" data-save-edit="${esc(st.id)}">Save</button>
            <button class="btn btn-ghost btn-sm" style="flex:1;" data-cancel-edit="${esc(st.id)}">Cancel</button>
          </div>
        </div>
      `;
    }
    return `
      <div class="student-mgmt-row" data-id="${esc(st.id)}">
        <span class="student-mgmt-num">${i + 1}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:15px;font-weight:500;">${esc(st.name)}</div>
          <div style="font-size:12px;color:var(--text-muted);">
            ${genderIcon(st.gender)} ${st.gender || 'unspecified'}
            ${st.classroomId && clsName(st.classroomId) ? ` · ${esc(clsName(st.classroomId))}` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="icon-btn" title="Edit student" data-edit="${esc(st.id)}">✏️</button>
          <button class="icon-btn" title="Move up" data-up="${esc(st.id)}" ${i === 0 ? 'disabled style="opacity:0.3"' : ''}>↑</button>
          <button class="icon-btn" title="Move down" data-dn="${esc(st.id)}" ${i === S.students.length-1 ? 'disabled style="opacity:0.3"' : ''}>↓</button>
          <button class="icon-btn" title="Remove" data-del="${esc(st.id)}" style="color:var(--red)">✕</button>
        </div>
      </div>
    `;
  }).join('');

  const classroomOptions = S.classrooms.map(c =>
    `<option value="${esc(c.id)}">${esc(c.name)}</option>`
  ).join('');

  const classroomRows = S.classrooms.map((c, i) => `
    <div class="student-mgmt-row">
      <span style="font-size:15px;font-weight:500;flex:1;">${esc(c.name)}</span>
      <span style="font-size:12px;color:var(--text-muted);margin-right:8px;">
        ${S.students.filter(s => s.classroomId === c.id).length} students
      </span>
      <button class="icon-btn" title="Delete classroom" data-del-cls="${esc(c.id)}" style="color:var(--red)">✕</button>
    </div>
  `).join('');

  return `
    <div class="setup-wrap">
      <div class="setup-section">
        <div class="setup-section-title">🏫 Classrooms (${S.classrooms.length})</div>
        ${classroomRows || '<p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">No classrooms yet.</p>'}
        <div class="add-student-row" style="margin-top:8px;">
          <input type="text" id="new-cls-name" placeholder="Classroom name (e.g. Year 3 Blue)" autocomplete="off">
          <button class="btn btn-secondary btn-sm" id="add-cls-btn">Add</button>
        </div>
      </div>

      <div class="setup-section">
        <div class="setup-section-title">👩‍🏫 Students (${S.students.length})</div>
        <div class="student-mgmt-list">${studentRows}</div>
        <div style="display:flex;flex-direction:column;gap:7px;margin-top:8px;">
          <input type="text" id="new-name" placeholder="Full name" autocomplete="off"
            style="padding:11px 13px;border:1.5px solid var(--border);border-radius:10px;font-size:15px;font-family:inherit;background:var(--bg);color:var(--text);">
          <div style="display:flex;gap:7px;">
            <select id="new-gender" style="flex:1;padding:10px 12px;border:1.5px solid var(--border);border-radius:10px;font-size:14px;font-family:inherit;background:var(--bg);color:var(--text);">
              <option value="">Gender…</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="other">Other / prefer not to say</option>
            </select>
            <select id="new-cls" style="flex:1;padding:10px 12px;border:1.5px solid var(--border);border-radius:10px;font-size:14px;font-family:inherit;background:var(--bg);color:var(--text);">
              <option value="">No classroom</option>
              ${classroomOptions}
            </select>
          </div>
          <button class="btn btn-secondary" id="add-student-btn">Add Student</button>
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
  // Add classroom
  const addClsBtn = document.getElementById('add-cls-btn');
  const clsInput  = document.getElementById('new-cls-name');
  const doAddCls  = async () => {
    const name = clsInput?.value.trim();
    if (!name) return;
    addClsBtn.disabled = true;
    S.classrooms.push({ id: crypto.randomUUID(), name });
    try {
      await persistClassrooms();
      clsInput.value = '';
      showToast(`${name} created`);
      render();
    } catch (e) {
      S.classrooms.pop();
      showToast('Failed to save: ' + e.message);
    } finally { if (addClsBtn) addClsBtn.disabled = false; }
  };
  addClsBtn?.addEventListener('click', doAddCls);
  clsInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doAddCls(); });

  // Delete classroom
  document.querySelectorAll('[data-del-cls]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delCls;
      const cls = S.classrooms.find(c => c.id === id);
      if (!cls) return;
      const count = S.students.filter(s => s.classroomId === id).length;
      if (!confirm(`Delete "${cls.name}"?${count ? ` ${count} student(s) will be unassigned.` : ''}`)) return;
      S.classrooms = S.classrooms.filter(c => c.id !== id);
      S.students.forEach(s => { if (s.classroomId === id) s.classroomId = null; });
      try {
        await Promise.all([persistClassrooms(), persistStudents()]);
        if (S.activeClassroom === id) S.activeClassroom = 'all';
        showToast(`${cls.name} deleted`);
        render();
      } catch (e) { showToast('Failed: ' + e.message); }
    });
  });

  // Edit student — open form
  document.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.editingStudentId = btn.dataset.edit;
      render();
    });
  });

  // Edit student — cancel
  document.querySelectorAll('[data-cancel-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      S.editingStudentId = null;
      render();
    });
  });

  // Edit student — save
  document.querySelectorAll('[data-save-edit]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id      = btn.dataset.saveEdit;
      const student = S.students.find(s => s.id === id);
      if (!student) return;
      const newName      = document.getElementById(`edit-name-${id}`)?.value.trim();
      const newGender    = document.getElementById(`edit-gender-${id}`)?.value || '';
      const newClassroom = document.getElementById(`edit-cls-${id}`)?.value || null;
      if (!newName) { showToast('Name cannot be empty'); return; }
      const prev = { name: student.name, gender: student.gender, classroomId: student.classroomId };
      student.name = newName;
      student.gender = newGender;
      student.classroomId = newClassroom || null;
      btn.disabled = true;
      try {
        await persistStudents();
        S.editingStudentId = null;
        showToast(`${newName} updated`);
        render();
      } catch (e) {
        Object.assign(student, prev);
        showToast('Failed to save: ' + e.message);
      } finally { if (btn) btn.disabled = false; }
    });
  });

  // Add student
  const addBtn   = document.getElementById('add-student-btn');
  const nameInput = document.getElementById('new-name');

  const doAdd = async () => {
    const name        = nameInput.value.trim();
    const gender      = document.getElementById('new-gender')?.value || '';
    const classroomId = document.getElementById('new-cls')?.value || null;
    if (!name) return;
    if (S.students.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      showToast('Student already exists');
      return;
    }
    addBtn.disabled = true;
    S.students.push({ id: crypto.randomUUID(), name, gender, classroomId: classroomId || null });
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
    await Promise.all([loadStudents(), loadClassrooms(), loadDailyLog()]);
    setView('daily');
  } catch (e) {
    console.error('Init failed:', e);
    showToast('⚠️ Could not load data — check settings');
    setView('setup');
  }
}

init();

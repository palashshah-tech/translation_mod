/**
 * main.js — Translation Moderator frontend
 *
 * Handles project selection, translation table rendering, inline editing,
 * Google Auth via Firebase, and committing changes back to GitHub via Express.
 */

import './style.css';
import { auth, googleProvider } from './firebase.js';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';

// ── Custom SVG Logos ──────────────────────────────────────────────────
const PROJECT_LOGOS = {
  'xiberlinc': `
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M16 4C9.37258 4 4 9.37258 4 16C4 22.6274 9.37258 28 16 28C22.6274 28 28 22.6274 28 16C28 9.37258 22.6274 4 16 4Z" stroke="#007aff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M16 8V24" stroke="#007aff" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M8 16H24" stroke="#007aff" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="16" cy="16" r="4" fill="#007aff"/>
      <circle cx="16" cy="8" r="2" fill="#007aff"/>
      <circle cx="16" cy="24" r="2" fill="#007aff"/>
      <circle cx="8" cy="16" r="2" fill="#007aff"/>
      <circle cx="24" cy="16" r="2" fill="#007aff"/>
    </svg>
  `,
  'working-memory': `
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="5" y="5" width="8" height="8" rx="2" stroke="#30d158" stroke-width="2" stroke-linecap="round"/>
      <rect x="19" y="5" width="8" height="8" rx="2" stroke="#30d158" stroke-width="2" stroke-linecap="round"/>
      <rect x="5" y="19" width="8" height="8" rx="2" stroke="#30d158" stroke-width="2" stroke-linecap="round"/>
      <rect x="19" y="19" width="8" height="8" rx="2" stroke="#30d158" stroke-width="2" stroke-linecap="round"/>
      <circle cx="16" cy="16" r="2" fill="#30d158"/>
    </svg>
  `
};

const STATUS_ICONS = {
  edited: `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="7" cy="7" r="6.5" fill="rgba(10, 132, 255, 0.15)" stroke="#0a84ff" stroke-width="1"/>
      <path d="M4.5 9.5H5.5L8.5 6.5L7.5 5.5L4.5 8.5V9.5Z" fill="#0a84ff"/>
      <path d="M7.5 5.5L8.5 6.5L9 6L8 5L7.5 5.5Z" fill="#0a84ff"/>
    </svg>
  `,
  missing: `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="7" cy="7" r="6.5" fill="rgba(255, 214, 10, 0.15)" stroke="#ffd60a" stroke-width="1"/>
      <rect x="6.5" y="3.5" width="1" height="4" rx="0.5" fill="#ffd60a"/>
      <circle cx="7" cy="9.5" r="0.75" fill="#ffd60a"/>
    </svg>
  `,
  translated: `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="7" cy="7" r="6.5" fill="rgba(48, 209, 88, 0.15)" stroke="#30d158" stroke-width="1"/>
      <path d="M4.5 7L6 8.5L9.5 5" stroke="#30d158" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `
};

// ── State ────────────────────────────────────────────────────────────
const state = {
  projects: [],
  activeProject: null,
  translationData: null, // { project, sha, pairs }
  edits: {},             // { key: editedValue }
  searchQuery: '',
  filterEdited: false,
  filterMissing: false,
  loading: false,
  userToken: null,       // Firebase ID Token passed in API requests
  currentUser: null      // User profile info
};

// ── DOM Refs ─────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const dom = {
  app: $('#app'),
  loginContainer: $('#login-container'),
  loginError: $('#login-error'),
  btnGoogleLogin: $('#btn-google-login'),
  headerRight: $('.header-right'),
  statsBar: $('#stats-bar'),
  statTotal: $('#stat-total'),
  statTranslated: $('#stat-translated'),
  statEdited: $('#stat-edited'),
  progressFill: $('#progress-fill'),
  progressLabel: $('#progress-label'),
  toolbar: $('#toolbar'),
  searchInput: $('#search-input'),
  filterEdited: $('#filter-edited'),
  filterMissing: $('#filter-missing'),
  btnReset: $('#btn-reset'),
  btnSave: $('#btn-save'),
  projectsHome: $('#projects-home'),
  projectsGrid: $('#projects-grid'),
  loadingState: $('#loading-state'),
  errorState: $('#error-state'),
  errorTitle: $('#error-title'),
  errorMessage: $('#error-message'),
  tableContainer: $('#table-container'),
  tableBody: $('#table-body'),
  modalOverlay: $('#modal-overlay'),
  modalBody: $('#modal-body'),
  modalClose: $('#modal-close'),
  modalCancel: $('#modal-cancel'),
  modalConfirm: $('#modal-confirm'),
  logo: $('.logo'),
  toast: $('#toast'),
  toastContent: $('#toast-content'),
};

// ── API ──────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };
  
  if (state.userToken) {
    headers['Authorization'] = `Bearer ${state.userToken}`;
  }

  const res = await fetch(`/api${path}`, {
    headers,
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

// ── Authentication ───────────────────────────────────────────────────
function setupAuth() {
  dom.btnGoogleLogin.addEventListener('click', async () => {
    dom.loginError.style.display = 'none';
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error(err);
      showLoginError(`Login failed: ${err.message}`);
    }
  });

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      const email = user.email || '';
      
      // Accept ONLY @xiberlinc.one email addresses
      if (!email.endsWith('@xiberlinc.one')) {
        showLoginError('Access denied. Only @xiberlinc.one accounts are permitted.');
        await signOut(auth);
        handleSignOutState();
        return;
      }

      try {
        state.currentUser = user;
        state.userToken = await user.getIdToken();
        
        renderHeaderProfile(user);
        handleSignInState();
        
        // Load the projects home dashboard
        await loadProjects();
      } catch (err) {
        console.error(err);
        showLoginError('Session initialization failed. Please try again.');
        await signOut(auth);
        handleSignOutState();
      }
    } else {
      handleSignOutState();
    }
  });
}

function renderHeaderProfile(user) {
  const initial = (user.displayName || user.email || 'U').charAt(0).toUpperCase();
  dom.headerRight.innerHTML = `
    <div class="user-profile">
      <div class="user-avatar">${initial}</div>
      <span class="user-email">${user.email}</span>
      <button class="btn-signout" id="btn-signout">Sign Out</button>
    </div>
  `;
  
  // Re-bind signout listener since innerHTML replaced it
  $('#btn-signout').addEventListener('click', () => signOut(auth));
}

function handleSignInState() {
  document.body.classList.add('in-app');
  dom.loginContainer.style.display = 'none';
  dom.loginError.style.display = 'none';
  dom.app.style.display = 'flex';
}

function handleSignOutState() {
  document.body.classList.remove('in-app');
  state.currentUser = null;
  state.userToken = null;
  state.activeProject = null;
  state.translationData = null;
  state.edits = {};
  
  dom.app.style.display = 'none';
  dom.loginContainer.style.display = 'flex';
}

function showLoginError(msg) {
  dom.loginError.textContent = msg;
  dom.loginError.style.display = 'block';
}

// ── Project Handlers ─────────────────────────────────────────────────
async function loadProjects() {
  try {
    const { projects } = await api('/projects');
    state.projects = projects;
    renderProjectCards();
  } catch (err) {
    showError('Load failed', `Could not fetch configured projects: ${err.message}`);
  }
}

function renderProjectCards() {
  dom.projectsGrid.innerHTML = state.projects.map(p => {
    const disabled = !p.hasTranslations;
    const svgIcon = PROJECT_LOGOS[p.icon] || '📂';
    return `
      <div class="project-card ${disabled ? 'project-card-disabled' : ''}" data-id="${p.id}">
        <div class="project-card-icon">${svgIcon}</div>
        <div class="project-card-body">
          <div class="project-card-name">${p.name}</div>
          <div class="project-card-desc">${p.description}</div>
          <div class="project-card-repo">${p.repo}</div>
        </div>
        ${disabled ? '<div class="project-card-badge">No i18n</div>' : '<div class="project-card-arrow">→</div>'}
      </div>
    `;
  }).join('');

  dom.projectsGrid.querySelectorAll('.project-card:not(.project-card-disabled)').forEach(el => {
    el.addEventListener('click', () => selectProject(el.dataset.id));
  });
}

async function selectProject(id) {
  const project = state.projects.find(p => p.id === id);
  if (!project) return;

  state.activeProject = project;
  state.edits = {};

  await loadTranslations(id);
}

// ── Translations ─────────────────────────────────────────────────────
async function loadTranslations(projectId) {
  showView('loading');
  state.loading = true;

  try {
    const data = await api(`/projects/${projectId}/translations`);
    state.translationData = data;
    state.edits = {};

    showView('table');
    updateStats();
    renderTable();
  } catch (err) {
    showError('Failed to load translations', err.message);
  } finally {
    state.loading = false;
  }
}

// ── Table Rendering ──────────────────────────────────────────────────
function renderTable() {
  const { pairs } = state.translationData;
  const filtered = filterPairs(pairs);

  dom.tableBody.innerHTML = filtered
    .map(pair => renderRow(pair))
    .join('');

  dom.tableBody.querySelectorAll('.edit-area').forEach(textarea => {
    textarea.addEventListener('input', handleEdit);
  });

  updateSaveButton();
}

function renderRow(pair) {
  const { key, en, jp, isArray } = pair;
  const edited = key in state.edits;
  const missing = jp === null || jp === undefined;
  const currentValue = edited ? state.edits[key] : (isArray ? JSON.stringify(jp) : (jp ?? ''));
  const displayValue = isArray ? JSON.stringify(currentValue) : currentValue;

  let statusIconSvg, statusTitle;
  if (edited) {
    statusIconSvg = STATUS_ICONS.edited;
    statusTitle = 'Edited';
  } else if (missing) {
    statusIconSvg = STATUS_ICONS.missing;
    statusTitle = 'Missing';
  } else {
    statusIconSvg = STATUS_ICONS.translated;
    statusTitle = 'Translated';
  }

  const enDisplay = isArray
    ? renderArrayDisplay(en)
    : escapeHtml(String(en ?? ''));

  const jpAiDisplay = isArray
    ? renderArrayDisplay(jp)
    : escapeHtml(String(jp ?? '—'));

  const rowClass = edited ? 'row-edited' : missing ? 'row-missing' : '';

  return `
    <tr class="${rowClass}" data-key="${escapeAttr(key)}">
      <td><div class="cell-key">${escapeHtml(key)}</div></td>
      <td><div class="cell-en">${enDisplay}</div></td>
      <td><div class="cell-jp-ai">${jpAiDisplay}</div></td>
      <td class="cell-jp-human">
        <textarea
          class="edit-area ${edited ? 'modified' : ''} ${isArray ? 'is-array' : ''}"
          data-key="${escapeAttr(key)}"
          data-is-array="${isArray}"
          data-original="${escapeAttr(isArray ? JSON.stringify(jp) : (jp ?? ''))}"
          placeholder="${isArray ? 'Edit as JSON array…' : 'Enter Japanese translation…'}"
        >${escapeHtml(String(displayValue))}</textarea>
      </td>
      <td>
        <div class="status-indicator" title="${statusTitle}">${statusIconSvg}</div>
      </td>
    </tr>
  `;
}

function renderArrayDisplay(arr) {
  if (!Array.isArray(arr)) return escapeHtml(String(arr ?? '—'));
  return `<div class="array-items">${arr.map((item, i) =>
    `<div><span class="array-idx">[${i}]</span>${escapeHtml(String(item))}</div>`
  ).join('')}</div>`;
}

// ── Editing ──────────────────────────────────────────────────────────
function handleEdit(e) {
  const textarea = e.target;
  const key = textarea.dataset.key;
  const isArray = textarea.dataset.isArray === 'true';
  const original = textarea.dataset.original;
  const currentValue = textarea.value;

  if (currentValue === original) {
    delete state.edits[key];
    textarea.classList.remove('modified');
  } else {
    if (isArray) {
      try {
        const parsed = JSON.parse(currentValue);
        if (Array.isArray(parsed)) {
          state.edits[key] = parsed;
        } else {
          state.edits[key] = currentValue;
        }
      } catch {
        state.edits[key] = currentValue;
      }
    } else {
      state.edits[key] = currentValue;
    }
    textarea.classList.add('modified');
  }

  updateStats();
  updateSaveButton();
  updateRowStatus(key);
}

function updateRowStatus(key) {
  const row = dom.tableBody.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
  if (!row) return;

  const edited = key in state.edits;
  const statusCell = row.querySelector('.status-indicator');

  row.classList.toggle('row-edited', edited);
  if (edited) {
    statusCell.innerHTML = STATUS_ICONS.edited;
    statusCell.title = 'Edited';
  } else {
    const pair = state.translationData.pairs.find(p => p.key === key);
    const missing = !pair || pair.jp === null;
    statusCell.innerHTML = missing ? STATUS_ICONS.missing : STATUS_ICONS.translated;
    statusCell.title = missing ? 'Missing' : 'Translated';
    row.classList.toggle('row-missing', missing);
  }
}

// ── Filtering ────────────────────────────────────────────────────────
function filterPairs(pairs) {
  return pairs.filter(pair => {
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const matchKey = pair.key.toLowerCase().includes(q);
      const matchEn = String(pair.en ?? '').toLowerCase().includes(q);
      const matchJp = String(pair.jp ?? '').toLowerCase().includes(q);
      if (!matchKey && !matchEn && !matchJp) return false;
    }

    if (state.filterEdited && !(pair.key in state.edits)) return false;
    if (state.filterMissing && pair.jp !== null) return false;

    return true;
  });
}

// ── Stats ────────────────────────────────────────────────────────────
function updateStats() {
  if (!state.translationData) return;

  const { totalKeys, translatedKeys } = state.translationData;
  const editedCount = Object.keys(state.edits).length;

  dom.statTotal.textContent = totalKeys;
  dom.statTranslated.textContent = translatedKeys;
  dom.statEdited.textContent = editedCount;

  const pct = totalKeys > 0 ? Math.round((translatedKeys / totalKeys) * 100) : 0;
  dom.progressFill.style.width = `${pct}%`;
  dom.progressLabel.textContent = `${pct}%`;
}

function updateSaveButton() {
  const hasEdits = Object.keys(state.edits).length > 0;
  dom.btnSave.disabled = !hasEdits;
}

// ── View Management ──────────────────────────────────────────────────
function showView(view) {
  dom.projectsHome.style.display = view === 'projects' ? '' : 'none';
  dom.loadingState.style.display = view === 'loading' ? '' : 'none';
  dom.errorState.style.display = view === 'error' ? '' : 'none';
  dom.tableContainer.style.display = view === 'table' ? '' : 'none';
  dom.statsBar.style.display = (view === 'table') ? '' : 'none';
  dom.toolbar.style.display = (view === 'table') ? '' : 'none';
}

function showError(title, message) {
  dom.errorTitle.textContent = title;
  dom.errorMessage.textContent = message;
  showView('error');
}

// ── Commit Modal ─────────────────────────────────────────────────────
function openCommitModal() {
  const changedKeys = Object.keys(state.edits);
  if (changedKeys.length === 0) return;

  dom.modalBody.innerHTML = `
    <p>You are about to commit <strong>${changedKeys.length}</strong> translation change(s) to
    <strong>${state.activeProject.name}</strong>.</p>
    <p>A new branch and Pull Request will be created on <code>${state.translationData.project.repo}</code>.</p>
    <div class="change-summary">
      ${changedKeys.map(k => `<div class="change-item">${k}</div>`).join('')}
    </div>
    <p style="color: var(--text-muted); font-size: 12px;">
      Branch: <code>translations/batch-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}</code>
    </p>
  `;

  dom.modalOverlay.style.display = '';
}

function closeModal() {
  dom.modalOverlay.style.display = 'none';
}

async function confirmCommit() {
  closeModal();
  dom.btnSave.disabled = true;

  try {
    const result = await api(`/projects/${state.activeProject.id}/translations`, {
      method: 'POST',
      body: JSON.stringify({
        updates: state.edits,
        sha: state.translationData.sha,
      }),
    });

    showToast(
      `PR created with ${result.changedKeys} change(s)! <a href="${result.pr.prUrl}" target="_blank">View PR #${result.pr.prNumber} →</a>`,
      'success'
    );

    state.edits = {};
    await loadTranslations(state.activeProject.id);
  } catch (err) {
    showToast(`Commit failed: ${err.message}`, 'error');
    dom.btnSave.disabled = false;
  }
}

// ── Toast ────────────────────────────────────────────────────────────
function showToast(html, type = 'success') {
  dom.toast.className = `toast toast-${type}`;
  dom.toastContent.innerHTML = html;
  dom.toast.style.display = '';

  setTimeout(() => {
    dom.toast.style.display = 'none';
  }, 8000);
}

// ── Reset ────────────────────────────────────────────────────────────
function resetEdits() {
  if (Object.keys(state.edits).length === 0) return;
  if (!confirm('Reset all edits? This will discard all your changes.')) return;

  state.edits = {};
  renderTable();
  updateStats();
}

// ── Utilities ────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Event Bindings ───────────────────────────────────────────────────
function bindEvents() {
  dom.logo.addEventListener('click', () => {
    if (state.currentUser) {
      state.activeProject = null;
      state.edits = {};
      state.translationData = null;
      showView('projects');
    }
  });

  // Search
  dom.searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderTable();
  });

  // Filters
  dom.filterEdited.addEventListener('change', (e) => {
    state.filterEdited = e.target.checked;
    renderTable();
  });

  dom.filterMissing.addEventListener('change', (e) => {
    state.filterMissing = e.target.checked;
    renderTable();
  });

  // Reset
  dom.btnReset.addEventListener('click', resetEdits);

  // Save
  dom.btnSave.addEventListener('click', openCommitModal);

  // Modal
  dom.modalClose.addEventListener('click', closeModal);
  dom.modalCancel.addEventListener('click', closeModal);
  dom.modalConfirm.addEventListener('click', confirmCommit);
  dom.modalOverlay.addEventListener('click', (e) => {
    if (e.target === dom.modalOverlay) closeModal();
  });

  // Keyboard shortcut: Cmd/Ctrl+S to save
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (!dom.btnSave.disabled) openCommitModal();
    }
  });
}

// ── Init ─────────────────────────────────────────────────────────────
async function init() {
  bindEvents();
  setupAuth();
}

init();

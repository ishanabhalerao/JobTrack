/* ==========================================================================
   JobTrack — app.js
   Vanilla JS: state, localStorage persistence, rendering, modal, filters,
   and follow-up alerts. No build step, no backend, no dependencies.
   ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */
  const STORAGE_KEY = 'jobtrack.v1';
  const BACKUP_KEY = 'jobtrack.v1.corrupt-backup';
  const PREFS_KEY = 'jobtrack.prefs.v1';

  const STATUSES = ['Applied', 'Interviewing', 'Offer', 'Rejected'];
  const TYPES = ['Club', 'Internship'];

  const STATUS_META = {
    Applied:      { color: '#818cf8', icon: 'fa-paper-plane', hint: 'Waiting to hear back' },
    Interviewing: { color: '#fbbf24', icon: 'fa-comments',    hint: 'In the process' },
    Offer:        { color: '#34d399', icon: 'fa-circle-check', hint: 'Decision time' },
    Rejected:     { color: '#fb7185', icon: 'fa-circle-xmark', hint: 'Closed out' }
  };

  /* ------------------------------------------------------------------ *
   * DOM references
   * ------------------------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const els = {
    board: $('#board'),
    emptyState: $('#empty-state'),
    emptyTitle: $('#empty-title'),
    emptyText: $('#empty-text'),
    emptyAddBtn: $('#empty-add-btn'),
    openModalBtn: $('#open-modal-btn'),
    closeModalBtn: $('#close-modal-btn'),
    cancelBtn: $('#cancel-btn'),
    modal: $('#modal'),
    modalTitle: $('#modal-title'),
    submitLabel: $('#submit-label'),
    form: $('#app-form'),
    company: $('#company'),
    role: $('#role'),
    type: $('#type'),
    status: $('#status'),
    nextDate: $('#nextDate'),
    search: $('#search-input'),
    filterGroup: $('#filter-group'),
    layoutGroup: $('#layout-group'),
    metricTotal: $('#metric-total'),
    metricInterviews: $('#metric-interviews'),
    metricDue: $('#metric-due'),
    metricDueSub: $('#metric-due-sub'),
    metricDueCard: $('#metric-due-card'),
    toast: $('#toast')
  };

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  const state = {
    apps: [],
    filter: 'all',        // 'all' | 'Club' | 'Internship'
    layout: 'board',      // 'board' | 'list'
    query: '',
    editingId: null,
    newId: null,          // id of the most recently added card (for highlight)
    storageOk: true,
    lastType: 'Club'
  };

  /* ------------------------------------------------------------------ *
   * Utilities
   * ------------------------------------------------------------------ */
  const uid = () =>
    (window.crypto && typeof window.crypto.randomUUID === 'function')
      ? window.crypto.randomUUID()
      : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  const escapeHTML = (str) =>
    String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Local-time YYYY-MM-DD (never UTC, so "today" flips at local midnight). */
  const toISODate = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const todayISO = () => toISODate(new Date());

  /** Parse YYYY-MM-DD as a local date (avoids the UTC off-by-one bug). */
  const parseISODate = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  const isValidISODate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(parseISODate(v).getTime());

  /** Whole days from today to the given ISO date (negative = overdue). */
  const daysUntil = (iso) => {
    const t = parseISODate(todayISO());
    const d = parseISODate(iso);
    return Math.round((d - t) / 86400000);
  };

  const formatDate = (iso) => {
    const d = parseISODate(iso);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' });
  };

  /** Describe a card's follow-up state. */
  const followUpInfo = (app) => {
    if (!app.nextDate) return { level: 'none' };
    const diff = daysUntil(app.nextDate);
    if (diff < 0) return { level: 'overdue', diff, label: diff === -1 ? 'Overdue 1 day' : `Overdue ${Math.abs(diff)} days` };
    if (diff === 0) return { level: 'due', diff, label: 'Due today' };
    if (diff === 1) return { level: 'upcoming', diff, label: 'Tomorrow' };
    return { level: 'upcoming', diff, label: `In ${diff} days` };
  };

  /* ------------------------------------------------------------------ *
   * Persistence (localStorage) — defensive against corruption & blocking
   * ------------------------------------------------------------------ */
  const sanitizeRecord = (r) => {
    if (!r || typeof r !== 'object') return null;
    const company = typeof r.company === 'string' ? r.company.trim().slice(0, 80) : '';
    const role = typeof r.role === 'string' ? r.role.trim().slice(0, 80) : '';
    if (!company || !role) return null;
    return {
      id: typeof r.id === 'string' && r.id ? r.id : uid(),
      company,
      role,
      type: TYPES.includes(r.type) ? r.type : 'Club',
      status: STATUSES.includes(r.status) ? r.status : 'Applied',
      nextDate: isValidISODate(r.nextDate) ? r.nextDate : '',
      createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now()
    };
  };

  const loadApps = () => {
    let raw = null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      state.storageOk = false;
      return [];
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Stored data is not a list');
      return parsed.map(sanitizeRecord).filter(Boolean);
    } catch (err) {
      // Keep the unreadable data around instead of silently destroying it.
      try { window.localStorage.setItem(BACKUP_KEY, raw); } catch (_) { /* ignore */ }
      showToast('Saved data was unreadable, so we started fresh. A backup was kept in your browser.', 'error', 6000);
      return [];
    }
  };

  const saveApps = () => {
    if (!state.storageOk) return false;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.apps));
      return true;
    } catch (err) {
      showToast('Could not save. Browser storage may be full or blocked.', 'error', 5000);
      return false;
    }
  };

  const loadPrefs = () => {
    try {
      const p = JSON.parse(window.localStorage.getItem(PREFS_KEY) || '{}');
      if (TYPES.includes(p.lastType)) state.lastType = p.lastType;
      if (['all', ...TYPES].includes(p.filter)) state.filter = p.filter;
      if (['board', 'list'].includes(p.layout)) state.layout = p.layout;
    } catch (_) { /* prefs are optional */ }
  };
  const savePrefs = () => {
    if (!state.storageOk) return;
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify({
        lastType: state.lastType, filter: state.filter, layout: state.layout
      }));
    } catch (_) { /* ignore */ }
  };

  /* ------------------------------------------------------------------ *
   * Toast
   * ------------------------------------------------------------------ */
  let toastTimer = null;
  function showToast(message, kind = 'info', duration = 2600) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', kind === 'error');
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), duration);
  }

  /* ------------------------------------------------------------------ *
   * Derived data
   * ------------------------------------------------------------------ */
  const visibleApps = () => {
    const q = state.query.trim().toLowerCase();
    return state.apps.filter((a) => {
      if (state.filter !== 'all' && a.type !== state.filter) return false;
      if (q && !(a.company.toLowerCase().includes(q) || a.role.toLowerCase().includes(q))) return false;
      return true;
    });
  };

  /** Dated items first (soonest/most overdue on top), then newest created. */
  const byUrgency = (a, b) => {
    if (a.nextDate && b.nextDate) {
      if (a.nextDate !== b.nextDate) return a.nextDate < b.nextDate ? -1 : 1;
    } else if (a.nextDate) return -1;
    else if (b.nextDate) return 1;
    return b.createdAt - a.createdAt;
  };

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */
  function renderMetrics() {
    const total = state.apps.length;
    const interviews = state.apps.filter((a) => a.status === 'Interviewing').length;
    let dueToday = 0;
    let overdue = 0;
    state.apps.forEach((a) => {
      const f = followUpInfo(a);
      if (f.level === 'due') dueToday++;
      else if (f.level === 'overdue') overdue++;
    });
    const dueTotal = dueToday + overdue;

    setMetric(els.metricTotal, total);
    setMetric(els.metricInterviews, interviews);
    setMetric(els.metricDue, dueTotal);

    els.metricDueCard.classList.toggle('alert', overdue > 0);
    els.metricDueCard.classList.toggle('warn', overdue === 0 && dueToday > 0);

    if (dueTotal === 0) {
      els.metricDueSub.textContent = 'Nothing due today';
    } else {
      const parts = [];
      if (overdue) parts.push(`${overdue} overdue`);
      if (dueToday) parts.push(`${dueToday} due today`);
      els.metricDueSub.textContent = parts.join(' · ');
    }
  }

  function setMetric(el, value) {
    const next = String(value);
    if (el.textContent !== next) {
      el.textContent = next;
      el.classList.remove('metric-bump');
      void el.offsetWidth; // restart animation
      el.classList.add('metric-bump');
    }
  }

  function cardHTML(app) {
    const f = followUpInfo(app);
    const cardClass = f.level === 'overdue' ? 'is-overdue' : f.level === 'due' ? 'is-due' : '';
    const isNew = app.id === state.newId ? 'is-new' : '';
    const typeBadge = app.type === 'Club'
      ? '<span class="badge badge-club"><i class="fa-solid fa-users"></i>Club</span>'
      : '<span class="badge badge-internship"><i class="fa-solid fa-briefcase"></i>Internship</span>';

    let flag = '';
    if (f.level === 'overdue') flag = `<span class="flag flag-overdue" title="Follow-up overdue"><i class="fa-solid fa-triangle-exclamation"></i>${f.label}</span>`;
    else if (f.level === 'due') flag = `<span class="flag flag-due" title="Follow-up due today"><i class="fa-solid fa-bell"></i>${f.label}</span>`;

    const dateLine = app.nextDate
      ? `<span class="card-date"><i class="fa-regular fa-calendar"></i>Next: ${escapeHTML(formatDate(app.nextDate))}${f.level === 'upcoming' ? ` · ${f.label.toLowerCase()}` : ''}</span>`
      : '<span class="card-date"><i class="fa-regular fa-calendar"></i>No follow-up date</span>';

    const options = STATUSES
      .map((s) => `<option value="${s}"${s === app.status ? ' selected' : ''}>${s}</option>`)
      .join('');

    return `
      <article class="app-card glass-card ${cardClass} ${isNew}" data-id="${escapeHTML(app.id)}">
        <div class="card-main">
          <div class="mb-2 flex flex-wrap items-center gap-2">${typeBadge}${flag}</div>
          <h3 class="card-company" title="${escapeHTML(app.company)}">${escapeHTML(app.company)}</h3>
          <p class="card-role" title="${escapeHTML(app.role)}">${escapeHTML(app.role)}</p>
          <div class="mt-2">${dateLine}</div>
        </div>
        <div class="card-side">
          <div class="card-actions w-full">
            <select class="status-select" data-action="status" data-status="${app.status}" aria-label="Status for ${escapeHTML(app.company)}">${options}</select>
            <div class="flex items-center gap-1">
              <button type="button" class="icon-btn" data-action="edit" title="Edit" aria-label="Edit ${escapeHTML(app.company)}"><i class="fa-solid fa-pen"></i></button>
              <button type="button" class="icon-btn danger" data-action="delete" title="Delete" aria-label="Delete ${escapeHTML(app.company)}"><i class="fa-solid fa-trash-can"></i></button>
            </div>
          </div>
        </div>
      </article>`;
  }

  function renderBoard(apps) {
    els.board.className = 'mt-6 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4';
    els.board.innerHTML = STATUSES.map((status) => {
      const items = apps.filter((a) => a.status === status).sort(byUrgency);
      const meta = STATUS_META[status];
      const body = items.length
        ? items.map(cardHTML).join('')
        : `<div class="column-empty"><span><i class="fa-solid ${meta.icon} mr-2 opacity-60"></i>${meta.hint}</span></div>`;
      return `
        <section class="column" aria-label="${status}">
          <header class="column-head">
            <h2 class="column-title"><span class="column-dot" style="background:${meta.color};color:${meta.color}"></span>${status}</h2>
            <span class="column-count">${items.length}</span>
          </header>
          <div class="column-body">${body}</div>
        </section>`;
    }).join('');
  }

  function renderList(apps) {
    els.board.className = 'list-layout mt-6 flex flex-col gap-3';
    const items = apps.slice().sort(byUrgency);
    els.board.innerHTML = items.map(cardHTML).join('');
  }

  function render() {
    // A re-render replaces every delete button, so drop any half-armed deletes.
    pendingDelete.forEach((timer) => clearTimeout(timer));
    pendingDelete.clear();

    renderMetrics();

    // Sync control states
    $$('.filter-btn', els.filterGroup).forEach((b) => {
      const active = b.dataset.filter === state.filter;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    $$('.layout-btn', els.layoutGroup).forEach((b) => b.classList.toggle('active', b.dataset.layout === state.layout));

    const hasAny = state.apps.length > 0;
    const apps = visibleApps();

    if (!hasAny || apps.length === 0) {
      els.board.classList.add('hidden');
      els.board.innerHTML = '';
      els.emptyState.classList.add('show');
      if (!hasAny) {
        els.emptyTitle.textContent = 'No applications yet';
        els.emptyText.textContent = 'Add your first club or internship application. It takes under 10 seconds, and everything stays in your browser.';
        els.emptyAddBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Add your first application';
        els.emptyAddBtn.dataset.mode = 'add';
      } else {
        els.emptyTitle.textContent = 'Nothing matches your view';
        els.emptyText.textContent = 'Try a different filter or clear your search to see the rest of your pipeline.';
        els.emptyAddBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> Reset filters';
        els.emptyAddBtn.dataset.mode = 'reset';
      }
      return;
    }

    els.emptyState.classList.remove('show');
    els.board.classList.remove('hidden');
    if (state.layout === 'list') renderList(apps); else renderBoard(apps);
    state.newId = null;
  }

  /* ------------------------------------------------------------------ *
   * Modal
   * ------------------------------------------------------------------ */
  let lastFocus = null;

  function clearErrors() {
    $$('[data-error-for]', els.form).forEach((p) => { p.textContent = ''; });
    $$('.field', els.form).forEach((f) => f.classList.remove('invalid'));
  }

  function setError(name, message) {
    const p = $(`[data-error-for="${name}"]`, els.form);
    const input = els.form.elements[name];
    if (p) p.textContent = message;
    if (input) input.classList.add('invalid');
  }

  function openModal(id = null) {
    lastFocus = document.activeElement;
    state.editingId = id;
    clearErrors();

    if (id) {
      const app = state.apps.find((a) => a.id === id);
      if (!app) return;
      els.modalTitle.textContent = 'Edit Application';
      els.submitLabel.textContent = 'Save changes';
      els.company.value = app.company;
      els.role.value = app.role;
      els.type.value = app.type;
      els.status.value = app.status;
      els.nextDate.value = app.nextDate || '';
    } else {
      els.modalTitle.textContent = 'Add Application';
      els.submitLabel.textContent = 'Save';
      els.form.reset();
      els.type.value = state.lastType;
      els.status.value = 'Applied';
    }

    els.modal.classList.add('open');
    els.modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    setTimeout(() => els.company.focus(), 60);
  }

  function closeModal() {
    els.modal.classList.remove('open');
    els.modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    state.editingId = null;
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  const isModalOpen = () => els.modal.classList.contains('open');

  function handleSubmit(e) {
    e.preventDefault();
    clearErrors();

    const company = els.company.value.trim();
    const role = els.role.value.trim();
    const type = els.type.value;
    const status = els.status.value;
    const nextDate = els.nextDate.value;

    let valid = true;
    if (!company) { setError('company', 'Please enter a company or organization.'); valid = false; }
    if (!role) { setError('role', 'Please enter a role or title.'); valid = false; }
    if (!valid) {
      (company ? els.role : els.company).focus();
      return;
    }

    if (state.editingId) {
      const app = state.apps.find((a) => a.id === state.editingId);
      if (app) {
        Object.assign(app, { company, role, type, status, nextDate: isValidISODate(nextDate) ? nextDate : '' });
        saveApps();
        showToast('Changes saved');
      }
    } else {
      const record = {
        id: uid(), company, role, type, status,
        nextDate: isValidISODate(nextDate) ? nextDate : '',
        createdAt: Date.now()
      };
      state.apps.push(record);
      state.newId = record.id;
      state.lastType = type;
      saveApps();
      savePrefs();
      showToast(`Added ${company}`);
    }

    closeModal();
    render();
  }

  /* ------------------------------------------------------------------ *
   * Card interactions (event delegation)
   * ------------------------------------------------------------------ */
  const pendingDelete = new Map(); // id -> timeout

  function resetDeleteButton(btn) {
    btn.classList.remove('confirm');
    btn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
    btn.setAttribute('title', 'Delete');
  }

  function handleBoardClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'SELECT') return;
    const card = btn.closest('.app-card');
    if (!card) return;
    const id = card.dataset.id;

    if (btn.dataset.action === 'edit') {
      openModal(id);
      return;
    }

    if (btn.dataset.action === 'delete') {
      // Two-step delete: first click arms, second click confirms.
      if (pendingDelete.has(id)) {
        clearTimeout(pendingDelete.get(id));
        pendingDelete.delete(id);
        const app = state.apps.find((a) => a.id === id);
        state.apps = state.apps.filter((a) => a.id !== id);
        saveApps();
        render();
        showToast(app ? `Deleted ${app.company}` : 'Deleted');
      } else {
        btn.classList.add('confirm');
        btn.textContent = 'Delete?';
        btn.setAttribute('title', 'Click again to confirm');
        pendingDelete.set(id, setTimeout(() => {
          pendingDelete.delete(id);
          resetDeleteButton(btn);
        }, 3000));
      }
    }
  }

  function handleBoardChange(e) {
    const select = e.target.closest('select[data-action="status"]');
    if (!select) return;
    const card = select.closest('.app-card');
    const app = state.apps.find((a) => a.id === card.dataset.id);
    if (!app || !STATUSES.includes(select.value)) return;
    app.status = select.value;
    saveApps();
    render();
    showToast(`${app.company} moved to ${app.status}`);
  }

  /* ------------------------------------------------------------------ *
   * Event wiring
   * ------------------------------------------------------------------ */
  function bindEvents() {
    els.openModalBtn.addEventListener('click', () => openModal());
    els.emptyAddBtn.addEventListener('click', () => {
      if (els.emptyAddBtn.dataset.mode === 'reset') {
        state.filter = 'all';
        state.query = '';
        els.search.value = '';
        savePrefs();
        render();
      } else {
        openModal();
      }
    });

    els.closeModalBtn.addEventListener('click', closeModal);
    els.cancelBtn.addEventListener('click', closeModal);
    els.modal.addEventListener('mousedown', (e) => { if (e.target === els.modal) closeModal(); });
    els.form.addEventListener('submit', handleSubmit);
    els.form.addEventListener('input', (e) => {
      if (e.target.classList && e.target.classList.contains('invalid')) {
        e.target.classList.remove('invalid');
        const p = $(`[data-error-for="${e.target.name}"]`, els.form);
        if (p) p.textContent = '';
      }
    });

    els.filterGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      state.filter = btn.dataset.filter;
      savePrefs();
      render();
    });

    els.layoutGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-layout]');
      if (!btn) return;
      state.layout = btn.dataset.layout;
      savePrefs();
      render();
    });

    els.search.addEventListener('input', () => {
      state.query = els.search.value;
      render();
    });

    els.board.addEventListener('click', handleBoardClick);
    els.board.addEventListener('change', handleBoardChange);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isModalOpen()) {
        closeModal();
        return;
      }
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if (!isModalOpen() && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        openModal();
      }
    });

    // Keep follow-up flags accurate when the tab regains focus (e.g. next morning).
    document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
    // Re-evaluate shortly after local midnight while the tab stays open.
    scheduleMidnightRefresh();
  }

  function scheduleMidnightRefresh() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    setTimeout(() => { render(); scheduleMidnightRefresh(); }, next - now);
  }

  /* ------------------------------------------------------------------ *
   * Init
   * ------------------------------------------------------------------ */
  function init() {
    try {
      // Probe storage once so private-mode / blocked cases are detected early.
      const probe = '__jobtrack_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
    } catch (_) {
      state.storageOk = false;
    }

    loadPrefs();
    state.apps = loadApps();
    els.search.value = '';
    bindEvents();
    render();

    if (!state.storageOk) {
      showToast('Browser storage is blocked, so changes will not be saved after you close this tab.', 'error', 7000);
    }
  }

  init();
})();

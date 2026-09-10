(() => {
  const $ = (id) => document.getElementById(id);
  const input = $('q');
  const sugg = $('sugg');
  const status = $('status');
  let debounceTimer;
  let stageTimer;

  // Loading-state styles
  const style = document.createElement('style');
  style.textContent = `
    .status { display: flex; align-items: center; gap: 10px; }
    .spinner {
      width: 18px; height: 18px; flex-shrink: 0;
      border: 2.5px solid rgba(255,255,255,0.25);
      border-top-color: #f08a2e;
      border-radius: 50%;
      animation: auditspin 0.8s linear infinite;
    }
    @keyframes auditspin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 1.6s; } }
    .status .msg { transition: opacity 0.25s ease; }
    .status .msg.swap { opacity: 0; }
    input.auditing { opacity: 0.6; pointer-events: none; }
  `;
  document.head.appendChild(style);

  const STAGES = [
    'Pulling your profile from Google\u2026',
    'Finding the businesses ranking near you\u2026',
    'Scoring 10 local ranking factors\u2026',
    'Writing your report\u2026',
  ];

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 3) { setStatus(''); return closeSuggestions(); }
    setStatus('Searching\u2026', true);
    debounceTimer = setTimeout(() => searchPlaces(q), 300);
  });

  document.addEventListener('click', (e) => {
    if (!sugg.contains(e.target) && e.target !== input) closeSuggestions();
  });

  async function searchPlaces(q) {
    try {
      const res = await fetch(`/api/place-search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setStatus('');
      renderSuggestions(data.suggestions || []);
    } catch { setStatus(''); closeSuggestions(); }
  }

  function renderSuggestions(list) {
    if (!list.length) {
      setStatus('No matches found. Try adding your area, e.g. "3 Bros Stechford".');
      return closeSuggestions();
    }
    sugg.innerHTML = '';
    list.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.innerHTML = `${escapeHtml(s.name)}<span class="addr">${escapeHtml(s.address)}</span>`;
      b.addEventListener('click', () => {
        input.value = s.name;
        closeSuggestions();
        runAudit(s.placeId);
      });
      sugg.appendChild(b);
    });
    sugg.classList.add('open');
  }

  function closeSuggestions() { sugg.classList.remove('open'); sugg.innerHTML = ''; }

  function setStatus(text, withSpinner = false) {
    clearInterval(stageTimer);
    if (!text) { status.innerHTML = ''; return; }
    status.innerHTML = `${withSpinner ? '<span class="spinner" aria-hidden="true"></span>' : ''}<span class="msg">${escapeHtml(text)}</span>`;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
  }

  function startStagedStatus() {
    let i = 0;
    setStatus(STAGES[0], true);
    stageTimer = setInterval(() => {
      i += 1;
      if (i >= STAGES.length) return clearInterval(stageTimer);
      const msg = status.querySelector('.msg');
      if (!msg) return;
      msg.classList.add('swap');
      setTimeout(() => { msg.textContent = STAGES[i]; msg.classList.remove('swap'); }, 250);
    }, 2200);
  }

  async function runAudit(placeId) {
    $('report').style.display = 'none';
    input.classList.add('auditing');
    startStagedStatus();
    try {
      const res = await fetch(`/api/audit?placeId=${encodeURIComponent(placeId)}`);
      if (!res.ok) throw new Error('Audit failed');
      const data = await res.json();
      renderReport(data);
      setStatus('');
    } catch {
      setStatus('Something went wrong loading that business. Try again, or pick a different result.');
    } finally {
      input.classList.remove('auditing');
    }
  }

  // ---------- report rendering ----------

  const gradeColor = (score) => (score >= 70 ? '#7ee2a8' : score >= 40 ? '#f08a2e' : '#e05656');

  function renderReport(d) {
    // Hero: dial colour by band, animated sweep + count-up
    const dial = $('dial');
    dial.style.setProperty('--dialc', gradeColor(d.score));
    $('gradeTxt').textContent = `Grade ${d.grade}`;
    $('headline').textContent = d.narrative.headline;
    $('summaryTxt').textContent = d.narrative.summary;
    $('bizmeta').textContent = [d.business.name, d.business.category, d.business.address].filter(Boolean).join(' \u00b7 ');

    const gain = 100 - d.score;
    if (gain >= 10) { $('gainNum').textContent = `+${gain}`; $('gainChip').hidden = false; }
    else { $('gainChip').hidden = true; }

    // What's costing you: failing checks with minus-points badges
    const failing = d.breakdown.filter((b) => b.earned < b.max)
      .sort((a, b) => (b.max - b.earned) - (a.max - a.earned));
    if (failing.length) {
      $('costList').innerHTML = failing.map((b) =>
        `<div class="cost-row"><span class="pts">-${b.max - b.earned}</span>` +
        `<div><div class="what">${escapeHtml(b.label)}</div><div class="why">${escapeHtml(b.detail)}</div></div></div>`
      ).join('');
      $('costCard').style.display = '';
    } else { $('costCard').style.display = 'none'; }

    // What's working: passing checks as chips, no explanations needed
    const passing = d.breakdown.filter((b) => b.earned === b.max && b.max > 0);
    if (passing.length) {
      $('workList').innerHTML = passing.map((b) => `<span class="chip">${escapeHtml(b.label)}</span>`).join('');
      $('workCard').style.display = '';
    } else { $('workCard').style.display = 'none'; }

    // Competitor review bars
    const rows = (d.comparison && d.comparison.rows) || [];
    if (rows.length > 1) {
      const maxReviews = Math.max(...rows.map((r) => r.reviews), 1);
      $('compRows').innerHTML = rows.map((r) => {
        const pct = Math.max(4, Math.round((r.reviews / maxReviews) * 100));
        const meta = `${r.rating ? r.rating.toFixed(1) + '\u2605' : 'no rating'} \u00b7 ${r.photos >= 10 ? '10+' : r.photos} photos`;
        return `<div class="v-row ${r.isSelf ? 'self' : ''}">` +
          `<div class="v-top"><span class="v-name">${escapeHtml(r.name)}${r.isSelf ? ' (you)' : ''}</span><span class="v-meta">${meta}</span></div>` +
          `<div class="v-bar"><i data-w="${pct}"></i><b>${r.reviews}</b></div></div>`;
      }).join('');
      $('compCard').style.display = '';
    } else { $('compCard').style.display = 'none'; }

    // Priority fixes: numbered rows (priority order is a real sequence)
    $('fixlist').innerHTML = d.narrative.topFixes
      .concat(d.issues.slice(3, 8).map((i) => `${i.area}: ${i.detail}`))
      .map((f, i) => `<li><span class="n">${i + 1}</span><span>${escapeHtml(f)}</span></li>`)
      .join('');
    $('leadBusiness').value = d.business.name || '';
    $('leadScore').value = String(d.score);

    $('manualList').innerHTML = d.manualCheckItems.map((m) => `<li>${escapeHtml(m)}</li>`).join('');
    $('ainote').textContent = d.narrative.aiVisibilityNote;

    const report = $('report');
    report.style.display = 'block';
    report.classList.add('show');
    report.scrollIntoView({ behavior: 'smooth', block: 'start' });

    animateResult(d.score);
  }

  // One orchestrated reveal: dial sweeps + score counts up, then bars grow
  function animateResult(score) {
    const dial = $('dial');
    const num = $('scoreNum');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      dial.style.setProperty('--pct', score);
      num.textContent = score;
    } else {
      const t0 = performance.now();
      const dur = 900;
      const ease = (t) => 1 - Math.pow(1 - t, 3);
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        const v = Math.round(ease(p) * score);
        dial.style.setProperty('--pct', v);
        num.textContent = v;
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    requestAnimationFrame(() => {
      document.querySelectorAll('#compRows .v-bar > i').forEach((el) => {
        el.style.width = reduced ? el.dataset.w + '%' : '0%';
        if (!reduced) requestAnimationFrame(() => { el.style.width = el.dataset.w + '%'; });
      });
    });
  }

  // Email gate
  $('gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Unlocking\u2026';
    const body = new URLSearchParams(new FormData(form)).toString();
    try {
      await fetch('/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    } catch { /* unlock anyway */ }
    $('fixCard').classList.remove('locked');
    $('gate').remove();
  });

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
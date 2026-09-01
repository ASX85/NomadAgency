(() => {
  const $ = (id) => document.getElementById(id);
  const input = $('q');
  const sugg = $('sugg');
  const status = $('status');
  let debounceTimer;
  let stageTimer;

  // Inject loading-state styles so no HTML/CSS edits are needed
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
    @media (prefers-reduced-motion: reduce) {
      .spinner { animation-duration: 1.6s; }
    }
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
    if (q.length < 3) {
      setStatus('');
      return closeSuggestions();
    }
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
    } catch {
      setStatus('');
      closeSuggestions();
    }
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

  function closeSuggestions() {
    sugg.classList.remove('open');
    sugg.innerHTML = '';
  }

  // status helpers -----------------------------------------------------------
  function setStatus(text, withSpinner = false) {
    clearInterval(stageTimer);
    if (!text) {
      status.innerHTML = '';
      return;
    }
    status.innerHTML = `${withSpinner ? '<span class="spinner" aria-hidden="true"></span>' : ''}<span class="msg">${escapeHtml(text)}</span>`;
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
  }

  function startStagedStatus() {
    let i = 0;
    setStatus(STAGES[0], true);
    stageTimer = setInterval(() => {
      i += 1;
      if (i >= STAGES.length) return clearInterval(stageTimer); // hold last stage
      const msg = status.querySelector('.msg');
      if (!msg) return;
      msg.classList.add('swap');
      setTimeout(() => {
        msg.textContent = STAGES[i];
        msg.classList.remove('swap');
      }, 250);
    }, 2200);
  }

  // audit --------------------------------------------------------------------
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

  function renderReport(d) {
    // Score dial
    $('dial').style.setProperty('--pct', d.score);
    $('scoreNum').textContent = d.score;
    $('gradeTxt').textContent = `Grade ${d.grade}`;
    $('headline').textContent = d.narrative.headline;
    $('summaryTxt').textContent = d.narrative.summary;
    $('bizmeta').textContent = [d.business.name, d.business.category, d.business.address]
      .filter(Boolean)
      .join(' \u00b7 ');

    // Competitor table
    const rows = d.comparison.rows || [];
    if (rows.length > 1) {
      $('compTable').innerHTML =
        '<tr><th>Business</th><th>Rating</th><th>Reviews</th><th>Photos</th></tr>' +
        rows
          .map(
            (r) =>
              `<tr class="${r.isSelf ? 'self' : ''}"><td>${escapeHtml(r.name)}${r.isSelf ? ' (you)' : ''}</td>` +
              `<td>${r.rating ? r.rating.toFixed(1) : '\u2014'}</td><td>${r.reviews}</td><td>${r.photos >= 10 ? '10+' : r.photos}</td></tr>`
          )
          .join('');
      $('compCard').style.display = '';
    } else {
      $('compCard').style.display = 'none';
    }

    // Breakdown bars
    $('breakdown').innerHTML = d.breakdown
      .map((b) => {
        const pct = Math.round((b.earned / b.max) * 100);
        return `<div class="brk"><div class="row"><span>${escapeHtml(b.label)}</span><span>${b.earned}/${b.max}</span></div>` +
          `<div class="bar ${pct < 50 ? 'low' : ''}"><i style="width:${pct}%"></i></div>` +
          `<p class="detail">${escapeHtml(b.detail)}</p></div>`;
      })
      .join('');

    // Fix list (gated)
    $('fixlist').innerHTML = d.narrative.topFixes
      .concat(d.issues.slice(3, 8).map((i) => `${i.area}: ${i.detail}`))
      .map((f) => `<li>${escapeHtml(f)}</li>`)
      .join('');
    $('leadBusiness').value = d.business.name || '';
    $('leadScore').value = String(d.score);

    // Manual audit items
    $('manualList').innerHTML = d.manualCheckItems.map((m) => `<li>${escapeHtml(m)}</li>`).join('');
    $('ainote').textContent = d.narrative.aiVisibilityNote;

    const report = $('report');
    report.style.display = 'block';
    report.classList.add('show');
    report.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Email gate: submit to Netlify Forms, then unlock
  $('gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Unlocking\u2026';
    const body = new URLSearchParams(new FormData(form)).toString();
    try {
      await fetch('/', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch {
      // Unlock anyway — never punish the user for our form failing
    }
    $('fixCard').classList.remove('locked');
    $('gate').remove();
  });

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
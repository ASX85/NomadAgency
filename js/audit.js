(() => {
  const $ = (id) => document.getElementById(id);
  const input = $('q');
  const sugg = $('sugg');
  const status = $('status');
  let debounceTimer;
  let stageTimer;

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

  const gradeColor = (score) => (score >= 70 ? '#7ee2a8' : score >= 40 ? '#f08a2e' : '#e05656');

  function starString(rating) {
    if (!rating) return '';
    const full = Math.round(rating);
    return '\u2605'.repeat(Math.min(5, full)) + '\u2606'.repeat(Math.max(0, 5 - full));
  }

  /** Bold/colour key phrases in narrative text without inventing numbers */
  function highlightCopy(text, { score, name } = {}) {
    let t = escapeHtml(text || '');
    if (name) {
      const re = new RegExp(escapeRegExp(name), 'gi');
      t = t.replace(re, (m) => `<span class="hl">${m}</span>`);
    }
    if (typeof score === 'number') {
      const scorePhrase = new RegExp(`\\b${score}\\s*(?:out of|/)?\\s*100\\b`, 'gi');
      if (scorePhrase.test(t)) {
        scorePhrase.lastIndex = 0;
        t = t.replace(scorePhrase, `<span class="hl-score">${score} out of 100</span>`);
      } else {
        t = t.replace(new RegExp(`\\b${score}\\b`), `<span class="hl-score">${score}</span>`);
      }
    }
    // Common gap / problem phrases
    const badPhrases = [
      'missing reviews', 'no website link', 'no profile description', 'no website',
      'effectively invisible', 'invisible', 'leaving significant', 'on the table',
      'no reviews', 'zero reviews', 'thin profile', 'incomplete profile',
    ];
    badPhrases.forEach((p) => {
      t = t.replace(new RegExp(escapeRegExp(p), 'gi'), (m) => `<span class="hl-bad">${m}</span>`);
    });
    const warnPhrases = ['ChatGPT', 'Gemini', 'AI assistants', 'local pack', 'Map Pack'];
    warnPhrases.forEach((p) => {
      t = t.replace(new RegExp(escapeRegExp(p), 'g'), (m) => `<span class="hl-warn">${m}</span>`);
    });
    return t;
  }

  function highlightHeadline(text, { score, name } = {}) {
    let t = escapeHtml(text || '');
    if (name) {
      t = t.replace(new RegExp(escapeRegExp(name), 'gi'), (m) => `<span class="hl-name">${m}</span>`);
    }
    if (typeof score === 'number') {
      t = t.replace(
        new RegExp(`\\b${score}\\s*(?:out of|/)?\\s*100\\b`, 'gi'),
        `<span class="hl-score">${score} out of 100</span>`
      );
    }
    return t;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function shortLabel(label) {
    const map = {
      'Business status': 'Status',
      'Website link': 'Website',
      'Phone number': 'Phone',
      'Opening hours': 'Hours',
      'Categories': 'Categories',
      'Average rating': 'Rating',
      'Review volume': 'Reviews',
      'Review recency': 'Recency',
      'Photos': 'Photos',
      'Profile summary': 'Summary',
    };
    return map[label] || label;
  }

  function renderReport(d) {
    const color = gradeColor(d.score);
    const dial = $('dial');
    dial.style.setProperty('--dialc', color);
    $('gradePill').style.setProperty('--dialc', color);
    $('gradeLetter').textContent = d.grade;
    $('gradeLabel').textContent = 'Grade';

    $('headline').innerHTML = highlightHeadline(d.narrative.headline, {
      score: d.score,
      name: d.business.name,
    });
    $('summaryTxt').innerHTML = highlightCopy(d.narrative.summary, {
      score: d.score,
      name: d.business.name,
    });
    $('bizmeta').textContent = [d.business.name, d.business.category, d.business.address]
      .filter(Boolean)
      .join(' \u00b7 ');

    const gain = 100 - d.score;
    if (gain >= 10) {
      $('gainNum').textContent = `+${gain}`;
      $('gainChip').hidden = false;
    } else {
      $('gainChip').hidden = true;
    }

    // Quick metrics strip
    const rating = d.business.rating;
    const reviews = d.business.reviews || 0;
    const selfRow = ((d.comparison && d.comparison.rows) || []).find((r) => r.isSelf);
    const photos = selfRow ? selfRow.photos : null;

    if (rating) {
      $('mRating').textContent = rating.toFixed(1);
      $('mRating').classList.remove('muted');
      $('mStars').textContent = starString(rating);
    } else {
      $('mRating').textContent = 'None';
      $('mRating').classList.add('muted');
      $('mStars').textContent = '';
    }
    $('mReviews').textContent = reviews;
    $('mReviews').classList.toggle('muted', reviews === 0);
    if (photos == null) {
      $('mPhotos').textContent = '—';
      $('mPhotos').classList.add('muted');
    } else {
      $('mPhotos').textContent = photos >= 10 ? '10+' : String(photos);
      $('mPhotos').classList.toggle('muted', photos === 0);
    }

    // What's costing you
    const failing = d.breakdown
      .filter((b) => b.earned < b.max)
      .sort((a, b) => (b.max - b.earned) - (a.max - a.earned));
    if (failing.length) {
      $('costList').innerHTML = failing
        .map(
          (b) =>
            `<div class="cost-row"><span class="pts">-${b.max - b.earned}<small>pts</small></span>` +
            `<div><div class="what">${escapeHtml(b.label)}</div><div class="why">${escapeHtml(b.detail)}</div></div></div>`
        )
        .join('');
      $('costCard').style.display = '';
    } else {
      $('costCard').style.display = 'none';
    }

    // What's working
    const passing = d.breakdown.filter((b) => b.earned === b.max && b.max > 0);
    if (passing.length) {
      $('workList').innerHTML = passing.map((b) => `<span class="chip">${escapeHtml(b.label)}</span>`).join('');
      $('workCard').style.display = '';
    } else {
      $('workCard').style.display = 'none';
    }

    // Mini ring breakdown
    $('brkGrid').innerHTML = d.breakdown
      .map((b) => {
        const pct = b.max ? Math.round((b.earned / b.max) * 100) : 0;
        const rc = pct >= 70 ? '#7ee2a8' : pct >= 40 ? '#f08a2e' : '#e05656';
        return (
          `<div class="brk-cell" title="${escapeHtml(b.detail)}">` +
          `<div class="brk-ring" style="--rp:0;--rc:${rc}" data-rp="${pct}"><span>${b.earned}/${b.max}</span></div>` +
          `<div class="lbl">${escapeHtml(shortLabel(b.label))}</div></div>`
        );
      })
      .join('');

    // Competitor review bars
    const rows = (d.comparison && d.comparison.rows) || [];
    if (rows.length > 1) {
      const maxReviews = Math.max(...rows.map((r) => r.reviews), 1);
      $('compRows').innerHTML = rows
        .map((r) => {
          const pct = Math.max(4, Math.round((r.reviews / maxReviews) * 100));
          const ratingTxt = r.rating ? `<b>${r.rating.toFixed(1)}</b>\u2605` : 'no rating';
          const photoTxt = `${r.photos >= 10 ? '10+' : r.photos} photos`;
          return (
            `<div class="v-row ${r.isSelf ? 'self' : ''}">` +
            `<div class="v-top"><span class="v-name">${escapeHtml(r.name)}${r.isSelf ? ' (you)' : ''}</span>` +
            `<span class="v-meta">${ratingTxt} \u00b7 ${photoTxt}</span></div>` +
            `<div class="v-bar"><i data-w="${pct}"></i><b>${r.reviews}</b></div></div>`
          );
        })
        .join('');
      $('compCard').style.display = '';
    } else {
      $('compCard').style.display = 'none';
    }

    // Priority fixes
    $('fixlist').innerHTML = d.narrative.topFixes
      .concat(d.issues.slice(3, 8).map((i) => `${i.area}: ${i.detail}`))
      .map((f, i) => `<li><span class="n">${i + 1}</span><span>${escapeHtml(f)}</span></li>`)
      .join('');
    $('leadBusiness').value = d.business.name || '';
    $('leadScore').value = String(d.score);

    $('manualList').innerHTML = d.manualCheckItems.map((m) => `<li>${escapeHtml(m)}</li>`).join('');
    $('ainote').innerHTML = highlightCopy(d.narrative.aiVisibilityNote, {
      name: d.business.name,
    });

    const report = $('report');
    report.style.display = 'block';
    report.classList.add('show');
    report.scrollIntoView({ behavior: 'smooth', block: 'start' });

    animateResult(d.score);
  }

  function animateResult(score) {
    const dial = $('dial');
    const num = $('scoreNum');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      dial.style.setProperty('--pct', score);
      num.textContent = score;
      document.querySelectorAll('.brk-ring').forEach((el) => {
        el.style.setProperty('--rp', el.dataset.rp);
      });
    } else {
      const t0 = performance.now();
      const dur = 1000;
      const ease = (t) => 1 - Math.pow(1 - t, 3);
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        const v = Math.round(ease(p) * score);
        dial.style.setProperty('--pct', v);
        num.textContent = v;
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      // Stagger mini rings
      document.querySelectorAll('.brk-ring').forEach((el, i) => {
        setTimeout(() => {
          el.style.transition = 'background 0.7s ease';
          el.style.setProperty('--rp', el.dataset.rp);
        }, 200 + i * 60);
      });
    }

    requestAnimationFrame(() => {
      document.querySelectorAll('#compRows .v-bar > i').forEach((el) => {
        el.style.width = reduced ? el.dataset.w + '%' : '0%';
        if (!reduced) requestAnimationFrame(() => { el.style.width = el.dataset.w + '%'; });
      });
    });
  }

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

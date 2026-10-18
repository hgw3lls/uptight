(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.UptightContributions = api;
  if (typeof document !== 'undefined') {
    const boot = () => document.getElementById('evidence-form') && api.init(document, root);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const REPOSITORY = 'https://github.com/hgw3lls/uptight';
  const SITE = 'https://hgw3lls.github.io/uptight/';
  const ISSUES_API = 'https://api.github.com/repos/hgw3lls/uptight/issues';
  const MARKER = 'UPTIGHT-EVIDENCE-V1';
  const MAX_PREFILL_LENGTH = 7000;
  const QUESTIONS = {
    'madison-full-facade': 'Madison Square: full facade comparison',
    'clark-road-level': 'Clark Avenue: period road-level view',
    'leader-kronheim-adjacency': 'Leader Drug / Kronheim: neighboring storefronts',
    'colonial-blood-bank-frontage': 'Colonial Hotel / blood bank: matching frontage',
    'east86-wadepark-shot': 'East 86th / Wade Park: match a filmed shot',
  };
  const STANCES = {
    supports: 'Supports current identification',
    challenges: 'Challenges current identification',
    'new-candidate': 'New candidate',
  };
  const STATUS = {
    received: { key: 'received', label: 'Received — awaiting review', reviewed: false,
      note: 'A public evidence record exists. This does not mean a researcher has evaluated it.' },
    'under-review': { key: 'under-review', label: 'Under review', reviewed: true,
      note: 'The maintainer has explicitly marked this evidence for review.' },
    incorporated: { key: 'incorporated', label: 'Incorporated', reviewed: true,
      note: 'The maintainer has explicitly marked this evidence as incorporated. Read the published review or linked issue for its scope and limits.' },
    disputed: { key: 'disputed', label: 'Disputed', reviewed: true,
      note: 'The maintainer has explicitly marked this evidence as disputed. Read the published review or linked issue for the reasons.' },
    conflicting: { key: 'conflicting', label: 'Conflicting review labels', reviewed: false,
      note: 'More than one review status is applied. No single outcome is asserted; consult the issue discussion.' },
  };
  const clean = value => typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  const validFrame = value => /^[1-9]\d{0,2}$/.test(clean(value)) && Number(value) <= 682;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function safeSourceUrl(value) {
    try {
      const raw = clean(value);
      if (!/^https?:\/\//i.test(raw) || /\s/.test(raw)) return null;
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
      return url.href;
    } catch (_) { return null; }
  }
  function validPoint(latitude, longitude) {
    const pattern = /^-?\d+(?:\.\d+)?$/;
    return pattern.test(latitude) && pattern.test(longitude) &&
      Number.isFinite(Number(latitude)) && Math.abs(Number(latitude)) <= 90 &&
      Number.isFinite(Number(longitude)) && Math.abs(Number(longitude)) <= 180;
  }
  function parseQuery(search, sites) {
    const q = new URLSearchParams(search || '');
    const result = { place: '', frame: '', question: '', stance: 'supports', note: clean(q.get('note')),
      address: clean(q.get('address')), links: clean(q.get('links')), latitude: '', longitude: '', warnings: [] };
    const place = clean(q.get('place'));
    if (place && (sites || []).some(site => site.id === place)) result.place = place;
    else if (place) result.warnings.push('The linked location could not be resolved from the current register. Choose a location or describe the proposed address.');
    const frame = clean(q.get('frame'));
    if (frame && validFrame(frame)) result.frame = frame;
    else if (frame) result.warnings.push('The linked frame is invalid. Frame numbers must be whole numbers from 1 to 682.');
    const question = clean(q.get('question'));
    if (question && own(QUESTIONS, question)) result.question = question;
    else if (question) result.warnings.push('The linked research question was not recognised. Choose one of the current questions or use general evidence.');
    const stance = clean(q.get('stance'));
    if (own(STANCES, stance)) result.stance = stance;
    else if (q.get('kind') === 'location') result.stance = 'new-candidate';
    const lat = clean(q.get('latitude')), lon = clean(q.get('longitude'));
    if (lat || lon) {
      if (validPoint(lat, lon)) { result.latitude = lat; result.longitude = lon; }
      else result.warnings.push('The proposed point could not be read as a valid latitude/longitude pair. No point has been carried into the draft.');
    }
    return result;
  }
  function validateDraft(raw) {
    const d = {};
    ['place', 'location', 'frame', 'question', 'stance', 'explanation', 'sourceDate', 'attribution', 'links', 'address', 'latitude', 'longitude'].forEach(key => { d[key] = clean(raw[key]); });
    const errors = {};
    if (d.frame && !validFrame(d.frame)) errors.frame = 'Enter one whole frame number from 1 to 682, or leave it blank.';
    if (!d.frame && !d.location && !d.question && !d.address) errors.location = 'Choose a location or question, enter a frame, or describe the proposed address.';
    if (d.question && !own(QUESTIONS, d.question)) errors.question = 'Choose a listed research question or general evidence.';
    if (!own(STANCES, d.stance)) errors.stance = 'Choose supports, challenges, or a new candidate.';
    if (d.explanation.length < 20) errors.explanation = 'Describe the evidence and what it changes in at least 20 characters.';
    if (d.explanation.length > 12000) errors.explanation = 'Keep the explanation under 12,000 characters; add longer material on GitHub.';
    if (!d.sourceDate) errors.sourceDate = 'Give the source date or write “unknown”.';
    if (!d.attribution) errors.attribution = 'Name the archive, creator or publication; write “unknown” if it cannot be established.';
    if (d.sourceDate.length > 160) errors.sourceDate = 'Keep the source-date note under 160 characters.';
    if (d.attribution.length > 2000) errors.attribution = 'Keep attribution under 2,000 characters; add further catalogue detail on GitHub.';
    if (d.address.length > 1000 || d.location.length > 500) errors.address = 'Keep the address or location description concise.';
    const links = d.links.split(/\r?\n/).map(clean).filter(Boolean);
    if (links.length > 12 || links.some(link => link.length > 2048 || !safeSourceUrl(link))) errors.links = 'Use up to 12 complete http:// or https:// links, one per line, without embedded passwords.';
    if ((d.latitude || d.longitude) && !validPoint(d.latitude, d.longitude)) errors.address = 'The proposed coordinates are invalid; remove or correct the point context.';
    return { ok: Object.keys(errors).length === 0, errors, draft: d };
  }
  function issueTitle(d) {
    const subject = d.frame ? 'Frame ' + d.frame : clean(d.location) || (QUESTIONS[d.question] || 'Unmatched area');
    return ('[Location evidence] ' + subject + ' — ' + (STANCES[d.stance] || 'Evidence')).slice(0, 240);
  }
  function proposedLocation(d) {
    return [clean(d.address), validPoint(clean(d.latitude), clean(d.longitude))
      ? 'User-proposed point (unverified): latitude ' + d.latitude + ', longitude ' + d.longitude + '. This does not establish a landmark footprint or camera position.' : ''].filter(Boolean).join('\n');
  }
  function issueContext(d) {
    const lines = [MARKER];
    if (d.place) lines.push('place: ' + d.place);
    if (validFrame(d.frame)) lines.push('frame: ' + d.frame);
    if (own(QUESTIONS, d.question)) lines.push('question: ' + d.question);
    if (validFrame(d.frame)) lines.push('Film still: ' + SITE + '#shot=' + d.frame);
    if (d.place) lines.push('Location register: ' + SITE + '#place=' + encodeURIComponent(d.place));
    if (own(QUESTIONS, d.question)) lines.push('Research question: ' + SITE + 'research-board.html#' + d.question);
    return lines.join('\n');
  }
  function buildIssueUrl(d, compact) {
    const url = new URL(REPOSITORY + '/issues/new');
    const fields = {
      template: 'location-evidence.yml', title: issueTitle(d), frame: clean(d.frame),
      location: clean(d.location), 'research-question': d.question ? d.question + ' — ' + (QUESTIONS[d.question] || '') : '',
      stance: STANCES[d.stance] || '', evidence: compact ? '' : clean(d.explanation),
      'source-date': compact ? '' : clean(d.sourceDate), attribution: compact ? '' : clean(d.attribution),
      'source-links': compact ? '' : clean(d.links), 'proposed-location': proposedLocation(compact ? { ...d, address: '' } : d), context: issueContext(d),
    };
    Object.entries(fields).forEach(([key, value]) => { if (value) url.searchParams.set(key, value); });
    return url.href;
  }
  function buildDraftText(d) {
    const value = key => clean(d[key]) || 'Not supplied';
    return [
      '# ' + issueTitle(d), '', 'Not submitted — this file is your evidence draft.',
      'Attach files on GitHub after opening the issue form. This draft does not include image files.',
      'The evidence and any attachments will be public when shared through this public repository.', '',
      '## Location', value('location'), '', '## Frame', value('frame'), '',
      '## Research question', QUESTIONS[d.question] || 'General evidence / not selected', '',
      '## Contribution', STANCES[d.stance] || 'Not supplied', '', '## Evidence statement', value('explanation'), '',
      '## Source date', value('sourceDate'), '', '## Attribution / catalogue reference', value('attribution'), '',
      '## Source links', value('links'), '', '## Proposed location', proposedLocation(d) || 'No proposed point or address', '',
      '## Site reference', issueContext(d), '',
      'GitHub form: ' + REPOSITORY + '/issues/new?template=location-evidence.yml', '',
    ].join('\n');
  }
  function labelNames(issue) {
    return (Array.isArray(issue.labels) ? issue.labels : []).map(label => clean(typeof label === 'string' ? label : label && label.name).toLowerCase());
  }
  function deriveIssueStatus(issue) {
    const labels = new Set(labelNames(issue || {}));
    const statuses = Object.keys(STATUS).filter(key => key !== 'conflicting' && labels.has('evidence:' + key));
    return { ...STATUS[statuses.length > 1 ? 'conflicting' : statuses[0] || 'received'] };
  }
  function normaliseEvidenceIssue(issue) {
    if (!issue || issue.pull_request || !Number.isInteger(issue.number) || issue.number < 1) return null;
    const title = clean(issue.title), body = clean(issue.body), labels = labelNames(issue);
    if (!/^\[Location evidence\]/i.test(title) && !body.includes(MARKER) && !labels.includes('location-evidence')) return null;
    let link;
    try {
      link = new URL(issue.html_url);
      if (link.origin !== 'https://github.com' || link.pathname !== '/hgw3lls/uptight/issues/' + issue.number || link.username || link.password) return null;
    } catch (_) { return null; }
    const updated = new Date(issue.updated_at);
    return { number: issue.number, title: title.slice(0, 500), url: link.origin + link.pathname,
      author: clean(issue.user && issue.user.login).slice(0, 100) || 'Contributor',
      updatedAt: Number.isNaN(updated.getTime()) ? null : updated.toISOString(),
      state: issue.state === 'closed' ? 'closed' : 'open', status: deriveIssueStatus(issue) };
  }
  function normalisePublishedReviews(data) {
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.decisions)) throw new Error('Unexpected public review record');
    const reviews = {};
    const labels = { pending: 'Awaiting review', 'under-review': 'Under review', disputed: 'Disputed', approved: 'Approved contribution' };
    for (const row of data.decisions) {
      if (!row || !Number.isInteger(row.issueNumber) || row.issueNumber < 1 || !own(labels, row.decision) ||
          !['content', 'evidence', 'location'].includes(row.mode) || typeof row.publicNote !== 'string' || !row.publicNote.trim()) continue;
      const reviewedAt = new Date(row.reviewedAt);
      if (typeof row.reviewedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(row.reviewedAt) || Number.isNaN(reviewedAt.getTime())) continue;
      if (row.issueUrl !== REPOSITORY + '/issues/' + row.issueNumber) continue;
      reviews[row.issueNumber] = {
        issueNumber: row.issueNumber, decision: row.decision, label: labels[row.decision], mode: row.mode,
        updatePin: row.mode === 'content' && row.updatePin === true,
        siteUrl: row.mode === 'content' && typeof row.siteId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(row.siteId)
          ? SITE + '#place=' + encodeURIComponent(row.siteId) : null,
        publicNote: row.publicNote.trim(), reviewedAt: reviewedAt.toISOString(),
        sourceLinks: (Array.isArray(row.sourceLinks) ? row.sourceLinks : []).map(safeSourceUrl).filter(Boolean).slice(0, 12),
      };
    }
    return reviews;
  }
  async function fetchPublishedReviews(options) {
    const opts = options || {};
    if (opts.online === false) return { state: 'offline', reviews: {} };
    const fetchImpl = opts.fetchImpl || fetch, controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Review record timed out')); }, 8000);
    });
    const request = Promise.resolve().then(async () => {
      const response = await fetchImpl('./data/review-decisions.json', { method: 'GET', credentials: 'same-origin', cache: 'no-cache', signal: controller.signal });
      if (response.status === 404) return { state: 'ok', reviews: {} };
      if (!response.ok) throw new Error('Review record unavailable');
      return { state: 'ok', reviews: normalisePublishedReviews(await response.json()) };
    });
    try { return await Promise.race([request, deadline]); }
    catch (_) { return { state: 'error', reviews: {} }; }
    finally { clearTimeout(timer); }
  }
  async function fetchEvidenceIssues(options) {
    const opts = options || {}, fetchImpl = opts.fetchImpl || fetch;
    if (opts.online === false) return { state: 'offline', issues: [], checkedAt: null, truncated: false, message: 'You appear to be offline. Public contributions could not be checked.' };
    const issues = [], seen = new Set();
    let checkedAt = null, scanned = 0, truncated = false;
    for (let page = 1; page <= 2; page++) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
      try {
        const url = new URL(ISSUES_API);
        Object.entries({ state: 'all', sort: 'updated', direction: 'desc', per_page: '100', page: String(page) }).forEach(([key, val]) => url.searchParams.set(key, val));
        const response = await fetchImpl(url.href, { method: 'GET', credentials: 'omit',
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: controller.signal });
        if (!response.ok) {
          if (response.status === 403 || response.status === 429) throw new Error('GitHub’s public read limit was reached. Try again later or open the issue list directly.');
          throw new Error('GitHub’s public issue list is unavailable right now. Open the issue list directly or try again later.');
        }
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('GitHub returned an unexpected response. The contribution list could not be verified.');
        scanned += data.length;
        for (const raw of data) {
          const item = normaliseEvidenceIssue(raw);
          if (item && !seen.has(item.number)) { seen.add(item.number); issues.push(item); }
        }
        checkedAt = new Date().toISOString();
        const link = response.headers && response.headers.get('link') || '';
        const hasNext = /rel="next"/.test(link) || (!link && data.length === 100);
        truncated = page === 2 && hasNext;
        if (!hasNext) break;
      } catch (error) {
        const message = error && error.name === 'AbortError' ? 'The public contribution check timed out. Try again or open GitHub directly.' : error instanceof TypeError ? 'The public contribution check could not reach GitHub. Check your connection or open GitHub directly.' : error.message || 'The public contribution list could not be checked.';
        return { state: checkedAt ? 'partial' : 'error', issues, checkedAt, scanned, truncated: !!checkedAt, message };
      } finally { clearTimeout(timer); }
    }
    return { state: 'ok', issues, checkedAt, scanned, truncated, message: '' };
  }
  function emailAvailable(config) {
    return !!(config && config.accessKey && config.endpoint === 'https://api.web3forms.com/submit');
  }
  async function sendEmailNote(draft, config, fetchImpl) {
    if (!emailAvailable(config)) throw new Error('The email note option is not configured. Download your draft or use the public GitHub form.');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await (fetchImpl || fetch)(config.endpoint, { method: 'POST', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ access_key: config.accessKey, subject: issueTitle(draft), from_name: 'Uptight research visitor',
          place: draft.location, place_id: draft.place, scene_frame: draft.frame, kind: STANCES[draft.stance],
          note: draft.explanation, source_date: draft.sourceDate, credit: draft.attribution, source_links: draft.links,
          proposed_location: proposedLocation(draft), site_reference: issueContext(draft),
          submission_type: 'Email note and links only; no attachments or public issue' }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success !== true) throw new Error('The email service did not accept the note. Your draft is still here; try again or download it.');
      return { accepted: true };
    } finally { clearTimeout(timer); }
  }

  function init(doc, win) {
    const $ = id => doc.getElementById(id);
    const form = $('evidence-form');
    if (!form || form.dataset.ready) return;
    form.dataset.ready = 'true';
    let sites = [], preparedDraft = null, loadingFeed = false;
    function text(tag, value, className) {
      const element = doc.createElement(tag);
      if (value !== undefined) element.textContent = value;
      if (className) element.className = className;
      return element;
    }
    function currentDraft() {
      const place = $('place').value, site = sites.find(s => s.id === place);
      return { place, location: site ? site.name : '', frame: $('frame').value, question: $('question').value,
        stance: $('stance').value, explanation: $('explanation').value, sourceDate: $('source-date').value,
        attribution: $('attribution').value, links: $('source-links').value, address: $('address').value,
        latitude: $('latitude').value, longitude: $('longitude').value };
    }
    function showMessage(id, value, bad) {
      const node = $(id); node.textContent = value; node.hidden = !value;
      node.dataset.kind = bad ? 'error' : 'notice';
    }
    function showContext() {
      const draft = currentDraft(), site = sites.find(s => s.id === draft.place);
      $('context-name').textContent = site ? site.name : draft.question ? QUESTIONS[draft.question] : 'Choose the frame or question your evidence addresses';
      $('context-confidence').textContent = site ? site.confidenceLabel || site.status : draft.question === 'east86-wadepark-shot' ? 'Documented filming area · no still has been matched' : 'New evidence can also concern an unplaced scene';
      const image = $('frame-preview'), frame = clean(draft.frame);
      if (validFrame(frame)) {
        image.hidden = false; image.src = './media/frames/' + frame.padStart(8, '0') + '.jpg';
        image.alt = 'Uptight indexed film still ' + frame;
        $('frame-link').hidden = false; $('frame-link').href = './#shot=' + frame;
        $('frame-link').textContent = 'Inspect frame ' + frame + ' ↗';
      } else { image.hidden = true; image.removeAttribute('src'); $('frame-link').hidden = true; }
      $('point-context').textContent = proposedLocation({ ...draft, address: '' });
      $('point-context').hidden = !validPoint(draft.latitude, draft.longitude);
      $('remove-point').hidden = $('point-context').hidden;
      if (preparedDraft) { $('prepared').hidden = true; preparedDraft = null; }
    }
    function checkDraft() {
      const result = validateDraft(currentDraft());
      const ids = { sourceDate: 'source-date', links: 'source-links', location: 'place' };
      form.querySelectorAll('[aria-invalid]').forEach(node => node.removeAttribute('aria-invalid'));
      if (result.ok) { showMessage('form-error', ''); return result.draft; }
      showMessage('form-error', Object.values(result.errors).join(' '), true);
      Object.keys(result.errors).forEach(key => { const field = $(ids[key] || key); if (field) field.setAttribute('aria-invalid', 'true'); });
      $('form-error').focus(); return null;
    }
    function download() {
      const draft = currentDraft(), blob = new Blob([buildDraftText(draft)], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob), a = doc.createElement('a');
      a.href = url; a.download = 'uptight-evidence-' + (validFrame(draft.frame) ? 'frame-' + draft.frame : 'draft') + '.md';
      doc.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      showMessage('draft-notice', 'Draft downloaded. Nothing has been sent; image files are not included.');
    }
    async function copy() {
      const value = buildDraftText(preparedDraft || currentDraft());
      try { await win.navigator.clipboard.writeText(value); showMessage('copy-notice', 'Complete draft copied. Nothing has been submitted.'); }
      catch (_) { $('draft-text').value = value; $('draft-text').focus(); $('draft-text').select(); showMessage('copy-notice', 'Copy the selected draft with your keyboard. Automatic clipboard access was unavailable.'); }
    }
    form.addEventListener('input', showContext);
    form.addEventListener('change', showContext);
    $('remove-point').addEventListener('click', () => { $('latitude').value = ''; $('longitude').value = ''; showContext(); });
    form.addEventListener('submit', event => {
      event.preventDefault(); const draft = checkDraft(); if (!draft) return;
      preparedDraft = draft;
      const full = buildIssueUrl(draft), long = full.length > MAX_PREFILL_LENGTH;
      $('github-open').href = long ? buildIssueUrl(draft, true) : full;
      $('github-open').textContent = long ? 'Open shorter draft on GitHub ↗' : 'Open this draft on GitHub ↗';
      $('draft-text').value = buildDraftText(draft);
      showMessage('long-draft', long ? 'This draft is too long for a dependable prefilled link. Copy or download the complete text below. The shorter link carries the frame, location, question and any proposed coordinates; paste your evidence, source date, attribution, links and proposed address/map point into GitHub’s matching fields.' : 'The GitHub form will open with these fields filled in. Review the text and add your files there.');
      $('prepared').hidden = false; $('prepared').scrollIntoView({ block: 'start', behavior: 'smooth' }); $('prepared-title').focus();
    });
    $('download-draft').addEventListener('click', download);
    $('download-prepared').addEventListener('click', download);
    $('copy-draft').addEventListener('click', copy);
    $('edit-draft').addEventListener('click', () => { $('prepared').hidden = true; preparedDraft = null; $('explanation').focus(); });
    $('email-send').hidden = !emailAvailable(win.UPTIGHT_EMAIL);
    $('email-unavailable').hidden = emailAvailable(win.UPTIGHT_EMAIL);
    $('email-send').addEventListener('click', async () => {
      const draft = checkDraft(); if (!draft) return;
      const button = $('email-send'); button.disabled = true;
      showMessage('email-status', 'Sending the note and links to the email service…');
      try {
        await sendEmailNote(draft, win.UPTIGHT_EMAIL);
        showMessage('email-status', 'The email service accepted your note and links. No files were sent, no public issue was created, and this does not mean the evidence has been reviewed.');
      } catch (error) {
        showMessage('email-status', error.name === 'AbortError' ? 'The email service did not confirm receipt before the request timed out. Your draft is still here; check before sending it again.' : error.message || 'Receipt could not be confirmed. Your draft is still here.', true);
      } finally { button.disabled = false; }
    });
    async function loadFeed() {
      if (loadingFeed) return;
      loadingFeed = true; $('refresh-issues').disabled = true;
      $('feed-status').textContent = 'Checking the public GitHub issue list…';
      $('feed-status').dataset.state = 'loading'; $('feed-list').replaceChildren(); $('feed-updated').textContent = '';
      const [result, published] = await Promise.all([
        fetchEvidenceIssues({ online: win.navigator.onLine }),
        fetchPublishedReviews({ online: win.navigator.onLine }),
      ]);
      $('feed-status').dataset.state = result.state;
      if (result.state === 'error' || result.state === 'offline') $('feed-status').textContent = result.message;
      else {
        const count = result.issues.length;
        $('feed-status').textContent = result.state === 'partial' ? 'Partial public record check. ' + result.message
          : count ? count + ' public evidence ' + (count === 1 ? 'record' : 'records') + ' retrieved from GitHub.'
          : result.truncated ? 'No evidence records found among the recently updated issues checked. Older records may exist; use the full GitHub list.'
          : 'No public evidence issues have been posted yet. Your draft is not part of this list until you submit it on GitHub.';
        if (result.checkedAt) $('feed-updated').textContent = 'Checked ' + new Date(result.checkedAt).toLocaleString() + '. ' + (result.truncated ? 'Limited to the 200 most recently updated repository issues; the GitHub list has the full history.' : 'Read-only view of public GitHub records.');
        if (published.state === 'error') $('feed-updated').textContent += ' Published review notes could not be loaded; issue statuses remain available below.';
        result.issues.forEach(item => {
          const li = text('li', undefined, 'issue-card');
          const status = text('span', item.status.label, 'issue-status'); status.dataset.status = item.status.key;
          const heading = text('h3'); const link = text('a', item.title); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; heading.appendChild(link);
          li.append(status, heading, text('p', '#' + item.number + ' · ' + item.author + ' · Issue ' + item.state, 'issue-meta'), text('p', item.status.note, 'small'));
          const review = published.reviews[item.number];
          if (review) {
            const section = text('section', undefined, 'published-review');
            section.append(text('p', 'Published review · ' + review.reviewedAt.slice(0, 10), 'issue-meta'),
              text('h4', review.label), text('p', review.publicNote, 'review-note'));
            if (review.decision === 'approved') section.append(text('p', review.mode === 'content'
              ? review.updatePin ? 'The location’s website information and map pin were updated. Read the location entry for the new information and confidence.'
                : 'The location’s website information was updated. No map pin change was requested.'
              : review.mode === 'location' ? 'This review includes a location update. The map records its confidence and the meaning of the point.'
                : 'Evidence review only. This decision does not change the map pin or location confidence.', 'small'));
            if (review.siteUrl && review.decision === 'approved') {
              const location = text('a', 'Read the updated location ↗'); location.href = review.siteUrl;
              location.target = '_blank'; location.rel = 'noopener noreferrer'; section.appendChild(location);
            }
            const expectedStatus = review.decision === 'approved' ? 'incorporated' : review.decision === 'pending' ? 'received' : review.decision;
            if (item.status.key !== expectedStatus) section.append(text('p', 'The latest published review and the current issue label differ. The issue status above has not been inferred from this note.', 'small'));
            if (review.sourceLinks.length) {
              const sources = text('ul', undefined, 'review-sources');
              review.sourceLinks.forEach((url, i) => { const row = text('li'); const source = text('a', 'Source ' + (i + 1) + ' ↗'); source.href = url; source.target = '_blank'; source.rel = 'noopener noreferrer'; row.appendChild(source); sources.appendChild(row); });
              section.appendChild(sources);
            }
            li.appendChild(section);
          }
          $('feed-list').appendChild(li);
        });
      }
      loadingFeed = false; $('refresh-issues').disabled = false;
    }
    $('refresh-issues').addEventListener('click', loadFeed);
    Object.entries(QUESTIONS).forEach(([value, label]) => { const option = text('option', label); option.value = value; $('question').appendChild(option); });
    const mapController = new AbortController();
    let mapTimer;
    const mapDeadline = new Promise((_, reject) => {
      mapTimer = setTimeout(() => { mapController.abort(); reject(new Error('Map index timed out')); }, 10000);
    });
    const mapRequest = Promise.resolve().then(() => fetch('./data/map-data.json', { credentials: 'same-origin', signal: mapController.signal }))
      .then(response => { if (!response.ok) throw new Error('Map index unavailable'); return response.json(); });
    Promise.race([mapRequest, mapDeadline])
      .then(data => {
        sites = Array.isArray(data.sites) ? data.sites.filter(site => site && /^[a-z0-9_-]+$/.test(site.id) && typeof site.name === 'string') : [];
        sites.forEach(site => { const option = text('option', site.name); option.value = site.id; $('place').appendChild(option); });
      }).catch(() => { showMessage('context-warning', 'The location index could not be loaded. You can still enter a frame, choose a research question, or describe an address.', true); })
      .finally(() => {
        clearTimeout(mapTimer);
        const context = parseQuery(win.location.search, sites);
        const values = { place: context.place, frame: context.frame, question: context.question, stance: context.stance,
          explanation: context.note, address: context.address, 'source-links': context.links, latitude: context.latitude, longitude: context.longitude };
        Object.entries(values).forEach(([id, value]) => { $(id).value = value; });
        if (context.warnings.length) showMessage('context-warning', context.warnings.join(' '), true);
        $('form-fields').disabled = false; $('prepare-draft').disabled = false; $('download-draft').disabled = false;
        showContext();
      });
    loadFeed();
  }
  return { REPOSITORY, QUESTIONS, STANCES, MAX_PREFILL_LENGTH, parseQuery, validateDraft, safeSourceUrl,
    buildIssueUrl, buildDraftText, deriveIssueStatus, normaliseEvidenceIssue, normalisePublishedReviews, fetchPublishedReviews, fetchEvidenceIssues, sendEmailNote, init };
});

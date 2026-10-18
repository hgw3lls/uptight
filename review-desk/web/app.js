(function (root, factory) {
  'use strict';
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root && root.document) {
    root.UptightReviewDesk = exported;
    const start = () => { if (root.document.getElementById('workspace')) root.uptightReviewDesk = exported.createApp(root); };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const BOUNDS = [-81.74, 41.43, -81.57, 41.56];
  const DECISIONS = ['pending', 'under-review', 'disputed', 'approved'];
  const DECISION_LABELS = { pending: 'Awaiting review', 'under-review': 'Under review', disputed: 'Disputed', approved: 'Approved locally' };
  const DRAFT_KEYS = ['decision', 'mode', 'place', 'name', 'address', 'connection', 'history', 'updatePin', 'latitude', 'longitude', 'status', 'confidenceLabel', 'confidenceNote', 'pinNote', 'publicNote', 'privateNote', 'baseIssueUpdatedAt'];
  const FIELD_IDS = { decision: 'decision', place: 'place', name: 'location-name', address: 'location-address', connection: 'website-information', history: 'website-history', updatePin: 'update-pin', latitude: 'latitude', longitude: 'longitude', status: 'location-status', confidenceLabel: 'confidence-label', confidenceNote: 'confidence-note', pinNote: 'pin-note', publicNote: 'public-note', privateNote: 'private-note' };
  const text = value => value == null ? '' : String(value);
  const validFrame = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 682 ? Number(value) : null;

  function safeUrl(value) {
    if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value) || value.length > 4096) return null;
    try {
      const parsed = new URL(value);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      return parsed.href;
    } catch (_) { return null; }
  }
  function uniqueUrls(values) {
    return Array.from(new Set((Array.isArray(values) ? values : []).map(safeUrl).filter(Boolean)));
  }
  function numberInput(value) {
    if (value == null || (typeof value === 'string' && !value.trim())) return { value: null, valid: true };
    if (typeof value === 'number') return { value, valid: Number.isFinite(value) };
    const trimmed = text(value).trim().replace(/\u2212/g, '-');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return { value: null, valid: false };
    const n = Number(trimmed);
    return { value: n, valid: Number.isFinite(n) };
  }
  function withinBounds(coord, bounds = BOUNDS) {
    return Array.isArray(coord) && coord.length === 2 && coord.every(Number.isFinite) && coord[0] >= bounds[0] && coord[0] <= bounds[2] && coord[1] >= bounds[1] && coord[1] <= bounds[3];
  }
  function draftPoint(draft) {
    if (!draft) return null;
    const lat = numberInput(draft.latitude), lon = numberInput(draft.longitude);
    return lat.valid && lon.valid && lat.value != null && lon.value != null ? [lon.value, lat.value] : null;
  }
  function issuePoint(issue) {
    const fields = issue && issue.fields || {};
    return Number.isFinite(fields.latitude) && Number.isFinite(fields.longitude) ? [fields.longitude, fields.latitude] : null;
  }
  function siteForIssue(issue, sites) {
    const fields = issue && issue.fields || {};
    return sites.find(site => site.id === fields.place) || sites.find(site => (site.frames || []).some(frame => Number(frame.id) === validFrame(fields.frame))) || null;
  }
  function defaultDraft(issue, sites, saved) {
    const site = siteForIssue(issue, sites), fields = issue.fields || {};
    const result = {
      decision: 'pending', mode: 'content', place: site ? site.id : 'new',
      name: site ? text(site.name) : text(fields.location), address: site ? text(site.address) : text(fields.proposedAddress),
      connection: text(fields.evidence) || text(site && site.connection), history: text(site && site.history), updatePin: false,
      latitude: site && Array.isArray(site.coord) ? site.coord[1] : null,
      longitude: site && Array.isArray(site.coord) ? site.coord[0] : null,
      status: site && ['Candidate', 'Strong match', 'Unplaced'].includes(site.status) ? site.status : 'Candidate',
      confidenceLabel: site ? text(site.confidenceLabel) : '', confidenceNote: site ? text(site.confidenceNote) : '', pinNote: site ? text(site.pinNote) : '',
      publicNote: '', privateNote: '', baseIssueUpdatedAt: text(issue.updatedAt)
    };
    if (saved && typeof saved === 'object') DRAFT_KEYS.forEach(key => { if (Object.prototype.hasOwnProperty.call(saved, key)) result[key] = saved[key]; });
    if (!DECISIONS.includes(result.decision)) result.decision = 'pending';
    if (!['content', 'evidence', 'location'].includes(result.mode)) result.mode = 'content';
    result.updatePin = result.updatePin === true;
    return result;
  }
  function pinEditsEnabled(draft) { return !!draft && (draft.mode === 'location' || (draft.mode === 'content' && draft.updatePin === true)); }
  function draftPayload(draft) {
    const result = {};
    DRAFT_KEYS.forEach(key => { result[key] = key === 'updatePin' ? draft[key] === true : key === 'latitude' || key === 'longitude' ? numberInput(draft[key]).value : text(draft[key]); });
    return result;
  }
  function fingerprint(draft) {
    if (!draft) return '';
    return JSON.stringify(DRAFT_KEYS.map(key => {
      if (key === 'latitude' || key === 'longitude') { const n = numberInput(draft[key]); return n.valid ? n.value : text(draft[key]); }
      if (key === 'updatePin') return draft[key] === true;
      return text(draft[key]);
    }));
  }
  function effectiveStatus(issue, draft) {
    if (draft && DECISIONS.includes(draft.decision)) return draft.decision;
    return { received: 'pending', 'under-review': 'under-review', disputed: 'disputed', incorporated: 'approved', approved: 'approved', conflicting: 'disputed' }[issue.remoteStatus] || 'pending';
  }
  function hasLocalReview(draft, dirty, number) {
    return !!draft && (dirty.has(number) || draft.decision !== 'pending' || draft.mode !== 'content' || !!text(draft.publicNote) || !!text(draft.privateNote));
  }
  function filterIssues(issues, query, filter, drafts, history, dirty) {
    const needles = text(query).toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return issues.filter(issue => {
      const d = drafts.get(Number(issue.number));
      const haystack = [issue.number, issue.title, issue.author, issue.body, issue.fields && issue.fields.frame, issue.fields && issue.fields.location].map(text).join(' ').toLocaleLowerCase();
      if (!needles.every(term => haystack.includes(term))) return false;
      if (filter === 'unsaved') return dirty.has(Number(issue.number));
      if (filter === 'published') return (history || []).some(record => Number(record.issueNumber) === Number(issue.number));
      return filter === 'all' || effectiveStatus(issue, hasLocalReview(d, dirty, Number(issue.number)) ? d : null) === filter;
    });
  }
  function formatPoint(point) { return point && point.every(Number.isFinite) ? point[1].toFixed(6) + ', ' + point[0].toFixed(6) : 'No pin'; }
  function displayValue(value) { return value == null ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : text(value); }

  class ReviewMap {
    constructor(win, element, options) {
      this.win = win; this.svg = element; this.options = options; this.d3 = win.d3; this.context = null; this.points = []; this.bounds = BOUNDS.slice(); this.exploring = false; this.picking = false; this.ready = false;
      if (!this.d3) return;
      const d3 = this.d3;
      this.root = d3.select(element);
      this.base = this.root.append('g');
      this.labels = this.root.append('g').attr('pointer-events', 'none');
      this.markers = this.root.append('g').attr('pointer-events', 'none');
      this.transform = d3.zoomIdentity;
      this.zoom = d3.zoom().extent([[0, 0], [640, 360]]).scaleExtent([1, 45]).translateExtent([[0, 0], [640, 360]])
        .filter(event => this.exploring && !this.picking && event.type !== 'wheel' && !event.button)
        .on('zoom', event => { this.transform = event.transform; this.base.attr('transform', this.transform); this.drawMarkers(); this.drawLabels(); });
      this.root.call(this.zoom).on('dblclick.zoom', null).on('click.review', event => {
        if (!this.picking || event.defaultPrevented || !this.projection) return;
        const p = d3.pointer(event, element), coord = this.projection.invert(this.transform.invert(p));
        if (withinBounds(coord, this.bounds)) this.options.onPick(coord.map(v => Number(v.toFixed(6))));
        else this.options.onMessage('Choose a point inside the Cleveland research boundary.');
      });
      this.setInteraction();
      this.setContext(null, this.bounds);
      this.ready = true;
    }
    setContext(context, bounds) {
      if (!this.d3) return;
      this.context = context;
      if (Array.isArray(bounds) && bounds.length === 4) this.bounds = bounds.slice();
      const d3 = this.d3, [w, s, e, n] = this.bounds;
      this.projection = d3.geoMercator().fitExtent([[18, 18], [622, 342]], { type: 'MultiPoint', coordinates: [[w, n], [e, s]] });
      const path = d3.geoPath(this.projection), nw = this.projection([w, n]), se = this.projection([e, s]);
      this.base.selectAll('*').remove();
      this.base.append('rect').attr('width', 640).attr('height', 360).attr('fill', '#e7dfc8');
      this.base.selectAll('.water').data(context && context.water && context.water.features || []).join('path').attr('class', 'water').attr('d', path).attr('fill', '#bdc6c0').attr('stroke', '#97a9a1').attr('stroke-width', .4).attr('vector-effect', 'non-scaling-stroke');
      this.base.selectAll('.road').data(context && context.roads && context.roads.features || []).join('path').attr('class', 'road').attr('d', path).attr('fill', 'none').attr('stroke', row => row.properties && row.properties.kind === 'primary' ? '#b4a684' : '#c7bda3').attr('stroke-width', row => row.properties && row.properties.kind === 'primary' ? 1.6 : .75).attr('vector-effect', 'non-scaling-stroke');
      this.base.append('rect').attr('x', nw[0]).attr('y', nw[1]).attr('width', se[0] - nw[0]).attr('height', se[1] - nw[1]).attr('fill', 'none').attr('stroke', '#897b5c').attr('stroke-width', 1).attr('stroke-dasharray', '5 4').attr('vector-effect', 'non-scaling-stroke');
      this.drawMarkers(); this.drawLabels();
    }
    setInteraction() {
      this.svg.classList.toggle('exploring', this.exploring && !this.picking);
      this.svg.classList.toggle('picking', this.picking);
      this.svg.style.touchAction = this.exploring && !this.picking ? 'none' : 'pan-y';
      if (this.root) this.root.style('-webkit-tap-highlight-color', 'transparent');
    }
    setPoints(points, fit) { this.points = points.filter(p => withinBounds(p.coord, this.bounds)); this.drawMarkers(); if (fit) this.fit(); }
    drawMarkers() {
      if (!this.projection || !this.markers) return;
      this.markers.selectAll('*').remove();
      const ordered = this.points.slice().sort((a, b) => ['submitted', 'current', 'draft'].indexOf(a.kind) - ['submitted', 'current', 'draft'].indexOf(b.kind));
      ordered.forEach(point => {
        const projected = this.projection(point.coord), p = this.transform.apply(projected);
        if (p[0] < -15 || p[0] > 655 || p[1] < -15 || p[1] > 375) return;
        const group = this.markers.append('g').attr('transform', 'translate(' + p[0] + ',' + p[1] + ')');
        const color = point.kind === 'draft' ? '#1f5a96' : point.kind === 'submitted' ? '#973609' : '#24221d';
        if (point.kind === 'submitted') group.append('path').attr('d', 'M0,-12L12,0L0,12L-12,0Z').attr('fill', color).attr('stroke', '#fffdf7').attr('stroke-width', 2);
        else {
          if (point.kind === 'draft') group.append('circle').attr('r', 13).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2);
          group.append('circle').attr('r', point.kind === 'draft' ? 6 : 8).attr('fill', color).attr('stroke', '#fffdf7').attr('stroke-width', 2);
        }
        group.append('title').text(point.label + ': ' + formatPoint(point.coord));
      });
    }
    drawLabels() {
      if (!this.labels || !this.context || !this.projection) return;
      this.labels.selectAll('*').remove();
      if (this.transform.k < 2) return;
      const used = new Set(), placed = [];
      for (const feature of this.context.roads.features || []) {
        const name = feature.properties && feature.properties.name;
        if (!name || used.has(name) || placed.length >= 13) continue;
        const lines = feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates : [feature.geometry.coordinates];
        for (const line of lines) {
          if (!line || line.length < 2) continue;
          const p = this.transform.apply(this.projection(line[Math.floor(line.length / 2)]));
          if (p[0] < 65 || p[0] > 565 || p[1] < 20 || p[1] > 340 || placed.some(old => Math.abs(old[0] - p[0]) < 115 && Math.abs(old[1] - p[1]) < 31)) continue;
          this.labels.append('text').attr('x', p[0]).attr('y', p[1]).attr('text-anchor', 'middle').attr('font-family', 'system-ui,sans-serif').attr('font-size', 10).attr('fill', '#625b49').attr('stroke', '#eee7d6').attr('stroke-width', 3).attr('paint-order', 'stroke').text(name);
          placed.push(p); used.add(name); break;
        }
      }
    }
    fit() {
      if (!this.projection || !this.points.length) return this.area();
      const coords = this.points.map(p => this.projection(p.coord)), xs = coords.map(p => p[0]), ys = coords.map(p => p[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const scale = Math.min(18, Math.max(1, Math.min(490 / Math.max(1, maxX - minX), 240 / Math.max(1, maxY - minY))));
      this.root.call(this.zoom.transform, this.d3.zoomIdentity.translate(320 - scale * (minX + maxX) / 2, 180 - scale * (minY + maxY) / 2).scale(scale));
    }
    area() { if (this.root) this.root.call(this.zoom.transform, this.d3.zoomIdentity); }
    scaleBy(factor) { if (this.root) this.root.call(this.zoom.scaleBy, factor); }
  }

  function createApp(win, options = {}) {
    const doc = win.document, $ = id => doc.getElementById(id);
    const state = { csrfToken: '', issues: [], sites: [], drafts: new Map(), saved: new Map(), dirty: new Set(), draftRevisions: new Map(), bootstrapSequence: 0, history: [], selected: null, frame: null, connection: {}, bounds: BOUNDS.slice(), comments: new Map(), commentLoads: new Set(), busy: new Set(), bootstrap: null, preview: null, previewNumber: null, publishing: false, publication: null, selectionEpoch: 0, dialogFocus: new Map(), resumePreviewAfterConnection: false };
    const fetcher = options.fetch || win.fetch.bind(win);
    let map = null;

    function element(tag, content, className) { const node = doc.createElement(tag); if (content != null) node.textContent = text(content); if (className) node.className = className; return node; }
    function setText(id, value) { const node = $(id); if (node) node.textContent = text(value); }
    function announce(value) { setText('announcer', value); }
    function errorAt(id, value) { const node = $(id); node.textContent = text(value); node.hidden = !value; }
    function selectedIssue() { return state.issues.find(issue => Number(issue.number) === state.selected) || null; }
    function selectedDraft() { return state.drafts.get(state.selected) || null; }
    function selectedSite() { const d = selectedDraft(); return d ? state.sites.find(site => site.id === d.place) || null : null; }
    function externalLink(url, label, className) {
      const clean = safeUrl(url);
      if (!clean) return element('span', label || url, className);
      const link = element('a', label || clean, className); link.href = clean; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'; return link;
    }
    function richText(node, value) {
      node.replaceChildren();
      const input = text(value), re = /https?:\/\/[^\s<>\[\]"']+/g;
      let cursor = 0, match;
      while ((match = re.exec(input))) {
        let url = match[0].replace(/[),.;]+$/, '');
        node.append(doc.createTextNode(input.slice(cursor, match.index)));
        node.append(externalLink(url, url));
        cursor = match.index + url.length;
      }
      node.append(doc.createTextNode(input.slice(cursor)));
    }
    function dateLabel(value, withTime) {
      if (!value) return 'Not yet refreshed';
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return text(value);
      return date.toLocaleString(undefined, withTime ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', year: 'numeric' });
    }
    function notice(message, isError) {
      const node = $('global-notice'); node.replaceChildren(); node.hidden = !message; node.classList.toggle('error', !!isError);
      if (message) { node.append(element('span', message)); const close = element('button', 'Dismiss', 'small text-button'); close.type = 'button'; close.addEventListener('click', () => { node.hidden = true; }); node.append(close); }
    }
    async function api(path, payload) {
      let response;
      try {
        response = await fetcher(path, { method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: payload === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Review-Token': state.csrfToken }, body: payload === undefined ? undefined : JSON.stringify(payload) });
      } catch (_) { const error = new Error('The local review desk could not be reached. Check that its launcher is still running, then try again. Your edits are still in this window.'); error.code = 'CONNECTION_LOST'; throw error; }
      let result;
      try { result = await response.json(); } catch (_) { const error = new Error('The review desk returned an unreadable response. Keep this window open and try refreshing the connection.'); error.code = 'BAD_RESPONSE'; throw error; }
      if (!response.ok || result.error) { const error = new Error(text(result.error) || 'The request could not be completed.'); error.code = result.code || 'REQUEST_FAILED'; error.status = response.status; throw error; }
      return result;
    }
    function bootstrapRequest() { return { sequence: ++state.bootstrapSequence, draftRevisions: new Map(state.draftRevisions) }; }
    function ensureDraft(issue, saved, revisions) {
      const number = Number(issue.number);
      if (!state.drafts.has(number)) {
        const draft = defaultDraft(issue, state.sites, saved);
        state.drafts.set(number, draft); state.saved.set(number, saved ? draftPayload(draft) : null);
      } else if (!state.dirty.has(number) && saved && (!revisions || (revisions.get(number) || 0) === (state.draftRevisions.get(number) || 0))) {
        const draft = defaultDraft(issue, state.sites, saved);
        state.drafts.set(number, draft); state.saved.set(number, draftPayload(draft));
      }
    }
    function applyBootstrap(data, opts = {}) {
      if (opts.sequence && opts.sequence !== state.bootstrapSequence) return;
      if (!data || !Array.isArray(data.issues) || !Array.isArray(data.sites)) throw new Error('The local review data has an unexpected format. No drafts have been changed.');
      state.bootstrap = data;
      if (data.csrfToken) state.csrfToken = data.csrfToken;
      const priorIssues = new Map(state.issues.map(issue => [Number(issue.number), issue]));
      state.issues = data.issues.map(issue => { const prior = priorIssues.get(Number(issue.number)); return prior && new Date(prior.updatedAt) > new Date(issue.updatedAt) ? prior : issue; }).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0) || Number(b.number) - Number(a.number));
      state.sites = data.sites; state.history = Array.isArray(data.history) ? data.history : []; state.connection = data.connection || {};
      if (Array.isArray(data.bounds) && data.bounds.length === 4) state.bounds = data.bounds.slice();
      state.issues.forEach(issue => ensureDraft(issue, data.drafts && data.drafts[String(issue.number)], opts.draftRevisions));
      if (state.selected == null || !selectedIssue()) state.selected = state.issues[0] ? Number(state.issues[0].number) : null;
      renderConnection(); renderInbox(); renderRefreshStatus(); renderHistory();
      if (!opts.keepSelectionRendering) renderSelected();
      $('startup').hidden = true; $('workspace').hidden = false;
      if (map) map.setContext(map.context, state.bounds);
    }
    function renderRefreshStatus() {
      const data = state.bootstrap || {};
      let status = data.lastRefresh ? 'Last refreshed ' + dateLabel(data.lastRefresh, true) + '.' : 'Showing the included public snapshot.';
      if (data.truncated) status += ' Some older records were not loaded.';
      if (data.refreshError) status += ' Refresh unavailable: ' + text(data.refreshError);
      setText('refresh-status', status);
    }
    function renderConnection() {
      const c = state.connection || {}, connected = !!c.connected && !!c.canPublish;
      setText('connection-label', connected ? text(c.login || 'Connected') : 'Connect to publish');
      $('connection-dot').classList.toggle('connected', connected);
      const status = $('connection-status'); status.classList.toggle('connected', connected);
      status.textContent = connected ? 'Connected as ' + text(c.login || 'your GitHub account') + ' using ' + (c.mode === 'token' ? 'a temporary session token' : 'GitHub CLI') + '. Ready to publish reviewed decisions.' : text(c.message) || 'Reading public submissions. Local drafts are available; publishing requires a connection.';
      $('disconnect-button').hidden = !c.connected;
      if (state.preview && !state.publication) renderPreviewActions();
    }
    function renderInbox() {
      setText('issue-count', state.issues.length);
      const items = filterIssues(state.issues, $('inbox-search').value, $('inbox-filter').value, state.drafts, state.history, state.dirty);
      const list = $('issue-list'); list.replaceChildren();
      if (!items.length) list.append(element('p', state.issues.length ? 'No submissions match these filters.' : 'No submissions are cached yet. Refresh when you are online.', 'inbox-empty'));
      items.forEach(issue => {
        const number = Number(issue.number), d = state.drafts.get(number), local = hasLocalReview(d, state.dirty, number) || !!state.saved.get(number), status = effectiveStatus(issue, local ? d : null), button = element('button', null, 'issue-row');
        button.type = 'button'; button.setAttribute('aria-current', state.selected === number ? 'true' : 'false');
        const head = element('span', null, 'issue-row-header'); head.append(element('span', '#' + number + (validFrame(issue.fields && issue.fields.frame) ? ' · FRAME ' + issue.fields.frame : ''))); head.append(element('span', dateLabel(issue.createdAt, false).replace(/, \d{4}$/, '')));
        button.append(head, element('strong', issue.fields && issue.fields.location || text(issue.title).replace(/^\[Location evidence\]\s*/i, '')));
        const publicLabel = issue.remoteStatus === 'incorporated' ? 'Incorporated' : issue.remoteStatus === 'conflicting' ? 'Conflicting labels' : (DECISION_LABELS[status] || 'Awaiting review').replace(' locally', '');
        const foot = element('span', null, 'issue-row-footer'); foot.append(element('span', local ? 'Local: ' + (DECISION_LABELS[status] || 'Awaiting review').replace(' locally', '') : 'Public: ' + publicLabel, 'badge ' + status));
        if (state.history.some(record => Number(record.issueNumber) === number)) foot.append(element('span', 'Published review on record', 'badge published'));
        if (state.dirty.has(number)) foot.append(element('span', 'Unsaved', 'badge unsaved'));
        button.append(foot); button.addEventListener('click', () => selectIssue(number)); list.append(button);
      });
      setText('history-count', state.history.length);
    }
    function renderSelected() {
      const issue = selectedIssue();
      $('empty-selection').hidden = !!issue; $('review-placeholder').hidden = !!issue; $('evidence-content').hidden = !issue; $('review-content').hidden = !issue;
      if (!issue) return;
      const first = validFrame(issue.fields && issue.fields.frame) || validFrame((selectedSite() && selectedSite().frames || [])[0]?.id) || 1;
      if (!state.frame) state.frame = first;
      renderEvidence(); renderEditor(); setFrame(state.frame); renderComments();
    }
    function selectIssue(number) {
      if (state.publishing || !state.issues.some(issue => Number(issue.number) === number)) return;
      state.selected = number; state.selectionEpoch++; state.frame = validFrame(selectedIssue().fields && selectedIssue().fields.frame) || validFrame(selectedSite()?.frames?.[0]?.id) || 1;
      if (map) { map.picking = false; map.exploring = false; map.setInteraction(); }
      renderInbox(); renderSelected(); loadIssue(number);
      doc.querySelector('.evidence-pane').scrollTop = 0; doc.querySelector('.review-pane').scrollTop = 0;
      announce('Selected submission ' + number + '. ' + (state.dirty.has(number) ? 'Your unsaved edits have been kept.' : ''));
    }
    function renderEvidence() {
      const issue = selectedIssue(), f = issue.fields || {};
      setText('issue-kicker', 'SUBMISSION #' + issue.number + (validFrame(f.frame) ? ' · FRAME ' + f.frame : ''));
      setText('evidence-heading', f.location || text(issue.title).replace(/^\[Location evidence\]\s*/i, ''));
      const url = safeUrl(issue.url); if (url) $('issue-link').href = url; else $('issue-link').removeAttribute('href');
      setText('issue-meta', 'From ' + text(issue.author || 'a contributor') + ' · ' + dateLabel(issue.createdAt, true));
      const publicStatus = { received: 'Received — awaiting review', 'under-review': 'Under review', incorporated: 'Incorporated', approved: 'Approved', disputed: 'Disputed', conflicting: 'Conflicting review labels' }[issue.remoteStatus] || text(issue.remoteStatus || 'Received — awaiting review');
      setText('issue-status', 'Public submission status: ' + publicStatus);
      const facts = $('submission-facts'); facts.replaceChildren();
      [['Type', f.kind], ['Question', f.question], ['Address', f.proposedAddress], ['Point', issuePoint(issue) ? formatPoint(issuePoint(issue)) : ''], ['Source date', f.sourceDate], ['Attribution', f.attribution]].forEach(([label, value]) => { if (value) facts.append(element('dt', label), element('dd', value)); });
      richText($('submission-evidence'), f.evidence || 'Read the complete submission below.'); richText($('submission-body'), issue.body || 'No submission text was supplied.');
      renderSources(); renderCurrentResearch(); renderVersionWarning();
    }
    function sourceCard(url, label) {
      const clean = safeUrl(url); if (!clean) return null;
      const link = externalLink(clean, '', 'source-item'), host = new URL(clean).hostname.replace(/^www\./, '');
      link.append(element('strong', label || host + ' ↗'), element('span', clean)); return link;
    }
    function renderSources() {
      const issue = selectedIssue(), fields = issue.fields || {}, urls = uniqueUrls(fields.links), container = $('submitted-sources'); container.replaceChildren();
      setText('source-count', urls.length);
      urls.forEach((url, index) => container.append(sourceCard(url, 'Source ' + (index + 1) + ' · ' + new URL(url).hostname.replace(/^www\./, '') + ' ↗')));
      if (!urls.length) container.append(element('p', 'No separate source links were submitted. Check the complete submission for context.', 'micro'));
      const attachments = $('submitted-attachments'); attachments.replaceChildren();
      uniqueUrls(fields.attachments).forEach((url, index) => {
        const card = element('div', null, 'attachment'), row = element('div', null, 'attachment-row'); row.append(externalLink(url, 'Attachment ' + (index + 1) + ' ↗', 'quiet-link'));
        const load = element('button', 'Preview image', 'small secondary'); load.type = 'button'; row.append(load); card.append(row);
        load.addEventListener('click', () => {
          load.disabled = true; load.textContent = 'Loading…'; const image = element('img'); image.alt = 'Contributor attachment ' + (index + 1); image.referrerPolicy = 'no-referrer'; image.loading = 'lazy';
          image.addEventListener('load', () => { load.hidden = true; });
          image.addEventListener('error', () => { image.remove(); load.hidden = true; card.append(element('p', 'An image preview was not available. Use the attachment link to inspect the source.', 'micro')); });
          image.src = url; card.append(image);
        });
        attachments.append(card);
      });
    }
    function renderCurrentResearch() {
      const site = selectedSite(), node = $('current-research'); node.replaceChildren(); $('related-frames').replaceChildren();
      if (!site) { node.append(element('p', 'No existing location is linked. An approved website update will create a new candidate entry for the submission’s frame. You can publish its information before setting a map pin.', 'research-text')); return; }
      node.append(element('h4', site.name, 'research-title'), element('span', site.status, 'badge ' + (site.status === 'Candidate' ? 'approved' : '')));
      node.append(element('p', [site.address, formatPoint(site.coord)].filter(Boolean).join(' · '), 'research-meta'));
      [['Film connection', site.connection], ['Historical context', site.history], ['Confidence: ' + text(site.confidenceLabel), site.confidenceNote], ['Meaning of the pin', site.pinNote]].forEach(([label, content]) => { if (!content) return; const block = element('div', null, 'research-text'); block.append(element('strong', label)); const p = element('p'); richText(p, content); block.append(p); node.append(block); });
      const refs = element('ul', null, 'research-source-list'); (site.sources || []).forEach(source => { if (!Array.isArray(source) || !safeUrl(source[1])) return; const li = element('li'); li.append(externalLink(source[1], source[0] + ' ↗')); refs.append(li); }); if (refs.childNodes.length) node.append(refs);
      const related = $('related-frames'); related.replaceChildren();
      const frames = Array.from(new Set([validFrame(selectedIssue().fields?.frame), ...(site.frames || []).map(frame => validFrame(frame.id))].filter(Boolean)));
      frames.forEach(id => { const button = element('button', String(id), 'frame-chip'); button.type = 'button'; button.setAttribute('aria-label', 'Inspect frame ' + id); button.setAttribute('aria-pressed', state.frame === id ? 'true' : 'false'); button.addEventListener('click', () => setFrame(id)); related.append(button); });
    }
    function setFrame(value) {
      const frame = validFrame(value); if (!frame) { $('frame-input').value = state.frame || 1; return; }
      state.frame = frame; $('frame-input').value = frame; setText('film-counter', String(frame).padStart(3, '0') + ' / 682');
      const src = '/api/frame/' + frame; if ($('film-image').getAttribute('src') !== src) { $('film-error').hidden = true; $('film-image').src = src; }
      $('film-image').alt = 'Uptight (1968), indexed film frame ' + frame;
      $('frame-previous').disabled = frame <= 1; $('frame-next').disabled = frame >= 682;
      doc.querySelectorAll('#related-frames button').forEach(button => button.setAttribute('aria-pressed', Number(button.textContent) === frame ? 'true' : 'false'));
      if ($('image-dialog').open) { $('large-image').src = src; $('large-image').alt = $('film-image').alt; setText('large-image-caption', 'Uptight · frame ' + frame); }
    }
    async function loadIssue(number, force) {
      if (state.commentLoads.has(number)) return;
      if (!force && state.comments.get(number)?.loaded) return;
      state.commentLoads.add(number);
      if (state.selected === number) setText('comments-status', 'Loading the latest discussion…');
      try {
        const result = await api('/api/issues/' + number);
        if (result.issue && Number(result.issue.number) === number) { const index = state.issues.findIndex(issue => Number(issue.number) === number); if (index >= 0) state.issues[index] = result.issue; }
        state.comments.set(number, { items: Array.isArray(result.comments) ? result.comments : [], loaded: true, error: text(result.warning) });
        if (state.selected === number) { renderEvidence(); renderVersionWarning(); renderComments(); renderInbox(); updateMap(false); }
      } catch (error) {
        state.comments.set(number, { ...(state.comments.get(number) || { items: [] }), error: error.message });
        if (state.selected === number) renderComments();
      } finally { state.commentLoads.delete(number); }
    }
    function renderComments() {
      const data = state.comments.get(state.selected), node = $('issue-comments'); node.replaceChildren();
      setText('comments-status', data?.error ? 'Showing cached evidence. ' + data.error : data?.loaded ? ((data.items || []).length ? 'Latest available discussion' : 'No discussion comments yet.') : 'Discussion has not been refreshed yet.');
      (data?.items || []).forEach(comment => { const card = element('article', null, 'comment'), head = element('header'); head.append(element('strong', comment.author || 'Contributor'), externalLink(comment.url, dateLabel(comment.createdAt, true) + ' ↗')); const body = element('div', null, 'prose'); richText(body, comment.body); card.append(head, body); node.append(card); });
    }
    function renderEditor() {
      const draft = selectedDraft(); if (!draft) return;
      const place = $('place'); place.replaceChildren();
      state.sites.forEach(site => { const option = element('option', site.name); option.value = site.id; place.append(option); });
      const fresh = element('option', 'New location for this submission frame'); fresh.value = 'new'; place.append(fresh);
      Object.entries(FIELD_IDS).forEach(([key, id]) => { if (key === 'updatePin') $(id).checked = draft[key] === true; else $(id).value = draft[key] == null ? '' : draft[key]; });
      doc.querySelectorAll('input[name="review-mode"]').forEach(input => { input.checked = input.value === draft.mode; });
      $('other-review-options').open = draft.mode !== 'content';
      renderMode(); renderSaveStatus(); errorAt('review-error', ''); updateMap(true);
    }
    function renderMode() {
      const draft = selectedDraft(), site = selectedSite(); if (!draft) return;
      const content = draft.mode === 'content', editPin = pinEditsEnabled(draft);
      $('content-fields').hidden = !content; $('site-fields').hidden = draft.mode === 'evidence';
      $('legacy-content-action').hidden = content; $('location-fields').hidden = !editPin;
      $('map-section').hidden = content && !editPin;
      setText('review-heading', content ? 'Website information' : 'Decision & map');
      setText('preview-button', content ? 'Review website changes →' : 'Preview publication →');
      setText('public-note-hint', content ? 'Optional' : 'Required to publish');
      setText('public-note-help', content ? 'A brief publication record is created automatically. Add a note here only if you want to explain the decision further.' : 'This note and the submitted source links will appear in the public review record.');
      $('public-note').placeholder = content ? 'Optional: explain your editorial decision or any remaining uncertainty.' : 'Explain your decision in terms a visitor can understand. Say which evidence you accept and what remains uncertain.';
      const frames = site ? (site.frames || []).map(frame => validFrame(frame.id)).filter(Boolean) : [validFrame(selectedIssue()?.fields?.frame)].filter(Boolean);
      let scope = site ? 'This location is shared by ' + frames.length + ' frame' + (frames.length === 1 ? '' : 's') + ': ' + frames.join(', ') + '.' : 'A new location will use the submission’s frame' + (frames.length ? ' ' + frames[0] : '') + '.';
      scope += content ? ' Approval publishes the edited website text and sources for this location.' + (editPin ? ' It also updates the pin and confidence shown below.' : site ? ' The current pin and confidence are kept.' : ' The new candidate entry will remain unpinned.') : draft.mode === 'location' ? ' An approved location review changes this whole location record.' : ' An approved evidence review adds notes and sources while preserving its map position and confidence.';
      setText('linked-scope', scope);
      $('decision').querySelector('option[value="approved"]').textContent = content ? 'Approve website update' : 'Approve contribution';
      setText('decision-help', draft.decision === 'approved' ? 'Approved locally. Your decision reaches the public site only after you preview and publish it.' : content ? 'Choose Approve website update to publish this text. You can save unfinished work locally.' : 'A saved decision stays local until you preview and publish it.');
      if (!editPin && map) { map.picking = false; map.setInteraction(); }
      const point = issuePoint(selectedIssue()); $('use-submitted-point').disabled = !withinBounds(point, state.bounds);
      $('use-submitted-point').title = !point ? 'No coordinates were supplied.' : !withinBounds(point, state.bounds) ? 'The submitted point is outside the research area.' : '';
      $('pick-map-point').disabled = !map?.ready;
      renderCoordinateValidation(); renderVersionWarning();
    }
    function renderVersionWarning() {
      const issue = selectedIssue(), draft = selectedDraft(); if (!issue || !draft) return;
      let warning = $('issue-version-warning');
      if (!warning) { warning = element('div', null, 'pending-card'); warning.id = 'issue-version-warning'; $('issue-status').insertAdjacentElement('afterend', warning); }
      warning.replaceChildren(); warning.hidden = text(draft.baseIssueUpdatedAt) === text(issue.updatedAt);
      if (!warning.hidden) {
        warning.append(element('p', 'This submission changed after your draft was started. Read the current evidence before reviewing this version.'));
        const acknowledge = element('button', 'Use this version for my review', 'small secondary'); acknowledge.type = 'button'; acknowledge.addEventListener('click', () => { setDraftField('baseIssueUpdatedAt', text(issue.updatedAt)); renderVersionWarning(); announce('The draft now refers to the displayed version of the submission.'); }); warning.append(acknowledge);
      }
    }
    function setDraftField(key, value) {
      if (!selectedDraft() || !DRAFT_KEYS.includes(key)) return;
      selectedDraft()[key] = value;
      state.draftRevisions.set(state.selected, (state.draftRevisions.get(state.selected) || 0) + 1);
      const saved = state.saved.get(state.selected);
      if (!saved || fingerprint(selectedDraft()) !== fingerprint(saved)) state.dirty.add(state.selected); else state.dirty.delete(state.selected);
      if (state.previewNumber === state.selected) state.preview = null;
      renderSaveStatus(); renderInbox();
    }
    function changeMode(mode) {
      if (!['content', 'evidence', 'location'].includes(mode) || !selectedDraft()) return;
      setDraftField('mode', mode);
      doc.querySelectorAll('input[name="review-mode"]').forEach(input => { input.checked = input.value === mode; });
      if (mode === 'content') $('other-review-options').open = false;
      renderMode(); updateMap(false);
    }
    function changePlace(place) {
      setDraftField('place', place);
      const draft = selectedDraft(), site = selectedSite(), fields = selectedIssue().fields || {};
      const replacements = site ? { name: site.name, address: site.address, history: site.history, latitude: site.coord?.[1] ?? null, longitude: site.coord?.[0] ?? null, status: site.status, confidenceLabel: site.confidenceLabel, confidenceNote: site.confidenceNote, pinNote: site.pinNote } : { name: fields.location || '', address: fields.proposedAddress || '', history: '', latitude: null, longitude: null, status: 'Candidate', confidenceLabel: '', confidenceNote: '', pinNote: '' };
      Object.entries(replacements).forEach(([key, value]) => { draft[key] = value == null && !['latitude', 'longitude'].includes(key) ? '' : value; });
      setDraftField('place', place); renderEditor(); renderCurrentResearch();
    }
    function renderCoordinateValidation() {
      const draft = selectedDraft(); if (!draft) return;
      const lat = numberInput(draft.latitude), lon = numberInput(draft.longitude), point = draftPoint(draft);
      let message = 'Allowed area: latitude ' + state.bounds[1] + '–' + state.bounds[3] + '; longitude ' + state.bounds[0] + '–' + state.bounds[2] + '.';
      const invalid = !lat.valid || !lon.valid || (!!point && !withinBounds(point, state.bounds));
      if (!lat.valid || !lon.valid) message = 'Use decimal numbers for latitude and longitude.';
      else if (point && !withinBounds(point, state.bounds)) message = 'This point is outside the Cleveland research area.';
      else if ((lat.value == null) !== (lon.value == null)) message = 'Enter both latitude and longitude to define a point.';
      else if (point) message = 'Point is inside the research area. Explain what it marks below.';
      $('latitude').setAttribute('aria-invalid', !lat.valid || (!!point && !withinBounds(point, state.bounds)) ? 'true' : 'false');
      $('longitude').setAttribute('aria-invalid', !lon.valid || (!!point && !withinBounds(point, state.bounds)) ? 'true' : 'false');
      setText('coordinate-validation', message); $('coordinate-validation').classList.toggle('error', invalid);
    }
    function updateMap(fit) {
      const issue = selectedIssue(), draft = selectedDraft(); if (!issue || !draft) return;
      const current = selectedSite()?.coord || null, submitted = issuePoint(issue), proposed = pinEditsEnabled(draft) ? draftPoint(draft) : null;
      const comparison = $('point-comparison'); comparison.replaceChildren();
      [['current', 'Current', current], ['submitted', 'Submitted', submitted], ['draft', 'Your draft', proposed]].forEach(([kind, label, point]) => {
        const cell = element('div', null, 'point-cell ' + kind); cell.append(element('strong', label), element('span', kind === 'draft' && !pinEditsEnabled(draft) ? draft.mode === 'content' ? 'Keep current pin' : 'Evidence only' : formatPoint(point)));
        if (point && !withinBounds(point, state.bounds)) cell.append(element('span', 'Outside area')); comparison.append(cell);
      });
      if (map) { map.setPoints([{ kind: 'current', label: 'Current public point', coord: current }, { kind: 'submitted', label: 'Submitted point — unreviewed', coord: submitted }, { kind: 'draft', label: 'Local draft point', coord: proposed }], fit); }
      $('map-explore').setAttribute('aria-pressed', map?.exploring ? 'true' : 'false'); $('pick-map-point').setAttribute('aria-pressed', map?.picking ? 'true' : 'false');
      renderCoordinateValidation();
    }
    function renderSaveStatus() {
      if (!selectedDraft()) return;
      const dirty = state.dirty.has(state.selected), saving = state.busy.has('save:' + state.selected), saved = !!state.saved.get(state.selected), d = selectedDraft();
      setText('save-status', saving ? 'Saving on this computer…' : dirty ? 'Unsaved edits in this window' : saved ? 'Saved on this computer' : 'New local draft');
      setText('draft-badge', dirty ? 'Unsaved' : d.decision === 'approved' ? 'Approved locally' : 'Local draft'); $('draft-badge').className = 'badge ' + (dirty ? 'unsaved' : d.decision === 'approved' ? 'approved' : '');
      $('save-draft').disabled = saving; $('preview-button').disabled = saving || state.busy.has('preview');
    }
    async function saveDraft(number = state.selected) {
      const draft = state.drafts.get(number); if (!draft || state.busy.has('save:' + number)) return false;
      if ((draft.mode !== 'content' || pinEditsEnabled(draft)) && (!numberInput(draft.latitude).valid || !numberInput(draft.longitude).valid)) { errorAt('review-error', 'Correct the coordinate format before saving. Use decimal numbers or leave the fields empty.'); return false; }
      const payload = draftPayload(draft), sentFingerprint = fingerprint(draft);
      state.busy.add('save:' + number); if (state.selected === number) { errorAt('review-error', ''); renderSaveStatus(); }
      try {
        const result = await api('/api/drafts/' + number, payload), saved = result.draft || payload;
        state.saved.set(number, draftPayload(saved));
        state.draftRevisions.set(number, (state.draftRevisions.get(number) || 0) + 1);
        if (fingerprint(state.drafts.get(number)) === sentFingerprint) { state.drafts.set(number, { ...payload, ...draftPayload(saved) }); state.dirty.delete(number); }
        if (state.selected === number) announce(state.dirty.has(number) ? 'Draft saved. Newer edits are still unsaved.' : 'Draft saved on this computer. Nothing has been published.');
        return true;
      } catch (error) { if (state.selected === number) errorAt('review-error', error.message); else notice('Submission #' + number + ' could not be saved: ' + error.message, true); return false; }
      finally { state.busy.delete('save:' + number); renderSaveStatus(); renderInbox(); }
    }
    function validateForPreview() {
      const draft = selectedDraft(), issue = selectedIssue();
      if (text(draft.baseIssueUpdatedAt) !== text(issue.updatedAt)) return 'The submission has changed. Read the updated evidence and choose “Use this version for my review” before previewing.';
      const note = text(draft.publicNote).trim();
      if ((draft.mode !== 'content' || note) && note.length < 20) return draft.mode === 'content' ? 'Use at least 20 characters for a custom public note, or leave it empty for an automatic publication record.' : 'Add a public review note of at least 20 characters explaining the decision and its limits.';
      if (draft.mode === 'content' && draft.decision === 'approved') {
        if (text(draft.name).trim().length < 2) return 'Add a location name before reviewing the website changes.';
        if (text(draft.connection).trim().length < 20) return 'Add the film and location information you want to publish, using at least 20 characters.';
        if (draft.place === 'new' && !validFrame(issue.fields?.frame)) return 'A new website location needs a valid submission frame from 1 to 682.';
      }
      if (pinEditsEnabled(draft) && draft.decision === 'approved') {
        if (!validFrame(issue.fields?.frame)) return 'A map location needs a valid submission frame. Use evidence-only review for a general historical contribution.';
        if (!withinBounds(draftPoint(draft), state.bounds)) return 'Choose a point inside the research area before publishing a location.' + (draft.mode === 'content' ? ' Uncheck Also update the map pin to publish the website text with the current position.' : ' Use website information or evidence-only review to leave it unpinned.');
        if (draft.status === 'Unplaced') return 'A published pin needs Candidate or Strong match status.' + (draft.mode === 'content' ? ' Uncheck Also update the map pin to keep the current position.' : ' Use evidence-only review to leave the location unplaced.');
        for (const [key, min, label] of [['name', 2, 'location name'], ['confidenceLabel', 3, 'confidence label'], ['confidenceNote', 20, 'confidence explanation'], ['pinNote', 20, 'explanation of what the pin represents']]) if (text(draft[key]).trim().length < min) return 'Complete the ' + label + ' before previewing a location change.';
      }
      return '';
    }
    function showDialog(id) {
      const dialog = $(id); if (dialog.open) return;
      state.dialogFocus.set(id, doc.activeElement);
      if (typeof dialog.showModal === 'function') dialog.showModal(); else { dialog.setAttribute('open', ''); dialog.open = true; }
    }
    function closeDialog(dialog) {
      if (!dialog || (dialog.id === 'preview-dialog' && state.publishing)) return;
      if (dialog.id === 'connection-dialog') $('session-token').value = '';
      if (typeof dialog.close === 'function') dialog.close(); else { dialog.removeAttribute('open'); dialog.open = false; }
      const focus = state.dialogFocus.get(dialog.id); if (focus && focus.isConnected && typeof focus.focus === 'function') focus.focus({ preventScroll: true });
    }
    async function previewReview() {
      const number = state.selected; if (!number || state.busy.has('preview') || state.publishing) return;
      const validation = validateForPreview(); if (validation) { errorAt('review-error', validation); if ($('preview-dialog').open) errorAt('preview-error', validation); return; }
      state.busy.add('preview'); renderSaveStatus();
      try {
        if (!(await saveDraft(number))) return;
        if (state.selected !== number || state.dirty.has(number)) { notice('The draft changed while it was saving. Preview the updated draft when you are ready.'); return; }
        state.preview = null; state.previewNumber = number; state.publication = null;
        $('preview-body').replaceChildren(element('p', 'Checking the latest submission and public website…', 'preview-summary')); errorAt('preview-error', ''); setText('publish-status', 'Building the exact change preview.');
        $('publish-button').disabled = true; $('publish-button').hidden = false; $('refresh-preview').hidden = true; $('preview-connect').hidden = true; setText('close-preview', 'Keep editing'); showDialog('preview-dialog');
        const result = await api('/api/preview/' + number, {});
        if (!result.previewId || Number(result.issueNumber) !== number) throw new Error('The review desk could not verify this preview. Generate a fresh preview before publishing.');
        state.preview = result; renderPreview();
      } catch (error) {
        errorAt('preview-error', error.message); $('publish-button').disabled = true; $('refresh-preview').hidden = false; setText('publish-status', 'No new publication has been confirmed.');
        if (error.code === 'ALREADY_PUBLISHED') {
          const refresh = element('button', 'Refresh desk & inspect history', 'secondary'); refresh.type = 'button'; refresh.addEventListener('click', async () => { await refreshBootstrap(); closeDialog($('preview-dialog')); showDialog('history-dialog'); }); $('preview-body').append(refresh);
        }
      } finally { state.busy.delete('preview'); renderSaveStatus(); }
    }
    function renderPreview() {
      const preview = state.preview, body = $('preview-body'); if (!preview) return;
      const content = (preview.mode || state.drafts.get(state.previewNumber)?.mode) === 'content';
      body.replaceChildren(); setText('preview-heading', (content ? 'Website changes · submission #' : 'Preview submission #') + preview.issueNumber);
      body.append(element('p', preview.summary || 'Review the exact public changes below.', 'preview-summary'));
      const meta = element('div', null, 'preview-meta'); meta.append(element('span', preview.decision === 'approved' ? 'Approve contribution' : DECISION_LABELS[preview.decision] || preview.decision, 'badge ' + preview.decision), element('span', 'Ready for your final review', 'micro')); body.append(meta);
      if (Array.isArray(preview.warnings) && preview.warnings.length) { const warnings = element('ul', null, 'warning-list'); preview.warnings.forEach(warning => warnings.append(element('li', warning))); body.append(warnings); }
      const table = element('table', null, 'change-table'), head = element('thead'), tr = element('tr'); ['Field', 'Current public record', 'After publication'].forEach(label => { const th = element('th', label); th.scope = 'col'; tr.append(th); }); head.append(tr); table.append(head);
      const fieldLabels = { connection: 'Film & location information', history: 'Historical context', name: 'Location name', address: 'Address or area', coord: 'Map pin', sources: 'Source links' };
      const tbody = element('tbody'); (preview.changes || []).forEach(change => { const row = element('tr'), label = content && fieldLabels[text(change.field).split('.').at(-1)] || change.field; row.append(element('td', label), element('td', displayValue(change.before)), element('td', displayValue(change.after))); tbody.append(row); }); table.append(tbody); body.append(table);
      if (!(preview.changes || []).length) body.append(element('p', 'The preview contains no field changes.', 'micro'));
      const note = element('section', null, 'preview-section'); note.append(element('h3', 'Public review note')); const prose = element('div', null, 'prose'); richText(prose, preview.publicNote); note.append(prose); body.append(note);
      const sources = element('section', null, 'preview-section'); sources.append(element('h3', 'Source links in the public record')); const links = element('div', null, 'source-list'); uniqueUrls(preview.sourceLinks).forEach(url => links.append(sourceCard(url))); if (!links.childNodes.length) links.append(element('p', 'No source links supplied.', 'micro')); sources.append(links); body.append(sources);
      const files = element('section', null, 'preview-section'); files.append(element('h3', 'Files this will update')); const list = element('ul', null, 'file-list'); (preview.files || []).forEach(file => list.append(element('li', file))); files.append(list); body.append(files);
      const publicationHelp = content && preview.decision === 'approved' ? 'Approve and publish applies the website changes shown above. The public site updates after its deployment finishes. Private working notes are excluded.' : content ? 'This decision publishes the review status. Choose Approve website update in the editor to publish the edited website text. Private working notes are excluded.' : 'Publishing writes this decision to the public repository. The website updates through GitHub Pages after the commit. Private working notes are excluded.';
      body.append(element('p', publicationHelp, 'preview-detail-note'));
      errorAt('preview-error', ''); setText('publish-status', 'Nothing from this preview has been published.'); renderPreviewActions();
    }
    function renderPreviewActions() {
      const canPublish = !!state.connection.canPublish && !!state.connection.connected;
      const draft = state.drafts.get(state.previewNumber), mode = state.preview?.mode || draft?.mode, decision = state.preview?.decision || draft?.decision;
      setText('publish-button', mode === 'content' && decision === 'approved' ? 'Approve & publish to site' : 'Publish this decision');
      $('publish-button').hidden = !!state.publication; $('publish-button').disabled = !state.preview || !canPublish || state.publishing;
      $('preview-connect').hidden = canPublish || !!state.publication;
      $('refresh-preview').hidden = !!state.preview || !!state.publication;
    }
    async function publishReview() {
      if (state.publishing || !state.preview || !state.connection.canPublish || !state.connection.connected) return;
      const preview = state.preview, number = state.previewNumber;
      if (state.dirty.has(number)) { state.preview = null; renderPreviewActions(); errorAt('preview-error', 'Your draft changed. Get a fresh preview before publishing.'); return; }
      state.publishing = true; $('publish-button').disabled = true; $('close-preview').disabled = true; $('refresh-preview').hidden = true; $('preview-connect').hidden = true;
      setText('publish-status', 'Publishing the reviewed changes. Keep this desk open…'); errorAt('preview-error', '');
      try {
        const result = await api('/api/publish/' + number, { previewId: preview.previewId });
        if (!result.published || !result.commitSha) { const error = new Error('Publication was not confirmed. Get a fresh preview to reconcile the server record before trying again.'); error.code = 'PUBLICATION_AMBIGUOUS'; throw error; }
        state.publication = result; state.preview = null; upsertRecord(result.record); renderPublication(result); renderHistory(); renderInbox();
        await refreshBootstrap(true);
      } catch (error) {
        state.preview = null; $('publish-button').disabled = true; $('refresh-preview').hidden = false; setText('publish-status', 'Publication has not been confirmed in this window.');
        errorAt('preview-error', error.message + (error.code === 'CONNECTION_LOST' || error.code === 'BAD_RESPONSE' ? ' Get a fresh preview to reconcile any existing commit before retrying.' : ''));
      } finally { state.publishing = false; $('close-preview').disabled = false; if (!state.publication) renderPreviewActions(); }
    }
    function upsertRecord(record) {
      if (!record) return;
      const index = state.history.findIndex(item => item.id === record.id || (!!record.commitSha && item.commitSha === record.commitSha));
      if (index >= 0) state.history[index] = record; else state.history.unshift(record);
    }
    function renderPublication(result) {
      const content = result.record?.mode === 'content' && result.record?.decision === 'approved';
      const body = $('preview-body'); body.replaceChildren(); setText('preview-heading', content ? 'Website update committed' : 'Review committed successfully');
      const card = element('div', null, 'success-card'); card.append(element('h3', content ? 'Your website update is committed.' : 'Your review is in the repository.'), element('p', (content ? 'The website information was published as commit ' : 'The decision was published as commit ') + text(result.commitSha).slice(0, 7) + '. GitHub Pages may still be building the updated website.'));
      card.append(externalLink(result.commitUrl, 'Inspect the published commit ↗', 'quiet-link')); body.append(card);
      if (result.issueSynced) body.append(element('p', 'The submission’s public review status has also been synchronized.', 'preview-detail-note'));
      else {
        const pending = element('div', null, 'pending-card'); pending.append(element('strong', 'Published · submission status sync pending'), element('p', result.warning || 'Your review commit succeeded. Only the issue’s status label still needs synchronization.'));
        const retry = element('button', 'Retry status sync', 'small secondary'); retry.type = 'button'; retry.addEventListener('click', () => syncIssue(Number(result.record?.issueNumber || state.previewNumber), retry)); pending.append(retry); body.append(pending);
      }
      const siteUrl = result.siteUrl || (result.record?.siteId ? 'https://hgw3lls.github.io/uptight/#place=' + encodeURIComponent(result.record.siteId) : state.bootstrap?.siteUrl || 'https://hgw3lls.github.io/uptight/');
      const links = element('div', null, 'history-links'); links.append(externalLink(result.issueUrl, 'Submission record ↗'), externalLink(siteUrl, content ? 'View updated location ↗' : 'Open public map ↗')); body.append(links);
      $('publish-button').hidden = true; $('refresh-preview').hidden = true; $('preview-connect').hidden = true; setText('close-preview', 'Done'); setText('publish-status', result.issueSynced ? 'Commit verified · status synchronized' : 'Commit verified · status sync pending'); errorAt('preview-error', '');
      announce((content ? 'Website update committed successfully.' : 'Review committed successfully.') + ' The public website may still be rebuilding.');
    }
    async function syncIssue(number, button) {
      if (!number || state.busy.has('sync:' + number)) return;
      state.busy.add('sync:' + number); if (button) button.disabled = true;
      try {
        const result = await api('/api/sync-issue/' + number, {}); upsertRecord(result.record);
        if (state.publication && Number(state.publication.record?.issueNumber || state.previewNumber) === number) { state.publication = result; renderPublication(result); }
        renderHistory(); announce(result.issueSynced ? 'Submission status synchronized. No additional commit was created.' : result.warning || 'Status synchronization is still pending.');
      } catch (error) { notice('The review remains published. Status synchronization failed: ' + error.message, true); if (button) button.disabled = false; }
      finally { state.busy.delete('sync:' + number); }
    }
    function renderHistory() {
      const list = $('history-list'); list.replaceChildren(); setText('history-count', state.history.length);
      if (!state.history.length) list.append(element('div', 'No reviews have been published from this desk yet. Your drafts are available in the inbox.', 'status-card'));
      state.history.slice().sort((a, b) => new Date(b.publishedAt || b.reviewedAt) - new Date(a.publishedAt || a.reviewedAt)).forEach(record => {
        const entry = element('article', null, 'history-entry'), head = element('header'), heading = element('div'); heading.append(element('h3', 'Submission #' + record.issueNumber + (validFrame(record.frame) ? ' · frame ' + record.frame : '')), element('p', dateLabel(record.publishedAt || record.reviewedAt, true) + (record.reviewer ? ' · ' + (typeof record.reviewer === 'string' ? record.reviewer : text(record.reviewer.login || record.reviewer.name)) : ''), 'micro'));
        head.append(heading, element('span', record.decision === 'approved' ? 'Approved' : DECISION_LABELS[record.decision] || record.decision, 'badge published')); entry.append(head);
        const note = element('div', null, 'prose'); richText(note, record.publicNote); entry.append(note);
        const links = element('div', null, 'history-links'); if (record.commitUrl) links.append(externalLink(record.commitUrl, 'Commit ' + text(record.commitSha).slice(0, 7) + ' ↗')); if (record.issueUrl) links.append(externalLink(record.issueUrl, 'Submission ↗'));
        if (record.siteId) links.append(externalLink('https://hgw3lls.github.io/uptight/#place=' + encodeURIComponent(record.siteId), 'View location ↗'));
        if (record.issueSynced === false) { links.append(element('span', 'Status sync pending', 'badge approved')); const retry = element('button', 'Retry sync', 'small secondary'); retry.type = 'button'; retry.addEventListener('click', () => syncIssue(Number(record.issueNumber), retry)); links.append(retry); }
        else links.append(element('span', 'Status synchronized', 'micro'));
        entry.append(links); list.append(entry);
      });
    }
    async function refreshBootstrap(keepSelectionRendering) {
      const request = bootstrapRequest();
      try { const result = await api('/api/bootstrap'); applyBootstrap(result, { ...request, keepSelectionRendering: !!keepSelectionRendering }); return true; }
      catch (error) { notice(error.message, true); return false; }
    }
    async function refreshIssues() {
      if (state.busy.has('refresh') || state.publishing) return;
      state.busy.add('refresh'); $('refresh-button').disabled = true; $('refresh-spinner').hidden = false;
      try {
        const current = state.selected, frame = state.frame, request = bootstrapRequest(), result = await api('/api/refresh', {});
        applyBootstrap(result, request); if (state.selected === current && frame) setFrame(frame);
        if (state.selected) loadIssue(state.selected, true);
        announce(result.refreshError ? 'Refresh could not complete. Cached evidence and your drafts have been kept.' : 'Submissions refreshed. Unsaved draft edits have been kept.');
      } catch (error) { notice(error.message, true); setText('refresh-status', 'Refresh unavailable. Your cached evidence and drafts have been kept.'); }
      finally { state.busy.delete('refresh'); $('refresh-button').disabled = false; $('refresh-spinner').hidden = true; }
    }
    async function connect(mode) {
      if (state.busy.has('connect')) return;
      const tokenInput = $('session-token'), token = mode === 'token' ? tokenInput.value.trim() : '';
      tokenInput.value = '';
      if (mode === 'token' && !token) { errorAt('connection-error', 'Enter a session token first.'); return; }
      state.bootstrapSequence++; state.busy.add('connect'); $('connect-gh').disabled = true; $('connect-token').disabled = true; errorAt('connection-error', '');
      state.connection = { connected: false, canPublish: false, mode: 'public', message: 'Checking this connection…' }; state.preview = null; renderConnection();
      try {
        const result = await api('/api/connection', mode === 'token' ? { mode, token } : { mode }); state.connection = result.connection || {}; state.preview = null; renderConnection();
        if (!state.connection.connected || !state.connection.canPublish) { errorAt('connection-error', state.connection.message || 'This account is not ready to publish.'); return; }
        if (state.resumePreviewAfterConnection) { state.resumePreviewAfterConnection = false; closeDialog($('connection-dialog')); await previewReview(); }
        else announce('Connected. Reviews will publish only when you choose Publish this decision.');
      } catch (error) { state.connection = { connected: false, canPublish: false, mode: 'public', message: error.message }; state.preview = null; renderConnection(); errorAt('connection-error', error.message); }
      finally { state.busy.delete('connect'); $('connect-gh').disabled = false; $('connect-token').disabled = false; }
    }
    async function disconnect() {
      state.bootstrapSequence++; state.preview = null;
      try { const result = await api('/api/disconnect', {}); state.connection = result.connection || {}; state.preview = null; $('session-token').value = ''; renderConnection(); announce('Disconnected. Local drafts remain saved.'); }
      catch (error) { errorAt('connection-error', error.message); }
    }
    async function copyBackup() {
      const button = $('copy-backup-button'); button.disabled = true;
      try {
        const response = await fetcher('/api/export', { credentials: 'same-origin', cache: 'no-store' }); if (!response.ok) throw new Error('The backup could not be read.');
        const backup = await response.text();
        if (!win.navigator.clipboard || !win.navigator.clipboard.writeText) throw new Error('Clipboard access is unavailable. Use Download local backup instead.');
        await win.navigator.clipboard.writeText(backup); announce('Saved local review backup copied. It may include private notes; keep the copy private.'); notice('Local backup copied. It includes saved drafts and private notes. Unsaved edits remain in this window.');
      } catch (error) { notice(error.message + ' You can also use Download local backup.', true); }
      finally { button.disabled = false; }
    }
    async function loadContext() {
      try { const response = await fetcher('/context.json', { credentials: 'same-origin' }); if (!response.ok) throw new Error('Unavailable'); const context = await response.json(); if (map) { map.setContext(context, state.bounds); updateMap(true); } }
      catch (_) { $('map-fallback').hidden = false; }
    }
    async function start() {
      $('startup-retry').hidden = true;
      try {
        const request = bootstrapRequest(), result = await api('/api/bootstrap'); applyBootstrap(result, request);
        if (!map) map = new ReviewMap(win, $('review-map'), { onPick: coord => { if (!pinEditsEnabled(selectedDraft())) return; setDraftField('latitude', coord[1]); setDraftField('longitude', coord[0]); $('latitude').value = coord[1]; $('longitude').value = coord[0]; map.picking = false; map.setInteraction(); updateMap(false); setText('map-message', 'Point added to your local draft. Explain what it represents below.'); announce('Draft point set at ' + formatPoint(coord)); }, onMessage: message => setText('map-message', message) });
        if (!map.ready) $('map-fallback').hidden = false;
        renderMode(); updateMap(true); loadContext(); if (state.selected) loadIssue(state.selected);
      } catch (error) {
        $('startup').hidden = false; $('workspace').hidden = true;
        $('startup').querySelector('h2').textContent = 'The review desk could not open'; $('startup').querySelector('p').textContent = error.message;
        $('startup').querySelector('.loader').hidden = true; $('startup-retry').hidden = false;
      }
    }

    $('inbox-search').addEventListener('input', renderInbox); $('inbox-filter').addEventListener('change', renderInbox);
    $('refresh-button').addEventListener('click', refreshIssues); $('startup-retry').addEventListener('click', start);
    $('history-button').addEventListener('click', () => { renderHistory(); showDialog('history-dialog'); });
    $('connection-button').addEventListener('click', () => { state.resumePreviewAfterConnection = false; errorAt('connection-error', ''); renderConnection(); showDialog('connection-dialog'); });
    $('connect-gh').addEventListener('click', () => connect('gh')); $('token-form').addEventListener('submit', event => { event.preventDefault(); connect('token'); }); $('disconnect-button').addEventListener('click', disconnect);
    $('copy-backup-button').addEventListener('click', copyBackup);
    $('frame-input').addEventListener('change', event => setFrame(event.target.value)); $('frame-previous').addEventListener('click', () => setFrame(state.frame - 1)); $('frame-next').addEventListener('click', () => setFrame(state.frame + 1)); $('frame-reset').addEventListener('click', () => setFrame(selectedIssue()?.fields?.frame));
    $('film-image').addEventListener('error', () => { $('film-error').hidden = false; }); $('film-image').addEventListener('load', () => { $('film-error').hidden = true; });
    $('film-enlarge').addEventListener('click', () => { $('large-image').src = '/api/frame/' + state.frame; $('large-image').alt = $('film-image').alt; setText('large-image-caption', 'Uptight · frame ' + state.frame); showDialog('image-dialog'); });
    $('reload-comments').addEventListener('click', () => { if (state.selected) loadIssue(state.selected, true); });
    Object.entries(FIELD_IDS).forEach(([key, id]) => {
      $(id).addEventListener(['decision', 'place', 'status', 'updatePin'].includes(key) ? 'change' : 'input', event => {
        if (key === 'place') return changePlace(event.target.value);
        setDraftField(key, key === 'updatePin' ? event.target.checked : event.target.value);
        if (key === 'decision' || key === 'status' || key === 'updatePin') renderMode();
        if (key === 'latitude' || key === 'longitude' || key === 'updatePin') updateMap(false);
      });
    });
    doc.querySelectorAll('input[name="review-mode"]').forEach(input => input.addEventListener('change', () => { if (input.checked) changeMode(input.value); }));
    $('edit-website-information').addEventListener('click', () => { changeMode('content'); $('website-information').focus(); announce('Website editor opened. Review the proposed text and choose whether to update the pin before publishing.'); });
    $('review-form').addEventListener('submit', event => { event.preventDefault(); saveDraft(); });
    $('preview-button').addEventListener('click', previewReview); $('refresh-preview').addEventListener('click', previewReview); $('publish-button').addEventListener('click', publishReview);
    $('preview-connect').addEventListener('click', () => { state.resumePreviewAfterConnection = true; state.preview = null; closeDialog($('preview-dialog')); renderConnection(); showDialog('connection-dialog'); });
    $('use-submitted-point').addEventListener('click', () => { if (!pinEditsEnabled(selectedDraft())) return; const point = issuePoint(selectedIssue()); if (!withinBounds(point, state.bounds)) return; setDraftField('latitude', point[1]); setDraftField('longitude', point[0]); $('latitude').value = point[1]; $('longitude').value = point[0]; if (selectedDraft().status === 'Unplaced') { setDraftField('status', 'Candidate'); $('location-status').value = 'Candidate'; } updateMap(true); announce('Submitted point copied to your local draft. It has not been published.'); });
    $('clear-point').addEventListener('click', () => { if (!pinEditsEnabled(selectedDraft())) return; setDraftField('latitude', null); setDraftField('longitude', null); $('latitude').value = ''; $('longitude').value = ''; updateMap(false); });
    $('pick-map-point').addEventListener('click', () => { if (!map?.ready || !pinEditsEnabled(selectedDraft())) return; map.picking = !map.picking; map.exploring = false; map.setInteraction(); updateMap(false); setText('map-message', map.picking ? 'Click a point inside the dashed research boundary. Escape cancels.' : 'Point selection canceled. Use + / − to zoom.'); $('review-map').scrollIntoView({ block: 'center', behavior: 'auto' }); });
    $('map-explore').addEventListener('click', () => { if (!map?.ready) return; map.exploring = !map.exploring; map.picking = false; map.setInteraction(); updateMap(false); setText('map-message', map.exploring ? 'Drag or pinch inside the map. Use + / − to zoom; wheel scrolling continues through the review.' : 'Use + / − to zoom. Scrolling here continues through the review.'); });
    $('map-zoom-in').addEventListener('click', () => map?.scaleBy(1.7)); $('map-zoom-out').addEventListener('click', () => map?.scaleBy(1 / 1.7)); $('map-fit').addEventListener('click', () => map?.fit()); $('map-area').addEventListener('click', () => map?.area());
    doc.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => closeDialog(button.closest('dialog'))));
    doc.querySelectorAll('dialog').forEach(dialog => {
      dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(dialog); });
      dialog.addEventListener('close', () => { if (dialog.id === 'connection-dialog') $('session-token').value = ''; });
    });
    doc.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape' && !doc.querySelector('dialog[open]') && map?.picking) { map.picking = false; map.setInteraction(); updateMap(false); setText('map-message', 'Point selection canceled.'); return; }
      if (event.ctrlKey || event.metaKey || event.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName) || event.target?.isContentEditable) return;
      if ($('image-dialog').open && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); setFrame(state.frame + (event.key === 'ArrowLeft' ? -1 : 1)); }
    });
    win.addEventListener('beforeunload', event => { if (state.dirty.size || state.publishing) { event.preventDefault(); event.returnValue = ''; } });
    const app = { state, start, api, applyBootstrap, selectIssue, saveDraft, previewReview, publishReview, refreshIssues, refreshBootstrap, connect, disconnect, setDraftField, renderInbox, renderSelected, showDialog, closeDialog, getMap: () => map };
    if (!options.manualStart) app.ready = start();
    return app;
  }

  return { BOUNDS, DRAFT_KEYS, safeUrl, uniqueUrls, numberInput, withinBounds, draftPoint, issuePoint, siteForIssue, defaultDraft, draftPayload, fingerprint, filterIssues, effectiveStatus, formatPoint, displayValue, ReviewMap, createApp };
});

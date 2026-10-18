// Exercises the real owner-desk actions with a small DOM and mocked same-origin
// API. This is behavioral verification, not a browser or visual-layout test.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../web/app.js');
const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../web/app.css'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

class Node {
  constructor(tag, doc, nodeType = 1) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.nodeType = nodeType; this.children = []; this.parentNode = null; this.attrs = {}; this._text = ''; this.listeners = new Map(); this.style = {}; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; this.open = false; this.scrollTop = 0; this.isContentEditable = false; }
  get childNodes() { return this.children; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this._text = String(value == null ? '' : value); }
  get id() { return this.attrs.id || ''; }
  set id(value) { this.attrs.id = String(value); }
  get className() { return this.attrs.class || ''; }
  set className(value) { this.attrs.class = String(value); }
  get classList() { return { contains: name => this.className.split(/\s+/).includes(name), toggle: (name, force) => { const current = new Set(this.className.split(/\s+/).filter(Boolean)), on = force === undefined ? !current.has(name) : force; if (on) current.add(name); else current.delete(name); this.className = [...current].join(' '); return on; }, add: name => { this.classList.toggle(name, true); }, remove: name => { this.classList.toggle(name, false); } }; }
  get src() { return this.attrs.src || ''; } set src(value) { this.attrs.src = String(value); }
  get href() { return this.attrs.href || ''; } set href(value) { this.attrs.href = String(value); }
  get isConnected() { let node = this; while (node) { if (node.nodeType === 9) return true; node = node.parentNode; } return false; }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'value') this.value = String(value); if (['hidden', 'disabled', 'checked', 'open'].includes(key)) this[key] = true; }
  getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null; }
  removeAttribute(key) { delete this.attrs[key]; if (['hidden', 'disabled', 'checked', 'open'].includes(key)) this[key] = false; }
  append(...nodes) { nodes.forEach(node => { if (typeof node === 'string') node = this.ownerDocument.createTextNode(node); if (node.parentNode) node.remove(); node.parentNode = this; this.children.push(node); }); }
  replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
  remove() { if (!this.parentNode) return; const siblings = this.parentNode.children, i = siblings.indexOf(this); if (i >= 0) siblings.splice(i, 1); this.parentNode = null; }
  insertAdjacentElement(where, node) { assert.equal(where, 'afterend'); const siblings = this.parentNode.children, i = siblings.indexOf(this); node.parentNode = this.parentNode; siblings.splice(i + 1, 0, node); }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  async fire(type, extra = {}) { const event = { type, target: this, key: '', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra }; const result = (this.listeners.get(type) || []).map(fn => fn(event)); await Promise.all(result); return event; }
  matches(selector) {
    const tag = selector.match(/^[a-z][\w-]*/i); if (tag && tag[0].toUpperCase() !== this.tagName) return false;
    const id = selector.match(/#([\w-]+)/); if (id && this.id !== id[1]) return false;
    const cls = selector.match(/\.([\w-]+)/); if (cls && !this.classList.contains(cls[1])) return false;
    for (const match of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) { if (!(match[1] in this.attrs)) return false; if (match[2] !== undefined && this.attrs[match[1]] !== match[2]) return false; }
    return this.nodeType === 1;
  }
  querySelectorAll(selector) {
    const pieces = selector.trim().split(/\s+/), all = [];
    const visit = node => { node.children.forEach(child => { if (child.matches(pieces.at(-1))) { let parent = child.parentNode, match = true; for (let i = pieces.length - 2; i >= 0; i--) { while (parent && !parent.matches(pieces[i])) parent = parent.parentNode; if (!parent) { match = false; break; } parent = parent.parentNode; } if (match) all.push(child); } visit(child); }); };
    visit(this); return all;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { let node = this; while (node) { if (node.matches(selector)) return node; node = node.parentNode; } return null; }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  showModal() { this.open = true; this.attrs.open = ''; this.focus(); }
  close() { this.open = false; delete this.attrs.open; this.fire('close'); }
}
class Document extends Node {
  constructor(markup) {
    super('#document', null, 9); this.ownerDocument = this; this.activeElement = null;
    const stack = [this], voids = new Set(['meta', 'link', 'input', 'img', 'br', 'hr']);
    for (const token of markup.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+/g)) {
      const value = token[0]; if (value.startsWith('<!')) continue;
      if (value.startsWith('</')) { const tag = value.match(/^<\/([\w-]+)/)[1].toUpperCase(); while (stack.length > 1) { if (stack.pop().tagName === tag) break; } continue; }
      if (value.startsWith('<')) {
        const tag = value.match(/^<([\w-]+)/)[1].toLowerCase(), node = this.createElement(tag), attrs = value.slice(tag.length + 1, -1);
        for (const attr of attrs.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) node.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
        stack.at(-1).append(node); if (!voids.has(tag)) stack.push(node);
      } else stack.at(-1).append(this.createTextNode(value.replace(/&amp;/g, '&')));
    }
    this.querySelectorAll('select').forEach(select => { select.value = select.querySelector('option')?.value || ''; });
  }
  createElement(tag) { return new Node(tag, this); }
  createTextNode(value) { const node = new Node('#text', this, 3); node.textContent = value; return node; }
  getElementById(id) { return this.querySelector('#' + id); }
}

const ISSUE = {
  number: 1, title: '[Location evidence] Frame 658 — New candidate', url: 'https://github.com/hgw3lls/uptight/issues/1', author: 'hgw3lls', state: 'open', createdAt: '2026-10-18T15:50:00Z', updatedAt: '2026-10-18T15:50:00Z', remoteStatus: 'received',
  body: 'A bridge comparison. <img src=x onerror=alert(1)>\nhttps://example.org/1935\n<script>unsafe()</script>',
  fields: { location: 'Former Clark Avenue Bridge / steelworks area', frame: 658, kind: 'New candidate', evidence: 'The central truss resembles the bridge; position remains a candidate.', links: ['https://example.org/1935', 'javascript:alert(1)', 'https://example.org/1984'], attachments: ['https://example.org/comparison.jpg'], latitude: 41.470289, longitude: -81.6755, place: 'third', sourceDate: '1935', attribution: 'Public archive', proposedAddress: 'Industrial valley' }
};
const SITE = { id: 'third', name: 'Former Clark Avenue Bridge / steelworks area', status: 'Candidate', coord: null, address: 'Former crossing', frames: [{ id: 658 }, { id: 654 }, { id: 653 }, { id: 657 }], connection: 'Published film comparison.', confidenceLabel: 'Probable candidate', confidenceNote: 'The bridge identity is probable; the exact camera position is unresolved.', pinNote: 'Currently unpinned; a site position still needs review.', sources: [['Archive', 'https://example.org/old']] };
function make(overrides = {}) {
  const document = new Document(html), requests = [], handlers = new Map(), windowListeners = new Map();
  const data = { csrfToken: 'csrf-secret', repository: 'hgw3lls/uptight', siteUrl: 'https://hgw3lls.github.io/uptight/', bounds: ui.BOUNDS, connection: { connected: false, canPublish: false, mode: 'public', message: 'Reading public submissions.' }, issues: [copy(ISSUE)], sites: [copy(SITE)], drafts: {}, history: [], lastRefresh: null, ...overrides };
  const fetch = async (url, options = {}) => {
    requests.push({ url, ...options }); let result;
    if (handlers.has(url)) result = await handlers.get(url)(options);
    else if (url === '/api/bootstrap' || url === '/api/refresh') result = copy(data);
    else if (/\/api\/drafts\/\d+$/.test(url)) { const draft = JSON.parse(options.body); data.drafts[url.split('/').at(-1)] = draft; result = { draft }; }
    else if (/\/api\/issues\/\d+$/.test(url)) result = { issue: data.issues.find(i => i.number === Number(url.split('/').at(-1))), comments: [] };
    else if (url === '/context.json') return { ok: false, status: 404, json: async () => ({ error: 'missing' }) };
    else throw new Error('Unexpected request: ' + url);
    if (result && result.__response) return result.__response;
    return { ok: true, status: 200, json: async () => copy(result), text: async () => JSON.stringify(result) };
  };
  const win = { document, fetch, navigator: {}, addEventListener(type, fn) { windowListeners.set(type, fn); } };
  Object.defineProperty(win, 'localStorage', { get() { throw new Error('Browser storage must not be used'); } });
  Object.defineProperty(win, 'sessionStorage', { get() { throw new Error('Browser storage must not be used'); } });
  const app = ui.createApp(win, { manualStart: true, fetch }); app.applyBootstrap(copy(data));
  return { app, win, document, data, requests, handlers, listeners: windowListeners, $: id => document.getElementById(id) };
}
function approvedEvidence(app) { app.setDraftField('decision', 'approved'); app.setDraftField('publicNote', 'Reviewed the structural comparison. The bridge remains a probable candidate; no camera position is established.'); }
function mockPreview(number = 1) { return { previewId: 'preview-1', issueNumber: number, decision: 'approved', changes: [{ field: 'review.decisions', before: 0, after: 1 }, { field: 'sites.third.reviewedContributions', before: 0, after: 1 }], publicNote: 'A public assessment; position remains unresolved.', sourceLinks: ['https://example.org/1935'], files: ['data/review-decisions.json', 'data/map-data.json'], warnings: ['A candidate is not a verified camera position.'], summary: 'Approve evidence for the existing candidate.' }; }
function fail(message, code, status = 409) { return { __response: { ok: false, status, json: async () => ({ error: message, code }) } }; }

test('first opening retains submitted coordinates as evidence; map adoption requires explicit action', async () => {
  const { app, $, requests, document } = make();
  const draft = app.state.drafts.get(1);
  assert.equal(draft.decision, 'pending'); assert.equal(draft.mode, 'evidence'); assert.equal(draft.latitude, null); assert.equal(draft.longitude, null);
  assert.ok($('point-comparison').textContent.includes('41.470289')); assert.ok($('point-comparison').textContent.includes('Evidence only'));
  assert.equal($('location-fields').hidden, true); assert.equal(requests.length, 0);
  const location = document.querySelector('input[name="review-mode"][value="location"]'); location.checked = true; await location.fire('change');
  assert.equal(draft.latitude, null, 'enabling location mode does not adopt a submitted point');
  await $('use-submitted-point').fire('click');
  assert.equal(draft.latitude, 41.470289); assert.equal(draft.longitude, -81.6755); assert.equal(app.state.dirty.has(1), true); assert.equal(requests.length, 0);
  assert.ok($('linked-scope').textContent.includes('658, 654, 653, 657'), 'all linked frames are visible before a shared site change');
});

test('untrusted issue HTML and unsafe source URLs remain inert', () => {
  const { $, document } = make();
  assert.ok($('submission-body').textContent.includes('<script>unsafe()</script>'));
  assert.equal($('submission-body').querySelectorAll('script').length, 0);
  assert.equal($('submission-body').querySelectorAll('img').length, 0);
  assert.equal($('submitted-sources').querySelectorAll('a').length, 2);
  assert.ok(document.querySelectorAll('a').every(a => !a.href.startsWith('javascript:')));
  assert.ok(document.querySelectorAll('#submitted-sources a').every(a => a.rel === 'noopener noreferrer'));
  assert.equal($('submitted-attachments').querySelectorAll('img').length, 0, 'remote attachments do not load automatically');
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'https://user:pass@example.org', 'https://example.org/\nfoo', 'file:///tmp/data']) assert.equal(ui.safeUrl(url), null);
});

test('saved local drafts and unsaved edits survive selection and refresh', async () => {
  const second = { ...copy(ISSUE), number: 2, createdAt: '2026-10-19T00:00:00Z', fields: { ...copy(ISSUE.fields), location: 'Other comparison', frame: 667, place: 'new' } };
  const { app, data } = make({ issues: [copy(ISSUE), second] }); app.selectIssue(1);
  app.setDraftField('privateNote', 'Keep this unfinished comparison private.'); app.setDraftField('publicNote', 'A public note still being drafted.');
  app.selectIssue(2); app.setDraftField('publicNote', 'The second submission needs further evidence.'); app.selectIssue(1);
  assert.equal(app.state.drafts.get(1).privateNote, 'Keep this unfinished comparison private.');
  data.drafts['1'] = { ...ui.defaultDraft(ISSUE, [SITE]), publicNote: 'Older stored note' };
  await app.refreshIssues();
  assert.equal(app.state.drafts.get(1).publicNote, 'A public note still being drafted.'); assert.ok(app.state.dirty.has(1)); assert.ok(app.state.dirty.has(2));
  await app.saveDraft(); assert.equal(data.drafts['1'].privateNote, 'Keep this unfinished comparison private.'); assert.equal(app.state.dirty.has(1), false); assert.equal(app.state.dirty.has(2), true);
});

test('edits made while a save is running are not overwritten by its older response', async () => {
  const { app, handlers } = make(), pending = deferred();
  app.setDraftField('publicNote', 'Initial assessment, saved before the following edit.');
  handlers.set('/api/drafts/1', () => pending.promise);
  const saving = app.saveDraft(); app.setDraftField('publicNote', 'Newer assessment typed while the save was in flight.');
  pending.resolve({ draft: { ...ui.defaultDraft(ISSUE, [SITE]), publicNote: 'Initial assessment, saved before the following edit.' } }); await saving;
  assert.equal(app.state.drafts.get(1).publicNote, 'Newer assessment typed while the save was in flight.'); assert.equal(app.state.dirty.has(1), true);
});

test('changed public submissions require acknowledging the displayed version before preview', async () => {
  const { app, data, $, requests } = make(); approvedEvidence(app); const oldTimestamp = app.state.drafts.get(1).baseIssueUpdatedAt;
  data.issues[0].updatedAt = '2026-10-18T17:00:00Z'; data.issues[0].body = 'New contributor evidence.';
  await app.refreshIssues(); assert.equal(app.state.drafts.get(1).baseIssueUpdatedAt, oldTimestamp); assert.equal($('issue-version-warning').hidden, false);
  await app.previewReview(); assert.ok($('review-error').textContent.includes('submission has changed')); assert.ok(!requests.some(request => request.url === '/api/preview/1'));
  await $('issue-version-warning').querySelector('button').fire('click'); assert.equal(app.state.drafts.get(1).baseIssueUpdatedAt, data.issues[0].updatedAt);
});

test('draft saving and previewing never publish; preview uses the saved exact draft and all diff values', async () => {
  const { app, handlers, requests, $ } = make({ connection: { connected: true, canPublish: true, login: 'owner' } });
  approvedEvidence(app); app.setDraftField('privateNote', 'PRIVATE NEVER PUBLISH THIS'); const preview = mockPreview(); preview.changes.push({ field: 'coordinate', before: null, after: [-81.6755, 41.470289] });
  handlers.set('/api/preview/1', () => preview);
  await app.previewReview();
  assert.deepEqual(requests.map(request => request.url), ['/api/drafts/1', '/api/preview/1']); assert.ok(requests.every(request => request.headers['X-Review-Token'] === 'csrf-secret'));
  assert.equal(app.state.dirty.has(1), false); assert.equal($('preview-dialog').open, true); assert.equal($('publish-button').disabled, false);
  assert.ok($('preview-body').textContent.includes('41.470289')); assert.ok(!$('preview-body').textContent.includes('PRIVATE NEVER PUBLISH THIS'));
  assert.deepEqual(JSON.parse(requests[1].body), {}); assert.equal(requests.some(request => request.url.includes('/publish/')), false);
});

test('token is cleared before authentication request; authenticated preview is regenerated, never auto-published', async () => {
  const { app, handlers, requests, $ } = make(); approvedEvidence(app); handlers.set('/api/preview/1', () => mockPreview()); await app.previewReview();
  assert.equal($('publish-button').disabled, true); assert.equal($('preview-connect').hidden, false);
  await $('preview-connect').fire('click'); assert.equal($('connection-dialog').open, true); assert.equal($('preview-dialog').open, false);
  $('session-token').value = 'test-session-token';
  handlers.set('/api/connection', options => { assert.equal($('session-token').value, '', 'password field is empty before networking begins'); assert.deepEqual(JSON.parse(options.body), { mode: 'token', token: 'test-session-token' }); return { connection: { connected: true, canPublish: true, login: 'owner', mode: 'token' } }; });
  await app.connect('token');
  assert.equal($('session-token').value, ''); assert.equal($('connection-dialog').open, false); assert.equal($('preview-dialog').open, true);
  assert.equal(requests.filter(request => request.url === '/api/preview/1').length, 2, 'the read-only preview is not reused after connection');
  assert.equal(requests.filter(request => request.url.includes('/publish/')).length, 0);
  assert.ok(!JSON.stringify([...app.state.drafts]).includes('test-session-token')); assert.ok(!JSON.stringify(app.state.connection).includes('test-session-token'));
});

test('only the publish action commits; label-sync failure is displayed as a successful commit with retry', async () => {
  const { app, handlers, requests, $, data } = make({ connection: { connected: true, canPublish: true, login: 'owner' } }); approvedEvidence(app); handlers.set('/api/preview/1', () => mockPreview()); await app.previewReview();
  const record = { id: 'review-1', issueNumber: 1, decision: 'approved', publicNote: app.state.drafts.get(1).publicNote, commitSha: 'abcdef012345', commitUrl: 'https://github.com/hgw3lls/uptight/commit/abcdef012345', issueUrl: ISSUE.url, publishedAt: '2026-10-18T18:00:00Z', issueSynced: false };
  const result = { published: true, commitSha: record.commitSha, commitUrl: record.commitUrl, issueUrl: ISSUE.url, issueSynced: false, warning: 'GitHub label update timed out.', record };
  handlers.set('/api/publish/1', options => { assert.deepEqual(JSON.parse(options.body), { previewId: 'preview-1' }); data.history = [record]; return result; });
  await app.publishReview(); assert.equal(requests.filter(request => request.url === '/api/publish/1').length, 1);
  assert.ok($('preview-body').textContent.includes('Your review is in the repository.')); assert.ok($('preview-body').textContent.includes('status sync pending')); assert.ok($('preview-body').textContent.includes('Pages may still be building'));
  assert.equal($('publish-button').hidden, true); assert.equal(app.state.history.length, 1); assert.ok($('history-list').textContent.includes('Status sync pending'));
  handlers.set('/api/sync-issue/1', () => ({ ...result, issueSynced: true, record: { ...record, issueSynced: true } })); await $('preview-body').querySelector('button').fire('click');
  assert.equal(requests.filter(request => request.url === '/api/publish/1').length, 1); assert.ok($('preview-body').textContent.includes('has also been synchronized')); assert.equal(app.state.history[0].issueSynced, true);
});

test('ambiguous publication disables the stale action and requires reconciliation through a fresh preview', async () => {
  const { app, handlers, requests, $ } = make({ connection: { connected: true, canPublish: true, login: 'owner' } }); approvedEvidence(app); handlers.set('/api/preview/1', () => mockPreview()); await app.previewReview();
  handlers.set('/api/publish/1', () => fail('Publication is unconfirmed. Preview again to reconcile the existing commit.', 'PUBLICATION_AMBIGUOUS'));
  await app.publishReview(); assert.equal(app.state.preview, null); assert.equal($('publish-button').disabled, true); assert.equal($('refresh-preview').hidden, false);
  assert.ok($('preview-error').textContent.includes('unconfirmed')); await app.publishReview(); assert.equal(requests.filter(request => request.url === '/api/publish/1').length, 1);
  handlers.set('/api/preview/1', () => fail('The earlier publication is now verified. Refresh to see history.', 'ALREADY_PUBLISHED'));
  await app.previewReview(); assert.ok($('preview-body').textContent.includes('Refresh desk & inspect history')); assert.equal($('publish-button').disabled, true);
});

test('bounded decimal coordinates and required confidence block accidental location publication', async () => {
  const { app, requests, $ } = make(); approvedEvidence(app); app.setDraftField('mode', 'location'); app.setDraftField('latitude', '40.7128'); app.setDraftField('longitude', '-74.006');
  await app.previewReview(); assert.ok($('review-error').textContent.includes('inside the research area')); assert.equal(requests.length, 0);
  app.setDraftField('latitude', '41e0'); app.setDraftField('longitude', '-81.6755'); assert.equal(await app.saveDraft(), false); assert.ok($('review-error').textContent.includes('coordinate format'));
  assert.equal(ui.withinBounds([-81.6755, 41.470289]), true); assert.equal(ui.withinBounds([-74.006, 40.7128]), false); assert.equal(ui.numberInput('−81.6755').value, -81.6755); assert.equal(ui.numberInput('41e0').valid, false);
});

test('inbox search and local-state filters operate on frame, location, unsaved and publication status', () => {
  const draft = ui.defaultDraft(ISSUE, [SITE]), drafts = new Map([[1, draft]]), dirty = new Set([1]);
  assert.equal(ui.filterIssues([ISSUE], '658 Clark', 'all', drafts, [], dirty).length, 1);
  assert.equal(ui.filterIssues([ISSUE], 'Detroit', 'all', drafts, [], dirty).length, 0);
  assert.equal(ui.filterIssues([ISSUE], '', 'unsaved', drafts, [], dirty).length, 1);
  assert.equal(ui.filterIssues([ISSUE], '', 'approved', drafts, [], dirty).length, 0);
  draft.decision = 'approved'; assert.equal(ui.filterIssues([ISSUE], '', 'approved', drafts, [], dirty).length, 1);
  assert.equal(ui.filterIssues([ISSUE], '', 'published', drafts, [{ issueNumber: 1, decision: 'approved', publicNote: '' }], new Set()).length, 1);
});

test('panels retain scrolling; map wheel capture and document-level map arrow keys are absent', () => {
  assert.match(css, /\.scroll-region\{[^}]*overscroll-behavior:contain/);
  assert.match(source, /\.filter\(event => this\.exploring && !this\.picking && event\.type !== 'wheel'/);
  assert.match(source, /this\.root\.call\(this\.zoom\)/);
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage|innerHTML|outerHTML|insertAdjacentHTML|eval\s*\()/);
  const { app, document, $ } = make(); $('public-note').focus();
  return document.fire('keydown', { target: $('public-note'), key: 'ArrowRight' }).then(event => { assert.equal(event.defaultPrevented, false); assert.equal(app.state.frame, 658); });
});

test('saving a changed point never labels that draft Published because an older review has the same note', async () => {
  const draft = { ...ui.defaultDraft(ISSUE, [SITE]), decision: 'approved', mode: 'location', latitude: 41.470289, longitude: -81.6755, publicNote: 'The proposed area is a candidate; further positional evidence is needed.' };
  const record = { id: 'old-review', issueNumber: 1, decision: 'approved', mode: 'location', publicNote: draft.publicNote, changes: [{ field: 'sites.third.coord', before: null, after: [-81.6755, 41.470289] }], publishedAt: '2026-10-18T18:00:00Z', issueSynced: true };
  const { app, $ } = make({ drafts: { '1': draft }, history: [record] });
  app.setDraftField('latitude', 41.48); await app.saveDraft();
  assert.equal(app.state.dirty.has(1), false); assert.equal(ui.effectiveStatus(ISSUE, app.state.drafts.get(1)), 'approved');
  assert.ok($('issue-list').textContent.includes('Local: Approved')); assert.ok($('issue-list').textContent.includes('Published review on record'));
  assert.equal($('save-status').textContent, 'Saved on this computer');
});

test('a fresh install shows remote review status separately from the neutral local draft', () => {
  const issue = { ...copy(ISSUE), remoteStatus: 'incorporated' }, { app, $ } = make({ issues: [issue] });
  assert.equal(app.state.drafts.get(1).decision, 'pending', 'opening the desk makes no new local approval');
  assert.ok($('issue-list').textContent.includes('Public: Incorporated'));
  assert.equal(ui.filterIssues([issue], '', 'pending', app.state.drafts, [], new Set()).length, 0);
});

test('partial or cached discussion warnings remain visible', async () => {
  const { app, handlers, $ } = make();
  handlers.set('/api/issues/1', () => ({ issue: copy(ISSUE), comments: [{ body: 'Cached discussion body', author: 'Reader' }], warning: 'Only cached discussion is available; GitHub is offline.' }));
  app.selectIssue(1); await flush();
  assert.ok($('comments-status').textContent.includes('GitHub is offline')); assert.ok($('issue-comments').textContent.includes('Cached discussion body'));
});

test('a failed replacement connection clears the previous account and invalidates its preview', async () => {
  const { app, handlers, $ } = make({ connection: { connected: true, canPublish: true, login: 'old-owner' } });
  app.state.preview = mockPreview(); $('session-token').value = 'invalid-replacement-token';
  handlers.set('/api/connection', () => fail('The new token was rejected.', 'NOT_CONNECTED', 401));
  await app.connect('token');
  assert.equal(app.state.connection.connected, false); assert.equal(app.state.connection.canPublish, false); assert.equal(app.state.preview, null); assert.equal($('session-token').value, '');
  assert.equal($('connection-label').textContent, 'Connect to publish'); assert.ok($('connection-error').textContent.includes('rejected'));
});

test('an older refresh cannot replace a newer draft after its successful save has cleared dirty', async () => {
  const { app, handlers, data, $ } = make();
  app.setDraftField('publicNote', 'Assessment A saved before the refresh.'); await app.saveDraft();
  const oldSnapshot = copy(data), pending = deferred(); handlers.set('/api/refresh', () => pending.promise);
  const refreshing = app.refreshIssues();
  app.setDraftField('publicNote', 'Assessment B is the newer saved review.'); await app.saveDraft();
  assert.equal(app.state.dirty.has(1), false);
  pending.resolve(oldSnapshot); await refreshing;
  assert.equal(data.drafts['1'].publicNote, 'Assessment B is the newer saved review.');
  assert.equal(app.state.drafts.get(1).publicNote, data.drafts['1'].publicNote);
  assert.equal(app.state.saved.get(1).publicNote, data.drafts['1'].publicNote);
  assert.equal($('public-note').value, data.drafts['1'].publicNote); assert.equal(app.state.dirty.has(1), false);
});

test('delayed refresh snapshots cannot restore an account after reconnect or disconnect', async () => {
  const { app, handlers, data, $ } = make({ connection: { connected: true, canPublish: true, login: 'owner-A' } });
  let pending = deferred(), snapshot = copy(data); handlers.set('/api/refresh', () => pending.promise);
  const refreshing = app.refreshIssues(); $('session-token').value = 'new-session-token';
  handlers.set('/api/connection', () => ({ connection: { connected: true, canPublish: true, login: 'owner-B', mode: 'token' } }));
  await app.connect('token'); pending.resolve(snapshot); await refreshing;
  assert.equal(app.state.connection.login, 'owner-B'); assert.equal($('connection-label').textContent, 'owner-B');
  pending = deferred(); const laterRefresh = app.refreshIssues();
  handlers.set('/api/disconnect', () => ({ connection: { connected: false, canPublish: false, mode: 'public' } }));
  await app.disconnect(); pending.resolve(snapshot); await laterRefresh;
  assert.equal(app.state.connection.connected, false); assert.equal($('connection-label').textContent, 'Connect to publish');
});

test('beforeunload guards only unsaved edits or an active publication', () => {
  const { app, listeners } = make(); const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  let e = event(); listeners.get('beforeunload')(e); assert.equal(e.prevented, false);
  app.setDraftField('privateNote', 'Unsaved local text'); e = event(); listeners.get('beforeunload')(e); assert.equal(e.prevented, true);
});

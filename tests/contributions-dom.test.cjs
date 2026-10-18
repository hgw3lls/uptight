const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../assets/contributions.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'contribute.html'), 'utf8');

// This is a deliberately small DOM simulation, not a rendering browser. It
// verifies wiring and text-only rendering without installing a browser or
// starting a preview server in the managed Sites environment.
function fixture() {
  const nodes = new Map(), created = [];
  const doc = { activeElement: null, getElementById: id => nodes.get(id) || null };
  class Element {
    constructor(tag, id) { this.tagName = tag.toUpperCase(); this.id = id || ''; this.dataset = {}; this.attributes = {}; this.children = []; this.listeners = {}; this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; }
    set innerHTML(_) { throw new Error('HTML parsing is forbidden in contribution rendering'); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    removeAttribute(k) { delete this.attributes[k]; if (k === 'src') this.src = ''; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll(selector) { return selector === '[aria-invalid]' ? [...nodes.values()].filter(node => node.attributes['aria-invalid']) : []; }
    focus() { doc.activeElement = this; }
    scrollIntoView() {}
    select() { this.selected = true; }
    remove() {}
    click() { if (this.listeners.click) return this.listeners.click({ preventDefault() {} }); }
  }
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const node = new Element(match[1], match[2]);
    node.hidden = /\shidden(?:\s|>)/.test(match[0]);
    node.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
    nodes.set(match[2], node);
  }
  doc.createElement = tag => { const node = new Element(tag); created.push(node); return node; };
  doc.body = new Element('body');
  const win = { location: { search: '?place=madison&frame=63&question=madison-full-facade' },
    navigator: { onLine: true, clipboard: { writeText: async () => {} } }, UPTIGHT_EMAIL: null };
  return { doc, win, nodes, created };
}
async function settle() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }
const reply = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

test('DOM handoff keeps drafts unsent, carries selected context and renders untrusted issue titles as text', async () => {
  const f = fixture(), calls = [], savedFetch = global.fetch;
  const attack = '<img src=x onerror="window.injected=true">';
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === './data/review-decisions.json') return reply({ schemaVersion: 1, decisions: [{
      issueNumber: 7, issueUrl: 'https://github.com/hgw3lls/uptight/issues/7', reviewedAt: '2026-10-18T01:00:00Z',
      decision: 'disputed', mode: 'evidence', publicNote: attack, sourceLinks: ['javascript:alert(1)', 'https://example.org/archive']
    }] });
    return url === './data/map-data.json' ? reply({ sites: [{ id: 'madison', name: 'Madison Square Building', confidenceLabel: 'Probable / high confidence' }] })
      : reply([{ number: 7, title: attack, body: 'UPTIGHT-EVIDENCE-V1', html_url: 'https://github.com/hgw3lls/uptight/issues/7',
        labels: [{ name: 'evidence:disputed' }], user: { login: '<script>visitor</script>' }, state: 'closed', updated_at: '2026-10-18T00:00:00Z' }]);
  };
  try {
    api.init(f.doc, f.win); await settle();
    const get = id => f.nodes.get(id);
    assert.equal(get('form-fields').disabled, false);
    assert.equal(get('frame').value, '63'); assert.equal(get('place').value, 'madison');
    assert.equal(get('question').value, 'madison-full-facade');
    assert.equal(get('frame-preview').src, './media/frames/00000063.jpg');
    assert.match(get('feed-status').textContent, /1 public evidence record retrieved/);
    assert.ok(f.created.some(node => node.tagName === 'A' && node.textContent === attack));
    assert.ok(f.created.some(node => node.tagName === 'P' && node.className === 'review-note' && node.textContent === attack));
    assert.equal(f.created.some(node => node.href && node.href.startsWith('javascript:')), false);
    assert.equal(f.created.some(node => node.tagName === 'IMG' || node.tagName === 'SCRIPT'), false);
    assert.equal(get('email-send').hidden, true);
    let prevented = false;
    get('evidence-form').listeners.submit({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(get('prepared').hidden, true);
    assert.equal(get('form-error').hidden, false);
    get('explanation').value = 'The white corner blocks and central arch match the dated photograph. ' + attack;
    get('source-date').value = '1964'; get('attribution').value = 'Cleveland Public Library';
    get('source-links').value = 'https://example.org/?a=1&b=2';
    get('evidence-form').listeners.submit({ preventDefault() {} });
    assert.equal(get('prepared').hidden, false);
    const url = new URL(get('github-open').href);
    assert.equal(url.searchParams.get('frame'), '63');
    assert.equal(url.searchParams.get('evidence'), get('explanation').value);
    assert.ok(get('draft-text').value.includes('Not submitted'));
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => !call.options.method || call.options.method === 'GET'));
    get('evidence-form').listeners.input();
    assert.equal(get('prepared').hidden, true, 'Editing invalidates the previously prepared outgoing link');
    get('explanation').value = 'A'.repeat(10000);
    get('evidence-form').listeners.submit({ preventDefault() {} });
    const shortUrl = new URL(get('github-open').href);
    assert.equal(shortUrl.searchParams.get('frame'), '63');
    assert.equal(shortUrl.searchParams.has('evidence'), false);
    assert.match(get('long-draft').textContent, /too long.*Copy or download/s);
    assert.match(get('long-draft').textContent, /paste your evidence, source date, attribution, links and proposed address\/map point/);
    assert.ok(get('draft-text').value.includes('A'.repeat(10000)), 'Long drafts are preserved rather than silently truncated');
  } finally { global.fetch = savedFetch; }
});

test('DOM error and offline states do not claim zero contributions or a successful public check', async () => {
  const f = fixture(), savedFetch = global.fetch;
  f.win.navigator.onLine = false;
  global.fetch = async () => { throw new TypeError('offline fixture'); };
  try {
    api.init(f.doc, f.win); await settle();
    assert.equal(f.nodes.get('feed-status').dataset.state, 'offline');
    assert.equal(f.nodes.get('feed-updated').textContent, '');
    assert.equal(f.nodes.get('feed-list').children.length, 0);
    assert.doesNotMatch(f.nodes.get('feed-status').textContent, /No public evidence|retrieved/);
    assert.equal(f.nodes.get('form-fields').disabled, false, 'Drafting remains available when map context cannot load');
    assert.equal(f.nodes.get('frame').value, '63');
    assert.equal(f.nodes.get('context-warning').hidden, false);
  } finally { global.fetch = savedFetch; }
});

test('stalled location requests and response bodies release the form with the supplied draft intact', async () => {
  const savedFetch = global.fetch, savedSetTimeout = global.setTimeout, savedClearTimeout = global.clearTimeout;
  try {
    for (const phase of ['request', 'body']) {
      const f = fixture(), timers = [], cleared = [];
      f.win.navigator.onLine = false;
      f.win.location.search += '&note=Compare+the+corner+blocks&latitude=41.5&longitude=-81.6';
      let signal;
      global.setTimeout = (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; };
      global.clearTimeout = timer => cleared.push(timer);
      global.fetch = async (_, options) => {
        signal = options.signal;
        return phase === 'request' ? new Promise(() => {}) : { ok: true, json: () => new Promise(() => {}) };
      };
      api.init(f.doc, f.win); await settle();
      assert.equal(timers.length, 1, 'The location request has a bounded loading deadline');
      assert.ok(timers[0].delay > 0 && timers[0].delay <= 10000);
      timers[0].callback(); await settle();
      assert.equal(signal.aborted, true);
      assert.ok(cleared.includes(timers[0]));
      for (const id of ['form-fields', 'prepare-draft', 'download-draft']) assert.equal(f.nodes.get(id).disabled, false, phase + ': ' + id);
      assert.equal(f.nodes.get('frame').value, '63');
      assert.equal(f.nodes.get('question').value, 'madison-full-facade');
      assert.equal(f.nodes.get('explanation').value, 'Compare the corner blocks');
      assert.equal(f.nodes.get('latitude').value, '41.5');
      assert.equal(f.nodes.get('longitude').value, '-81.6');
      assert.equal(f.nodes.get('place').value, '', 'An unavailable location index cannot establish a match');
      assert.equal(f.nodes.get('context-warning').hidden, false);
    }
  } finally { global.fetch = savedFetch; global.setTimeout = savedSetTimeout; global.clearTimeout = savedClearTimeout; }
});

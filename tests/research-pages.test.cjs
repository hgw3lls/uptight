// Deterministic DOM harness: no browser, network requests, or third-party packages.
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const base = path.resolve(__dirname, '..') + path.sep;
const script = fs.readFileSync(base + 'assets/research.js', 'utf8');
const evidence = JSON.parse(fs.readFileSync(base + 'data/evidence-cases.json', 'utf8'));
const questions = JSON.parse(fs.readFileSync(base + 'data/research-questions.json', 'utf8'));
const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

function environment(page, hash = '', overrides = {}) {
  const ids = new Map(), all = [], observers = [], windowEvents = new Map();
  let document;
  class Node {
    constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {}; this.style = {}; this.dataset = {}; this.hidden = false; this._text = ''; this.clientWidth = 560; this.clientHeight = 420; this.naturalWidth = 0; this.naturalHeight = 0; all.push(this); }
    set id(value) { this._id = value; ids.set(value, this); }
    get id() { return this._id || ''; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    get firstElementChild() { return this.children.find(child => child.tagName !== '#text') || null; }
    get isConnected() { return true; }
    appendChild(child) { if (child.tagName === '#fragment') { [...child.children].forEach(node => this.appendChild(node)); child.children = []; } else { child.parentNode = this; this.children.push(child); } return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    fire(name, extra = {}) { (this.handlers[name] || []).forEach(fn => fn({target: this, ...extra})); }
    focus() { document.activeElement = this; }
    scrollIntoView() { this.scrolled = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
  }
  const html = fs.readFileSync(base + (page === 'evidence' ? 'evidence.html' : 'research-board.html'), 'utf8');
  for (const match of html.matchAll(/<([a-z0-9-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Node(match[1]); node.id = match[2]; node.hidden = /\bhidden\b/.test(match[0]);
  }
  document = {baseURI: 'https://hgw3lls.github.io/uptight/' + (page === 'evidence' ? 'evidence.html' : 'research-board.html'), body: {dataset: {page}}, activeElement: null, getElementById: id => ids.get(id), createElement: tag => new Node(tag), createDocumentFragment: () => new Node('#fragment'), createTextNode: text => {const n = new Node('#text'); n.textContent = text; return n;}};
  const window = {location: {hash}, addEventListener: (name, fn) => {if (!windowEvents.has(name)) windowEvents.set(name, []); windowEvents.get(name).push(fn);}, removeEventListener: (name, fn) => {windowEvents.set(name, (windowEvents.get(name) || []).filter(item => item !== fn));}, open: () => {}};
  let fail = Boolean(overrides.fail);
  let hangFetch = Boolean(overrides.hangFetch), hangBody = Boolean(overrides.hangBody);
  const context = vm.createContext({document, window, URL, URLSearchParams, console, AbortController, setTimeout: overrides.fastTimers ? (fn, ms) => setTimeout(fn, Math.min(ms, 10)) : setTimeout, clearTimeout, ResizeObserver: class {constructor(fn) {this.fn = fn; observers.push(this);} observe(node) {this.node = node;} disconnect() {this.disconnected = true;}}, fetch: async path => { if (fail) throw new Error('Offline fixture'); if (hangFetch) return new Promise(() => {}); return {ok: true, json: async () => {if (hangBody) return new Promise(() => {}); return structuredClone(path.includes('evidence') ? overrides.evidence || evidence : questions);}}; }});
  vm.runInContext(script, context);
  return {ids, all, observers, window, document, api: window.UptightResearch, setFailure(value) {fail = value;}, setHang(value) {hangFetch = value === 'fetch'; hangBody = value === 'body';}, changeHash(value) {window.location.hash = value; (windowEvents.get('hashchange') || []).forEach(fn => fn());}};
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const findClass = (node, className) => descendants(node).find(item => (item.className || '').split(' ').includes(className));

test('Evidence navigation, image details, annotations, safe links, and retry states', {timeout: 5000}, async () => {
  const e = environment('evidence', '#case=clark'); await settle();
  assert.equal(e.ids.get('error-state').hidden, true);
  assert.equal(e.ids.get('evidence-content').hidden, false);
  assert.match(e.ids.get('case-title').textContent, /Clark/);
  assert.match(e.ids.get('film-panel').textContent, /Frame 658/);
  assert.match(e.ids.get('reference-panel').textContent, /1984/);
  assert.equal(e.ids.get('case-nav').children.length, 4);
  assert.deepEqual(e.ids.get('case-nav').children.map(node => node.dataset.case), ['eagle', 'madison', 'clark', 'carter']);
  assert.equal(e.ids.get('case-nav').children.filter(node => node.getAttribute('aria-current') === 'true').length, 1);
  assert.equal(e.ids.get('case-pagination').children[1].textContent, '03 / 04');
  const nextCase = e.ids.get('case-pagination').children[2];
  assert.equal(nextCase.href, '#case=carter');
  assert.equal(nextCase.textContent, 'Carter Road →');
  e.changeHash(nextCase.href);
  assert.match(e.ids.get('case-title').textContent, /Carter/);
  assert.equal(e.ids.get('case-status').textContent, 'Strong visual identification');
  assert.match(e.ids.get('film-panel').textContent, /Frame 639/);
  assert.match(e.ids.get('film-panel').textContent, /01:39:27\.628/);
  assert.match(e.ids.get('reference-panel').textContent, /July 1986|1986-07/);
  assert.equal(e.ids.get('case-actions').children[0].href, './contribute.html?place=carter&frame=639');
  assert.equal(e.ids.get('case-pagination').children[0].href, '#case=clark');
  assert.equal(e.ids.get('case-pagination').children[1].textContent, '04 / 04');
  assert.equal(e.ids.get('case-pagination').children[2].href, './research-board.html');
  const missingCarter = structuredClone(evidence); missingCarter.cases = missingCarter.cases.filter(item => item.id !== 'carter');
  assert.throws(() => e.api.validateEvidence(missingCarter), /4 comparison records/);
  e.changeHash('#case=madison');
  assert.match(e.ids.get('case-title').textContent, /Madison/);
  const madisonReferences = evidence.cases.find(item => item.id === 'madison').references;
  assert.equal(e.ids.get('reference-selectors').children.length, madisonReferences.length);
  e.ids.get('reference-selectors').children[madisonReferences.findIndex(item => item.archiveId === 'H-020.jpg')].fire('click');
  assert.match(e.ids.get('reference-panel').textContent, /August 11, 1972/);
  e.ids.get('reference-selectors').children[madisonReferences.findIndex(item => item.archiveId.includes('p4014coll24/325'))].fire('click');
  assert.match(e.ids.get('reference-panel').textContent, /1921 \(revised 1924\)/);
  assert.match(e.ids.get('reference-panel').textContent, /7812.*7828/);
  assert.match(e.ids.get('film-panel').textContent, /Frame 63/);
  e.changeHash('#case=eagle');
  e.ids.get('film-selectors').children[1].fire('click');
  assert.match(e.ids.get('film-panel').textContent, /Frame 638/);
  assert.match(e.ids.get('case-actions').children[0].href, /place=eagle&frame=638/);
  e.ids.get('film-selectors').children[0].fire('click');
  const film = e.ids.get('film-panel').firstElementChild;
  const photo = descendants(film).find(node => node.tagName === 'img');
  photo.naturalWidth = 480; photo.naturalHeight = 270; photo.fire('load');
  e.ids.get('toggle-annotations').fire('click');
  const layer = findClass(film, 'annotation-layer');
  assert.equal(layer.hidden, false);
  assert.equal(layer.style.width, '560px');
  assert.equal(layer.style.height, '315px');
  assert.equal(layer.style.top, '52.5px');
  assert.equal(layer.style.left, '0px');
  assert.equal(layer.children.length, evidence.cases.find(item => item.id === 'eagle').frames[0].annotations.length);
  const stage = findClass(film, 'image-stage'); stage.clientWidth = 400; stage.clientHeight = 300;
  e.observers.find(observer => observer.node === stage).fn();
  assert.equal(layer.style.height, '225px');
  assert.equal(layer.style.top, '37.5px');
  const ref = e.ids.get('reference-panel').firstElementChild;
  const refPhoto = descendants(ref).find(node => node.tagName === 'img');
  refPhoto.naturalWidth = 571; refPhoto.naturalHeight = 599; refPhoto.fire('load');
  const refLayer = findClass(ref, 'annotation-layer');
  assert.equal(refLayer.style.top, '0px');
  assert(Math.abs(parseFloat(refLayer.style.height) - 420) < 1e-8);
  assert(Math.abs(parseFloat(refLayer.style.left) - (560 - 571 * 420 / 599) / 2) < 1e-8);
  const enlarge = findClass(ref, 'image-open'); enlarge.fire('click');
  assert.equal(e.ids.get('image-dialog').open, true);
  assert.equal(e.ids.get('open-original').href, evidence.cases[0].references[0].originalImageUrl);
  e.ids.get('toggle-image-size').fire('click');
  assert.equal(e.ids.get('dialog-stage').dataset.size, 'original');
  e.ids.get('close-dialog').fire('click');
  assert.equal(e.ids.get('image-dialog').open, false);
  assert.equal(e.document.activeElement, enlarge);
  assert.equal(e.api.safeUrl('javascript:alert(1)', true), null);
  assert.equal(e.api.safeUrl('data:text/html,test', true), null);
  assert.equal(e.api.validFrame(null), false);
  assert.equal(e.api.validFrame(true), false);
  assert.equal(e.api.frameUrl(0), null);
  assert.equal(e.api.frameUrl(683), null);
  assert.equal(e.api.frameUrl(682), './#shot=682');
  assert.equal(e.api.containedImageRect(0, 100, 100, 100), null);
  assert.deepEqual(JSON.parse(JSON.stringify(e.api.containedImageRect(480, 270, 400, 300))), {left:0,top:37.5,width:400,height:225});
  const linked = descendants(e.ids.get('case-sources')).filter(node => node.tagName === 'a');
  assert(linked.some(node => node.href.endsWith('/data/location-review.json')));
  assert(linked.every(node => node.target === '_blank' && node.rel === 'noopener noreferrer'));
  const noImage = structuredClone(evidence); noImage.cases[0].references[0].src = null;
  const linkedOnly = environment('evidence', '#case=eagle', {evidence:noImage}); await settle();
  assert.equal(linkedOnly.ids.get('error-state').hidden, true);
  assert.match(linkedOnly.ids.get('reference-panel').textContent, /not reproduced here/);
  const failed = environment('evidence', '', {fail:true}); await settle();
  assert.equal(failed.ids.get('error-state').hidden, false);
  failed.setFailure(false); failed.ids.get('retry-button').fire('click'); await settle();
  assert.equal(failed.ids.get('error-state').hidden, true);
  assert.equal(failed.ids.get('evidence-content').hidden, false);
});

test('Stalled fetch and JSON body requests time out and allow retry', {timeout: 5000}, async () => {
  const e = environment('evidence'); await settle();
  e.setHang('fetch');
  await assert.rejects(e.api.fetchJsonWithTimeout('data/evidence-cases.json', 10), /timed out/);
  e.setHang('body');
  await assert.rejects(e.api.fetchJsonWithTimeout('data/evidence-cases.json', 10), /timed out/);
  e.setHang(null);
  const stalled = environment('evidence', '', {hangBody:true, fastTimers:true});
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(stalled.ids.get('error-state').hidden, false);
  assert.equal(stalled.ids.get('main').getAttribute('aria-busy'), 'false');
  stalled.setHang(null); stalled.ids.get('retry-button').fire('click'); await settle();
  assert.equal(stalled.ids.get('error-state').hidden, true);
  assert.equal(stalled.ids.get('evidence-content').hidden, false);

});

test('Research board preserves five ranked questions, contribution context, and unassigned shots', {timeout: 5000}, async () => {
  const b = environment('research-board', '#east86-wadepark-shot'); await settle();
  assert.equal(b.ids.get('error-state').hidden, true);
  assert.equal(b.ids.get('question-list').children.length, 5);
  const cards = b.ids.get('question-list').children;
  assert.deepEqual(cards.map(card => card.id), questions.questions.map(question => question.id));
  const ctas = cards.map(card => descendants(card).find(node => node.tagName === 'a' && node.href && node.href.startsWith('./contribute.html')));
  assert.equal(ctas[0].href, './contribute.html?place=madison&frame=63&question=madison-full-facade');
  assert.equal(ctas[1].href, './contribute.html?place=third&frame=658&question=clark-road-level');
  assert.equal(ctas[2].href, './contribute.html?place=leader&frame=151&question=leader-kronheim-adjacency');
  assert.equal(ctas[3].href, './contribute.html?frame=413&question=colonial-blood-bank-frontage');
  assert.equal(ctas[4].href, './contribute.html?question=east86-wadepark-shot');
  assert.match(cards[4].textContent, /No individual frame is assigned/);
  assert.equal(descendants(cards[4]).filter(node => node.href && node.href.startsWith('./#shot=')).length, 0);
  assert.equal(cards[4].scrolled, true);
  assert.match(cards[1].textContent, /Michael A. Fuerst’s 1984 demolition photograph/);
  const invalid = structuredClone(questions); invalid.questions[4].frameId = 313;
  assert.throws(() => b.api.validateQuestions(invalid), /unassigned/);
  const tooMany = structuredClone(questions); tooMany.questions.push({...tooMany.questions[0]});
  assert.throws(() => b.api.validateQuestions(tooMany), /Five research questions/);
});

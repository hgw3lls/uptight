const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const logic = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/map-data.json'), 'utf8'));
const film = JSON.parse(fs.readFileSync(path.join(root, 'data/film-frames.json'), 'utf8'));
const review = JSON.parse(fs.readFileSync(path.join(root, 'data/location-review.json'), 'utf8'));

function make() {
  const navigations = [], requests = [], storage = new Map();
  const location = {hash: '', href: 'https://hgw3lls.github.io/uptight/', assign: url => navigations.push(url)};
  class DCLogic {
    constructor() { this.props = {}; }
    setState(value, done) {
      this.state = {...this.state, ...(typeof value === 'function' ? value(this.state) : value)};
      if (done) done();
    }
  }
  const context = vm.createContext({
    DCLogic, React: {createRef: () => ({current: null}), createElement: (type, props, ...children) => ({type, props, children})},
    window: {location}, location, URLSearchParams, FormData,
    localStorage: {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value)},
    fetch: async (url, options) => {requests.push({url, options}); return {ok: true, json: async () => ({})};},
    setTimeout, clearTimeout, console, navigator: {}, document: {activeElement: null}
  });
  vm.runInContext(logic + '\nglobalThis.TestComponent = Component;', context);
  const c = new context.TestComponent();
  c.state = {...c.state, data, film, review, api: 'local', size: {w: 1440, h: 900}};
  c.screen = () => [500, 200];
  c.proj = () => [500, 200];
  c.focusSel = () => {};
  return {c, navigations, requests, storage};
}

test('every selected location still is preserved in the evidence draft link', () => {
  const {c} = make();
  assert.equal(typeof c.contributionUrl, 'function', 'the map needs a frame-aware contribution link');
  for (const site of data.sites) {
    site.frames.forEach((frame, index) => {
      c.state.sel = site.id;
      c.state.frame = index;
      const url = new URL(c.contributionUrl(), 'https://hgw3lls.github.io/uptight/');
      assert.equal(url.pathname, '/uptight/contribute.html');
      assert.equal(url.searchParams.get('place'), site.id);
      assert.equal(url.searchParams.get('frame'), String(frame.id));
    });
  }
});

test('an unresolved film still does not inherit the selected map location', () => {
  const {c} = make();
  c.state.sel = 'eagle';
  c.state.shot = film.frames.findIndex(([id]) => id === 413);
  const values = c.renderVals();
  assert.ok(values.shot.contributeUrl, 'all film stills need an evidence link');
  const url = new URL(values.shot.contributeUrl, 'https://hgw3lls.github.io/uptight/');
  assert.equal(url.searchParams.get('frame'), '413');
  assert.equal(url.searchParams.has('place'), false);
});

test('public map evidence opens an editable draft without sending or claiming review', () => {
  const {c, navigations, requests} = make();
  c.state.sel = 'eagle';
  c.state.frame = 1;
  c.openDrawer('clue', {text: 'Check the north tower & adjacent railing.', links: 'https://example.org/photo?a=1&b=2'});
  assert.equal(navigations.length, 1, 'continue to the public evidence form');
  const url = new URL(navigations[0], 'https://hgw3lls.github.io/uptight/');
  assert.equal(url.searchParams.get('frame'), '638');
  assert.equal(url.searchParams.get('note'), 'Check the north tower & adjacent railing.');
  assert.equal(url.searchParams.get('links'), 'https://example.org/photo?a=1&b=2');
  assert.equal(c.state.drawer, null);
  assert.equal(requests.length, 0);
  assert.equal(c.state.held.eagle, undefined);
});

test('a proposed map point travels as an unverified proposal with the selected still', () => {
  const {c, navigations} = make();
  c.state.sel = 'third';
  c.state.frame = 1;
  c.state.placing = 'third';
  c.proj.invert = () => [-81.6823456, 41.4723456];
  c.wrapRef.current = {getBoundingClientRect: () => ({left: 0, top: 0})};
  c.renderVals().onMapClick({clientX: 40, clientY: 80});
  assert.equal(navigations.length, 1);
  const url = new URL(navigations[0], 'https://hgw3lls.github.io/uptight/');
  assert.equal(url.searchParams.get('place'), 'third');
  assert.equal(url.searchParams.get('frame'), String(data.sites.find(site => site.id === 'third').frames[1].id));
  assert.equal(url.searchParams.get('latitude'), '41.472346');
  assert.equal(url.searchParams.get('longitude'), '-81.682346');
  assert.equal(url.searchParams.get('kind'), 'location');
  assert.equal(data.sites.find(site => site.id === 'third').coord, null);
});

test('saving a camera direction keeps it a local draft and opens supporting evidence', () => {
  const {c, navigations, requests, storage} = make();
  c.state.sel = 'eagle';
  c.state.frame = 1;
  c.state.camEdit = {id: 'eagle', b: 90};
  c.renderVals().cam.submit();
  assert.equal(navigations.length, 1);
  assert.equal(requests.length, 0);
  assert.equal(JSON.parse(storage.get('uptight-mock-bearings')).eagle, 90);
  assert.equal(c.renderVals().cam.tag, 'LOCAL DRAFT');
  assert.doesNotMatch(c.renderVals().conf.note, /in review/i);
  const url = new URL(navigations[0], 'https://hgw3lls.github.io/uptight/');
  assert.equal(url.searchParams.get('frame'), '638');
  assert.match(url.searchParams.get('note'), /90° E/);
  assert.match(url.searchParams.get('note'), /unverified/i);
});

test('published owner reviews are visible without converting approval into identification confidence', () => {
  const {c} = make();
  c.state.data = JSON.parse(JSON.stringify(data));
  c.state.sel = 'third';
  const site = c.state.data.sites.find(item => item.id === 'third');
  const before = {coord: site.coord, status: site.status, confidence: site.confidenceLabel};
  site.reviewedContributions = [
    {issueNumber: 1, issueUrl: 'javascript:alert(1)', reviewDate: '2026-10-18', decision: 'approved', mode: 'evidence', publicNote: 'Historical source accepted; precise camera position remains unresolved.'},
    {issueNumber: 2, reviewDate: '2026-10-19', decision: 'disputed', mode: 'location', publicNote: 'This is not an approved map update.'},
    {issueNumber: '3oops', decision: 'approved', publicNote: 'Invalid issue number'},
    {issueNumber: 4, decision: 'approved', publicNote: ''}
  ];
  const selected = c.renderVals().sel;
  assert.equal(selected.hasReviews, true);
  assert.equal(selected.reviews.length, 1);
  assert.equal(selected.reviews[0].url, 'https://github.com/hgw3lls/uptight/issues/1');
  assert.equal(selected.reviews[0].note, site.reviewedContributions[0].publicNote);
  assert.match(selected.reviews[0].label, /2026-10-18.*evidence/);
  assert.deepEqual({coord: site.coord, status: site.status, confidence: site.confidenceLabel}, before);
  assert.equal(site.coord, null);
});

test('optional local-server uploads retain the actual selected frame', async () => {
  const {c, requests} = make();
  const site = data.sites.find(item => item.id === 'eagle');
  c.state.sel = site.id;
  c.state.frame = 1;
  c.state.api = 'live';
  c.fetchSite = () => {};
  await c.apiContribute(site, {kind: 'clue', body: 'Tower detail visible in this selected still.'}, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.body.get('frame'), '638');
});

test('published website information replaces the primary location text while text-only edits keep the pin', () => {
  const {c} = make();
  c.state.data = JSON.parse(JSON.stringify(data));
  c.state.sel = 'third';
  const site = c.state.data.sites.find(item => item.id === 'third');
  const original = {coord: site.coord, status: site.status, confidence: site.confidenceLabel};
  Object.assign(site, {name: 'Reviewed location name', address: 'Reviewed location area',
    connection: 'New information accepted from the submitted source.\n\nA second paragraph remains distinct.',
    history: 'Revised historical context based on the dated archive record.'});
  site.reviewedContributions = [{issueNumber: 1, reviewDate: '2026-10-18', decision: 'approved',
    mode: 'content', updatePin: false, publicNote: 'Published the approved website information.'}];
  const selected = c.renderVals().sel;
  for (const field of ['name', 'address', 'connection', 'history']) assert.equal(selected[field], site[field]);
  assert.match(selected.reviews[0].label, /website information/);
  assert.doesNotMatch(selected.reviews[0].label, /\+ pin/);
  assert.deepEqual({coord: site.coord, status: site.status, confidence: site.confidenceLabel}, original);
  site.reviewedContributions[0].updatePin = true;
  assert.match(c.renderVals().sel.reviews[0].label, /website information \+ pin/);
});

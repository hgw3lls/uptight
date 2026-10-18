// Exercise the map component's actual search and contribution transitions.
// A VM supplies browser dependencies; this is not a visual layout test.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(process.env.UPTIGHT_MAP_HTML || path.join(root, 'index.html'), 'utf8');
const logic = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const navigationScript = fs.readFileSync(path.join(root, 'assets/map-navigation.js'), 'utf8');
const mapText = fs.readFileSync(path.join(root, 'data/map-data.json'), 'utf8');
const film = JSON.parse(fs.readFileSync(path.join(root, 'data/film-frames.json'), 'utf8'));
const review = JSON.parse(fs.readFileSync(path.join(root, 'data/location-review.json'), 'utf8'));
const POINT = [-81.681121, 41.472714];
const RESULT = { id: 'osm:W524120662', label: 'Flat Iron Cafe, 1114 Center Street, Cleveland, Ohio', coord: [-81.701799, 41.4943246] };
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const event = () => ({ preventDefault() {}, stopPropagation() {}, target: { closest: () => null } });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function method(c, name) { assert.equal(typeof c[name], 'function', `the map exposes ${name}`); return c[name].bind(c); }

function make() {
  const navigations = [], requests = [], zooms = [], focused = [], storage = new Map();
  const data = JSON.parse(mapText);
  const location = { hash: '', href: 'https://hgw3lls.github.io/uptight/', assign: url => navigations.push(url) };
  class DCLogic {
    constructor() { this.props = {}; }
    setState(value, done) { this.state = { ...this.state, ...(typeof value === 'function' ? value(this.state) : value) }; if (done) done(); }
  }
  const window = { location }, document = { activeElement: null };
  const context = vm.createContext({
    DCLogic, React: { createRef: () => ({ current: null }), createElement: (type, props, ...children) => ({ type, props, children }) },
    window, location, URL, URLSearchParams, FormData, AbortController,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, json: async () => ({ type: 'FeatureCollection', features: [] }) }; },
    setTimeout, clearTimeout, console, navigator: {}, document,
  });
  vm.runInContext(navigationScript, context);
  vm.runInContext(logic + '\nglobalThis.TestComponent = Component;', context);
  const c = new context.TestComponent();
  c.state = { ...c.state, data, film, review, api: 'local', size: { w: 1440, h: 900 }, sel: 'third', frame: 1 };
  c.proj = ([lon, lat]) => [(lon + 82) * 1000, (42 - lat) * 1000];
  c.proj.invert = () => POINT.slice();
  c.screen = coord => c.proj(coord);
  c.zoomTo = (...args) => zooms.push(args);
  c.focusSel = () => {};
  c.wrapRef.current = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const input = { tagName: 'INPUT', focus(options) { document.activeElement = this; focused.push({ target: 'input', options }); c.renderVals().find.focus(); } };
  const preview = { tagName: 'SECTION', focus(options) { document.activeElement = this; focused.push({ target: 'preview', options }); } };
  c.searchRef.current = input;
  if (c.searchPreviewRef) c.searchPreviewRef.current = preview;
  const selectedFrame = () => data.sites.find(site => site.id === c.state.sel).frames[c.state.frame].id;
  return { c, data, context, navigations, requests, zooms, focused, input, preview, document, storage, selectedFrame };
}

test('submitting coordinates only previews a pin and preserves the selected still', async () => {
  const { c, data, navigations, requests, zooms, selectedFrame } = make();
  const before = JSON.stringify(data), frame = selectedFrame(), selection = c.state.sel, index = c.state.frame;
  let find = c.renderVals().find;
  assert.ok(find && typeof find.change === 'function' && typeof find.submit === 'function', 'the search form has bound change and submit actions');
  find.change({ target: { value: '41.472714, -81.681121' } });
  assert.equal(c.state.searchQuery, '41.472714, -81.681121');
  assert.equal(requests.length, 0, 'typing performs no address lookup');
  find = c.renderVals().find;
  await find.submit(event()); await flush();
  assert.deepEqual(plain(c.state.searchTarget.coord), POINT);
  assert.ok(zooms.length, 'a coordinate preview centers the map');
  assert.deepEqual(plain(zooms.at(-1).slice(0, 2)), c.proj(POINT));
  assert.equal(c.state.sel, selection); assert.equal(c.state.frame, index);
  const pin = c.renderVals().searchPin;
  assert.ok(pin, 'the coordinate preview exposes its explicit pin actions');
  assert.equal(String(pin.frame), String(frame));
  assert.equal(c.state.proposal, null, 'navigation alone does not create a proposed filming location');
  assert.equal(navigations.length, 0, 'a coordinate search does not open the contribution form');
  assert.equal(requests.length, 0, 'coordinate navigation works without network requests');
  assert.equal(JSON.stringify(data), before, 'search does not mutate the location register');
});

test('choosing an address result centers a temporary pin without changing the film selection', () => {
  const { c, data, navigations, requests, zooms, selectedFrame } = make();
  const before = JSON.stringify(data), frame = selectedFrame();
  method(c, 'chooseSearchResult')(RESULT);
  assert.deepEqual(plain(c.state.searchTarget.coord), RESULT.coord);
  assert.equal(c.state.searchTarget.label, RESULT.label);
  assert.deepEqual(plain(zooms.at(-1).slice(0, 2)), c.proj(RESULT.coord));
  assert.equal(c.state.sel, 'third'); assert.equal(c.state.frame, 1);
  const pin = c.renderVals().searchPin;
  assert.ok(pin, 'the address preview exposes its explicit pin actions');
  assert.equal(String(pin.frame), String(frame));
  assert.equal(c.state.proposal, null); assert.equal(navigations.length, 0); assert.equal(requests.length, 0);
  assert.equal(JSON.stringify(data), before);
});

test('only explicit use of a search pin opens an evidence draft with its address and actual selected frame', () => {
  const { c, data, navigations, requests, selectedFrame } = make();
  const before = JSON.stringify(data), frame = selectedFrame();
  method(c, 'chooseSearchResult')(RESULT);
  const pin = c.renderVals().searchPin;
  assert.ok(pin && typeof pin.use === 'function', 'the preview offers an explicit use action');
  pin.use(event());
  assert.equal(navigations.length, 1);
  const url = new URL(navigations[0], 'https://hgw3lls.github.io/uptight/');
  assert.equal(url.pathname, '/uptight/contribute.html');
  assert.equal(url.searchParams.get('place'), 'third');
  assert.equal(url.searchParams.get('frame'), String(frame));
  assert.equal(url.searchParams.get('latitude'), RESULT.coord[1].toFixed(6));
  assert.equal(url.searchParams.get('longitude'), RESULT.coord[0].toFixed(6));
  assert.equal(url.searchParams.get('address'), RESULT.label);
  assert.equal(url.searchParams.get('kind'), 'location');
  assert.equal(requests.length, 0, 'using a pin opens a draft rather than sending evidence');
  assert.equal(JSON.stringify(data), before, 'a proposed point does not become a confirmed map site');
});

test('a map click outside the study area cannot change an existing proposal or open a draft', () => {
  const { c, data, navigations, requests } = make();
  const before = JSON.stringify(data);
  c.state.placing = 'third';
  c.state.proposal = { id: 'eagle', coord: [-81.699, 41.487] };
  const proposal = plain(c.state.proposal);
  c.proj.invert = () => [-74.006, 40.7128];
  c.renderVals().onMapClick({ ...event(), clientX: 40, clientY: 80 });
  assert.equal(navigations.length, 0, 'an out-of-bounds click is rejected locally');
  assert.equal(requests.length, 0);
  assert.deepEqual(plain(c.state.proposal), proposal);
  assert.equal(c.state.placing, 'third', 'the user can still choose a valid point');
  assert.equal(c.state.sel, 'third'); assert.equal(c.state.frame, 1);
  assert.equal(JSON.stringify(data), before);
});

test('typing cancels old work without requesting address results or creating a point', () => {
  const { c, navigations, requests } = make();
  let cancelled = 0;
  c.searchClient = { cancel: () => { cancelled++; }, search: () => assert.fail('typing must not invoke the address service') };
  method(c, 'updateSearchQuery')('1114 Center Street');
  assert.equal(c.state.searchQuery, '1114 Center Street');
  assert.ok(cancelled > 0, 'editing the query invalidates its old pending work');
  assert.equal(c.state.searchBusy, false);
  assert.equal(c.state.proposal, null); assert.equal(c.state.searchTarget, null);
  assert.equal(navigations.length, 0); assert.equal(requests.length, 0);
});

test('a late result from an older address query cannot replace the current results', async () => {
  const { c, navigations } = make();
  const older = deferred(), newer = deferred();
  c.searchClient = { cancel() {}, search: query => query === 'Older address' ? older.promise : newer.promise };
  method(c, 'updateSearchQuery')('Older address');
  const first = method(c, 'searchLocation')();
  c.updateSearchQuery('Newer address');
  const second = c.searchLocation();
  const latest = { ...RESULT, id: 'osm:W2', label: 'Newer address' };
  newer.resolve([latest]); await second; await flush();
  assert.equal(c.state.searchResults[0].label, 'Newer address');
  older.resolve([{ ...RESULT, id: 'osm:W1', label: 'Older address' }]); await first; await flush();
  assert.equal(c.state.searchQuery, 'Newer address');
  assert.equal(c.state.searchResults[0].label, 'Newer address');
  assert.equal(c.state.searchBusy, false); assert.equal(c.state.searchError, false);
  assert.equal(c.state.searchTarget, null, 'address results still need an explicit result choice');
  assert.equal(navigations.length, 0);
});

test('closing search cancels loading and a delayed response cannot reopen its result panel', async () => {
  const { c, navigations } = make();
  const delayed = deferred(); let cancelled = 0;
  c.searchClient = { cancel: () => { cancelled++; }, search: () => delayed.promise };
  method(c, 'updateSearchQuery')('Delayed address');
  const pending = method(c, 'searchLocation')();
  method(c, 'closeSearch')();
  assert.equal(c.state.searchOpen, false); assert.equal(c.state.searchBusy, false);
  assert.ok(cancelled > 0);
  delayed.resolve([RESULT]); await pending; await flush();
  assert.equal(c.state.searchOpen, false); assert.equal(c.state.searchBusy, false);
  assert.equal(c.state.searchTarget, null); assert.equal(c.state.searchResults.length, 0);
  assert.equal(navigations.length, 0);
});

test('choosing a keyboard result moves focus to the temporary pin when the result button disappears', async () => {
  const { c, focused, document, preview, navigations } = make();
  document.activeElement = { tagName: 'BUTTON' };
  method(c, 'chooseSearchResult')(RESULT); await flush();
  assert.ok(c.searchPreviewRef, 'the temporary pin has a focusable component reference');
  assert.ok(document.activeElement === preview, 'focus stays in the preview instead of falling back to global map shortcuts');
  assert.equal(focused.at(-1).target, 'preview');
  assert.equal(focused.at(-1).options.preventScroll, true);
  assert.equal(c.state.sel, 'third'); assert.equal(c.state.frame, 1);
  assert.equal(navigations.length, 0);
});

test('closing results or clearing a preview restores input focus without reopening the search popup', async () => {
  const { c, focused, document, input } = make();
  method(c, 'updateSearchQuery')('1114 Center Street');
  c.renderVals().find.close(event()); await flush();
  assert.ok(document.activeElement === input, 'closing results restores focus to the input');
  assert.equal(c.state.searchOpen, false, 'restored input focus must not reopen the closed popup');
  assert.equal(focused.at(-1).options.preventScroll, true);
  c.chooseSearchResult(RESULT); await flush();
  c.renderVals().searchPin.clear(event()); await flush();
  assert.equal(c.state.searchTarget, null);
  assert.ok(document.activeElement === input, 'clearing a preview restores a useful focus target');
  assert.equal(c.state.searchOpen, false);
  assert.equal(focused.at(-1).options.preventScroll, true);
});

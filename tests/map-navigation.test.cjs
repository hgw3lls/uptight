const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const script = path.join(__dirname, '..', 'assets', 'map-navigation.js');
const api = fs.existsSync(script) ? require(script) : {};
const BOUNDS = [-81.74, 41.43, -81.57, 41.56];
const POINT = [-81.681121, 41.472714];
function fn(name) { assert.equal(typeof api[name], 'function', `${name} implements bounded map navigation`); return api[name]; }
function feature(coord = POINT, properties = {}) {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: coord }, properties: {
    osm_type: 'N', osm_id: 100, name: 'Public landmark', street: 'Center Street', housenumber: '1114', city: 'Cleveland', state: 'Ohio', ...properties,
  } };
}
function response(features, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => ({ type: 'FeatureCollection', features }) }; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function clock() {
  let now = 10000, nextId = 0;
  const tasks = new Map();
  return {
    now: () => now,
    setTimeout: (run, delay) => { const id = ++nextId; tasks.set(id, { at: now + delay, run }); return id; },
    clearTimeout: id => tasks.delete(id),
    async tick(ms) {
      const until = now + ms;
      await flush();
      while (true) {
        const next = [...tasks].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        tasks.delete(next[0]); now = next[1].at; next[1].run(); await flush();
      }
      now = until; await flush();
    },
    pending: () => tasks.size,
  };
}
function client(fetch, extra = {}) { const time = clock(); return { time, search: fn('createSearchClient')({ fetch, ...time, ...extra }) }; }

test('decimal coordinates preserve precision and accept unambiguous Cleveland longitude-first input', () => {
  const parse = fn('parseCoordinates');
  assert.deepEqual(api.DEFAULT_BOUNDS, BOUNDS);
  for (const input of ['41.472714, -81.681121', ' 41.472714 -81.681121 ', '(41.472714, -81.681121)']) {
    const found = parse(input);
    assert.equal(found.kind, 'coordinate'); assert.deepEqual(found.coord, POINT); assert.equal(found.order, 'lat-lon');
  }
  const reversed = parse('-81.681121, 41.472714');
  assert.equal(reversed.kind, 'coordinate'); assert.deepEqual(reversed.coord, POINT); assert.equal(reversed.order, 'lon-lat');
  assert.match(reversed.label, /^41\.472714, -81\.681121$/);
});

test('addresses remain addresses while malformed or out-of-area coordinates cannot become a geocoder query', () => {
  const parse = fn('parseCoordinates');
  for (const input of ['1114 Center Street, Cleveland', 'Hough Avenue & East 79th Street', 'Cory United Methodist Church']) assert.equal(parse(input).kind, 'address', input);
  for (const input of ['41.5,', '41.5, -81x', '41.5, -81.6, 12', '41.5; -81.6', '41.5', '41°30′, -81°36′', 'NaN, -81.6', '4.15e1, -81.6', '41e0, -81.6', '5e1, -8.1e1']) {
    const found = parse(input); assert.equal(found.kind, 'invalid', input); assert.equal(found.reason, 'malformed', input);
  }
  for (const input of ['40.7128, -74.0060', '-74.0060, 40.7128', '41.6, -81.65', '95, -181']) {
    const found = parse(input); assert.equal(found.kind, 'invalid', input); assert.equal(found.reason, 'outside', input);
  }
  assert.equal(parse('  ').reason, 'empty');
});

test('search boundary is inclusive, configurable, and never coerces malformed points', () => {
  const within = fn('isWithinBounds');
  assert.equal(within([BOUNDS[0], BOUNDS[1]]), true);
  assert.equal(within([BOUNDS[2], BOUNDS[3]]), true);
  for (const point of [[-81.740001, 41.5], [-81.6, 41.560001], ['-81.6', '41.5'], [NaN, 41.5], null, [-81.6]]) assert.equal(within(point), false);
  assert.equal(within(POINT, [-82, 41, -81, 42]), true);
  assert.equal(within(POINT, [-81, 42, -82, 41]), false);
  assert.equal(api.parseCoordinates('41.7, -81.8', [-82, 41, -81, 42]).kind, 'coordinate');
});

test('coordinates resolve offline and invalid point input never calls the address service', async () => {
  const { search } = client(() => { assert.fail('Coordinate input must not contact a geocoder'); });
  const found = await search.search('41.472714, -81.681121');
  assert.deepEqual(found[0].coord, POINT); assert.equal(found.length, 1);
  for (const input of ['40.7, -74', '41.5, -81x', '']) await assert.rejects(search.search(input), error => error.name === 'ValidationError' && !!error.message);
});

test('address requests are server bounded and only valid in-area point results reach the map', async () => {
  let requested;
  const { time, search } = client(async (url, options) => {
    requested = { url: new URL(url), options };
    return response([feature(), feature(), feature([-74, 40.7]), feature(['-81.6', '41.5']), { ...feature(), geometry: { type: 'LineString', coordinates: [POINT, POINT] } }, feature([-81.62, 41.52], { osm_id: 101, name: 'Second landmark' })]);
  });
  const pending = search.search('1114 Center Street & Hough');
  await time.tick(150);
  const found = await pending;
  assert.equal(requested.url.origin, 'https://photon.komoot.io');
  assert.equal(requested.url.searchParams.get('q'), '1114 Center Street & Hough');
  assert.equal(requested.url.searchParams.get('bbox'), BOUNDS.join(','));
  assert.equal(requested.url.searchParams.get('limit'), '5');
  assert.equal(requested.url.searchParams.get('lang'), 'en');
  assert.equal(requested.options.credentials, 'omit');
  assert.equal(found.length, 2); assert.deepEqual(found[0].coord, POINT);
  assert.match(found[0].label, /1114 Center Street/); assert.match(found[0].label, /Cleveland/);
  assert.notEqual(found[0].id, found[1].id);
  assert.equal(time.pending(), 0, 'Completed requests release their timeout');
});

test('repeated submitted queries share in-flight work and reuse an isolated in-memory cache', async () => {
  let requests = 0;
  const { time, search } = client(async () => { requests++; return response([feature()]); });
  const first = search.search('1114 Center Street');
  const duplicate = search.search('  1114   center street  ');
  await time.tick(150);
  const [a, b] = await Promise.all([first, duplicate]);
  assert.equal(requests, 1); assert.deepEqual(a, b);
  a[0].coord[0] = 0;
  const cached = await search.search('1114 CENTER Street');
  assert.deepEqual(cached[0].coord, POINT); assert.equal(requests, 1);
  search.clearCache();
  const uncached = search.search('1114 Center Street');
  await time.tick(1000); await uncached;
  assert.equal(requests, 2);
});

test('rapid replacements debounce and subsequent network requests begin at least one second apart', async () => {
  const starts = [];
  const { time, search } = client(async url => { starts.push({ at: time.now(), q: new URL(url).searchParams.get('q') }); return response([feature()]); });
  const stale = search.search('Old query');
  const rejected = assert.rejects(stale, { name: 'AbortError' });
  await time.tick(50);
  const current = search.search('New query');
  await time.tick(149); assert.equal(starts.length, 0);
  await time.tick(1); await current; await rejected;
  assert.equal(starts[0].q, 'New query');
  const next = search.search('Third query');
  await time.tick(999); assert.equal(starts.length, 1);
  await time.tick(1); await next;
  assert.ok(starts[1].at - starts[0].at >= 1000);
});

test('cancel immediately settles scheduled or stalled requests and discards late responses', async () => {
  const body = deferred(); let requests = 0, signal;
  const { time, search } = client(async (_url, options) => { requests++; signal = options.signal; return { ok: true, status: 200, json: () => body.promise }; });
  const scheduled = search.search('Scheduled query');
  const scheduledRejected = assert.rejects(scheduled, { name: 'AbortError' });
  search.cancel(); await scheduledRejected; await time.tick(200); assert.equal(requests, 0);
  const pending = search.search('Stalled query');
  const pendingRejected = assert.rejects(pending, { name: 'AbortError' });
  await time.tick(150); assert.equal(requests, 1);
  search.cancel(); await pendingRejected;
  assert.equal(signal.aborted, true); assert.equal(time.pending(), 0);
  body.resolve({ features: [feature()] }); await flush();
  const again = search.search('Stalled query');
  await time.tick(1000); await again;
  assert.equal(requests, 2, 'A cancelled late result did not enter the cache');
});

test('a stale response cannot replace the latest query and entering coordinates cancels network work', async () => {
  const old = deferred(); let request = 0, oldSignal;
  const { time, search } = client((_url, options) => { request++; if (request === 1) { oldSignal = options.signal; return old.promise; } return Promise.resolve(response([feature([-81.62, 41.52], { name: 'Latest result' })])); });
  const first = search.search('First query'); const rejected = assert.rejects(first, { name: 'AbortError' });
  await time.tick(150);
  const second = search.search('Second query');
  await time.tick(1000);
  const latest = await second; await rejected;
  assert.equal(oldSignal.aborted, true); assert.deepEqual(latest[0].coord, [-81.62, 41.52]);
  old.resolve(response([feature()])); await flush();
  assert.deepEqual((await search.search('Second query'))[0].coord, [-81.62, 41.52]);
  const third = search.search('Third query'); const thirdRejected = assert.rejects(third, { name: 'AbortError' });
  const point = await search.search('41.472714, -81.681121');
  await thirdRejected; assert.deepEqual(point[0].coord, POINT);
});

test('bounded timeout covers a stalled fetch or response body while coordinates remain usable', async () => {
  for (const mode of ['fetch', 'body']) {
    let signal;
    const stalled = new Promise(() => {});
    const { time, search } = client((_url, options) => { signal = options.signal; return mode === 'fetch' ? stalled : Promise.resolve({ ok: true, status: 200, json: () => stalled }); }, { timeoutMs: 100 });
    const pending = search.search('Public landmark'); const rejected = assert.rejects(pending, error => error.name === 'TimeoutError' && /coordinates/i.test(error.message));
    await time.tick(150); await time.tick(100); await rejected;
    assert.equal(signal.aborted, true); assert.equal(time.pending(), 0);
    assert.deepEqual((await search.search('41.472714, -81.681121'))[0].coord, POINT);
  }
});

test('service, malformed response and network errors are distinct from a valid empty search', async () => {
  for (const mode of ['offline', 'malformed', 'busy', 'empty']) {
    const { time, search } = client(async () => {
      if (mode === 'offline') throw new TypeError('Failed to fetch');
      if (mode === 'malformed') return { ok: true, json: async () => ({ error: 'wrong schema' }) };
      return response([], mode === 'busy' ? 429 : 200);
    });
    const pending = search.search('Public landmark');
    const handled = mode === 'empty' ? pending : assert.rejects(pending, error => error.name !== 'AbortError' && /address|search/i.test(error.message));
    await time.tick(150);
    const result = await handled;
    if (mode === 'empty') assert.deepEqual(result, []);
    assert.equal(time.pending(), 0);
  }
});

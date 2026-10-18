const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const script = path.join(__dirname, '..', 'assets', 'contributions.js');
const api = fs.existsSync(script) ? require(script) : {};
const sites = [{ id: 'madison', name: 'Madison Square / Hough', frames: [{ id: 63, time: '00:06:29.431' }] }];
const validDraft = {
  place: 'madison', location: 'Madison Square / Hough', frame: '63',
  question: 'madison-full-facade', stance: 'supports',
  explanation: 'The arch, balconies & white blocks agree with the period photograph.',
  sourceDate: '1964-09-16', attribution: 'Cleveland Public Library; image 8730',
  links: 'https://example.org/photo?building=Madison&date=1964#detail', address: '7812–14 Hough Avenue',
  latitude: '', longitude: '',
};
function fn(name) { assert.equal(typeof api[name], 'function', `${name} must implement the contribution contract`); return api[name]; }
function response(body, options = {}) {
  return { ok: (options.status || 200) < 400, status: options.status || 200,
    headers: { get: key => key.toLowerCase() === 'link' ? options.link || null : null },
    json: async () => body };
}
function issue(overrides = {}) {
  return { number: 3, title: '[Location evidence] Frame 63', body: 'UPTIGHT-EVIDENCE-V1',
    html_url: 'https://github.com/hgw3lls/uptight/issues/3', state: 'open', labels: [],
    updated_at: '2026-10-17T22:00:00Z', user: { login: 'contributor' }, ...overrides };
}

test('query context preserves selected frame, question, links and proposed point without inventing a match', () => {
  const p = new URLSearchParams({ place: 'madison', frame: '63', question: 'madison-full-facade',
    kind: 'location', note: 'Facing west & above the arch', latitude: '41.5', longitude: '-81.6',
    links: 'https://example.org/?a=1&b=2', address: 'Hough / E79' });
  const result = fn('parseQuery')('?' + p, sites);
  assert.equal(result.frame, '63'); assert.equal(result.place, 'madison');
  assert.equal(result.stance, 'new-candidate'); assert.equal(result.note, 'Facing west & above the arch');
  assert.equal(result.longitude, '-81.6'); assert.equal(result.links, 'https://example.org/?a=1&b=2');
  assert.deepEqual(result.warnings, []);
  const area = api.parseQuery('?question=east86-wadepark-shot', sites);
  assert.equal(area.frame, ''); assert.equal(area.place, '');
  assert.equal(area.question, 'east86-wadepark-shot');
});

test('malformed context warns instead of accepting truncated frame IDs, unknown sites or half a point', () => {
  const parse = fn('parseQuery');
  for (const frame of ['0', '683', '63abc', '-1', '1.5', '1e2']) {
    const r = parse('?frame=' + encodeURIComponent(frame), sites);
    assert.equal(r.frame, ''); assert.ok(r.warnings.length);
  }
  const r = parse('?place=%3Cscript%3E&question=unknown&latitude=41.5&longitude=-81x', sites);
  assert.equal(r.place, ''); assert.equal(r.question, '');
  assert.equal(r.latitude, ''); assert.equal(r.longitude, '');
  assert.equal(r.warnings.length, 3);
});

test('draft validation rejects unsafe links, missing source context and invalid frame IDs', () => {
  const validate = fn('validateDraft');
  assert.equal(validate(validDraft).ok, true);
  for (const links of ['javascript:alert(1)', 'data:text/html,hello', 'ftp://example.org/photo', 'https://user:password@example.org/', 'https://example.org\nnot-a-url']) {
    const r = validate({ ...validDraft, links });
    assert.equal(r.ok, false, links); assert.ok(r.errors.links);
  }
  assert.equal(validate({ ...validDraft, frame: '684' }).ok, false);
  assert.equal(validate({ ...validDraft, sourceDate: '', attribution: '' }).ok, false);
  assert.equal(validate({ ...validDraft, frame: '', place: '', location: '', question: 'east86-wadepark-shot' }).ok, true);
  assert.equal(validate({ ...validDraft, frame: '', place: '', location: '', question: '', address: '' }).ok, false);
});

test('GitHub draft URL prefills canonical form fields with literal Unicode, ampersands and newlines', () => {
  const draft = { ...validDraft, explanation: 'Facade: “MADISON” & arch\nSee 1964 / 1972 comparison.', attribution: 'Archive / A&B <credit>' };
  const url = new URL(fn('buildIssueUrl')(draft));
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, '/hgw3lls/uptight/issues/new');
  assert.equal(url.searchParams.get('template'), 'location-evidence.yml');
  assert.equal(url.searchParams.get('frame'), '63');
  assert.equal(url.searchParams.get('evidence'), draft.explanation);
  assert.equal(url.searchParams.get('source-date'), draft.sourceDate);
  assert.equal(url.searchParams.get('attribution'), draft.attribution);
  assert.equal(url.searchParams.get('source-links'), draft.links);
  assert.ok(url.searchParams.get('context').includes('UPTIGHT-EVIDENCE-V1'));
  assert.ok(url.searchParams.get('context').includes('place: madison'));
  assert.equal(url.searchParams.has('labels'), false);
  assert.equal(url.searchParams.has('assignees'), false);
});

test('downloadable text keeps the full evidence and clearly says it has not been submitted', () => {
  const text = fn('buildDraftText')({ ...validDraft, explanation: 'A'.repeat(8000), latitude: '41.5', longitude: '-81.6' });
  assert.ok(text.includes('A'.repeat(8000)));
  assert.ok(text.includes('Not submitted'));
  assert.ok(text.includes('proposed') && text.includes('41.5') && text.includes('-81.6'));
  assert.ok(text.includes('Attach files on GitHub'));
});

test('compact handoff retains an unverified proposed point and the complete draft retains its address', () => {
  const draft = { ...validDraft, explanation: 'A'.repeat(10000), latitude: '41.472346', longitude: '-81.682346' };
  assert.ok(fn('buildIssueUrl')(draft).length > api.MAX_PREFILL_LENGTH);
  const url = new URL(api.buildIssueUrl(draft, true));
  assert.ok(url.href.length < api.MAX_PREFILL_LENGTH);
  assert.equal(url.searchParams.has('evidence'), false);
  assert.match(url.searchParams.get('proposed-location') || '', /unverified.*41\.472346.*-81\.682346/);
  assert.ok(fn('buildDraftText')(draft).includes(draft.address));
});

test('only explicit maintainer review labels set review outcome; closure never implies incorporation', () => {
  const status = fn('deriveIssueStatus');
  assert.equal(status(issue({ state: 'closed' })).key, 'received');
  assert.equal(status(issue({ state: 'closed' })).reviewed, false);
  for (const key of ['received', 'under-review', 'incorporated', 'disputed']) {
    assert.equal(status(issue({ labels: [{ name: 'evidence:' + key }] })).key, key);
  }
  assert.equal(status(issue({ labels: [{ name: 'evidence:incorporated' }, { name: 'evidence:disputed' }] })).key, 'conflicting');
  assert.equal(status(issue({ body: 'status: incorporated', labels: [{ name: 'random-incorporated-claim' }] })).key, 'received');
});

test('feed accepts evidence issues only and restricts all outgoing record links to this repository', () => {
  const normalise = fn('normaliseEvidenceIssue');
  assert.equal(normalise(issue()).number, 3);
  assert.equal(normalise(issue({ pull_request: {} })), null);
  assert.equal(normalise(issue({ title: 'A bug', body: 'Something else' })), null);
  assert.equal(normalise(issue({ html_url: 'javascript:alert(1)' })), null);
  assert.equal(normalise(issue({ html_url: 'https://github.com/other/repo/issues/3' })), null);
  assert.equal(normalise(issue({ number: '3x' })), null);
  assert.equal(normalise(issue({ title: '<img src=x onerror=alert(1)>', body: 'UPTIGHT-EVIDENCE-V1' })).title, '<img src=x onerror=alert(1)>');
});

test('successful empty public fetch is distinguished from failure and offline state', async () => {
  const fetchIssues = fn('fetchEvidenceIssues');
  const ok = await fetchIssues({ fetchImpl: async () => response([]) });
  assert.equal(ok.state, 'ok'); assert.deepEqual(ok.issues, []); assert.ok(ok.checkedAt);
  const failed = await fetchIssues({ fetchImpl: async () => response({ message: 'limit' }, { status: 403 }) });
  assert.equal(failed.state, 'error'); assert.equal(failed.checkedAt, null); assert.match(failed.message, /limit/i);
  const invalid = await fetchIssues({ fetchImpl: async () => response({ not: 'an issue list' }) });
  assert.equal(invalid.state, 'error'); assert.equal(invalid.checkedAt, null);
  const offline = await fetchIssues({ online: false, fetchImpl: async () => { throw Error('must not fetch'); } });
  assert.equal(offline.state, 'offline'); assert.equal(offline.checkedAt, null);
});

test('feed paginates to its explicit cap, makes read-only unauthenticated calls and marks partial failure', async () => {
  const fetchIssues = fn('fetchEvidenceIssues');
  const calls = [];
  const items = Array.from({ length: 100 }, (_, i) => issue({ number: i + 1, html_url: 'https://github.com/hgw3lls/uptight/issues/' + (i + 1) }));
  const result = await fetchIssues({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(items, { link: '<https://api.github.com/repos/hgw3lls/uptight/issues?page=3>; rel="next"' });
  } });
  assert.equal(calls.length, 2); assert.equal(result.truncated, true);
  assert.ok(calls.every(c => c.options.method === 'GET' && c.options.credentials === 'omit' && !('Authorization' in c.options.headers)));
  assert.equal(new URL(calls[0].url).searchParams.get('state'), 'all');
  assert.equal(new URL(calls[1].url).searchParams.get('page'), '2');
  let n = 0;
  const partial = await fetchIssues({ fetchImpl: async () => ++n === 1 ? response(items, { link: '<https://api.github.com/next>; rel="next"' }) : response({}, { status: 500 }) });
  assert.equal(partial.state, 'partial'); assert.equal(partial.issues.length, 100); assert.ok(partial.checkedAt);
});

test('email receipt requires explicit service success and sends only text fields, never attachments', async () => {
  const send = fn('sendEmailNote');
  const config = { endpoint: 'https://api.web3forms.com/submit', accessKey: 'test-fixture-only' };
  let sent;
  const result = await send(validDraft, config, async (_, options) => { sent = JSON.parse(options.body); return response({ success: true }); });
  assert.equal(result.accepted, true); assert.equal(sent.note, validDraft.explanation);
  assert.equal('attachments' in sent, false); assert.equal('attachments_not_sent' in sent, false);
  await assert.rejects(send(validDraft, config, async () => response({ success: false })), /not accept/i);
  await assert.rejects(send(validDraft, config, async () => response({})), /not accept/i);
  await assert.rejects(send(validDraft, { endpoint: 'http://example.org', accessKey: 'no' }, async () => response({ success: true })), /not configured/i);
});

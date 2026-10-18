(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.UptightMapNavigation = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // The search area and map context share [west, south, east, north] coordinates.
  const DEFAULT_BOUNDS = Object.freeze([-81.74, 41.43, -81.57, 41.56]);
  const DEFAULT_ENDPOINT = 'https://photon.komoot.io/api/';
  const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
  const PAIR = new RegExp('^(' + NUMBER + ')(?:\\s*,\\s*|\\s+)(' + NUMBER + ')$');
  const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ') : '';

  function validBounds(bounds) {
    return Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite) &&
      bounds[0] >= -180 && bounds[2] <= 180 && bounds[1] >= -90 && bounds[3] <= 90 &&
      bounds[0] < bounds[2] && bounds[1] < bounds[3];
  }

  function isWithinBounds(coord, bounds = DEFAULT_BOUNDS) {
    return validBounds(bounds) && Array.isArray(coord) && coord.length === 2 && coord.every(Number.isFinite) &&
      coord[0] >= bounds[0] && coord[0] <= bounds[2] && coord[1] >= bounds[1] && coord[1] <= bounds[3];
  }

  function coordinateLabel(coord) { return coord[1].toFixed(6) + ', ' + coord[0].toFixed(6); }

  function parseCoordinates(input, bounds = DEFAULT_BOUNDS) {
    const text = clean(input).replace(/\u2212/g, '-');
    if (!text) return { kind: 'invalid', reason: 'empty', message: 'Enter an address or decimal latitude, longitude.' };
    const bare = text.startsWith('(') && text.endsWith(')') ? text.slice(1, -1).trim() : text;
    const pair = bare.match(PAIR);
    if (pair) {
      const first = Number(pair[1]), second = Number(pair[2]);
      const latLon = [second, first], lonLat = [first, second];
      if (isWithinBounds(latLon, bounds)) return { kind: 'coordinate', coord: latLon, label: coordinateLabel(latLon), order: 'lat-lon' };
      if (isWithinBounds(lonLat, bounds)) return { kind: 'coordinate', coord: lonLat, label: coordinateLabel(lonLat), order: 'lon-lat' };
      return { kind: 'invalid', reason: 'outside', message: 'That point is outside the Cleveland study area. Choose a point within the map boundary.' };
    }
    // Numeric-looking input is an attempted point, including partial pairs and DMS.
    // Do not send it to an address service that might silently reinterpret it.
    const looksNumeric = /^[\s()+\-.,;\d]+$/.test(text) || /^[+\-]?(?:\d+\.\d*|\.\d+)/.test(text) ||
      /^[+\-]?\d+(?:\.\d*)?[eE][+\-]?\d+(?:\s|[,;]|$)/.test(text) ||
      /^[+\-]?\d+\s*[,;]\s*[+\-\d.]/.test(text) || /[°′″]/.test(text) || /^(?:NaN|[+\-]?Infinity)(?:\s|,|$)/i.test(text);
    if (looksNumeric) return { kind: 'invalid', reason: 'malformed', message: 'Enter decimal latitude, longitude, for example 41.500000, -81.680000.' };
    return { kind: 'address' };
  }

  function namedError(name, message, reason) {
    const error = new Error(message); error.name = name;
    if (reason) error.reason = reason;
    return error;
  }

  function copyResults(results) { return results.map(result => ({ ...result, coord: result.coord.slice() })); }

  function normalizeResults(data, bounds, limit) {
    if (!data || !Array.isArray(data.features)) throw namedError('ResponseError', 'The address service returned an unreadable search response. Try again or enter coordinates.');
    const results = [], seen = new Set();
    for (const feature of data.features) {
      if (!feature || !feature.geometry || feature.geometry.type !== 'Point' || !isWithinBounds(feature.geometry.coordinates, bounds)) continue;
      const coord = feature.geometry.coordinates.slice(), props = feature.properties || {};
      const street = [clean(props.housenumber), clean(props.street)].filter(Boolean).join(' ');
      const parts = [clean(props.name), street, clean(props.city || props.town || props.village || props.locality || props.district), clean(props.state), clean(props.postcode)].filter(Boolean);
      const label = (clean(props.label) || [...new Set(parts)].join(', ') || coordinateLabel(coord)).slice(0, 500);
      const key = coord.join(',') + '|' + label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const osmType = clean(props.osm_type).toUpperCase(), osmId = String(props.osm_id == null ? '' : props.osm_id);
      const id = /^[NWR]$/.test(osmType) && /^\d+$/.test(osmId) ? 'osm:' + osmType + osmId : 'point:' + key;
      results.push({ id, label, coord });
      if (results.length >= limit) break;
    }
    return results;
  }

  /**
   * Call search only on an explicit form submission, never on each keystroke.
   * Photon permits reasonable project use without an API key, may throttle, and
   * does not promise availability: https://github.com/komoot/photon#demo-server
   * API: https://github.com/komoot/photon/blob/master/docs/api-v1.md
   * Display Photon and © OpenStreetMap contributors attribution beside the UI.
   * These are present-day navigation results, not verified filming locations.
   */
  function createSearchClient(options = {}) {
    const bounds = (options.bounds || DEFAULT_BOUNDS).slice();
    if (!validBounds(bounds)) throw new RangeError('Map search needs valid [west, south, east, north] bounds.');
    const endpoint = options.endpoint || DEFAULT_ENDPOINT;
    const fetcher = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const now = options.now || Date.now;
    const schedule = options.setTimeout || setTimeout, unschedule = options.clearTimeout || clearTimeout;
    const debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 150;
    const minIntervalMs = Math.max(1000, Number(options.minIntervalMs) || 1000);
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || 8000);
    const limit = Math.min(10, Math.max(1, Math.floor(Number(options.limit) || 5)));
    const cache = new Map();
    let active = null, lastStarted = -Infinity;

    function cancel() {
      if (active) active.stop(namedError('AbortError', 'The address search was cancelled.'));
    }

    function search(input) {
      const query = clean(input), parsed = parseCoordinates(query, bounds), key = query.toLowerCase();
      if (parsed.kind === 'address' && active && active.key === key) return active.promise.then(copyResults);
      cancel();
      if (parsed.kind === 'invalid') return Promise.reject(namedError('ValidationError', parsed.message, parsed.reason));
      if (parsed.kind === 'coordinate') return Promise.resolve([{ id: 'coordinate:' + parsed.coord.join(','), label: parsed.label, coord: parsed.coord.slice() }]);
      if (query.length < 3 || query.length > 300) return Promise.reject(namedError('ValidationError', 'Enter an address or place name between 3 and 300 characters.', 'length'));
      if (cache.has(key)) return Promise.resolve(copyResults(cache.get(key)));
      if (typeof fetcher !== 'function') return Promise.reject(namedError('SearchError', 'Address search is unavailable. You can still enter latitude, longitude.'));

      let url;
      try {
        url = new URL(endpoint);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
      } catch (_) { return Promise.reject(namedError('SearchError', 'The address search service is not configured. You can still enter latitude, longitude.')); }
      url.searchParams.set('q', query);
      url.searchParams.set('bbox', bounds.join(','));
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('lang', 'en');

      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let resolve, reject, waiting = null, deadline = null, settled = false;
      const op = { key, promise: new Promise((yes, no) => { resolve = yes; reject = no; }) };
      function finish(error, results) {
        if (settled) return;
        settled = true;
        if (waiting !== null) unschedule(waiting);
        if (deadline !== null) unschedule(deadline);
        if (active === op) active = null;
        if (error) reject(error); else resolve(results);
      }
      op.stop = error => { finish(error); if (controller) controller.abort(); };
      active = op;
      waiting = schedule(() => {
        waiting = null;
        if (settled) return;
        lastStarted = now();
        deadline = schedule(() => op.stop(namedError('TimeoutError', 'Address search took too long. Try again or enter coordinates.')), timeoutMs);
        Promise.resolve().then(() => fetcher(url.toString(), {
          method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin',
          ...(controller ? { signal: controller.signal } : {}),
        })).then(response => {
          if (settled) return null;
          if (!response || !response.ok) throw namedError('ServiceError', response && response.status === 429 ?
            'Address search is busy. Wait a moment and try again, or enter coordinates.' : 'The address service is unavailable. Try again or enter coordinates.');
          if (typeof response.json !== 'function') throw namedError('ResponseError', 'The address service returned an unreadable search response. Try again or enter coordinates.');
          return response.json();
        }).then(data => {
          if (settled) return;
          const results = normalizeResults(data, bounds, limit);
          cache.set(key, copyResults(results));
          if (cache.size > 100) cache.delete(cache.keys().next().value);
          finish(null, results);
        }).catch(error => {
          if (settled) return;
          if (error && /^(ServiceError|ResponseError)$/.test(error.name)) finish(error);
          else finish(namedError('SearchError', 'Address search could not be reached. Check your connection or enter coordinates.'));
        });
      }, Math.max(debounceMs, lastStarted + minIntervalMs - now()));
      return op.promise;
    }

    return { search, cancel, clearCache: () => cache.clear() };
  }

  return { DEFAULT_BOUNDS, DEFAULT_ENDPOINT, parseCoordinates, isWithinBounds, createSearchClient };
});

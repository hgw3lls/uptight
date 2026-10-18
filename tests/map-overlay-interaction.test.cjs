// Exercise the map's actual D3 behavior with a small event-bubbling DOM.
// This verifies event routing and transforms; it is not a browser layout test.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(process.env.UPTIGHT_MAP_HTML || path.join(root, 'index.html'), 'utf8');
const logic = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const d3Script = fs.readFileSync(path.join(root, 'lib/d3.min.js'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/map-data.json'), 'utf8'));
const film = JSON.parse(fs.readFileSync(path.join(root, 'data/film-frames.json'), 'utf8'));

function openingTag(tag, attribute, value) {
  const found = [...html.matchAll(new RegExp('<' + tag + '\\b[^>]*>', 'g'))]
    .find(match => match[0].includes(attribute + '="' + value + '"'));
  assert.ok(found, 'the map template contains ' + value);
  return found[0];
}

function environment(t) {
  const timers = new Set(), intervals = new Set(), selected = [], observed = [];
  let document;
  class Element {
    constructor(tag, markup = '') {
      this.tagName = tag.toUpperCase(); this.nodeName = this.tagName;
      this.markup = markup;
      this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = new Map();
      this.clientWidth = 1440; this.clientHeight = 900; this.clientLeft = 0; this.clientTop = 0;
      this.scrollTop = 0; this.scrollHeight = 1800;
      const styles = {};
      this.style = {setProperty: (key, value) => {styles[key] = value;}, getPropertyValue: key => styles[key] || '', removeProperty: key => {delete styles[key];}};
      for (const match of markup.matchAll(/([\w:-]+)="([^"]*)"/g)) this.setAttribute(match[1], match[2]);
      this.ownerDocument = document;
    }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    setAttribute(name, value) {
      name = name.toLowerCase(); this.attributes[name] = String(value);
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = String(value);
      if (name === 'style') for (const declaration of value.split(';')) { const index = declaration.indexOf(':'); if (index >= 0) this.style.setProperty(declaration.slice(0, index).trim(), declaration.slice(index + 1).trim()); }
    }
    getAttribute(name) { return this.attributes[name.toLowerCase()] ?? null; }
    hasAttribute(name) { return this.getAttribute(name) != null; }
    get isContentEditable() { const value = this.getAttribute('contenteditable'); return value == null ? Boolean(this.parentNode && this.parentNode.isContentEditable) : value !== 'false'; }
    matches(selector) {
      return selector.split(',').some(part => {
        part = part.trim();
        const excluded = part.match(/:not\(([^)]+)\)/);
        if (excluded) { if (this.matches(excluded[1])) return false; part = part.replace(excluded[0], ''); }
        const tag = part.match(/^[a-z][\w-]*/i);
        if (tag && this.tagName !== tag[0].toUpperCase()) return false;
        const attrs = [...part.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)];
        if (attrs.some(match => !this.hasAttribute(match[1]) || (match[2] != null && this.getAttribute(match[1]) !== match[2]))) return false;
        return Boolean(tag || attrs.length);
      });
    }
    closest(selector) { for (let current = this; current; current = current.parentNode) if (current.matches && current.matches(selector)) return current; return null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    querySelector(selector) { for (const child of this.children) { if (child.matches(selector)) return child; const match = child.querySelector(selector); if (match) return match; } return null; }
    addEventListener(type, listener, options) { const list = this.listeners.get(type) || []; list.push({listener, options}); this.listeners.set(type, list); }
    removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.listener !== listener)); }
    getBoundingClientRect() { return {left: 0, top: 0, width: this.clientWidth, height: this.clientHeight}; }
    focus() { document.activeElement = this; }
  }
  class SVGElement extends Element {
    constructor(markup) { super('svg', markup); this.width = {baseVal: {value: 1440}}; this.height = {baseVal: {value: 900}}; this.viewBox = {baseVal: {x: 0, y: 0, width: 1440, height: 900}}; }
  }
  document = {activeElement: null};
  const page = new Element('div');
  const wrap = page.appendChild(new Element('main', openingTag('main', 'ref', '{{ wrapRef }}')));
  const surface = wrap.appendChild(new SVGElement(openingTag('svg', 'ref', '{{ svgRef }}')));
  const detail = wrap.appendChild(new Element('section', openingTag('section', 'aria-label', 'Selected scene')));
  const sheetHandle = detail.appendChild(new Element('button', openingTag('button', 'onClick', '{{ toggleSheet }}')));
  const paragraph = detail.appendChild(new Element('p'));
  const detailButton = detail.appendChild(new Element('button'));
  const tray = wrap.appendChild(new Element('section', openingTag('section', 'aria-label', 'Unplaced scenes')));
  const trayButton = tray.appendChild(new Element('button'));
  const viewer = wrap.appendChild(new Element('div', openingTag('div', 'aria-label', 'Film frame viewer')));
  const viewerParagraph = viewer.appendChild(new Element('p'));
  const pin = wrap.appendChild(new Element('button', '<button data-pin="1">'));
  const drawer = page.appendChild(new Element('aside', openingTag('aside', 'aria-label', 'Add evidence')));
  const window = new Element('window');
  const location = {hash: '', href: 'https://hgw3lls.github.io/uptight/', assign() {}};
  window.location = location;
  window.document = document;
  document.defaultView = window; document.documentElement = page; document.body = page;
  const later = (fn, delay) => { const id = setTimeout(() => {timers.delete(id); fn();}, delay); timers.add(id); return id; };
  const cancel = id => {timers.delete(id); clearTimeout(id);};
  class DCLogic {
    constructor() { this.props = {}; }
    setState(value, callback) { this.state = {...this.state, ...(typeof value === 'function' ? value(this.state) : value)}; if (callback) callback(); }
  }
  const context = vm.createContext({
    window, document, location, SVGElement, DCLogic, URLSearchParams, URL, console,
    React: {createRef: () => ({current: null}), createElement: (type, props, ...children) => ({type, props, children})},
    navigator: {maxTouchPoints: 1}, localStorage: {getItem: () => null, setItem() {}},
    ResizeObserver: class {constructor(callback) {this.callback = callback;} observe(node) {observed.push(node);} disconnect() {}},
    fetch: async url => ({ok: true, json: async () => String(url).includes('film-frames') ? film : {}, text: async () => 'frame_id,location\n'}),
    setTimeout: later, clearTimeout: cancel, setInterval: (fn, delay) => {const id = setInterval(fn, delay); intervals.add(id); return id;}, clearInterval: id => {intervals.delete(id); clearInterval(id);},
    requestAnimationFrame: callback => later(callback, 0)
  });
  vm.runInContext(d3Script, context);
  window.d3 = context.d3;
  // Run transitions synchronously while retaining the real D3 transform methods.
  const realSelect = context.d3.select;
  context.d3.select = node => {
    selected.push(node);
    const selection = realSelect(node);
    selection.transition = () => {
      const transition = {duration: () => transition, call: (fn, ...args) => {fn(selection, ...args); return transition;}};
      return transition;
    };
    return selection;
  };
  vm.runInContext(logic + '\nglobalThis.TestComponent = Component;', context);
  const c = new context.TestComponent();
  c.state = {...c.state, data, film, api: 'local', size: {w: 1440, h: 900}};
  c.wrapRef.current = wrap; c.svgRef.current = surface; c.rootRef.current = page;
  c.load = () => {}; c.drawBase = () => {}; c.screen = () => [650, 300];
  c.proj = () => [650, 300]; c.proj.invert = () => [-81.685, 41.49];
  c.componentDidMount();
  // Invoke touch callbacks from their real template bindings, wherever they live.
  for (const node of [detail, sheetHandle]) {
    for (const match of node.markup.matchAll(/on(TouchStart|TouchMove|TouchEnd|TouchCancel)="\{\{\s*(\w+)\s*\}\}"/g)) {
      node.addEventListener(match[1].toLowerCase(), event => c.renderVals()[match[2]](event));
    }
  }
  t.after(() => { for (const id of timers) clearTimeout(id); for (const id of intervals) clearInterval(id); c.componentWillUnmount(); });

  function fire(type, target, extra = {}) {
    const event = {type, target, currentTarget: target, view: window, clientX: 650, clientY: 300, ctrlKey: false, metaKey: false, altKey: false, button: 0, deltaY: -120, deltaMode: 0, defaultPrevented: false,
      preventDefault() {this.defaultPrevented = true;}, stopPropagation() {this.stopped = true;}, stopImmediatePropagation() {this.stopped = this.immediate = true;}, ...extra};
    for (let node = target; node; node = node.parentNode) {
      event.currentTarget = node;
      for (const {listener} of node.listeners.get(type) || []) {listener.call(node, event); if (event.immediate) break;}
      if (event.stopped) break;
    }
    return event;
  }
  function key(target, value, extra = {}) {
    document.activeElement = target;
    const event = {key: value, target, defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}, ...extra};
    c.onKey(event); return event;
  }
  return {c, context, page, wrap, surface, detail, sheetHandle, paragraph, detailButton, tray, trayButton, viewer, viewerParagraph, pin, drawer, selected, observed, fire, key, Element};
}

function projectMap(e, width = 1440, height = 900) {
  const {c, context} = e;
  c.state.size = {w: width, h: height};
  e.wrap.clientWidth = e.surface.clientWidth = width;
  e.wrap.clientHeight = e.surface.clientHeight = height;
  e.surface.width.baseVal.value = e.surface.viewBox.baseVal.width = width;
  e.surface.height.baseVal.value = e.surface.viewBox.baseVal.height = height;
  c.proj = context.d3.geoMercator().fitExtent(c.mapViewport(true), {
    type: 'MultiPoint',
    coordinates: [[-81.712, 41.505], [-81.645, 41.482], ...data.sites.filter(site => site.coord).map(site => site.coord)]
  });
  const [west, south, east, north] = c.mapBounds();
  c.mapExtent = [c.proj([west, north]), c.proj([east, south])];
}

function assertVisible(e, coordinates, message) {
  const [[left, top], [right, bottom]] = e.c.mapViewport();
  for (const coord of coordinates) {
    const [x, y] = e.surface.__zoom.apply(e.c.proj(coord));
    assert.ok(x >= left - 1e-7 && x <= right + 1e-7 && y >= top - 1e-7 && y <= bottom + 1e-7,
      `${message}: ${coord} projects to ${x}, ${y} outside ${left}, ${top}, ${right}, ${bottom}`);
  }
}

test('detail and tray wheel events remain available for native scrolling, including at their edges', t => {
  const e = environment(t);
  const before = JSON.stringify(e.c.state.t);
  for (const target of [e.paragraph, e.detailButton, e.trayButton, e.viewerParagraph]) {
    for (const scrollTop of [0, 900]) {
      e.detail.scrollTop = scrollTop;
      const event = e.fire('wheel', target);
      assert.equal(event.defaultPrevented, false, 'D3 must not consume a panel wheel event');
      assert.equal(JSON.stringify(e.c.state.t), before, 'scrolling an overlay must not change the map transform');
    }
  }
  const event = e.fire('wheel', e.surface);
  assert.equal(event.defaultPrevented, true, 'the exposed map still handles wheel zoom');
  assert.ok(e.c.state.t.k > 1, 'map wheel input changes the zoom');
});

test('drag and touch gestures beginning in overlays cannot start a D3 map gesture', t => {
  const e = environment(t);
  assert.ok(e.observed[0] === e.wrap, 'layout observation remains on the outer viewport');
  for (const target of [e.paragraph, e.trayButton, e.viewerParagraph]) {
    const mouse = e.fire('mousedown', target);
    assert.equal(mouse.defaultPrevented, false);
    assert.ok(e.wrap.__zooming === undefined, 'the panel ancestor must not begin a mouse drag');
    assert.ok(e.surface.__zooming === undefined, 'a panel mouse drag must not activate the map surface');
    const touch = {identifier: 1, clientX: 650, clientY: 300};
    const event = e.fire('touchstart', target, {touches: [touch], changedTouches: [touch]});
    assert.equal(event.defaultPrevented, false);
    assert.ok(e.wrap.__zooming === undefined, 'the panel ancestor must not begin a touch gesture');
    assert.ok(e.surface.__zooming === undefined, 'a panel touch must not activate the map surface');
  }
  assert.ok((e.surface.listeners.get('wheel') || []).length, 'only the map surface owns wheel handling');
  assert.equal((e.wrap.listeners.get('wheel') || []).length, 0, 'the common panel ancestor must not own D3 gestures');
});

test('map buttons and camera focus share the same transform as direct map gestures', t => {
  const e = environment(t);
  projectMap(e);
  e.c.zoomBy(1.8);
  assert.ok(e.selected.at(-1) === e.surface, 'zoom button targets the gesture surface');
  assert.equal(e.surface.__zoom.k, 1.8);
  e.c.zoomTo(650, 300, 3);
  assert.ok(e.selected.at(-1) === e.surface, 'focus targets the gesture surface');
  assert.equal(e.surface.__zoom.k, 3);
  e.c.zoomReset();
  assert.ok(e.selected.at(-1) === e.surface, 'fit targets the gesture surface');
  assertVisible(e, data.sites.filter(site => site.coord).map(site => site.coord), 'FIT exposes every known landmark');
  assert.equal(JSON.stringify({k: e.surface.__zoom.k, x: e.surface.__zoom.x, y: e.surface.__zoom.y}), JSON.stringify(e.c.state.t), 'the displayed transform and component state stay synchronized');
  assert.equal(e.wrap.__zoom, undefined, 'the outer panel container must not accumulate a second transform');
});

test('AREA fits the whole study boundary into the space left visible by mobile and desktop panels', t => {
  for (const [width, height, preview] of [[390, 597, false], [375, 431, false], [375, 431, true], [800, 400, true], [1440, 740, false]]) {
    const e = environment(t);
    if (preview) e.c.state.searchTarget = {id: 'coordinate:example', label: 'Temporary point', coord: [-81.681121, 41.472714]};
    projectMap(e, width, height);
    e.c.zoomArea();
    const [west, south, east, north] = e.c.mapBounds();
    assertVisible(e, [[west, north], [east, north], [east, south], [west, south]], `AREA at ${width} × ${height}, preview=${preview}`);
    if (width < 760) {
      const [[left, top], [right, bottom]] = e.c.mapViewport();
      if (preview) {
        const previewBottom = 114 + Math.min(210, height - 190);
        assert.ok(top > previewBottom && bottom <= height, 'a temporary pin overview sits below the preview and inside the map');
      } else {
        assert.ok(right < width - 150 && left >= 0, 'the mobile viewport stays left of the three-column map controls');
        assert.ok(bottom < height * 0.46, 'the normal mobile overview stays above the detail sheet');
      }
    }
  }
});

test('keyboard scrolling and editing inside overlays do not change the selected scene or map zoom', t => {
  const e = environment(t);
  const actions = [];
  e.c.step = value => actions.push(['step', value]);
  e.c.zoomBy = value => actions.push(['zoom', value]);
  e.c.zoomReset = () => actions.push(['reset']);
  for (const target of [e.detail, e.detailButton, e.trayButton, e.drawer]) {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', '+', '-', '0']) {
      assert.equal(e.key(target, key).defaultPrevented, false, 'panel keys retain their native behavior');
    }
  }
  const select = e.page.appendChild(new e.Element('select'));
  const editable = e.page.appendChild(new e.Element('div', '<div contenteditable="true">'));
  for (const target of [select, editable]) for (const key of ['ArrowLeft', 'ArrowRight', '+', '0']) e.key(target, key);
  assert.deepEqual(actions, [], 'overlay and editable focus suppress global map shortcuts');
  e.key(e.pin, 'ArrowRight');
  assert.deepEqual(actions, [['step', 1]], 'pin keyboard navigation still works');
});

test('film viewer keeps its own shortcuts without stealing editing or browser shortcuts', t => {
  const e = environment(t);
  e.c.state.shot = 2;
  const input = e.viewer.appendChild(new e.Element('input'));
  e.key(input, 'ArrowRight');
  assert.equal(e.c.state.shot, 2, 'editing inside a viewer must not step frames');
  e.key(e.viewerParagraph, 'ArrowRight', {metaKey: true});
  assert.equal(e.c.state.shot, 2, 'browser shortcuts are left alone');
  e.key(e.viewerParagraph, 'ArrowRight');
  assert.equal(e.c.state.shot, 3, 'plain viewer navigation remains available');
  e.key(e.viewerParagraph, 'Escape');
  assert.equal(e.c.state.shot, null, 'Escape closes the viewer');
});

test('touch scrolling scene text does not toggle the mobile sheet; its explicit handle can expand it', t => {
  const e = environment(t);
  e.c.state.size = {w: 600, h: 800};
  e.c.state.sheetOpen = false;
  const selected = e.c.state.sel;
  const swipe = target => {
    const start = {identifier: 1, clientX: 100, clientY: 350};
    const end = {identifier: 1, clientX: 100, clientY: 200};
    e.fire('touchstart', target, {touches: [start], changedTouches: [start]});
    return e.fire('touchend', target, {touches: [], changedTouches: [end]});
  };
  swipe(e.paragraph);
  assert.equal(e.c.state.sheetOpen, false, 'a normal content swipe must remain native scrolling');
  assert.equal(e.c.state.sel, selected, 'scrolling text must not change scenes');
  const handleEnd = swipe(e.sheetHandle);
  assert.equal(e.c.state.sheetOpen, true, 'the separate sheet handle still supports expanding');
  assert.equal(handleEnd.defaultPrevented, true, 'a completed handle drag suppresses a compatibility click that would toggle it again');
  e.c.state.sheetOpen = false;
  const start = {identifier: 2, clientX: 100, clientY: 350};
  e.fire('touchstart', e.sheetHandle, {touches: [start], changedTouches: [start]});
  e.fire('touchcancel', e.sheetHandle, {touches: [], changedTouches: [start]});
  e.fire('touchend', e.sheetHandle, {touches: [], changedTouches: [{...start, clientY: 200}]});
  assert.equal(e.c.state.sheetOpen, false, 'a canceled gesture must not leave a pending sheet drag');
});

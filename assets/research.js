(function () {
  'use strict';

  const byId = id => document.getElementById(id);
  const caseOrder = ['eagle', 'madison', 'clark'];
  const caseNames = { eagle: 'Eagle Avenue', madison: 'Madison Square', clark: 'Clark Avenue' };
  const caseQuestions = { madison: 'madison-full-facade', clark: 'clark-road-level' };
  const questionOrder = ['madison-full-facade', 'clark-road-level', 'leader-kronheim-adjacency', 'colonial-blood-bank-frontage', 'east86-wadepark-shot'];
  const state = { data: null, activeCase: null, frameIndex: 0, referenceIndex: 0, loading: false, returnFocus: null, showAnnotations: false };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function paragraph(parent, text, className) {
    if (text) parent.appendChild(element('p', className || '', text));
  }

  function safeUrl(value, allowRelative) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = allowRelative ? new URL(value, document.baseURI) : new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch (error) {
      return null;
    }
  }

  function validFrame(value) {
    if (value === null || value === undefined || typeof value === 'boolean') return false;
    const frame = Number(value);
    return Number.isSafeInteger(frame) && frame >= 1 && frame <= 682;
  }

  function containedImageRect(naturalWidth, naturalHeight, containerWidth, containerHeight) {
    if (![naturalWidth, naturalHeight, containerWidth, containerHeight].every(value => Number.isFinite(value) && value > 0)) return null;
    const scale = Math.min(containerWidth / naturalWidth, containerHeight / naturalHeight);
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;
    return { left: (containerWidth - width) / 2, top: (containerHeight - height) / 2, width, height };
  }

  function validAnnotations(record) {
    return (Array.isArray(record.annotations) ? record.annotations : []).filter(annotation =>
      Number.isFinite(annotation.x) && Number.isFinite(annotation.y) && annotation.x >= 0 && annotation.x <= 100 && annotation.y >= 0 && annotation.y <= 100 && typeof annotation.label === 'string' && annotation.label.trim()
    );
  }

  function frameUrl(value) {
    return validFrame(value) ? './#shot=' + Number(value) : null;
  }

  function contributionUrl(options) {
    const values = options || {};
    const params = new URLSearchParams();
    if (typeof values.placeId === 'string' && /^[a-z0-9-]+$/.test(values.placeId)) params.set('place', values.placeId);
    if (validFrame(values.frameId)) params.set('frame', String(Number(values.frameId)));
    if (typeof values.question === 'string' && /^[a-z0-9-]+$/.test(values.question)) params.set('question', values.question);
    return './contribute.html' + (params.toString() ? '?' + params.toString() : '');
  }

  function statusKey(status) {
    const label = String(status || '').toLowerCase();
    if (label.includes('probable') || label.includes('tentative')) return 'probable';
    if (label.includes('documented')) return 'documented';
    if (label.includes('unplaced') || label.includes('open')) return 'open';
    return 'strong';
  }

  function actionLink(text, href, secondary) {
    const link = element('a', secondary ? 'button secondary' : 'button', text);
    link.href = href;
    return link;
  }

  function externalLink(text, href, className) {
    const url = safeUrl(href, false);
    const link = element(url ? 'a' : 'span', className || '', text);
    if (url) {
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    return link;
  }

  function renderSourceList(parent, sources) {
    const fragment = document.createDocumentFragment();
    (sources || []).forEach(source => {
      const item = element('li');
      item.appendChild(externalLink(source.title || 'Source record', safeUrl(source.url, true)));
      paragraph(item, source.note);
      fragment.appendChild(item);
    });
    parent.replaceChildren(fragment);
  }

  function parseCaseHash(hash, cases) {
    const match = String(hash || '').match(/^#case=([a-z0-9-]+)$/);
    const id = match ? match[1] : null;
    return cases.some(item => item.id === id) ? id : cases[0].id;
  }

  function validateEvidence(data) {
    if (!data || !Array.isArray(data.cases) || data.cases.length !== 3) throw new Error('Three comparison records are required');
    if (!caseOrder.every(id => data.cases.filter(item => item.id === id).length === 1)) throw new Error('Unexpected comparison identifiers');
    data.cases.forEach(item => {
      if (!item.title || !item.status || !Array.isArray(item.frames) || !item.frames.length || !item.frames.every(frame => validFrame(frame.id))) throw new Error('Incomplete film comparison');
      if (!Array.isArray(item.references) || !item.references.length || !Array.isArray(item.observations) || !Array.isArray(item.uncertainties)) throw new Error('Incomplete historical comparison');
    });
  }

  function validateQuestions(data) {
    if (!data || !Array.isArray(data.questions) || data.questions.length !== 5) throw new Error('Five research questions are required');
    const ordered = [...data.questions].sort((left, right) => left.rank - right.rank);
    ordered.forEach((question, index) => {
      if (question.rank !== index + 1 || question.id !== questionOrder[index]) throw new Error('Unexpected question order');
      if (!question.title || !question.missing || !Array.isArray(question.checked) || !Array.isArray(question.frames) || !question.frames.every(frame => validFrame(frame.id))) throw new Error('Incomplete research question');
    });
    const documented = ordered[4];
    if (documented.frameId != null || documented.placeId != null || documented.frames.length) throw new Error('The documented area must remain unassigned');
    return ordered;
  }

  async function fetchJsonWithTimeout(path, timeoutMs = 12000) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(function () {
        controller.abort();
        reject(new Error('The data request timed out'));
      }, timeoutMs);
    });
    try {
      const request = (async function () {
        const response = await fetch(path, { cache: 'no-cache', signal: controller.signal });
        if (!response.ok) throw new Error('Data request failed');
        return response.json();
      }());
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Small, deterministic helpers are available for buildless verification.
  window.UptightResearch = { safeUrl, validFrame, frameUrl, contributionUrl, statusKey, parseCaseHash, validateEvidence, validateQuestions, containedImageRect, validAnnotations, fetchJsonWithTimeout };

  function openImage(image, title, caption, opener, originalImage) {
    const src = safeUrl(image, true);
    if (!src) return;
    const dialog = byId('image-dialog');
    if (!dialog || typeof dialog.showModal !== 'function') {
      window.open(src, '_blank', 'noopener,noreferrer');
      return;
    }
    state.returnFocus = opener || document.activeElement;
    byId('dialog-title').textContent = title;
    byId('dialog-caption').textContent = caption || title;
    byId('dialog-image').src = src;
    byId('dialog-image').alt = caption || title;
    byId('open-original').href = safeUrl(originalImage, false) || src;
    byId('dialog-stage').dataset.size = 'fit';
    byId('toggle-image-size').textContent = 'Original size';
    byId('toggle-image-size').setAttribute('aria-pressed', 'false');
    dialog.showModal();
  }

  function addMetadata(parent, pairs) {
    const list = element('dl', 'image-metadata');
    pairs.forEach(([label, value]) => {
      if (value === undefined || value === null || value === '') return;
      list.appendChild(element('dt', '', label));
      const description = element('dd');
      if (typeof value === 'string') description.textContent = value;
      else description.appendChild(value);
      list.appendChild(description);
    });
    parent.appendChild(list);
  }

  function imageFigure(record, type) {
    const film = type === 'film';
    const title = film ? 'Frame ' + record.id + (record.time ? ' · ' + record.time : '') : record.title || 'Historical reference';
    const caption = record.caption || (film ? 'Indexed film still ' + record.id + ' from Uptight (1968).' : 'See the linked archival record for the reference description.');
    const src = safeUrl(record.src, true);
    const sourceUrl = film ? frameUrl(record.id) : safeUrl(record.sourceUrl, false);
    const annotations = validAnnotations(record);
    const figure = element('figure', 'comparison-figure');
    const stage = element('div', 'image-stage');
    const fallback = element('div', 'image-fallback');
    fallback.appendChild(element('h4', '', src ? 'This image could not load' : 'Open the archival record'));
    paragraph(fallback, src ? 'The image may be temporarily unavailable. You can inspect the linked record or open the image directly.' : 'The reference image is not reproduced here. Its source, date and limits are retained below.');
    if (sourceUrl) {
      const link = film ? element('a', '', 'Open this frame in the map →') : externalLink('Inspect the archival source ↗', sourceUrl);
      if (film) link.href = sourceUrl;
      fallback.appendChild(link);
    }
    if (src) fallback.appendChild(externalLink('Open the image directly ↗', src));
    fallback.hidden = Boolean(src);
    if (src) {
      const button = element('button', 'image-open');
      button.type = 'button';
      button.setAttribute('aria-label', 'Enlarge ' + title);
      const image = element('img');
      image.alt = record.alt || caption;
      image.decoding = 'async';
      const layer = element('div', 'annotation-layer');
      layer.setAttribute('aria-hidden', 'true');
      layer.hidden = true;
      annotations.forEach((annotation, index) => {
        const marker = element('span', 'annotation-marker', index + 1);
        marker.style.left = annotation.x + '%';
        marker.style.top = annotation.y + '%';
        layer.appendChild(marker);
      });
      const updateMarkers = function () {
        const rect = containedImageRect(image.naturalWidth, image.naturalHeight, stage.clientWidth, stage.clientHeight);
        if (!rect || button.hidden || !annotations.length) { layer.hidden = true; return; }
        layer.style.left = rect.left + 'px';
        layer.style.top = rect.top + 'px';
        layer.style.width = rect.width + 'px';
        layer.style.height = rect.height + 'px';
        layer.hidden = !state.showAnnotations;
      };
      figure.updateAnnotations = updateMarkers;
      image.addEventListener('load', updateMarkers);
      image.addEventListener('error', function () { button.hidden = true; fallback.hidden = false; layer.hidden = true; });
      image.src = src;
      button.appendChild(image);
      button.addEventListener('click', function () { openImage(src, title, caption, button, record.originalImageUrl); });
      stage.append(button, layer);
      if (annotations.length) {
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(updateMarkers);
          observer.observe(stage);
          figure.dispose = function () { observer.disconnect(); };
        } else {
          window.addEventListener('resize', updateMarkers);
          figure.dispose = function () { window.removeEventListener('resize', updateMarkers); };
        }
      }
    }
    stage.appendChild(fallback);
    const description = element('figcaption');
    paragraph(description, title, 'figure-title');
    paragraph(description, caption, 'figure-caption');
    let source;
    if (film) {
      source = element('a', '', 'Film frame collection');
      source.href = frameUrl(record.id);
    } else source = externalLink('Archival record ↗', record.sourceUrl);
    addMetadata(description, [
      [film ? 'Film date' : 'Image date', film ? '1968' : record.date || 'Date not established in the supplied record'],
      ['Credit', record.credit || (film ? 'Uptight (1968); indexed still collection' : 'Credit not specified in the supplied record')],
      ['Source', source]
    ]);
    const rights = element('details', 'rights-details');
    rights.appendChild(element('summary', '', 'Image credit and use'));
    paragraph(rights, record.rights || 'The comparison record does not specify a reuse license for this image.');
    description.appendChild(rights);
    if (annotations.length) {
      const legend = element('ol', 'annotation-legend');
      legend.setAttribute('aria-label', 'Numbered details in this image');
      annotations.forEach(annotation => legend.appendChild(element('li', '', annotation.label)));
      description.appendChild(legend);
    }
    figure.append(stage, description);
    return figure;
  }

  function selectedCase() {
    return state.data.cases.find(item => item.id === state.activeCase);
  }

  function renderFilmPanel() {
    const item = selectedCase();
    const previous = byId('film-panel').firstElementChild;
    if (previous && previous.dispose) previous.dispose();
    byId('film-panel').replaceChildren(imageFigure(item.frames[state.frameIndex], 'film'));
    Array.from(byId('film-selectors').children).forEach((button, index) => button.setAttribute('aria-pressed', String(index === state.frameIndex)));
  }

  function renderReferencePanel() {
    const item = selectedCase();
    const previous = byId('reference-panel').firstElementChild;
    if (previous && previous.dispose) previous.dispose();
    byId('reference-panel').replaceChildren(imageFigure(item.references[state.referenceIndex], 'reference'));
    Array.from(byId('reference-selectors').children).forEach((button, index) => button.setAttribute('aria-pressed', String(index === state.referenceIndex)));
  }

  function renderSelectors(item) {
    const frames = document.createDocumentFragment();
    item.frames.forEach((frame, index) => {
      const button = element('button', '', 'Frame ' + frame.id);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(index === state.frameIndex));
      button.addEventListener('click', function () { state.frameIndex = index; renderFilmPanel(); renderCaseActions(); });
      frames.appendChild(button);
    });
    byId('film-selectors').replaceChildren(frames);
    const references = document.createDocumentFragment();
    item.references.forEach((reference, index) => {
      const label = reference.label || 'Reference ' + (index + 1) + (reference.date ? ' · ' + reference.date : '');
      const button = element('button', '', label);
      button.type = 'button';
      button.setAttribute('aria-label', 'View reference ' + (index + 1) + ': ' + (reference.title || 'Historical comparison'));
      button.setAttribute('aria-pressed', String(index === state.referenceIndex));
      button.addEventListener('click', function () { state.referenceIndex = index; renderReferencePanel(); });
      references.appendChild(button);
    });
    byId('reference-selectors').replaceChildren(references);
  }

  function renderCaseActions() {
    const item = selectedCase();
    const frame = item.frames[state.frameIndex];
    const question = caseQuestions[item.id];
    const actions = document.createDocumentFragment();
    actions.appendChild(actionLink('Contribute evidence', contributionUrl({ placeId: item.placeId, frameId: frame.id, question })));
    if (question) actions.appendChild(actionLink('See the open research question →', './research-board.html#' + question, true));
    const frameReview = element('a', 'text-link', 'Read frame ' + frame.id + ' review');
    frameReview.href = './location-review.html#frame=' + frame.id;
    actions.appendChild(frameReview);
    byId('case-actions').replaceChildren(actions);
  }

  function renderCasePagination() {
    const position = caseOrder.indexOf(state.activeCase);
    const fragment = document.createDocumentFragment();
    if (position > 0) {
      const previous = element('a', '', '← ' + caseNames[caseOrder[position - 1]]);
      previous.href = '#case=' + caseOrder[position - 1];
      fragment.appendChild(previous);
    } else fragment.appendChild(element('span', '', 'First comparison'));
    fragment.appendChild(element('span', '', String(position + 1).padStart(2, '0') + ' / 03'));
    const next = element('a', '', position < 2 ? caseNames[caseOrder[position + 1]] + ' →' : 'Research board →');
    next.href = position < 2 ? '#case=' + caseOrder[position + 1] : './research-board.html';
    fragment.appendChild(next);
    byId('case-pagination').replaceChildren(fragment);
  }

  function renderActiveCase(shouldFocus) {
    const item = selectedCase();
    state.frameIndex = 0;
    state.referenceIndex = 0;
    byId('case-title').textContent = item.title;
    byId('case-status').textContent = item.status;
    byId('case-status').dataset.state = statusKey(item.status);
    byId('case-summary').textContent = item.summary || '';
    Array.from(byId('case-nav').children).forEach(link => {
      if (link.dataset.case === item.id) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
    renderSelectors(item);
    renderFilmPanel();
    renderReferencePanel();
    byId('comparison-tools').hidden = !item.frames.concat(item.references).some(record => validAnnotations(record).length);
    const observations = document.createDocumentFragment();
    item.observations.forEach(observation => {
      const row = element('li');
      row.appendChild(element('h4', '', observation.title));
      paragraph(row, observation.text);
      observations.appendChild(row);
    });
    byId('observations').replaceChildren(observations);
    const uncertainties = document.createDocumentFragment();
    item.uncertainties.forEach(text => uncertainties.appendChild(element('li', '', text)));
    byId('uncertainties').replaceChildren(uncertainties);
    byId('resolution').textContent = item.resolution || 'A more complete source comparison is still needed.';
    renderCaseActions();
    renderSourceList(byId('case-sources'), item.sources);
    renderCasePagination();
    byId('case-live').textContent = item.title + '. ' + item.status + '.';
    if (shouldFocus) {
      byId('comparison-case').scrollIntoView({ block: 'start' });
      byId('case-title').focus({ preventScroll: true });
    }
  }

  function renderEvidence(data) {
    validateEvidence(data);
    state.data = data;
    state.activeCase = parseCaseHash(window.location.hash, data.cases);
    const navigation = document.createDocumentFragment();
    caseOrder.forEach((id, index) => {
      const item = data.cases.find(value => value.id === id);
      const link = element('a');
      link.href = '#case=' + id;
      link.dataset.case = id;
      link.appendChild(element('span', 'case-number', 'Comparison ' + String(index + 1).padStart(2, '0')));
      link.appendChild(element('span', 'case-label', caseNames[id]));
      link.appendChild(element('span', 'case-state', item.status));
      navigation.appendChild(link);
    });
    byId('case-nav').replaceChildren(navigation);
    byId('evidence-content').hidden = false;
    renderActiveCase(/^#case=/.test(window.location.hash));
    const notes = document.createDocumentFragment();
    (data.researchNotes || []).forEach(note => {
      const article = element('article', 'research-note');
      article.appendChild(element('h3', '', note.topic));
      [['Checked', note.checked], ['Result', note.found], ['Still needed', note.remaining]].forEach(([label, text]) => {
        if (!text) return;
        const line = element('p');
        line.appendChild(element('strong', '', label + '. '));
        line.appendChild(document.createTextNode(text));
        article.appendChild(line);
      });
      const sourceDetails = element('details', 'question-sources');
      sourceDetails.appendChild(element('summary', '', 'Source records · ' + (note.sources || []).length));
      const sources = element('ul', 'source-list');
      renderSourceList(sources, note.sources);
      sourceDetails.appendChild(sources);
      article.appendChild(sourceDetails);
      const question = caseQuestions[note.caseId] || (note.placeId === 'leader' ? 'leader-kronheim-adjacency' : null);
      if (question) {
        const link = element('a', 'text-link', 'See the open research question →');
        link.href = './research-board.html#' + question;
        article.appendChild(link);
      }
      notes.appendChild(article);
    });
    byId('research-note-list').replaceChildren(notes);
    byId('followup-checks').hidden = !(data.researchNotes || []).length;
  }

  function addQuestionSources(parent, question) {
    const details = element('details', 'question-sources');
    details.appendChild(element('summary', '', 'Source records · ' + question.sources.length));
    const list = element('ul', 'source-list');
    renderSourceList(list, question.sources);
    details.appendChild(list);
    parent.appendChild(details);
  }

  function addSourceChips(parent, ids, sources) {
    if (!ids || !ids.length) return;
    const list = element('span', 'source-chips');
    const sourceMap = new Map(sources.map(source => [source.id, source]));
    [...new Set(ids)].forEach(id => {
      if (!sourceMap.has(id)) return;
      const link = element('a', '', '[' + id + ']');
      link.href = './location-review.html#source-' + id;
      link.setAttribute('aria-label', id + ': ' + sourceMap.get(id).title);
      list.appendChild(link);
    });
    parent.appendChild(list);
  }

  function questionCard(question) {
    const card = element('li', 'question-card');
    card.id = question.id;
    const rank = element('span', 'question-rank', String(question.rank).padStart(2, '0'));
    rank.setAttribute('aria-hidden', 'true');
    card.appendChild(rank);
    const body = element('article');
    const heading = element('div', 'question-heading');
    const status = element('span', 'status', question.status);
    status.dataset.state = question.statusKey || statusKey(question.status);
    heading.appendChild(status);
    const title = element('h2', '', question.title);
    title.id = question.id + '-title';
    heading.appendChild(title);
    body.setAttribute('aria-labelledby', title.id);
    body.appendChild(heading);
    paragraph(body, question.summary, 'question-summary');
    if (question.frames.length) {
      const links = element('div', 'frame-links');
      question.frames.forEach(frame => {
        const link = element('a', '', 'Frame ' + frame.id + (frame.time ? ' · ' + frame.time : ''));
        link.href = frameUrl(frame.id);
        links.appendChild(link);
      });
      body.appendChild(links);
    } else paragraph(body, 'No individual frame is assigned to this area.', 'no-frame');
    const evidence = element('div', 'question-evidence');
    const checked = element('section');
    const checkedHeading = element('h3', '', 'Evidence already checked');
    checkedHeading.id = question.id + '-checked';
    checked.setAttribute('aria-labelledby', checkedHeading.id);
    checked.appendChild(checkedHeading);
    const checkedList = element('ul', 'checked-list');
    question.checked.forEach(record => {
      const item = element('li', '', record.text);
      addSourceChips(item, record.sourceIds, question.sources);
      if (Array.isArray(record.links) && record.links.length) {
        const links = element('span', 'source-chips');
        record.links.forEach(source => links.appendChild(externalLink(source.title + ' ↗', source.url)));
        item.appendChild(links);
      }
      checkedList.appendChild(item);
    });
    checked.appendChild(checkedList);
    const needed = element('section');
    const missing = element('div', 'missing-item');
    const neededHeading = element('h3', '', 'Decisive missing item');
    neededHeading.id = question.id + '-missing';
    needed.setAttribute('aria-labelledby', neededHeading.id);
    missing.appendChild(neededHeading);
    paragraph(missing, question.missing);
    needed.appendChild(missing);
    paragraph(needed, question.closure, 'closure-note');
    evidence.append(checked, needed);
    body.appendChild(evidence);
    const actions = element('div', 'question-actions');
    const contribute = actionLink('Contribute evidence', contributionUrl({ placeId: question.placeId, frameId: question.frameId, question: question.id }));
    contribute.setAttribute('aria-label', 'Contribute evidence: ' + question.title);
    actions.appendChild(contribute);
    if (question.evidenceCase) actions.appendChild(actionLink('Inspect the comparison →', './evidence.html#case=' + question.evidenceCase, true));
    if (question.contextUrl) actions.appendChild(actionLink('Read the documented-area evidence', question.contextUrl, true));
    if (validFrame(question.frameId)) {
      const review = element('a', 'text-link', 'Read the frame review');
      review.href = './location-review.html#frame=' + question.frameId;
      actions.appendChild(review);
    } else {
      const review = element('a', 'text-link', 'Browse all frame notes');
      review.href = './location-review.html#coverage';
      actions.appendChild(review);
    }
    body.appendChild(actions);
    addQuestionSources(body, question);
    card.appendChild(body);
    return card;
  }

  function scrollToQuestion() {
    const id = window.location.hash.slice(1);
    if (questionOrder.includes(id)) {
      const question = byId(id);
      if (question) question.scrollIntoView({ block: 'start' });
    }
  }

  function renderBoard(data) {
    const questions = validateQuestions(data);
    state.data = data;
    if (data.orderingNote) byId('ordering-note').textContent = data.orderingNote;
    const index = document.createDocumentFragment();
    const cards = document.createDocumentFragment();
    questions.forEach(question => {
      const link = element('a');
      link.href = '#' + question.id;
      link.appendChild(element('span', '', String(question.rank).padStart(2, '0')));
      link.appendChild(document.createTextNode(question.shortTitle || question.title));
      index.appendChild(link);
      cards.appendChild(questionCard(question));
    });
    byId('question-index').replaceChildren(index);
    byId('question-list').replaceChildren(cards);
    byId('board-content').hidden = false;
    scrollToQuestion();
  }

  async function loadPage() {
    if (state.loading) return;
    state.loading = true;
    byId('main').setAttribute('aria-busy', 'true');
    byId('loading-state').hidden = false;
    byId('error-state').hidden = true;
    const evidence = document.body.dataset.page === 'evidence';
    try {
      const data = await fetchJsonWithTimeout(evidence ? 'data/evidence-cases.json' : 'data/research-questions.json');
      if (evidence) renderEvidence(data);
      else renderBoard(data);
    } catch (error) {
      byId(evidence ? 'evidence-content' : 'board-content').hidden = true;
      byId('error-state').hidden = false;
    } finally {
      state.loading = false;
      byId('loading-state').hidden = true;
      byId('main').setAttribute('aria-busy', 'false');
    }
  }

  byId('retry-button').addEventListener('click', loadPage);
  window.addEventListener('hashchange', function () {
    if (!state.data) return;
    if (document.body.dataset.page === 'evidence') {
      const id = parseCaseHash(window.location.hash, state.data.cases);
      if (id !== state.activeCase) {
        state.activeCase = id;
        renderActiveCase(true);
      }
    } else scrollToQuestion();
  });
  if (document.body.dataset.page === 'evidence') {
    byId('toggle-annotations').addEventListener('click', function () {
      state.showAnnotations = !state.showAnnotations;
      byId('toggle-annotations').setAttribute('aria-pressed', String(state.showAnnotations));
      byId('toggle-annotations').textContent = state.showAnnotations ? 'Hide details' : 'Show details';
      ['film-panel', 'reference-panel'].forEach(id => {
        const figure = byId(id).firstElementChild;
        if (figure && figure.updateAnnotations) figure.updateAnnotations();
      });
    });
    byId('close-dialog').addEventListener('click', function () { byId('image-dialog').close(); });
    byId('image-dialog').addEventListener('click', function (event) { if (event.target === byId('image-dialog')) byId('image-dialog').close(); });
    byId('image-dialog').addEventListener('close', function () {
      if (state.returnFocus && state.returnFocus.isConnected) state.returnFocus.focus();
    });
    byId('toggle-image-size').addEventListener('click', function () {
      const original = byId('dialog-stage').dataset.size !== 'original';
      byId('dialog-stage').dataset.size = original ? 'original' : 'fit';
      byId('toggle-image-size').setAttribute('aria-pressed', String(original));
      byId('toggle-image-size').textContent = original ? 'Fit image' : 'Original size';
      byId('dialog-stage').focus({ preventScroll: true });
    });
  }
  loadPage();
}());

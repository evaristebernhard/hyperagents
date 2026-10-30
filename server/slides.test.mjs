import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { buildSlidesHtml, parseSlidesContent, serializeSlides, validateSlides, SLIDES_NAVIGATION_SCRIPT, SLIDES_SCRIPT_HASH, SLIDES_CSP } from './slides.mjs';
import { emptyState, validateState } from './validation.mjs';
const deck = { title: 'Example deck', slides: [{ title: 'One', body: 'Hello\nWorld', notes: 'Notes' }, { title: 'Two', body: 'Second page' }] };

test('structured schema rejects HTML documents, unknown fields, limits, and invalid text', () => {
  assert.deepEqual(parseSlidesContent(serializeSlides(deck)), deck);
  for (const input of [null, {}, { ...deck, html: '<script>' }, { ...deck, title: ' ' }, { ...deck, slides: [] }, { ...deck, slides: Array(41).fill(deck.slides[0]) }, { ...deck, slides: [{ title: 'x', body: 'x'.repeat(6001) }] }, { ...deck, slides: [{ title: 'x', body: '', notes: 42 }] }, { ...deck, slides: [{ title: 'x', body: '', script: 'alert(1)' }] }]) assert.throws(() => validateSlides(input));
  assert.throws(() => parseSlidesContent('<html><script>alert(1)</script></html>'));
  assert.throws(() => parseSlidesContent(' '.repeat(300001)));
  assert.throws(() => validateSlides({ ...deck, slides: Array(40).fill({ title: 'x', body: 'x'.repeat(6000), notes: 'x'.repeat(4000) }) }));
  assert.equal(validateSlides({ ...deck, slides: Array(40).fill({ title: 'x', body: '' }) }).slides.length, 40);
});

test('all presentation text is escaped; no dynamic script or network source is interpolated', () => {
  const attack = '</script><script src="https://evil.example/x">alert(1)</script><img src=x onerror=alert(2)>&\'"';
  const html = buildSlidesHtml({ title: attack, slides: [{ title: attack, body: attack, notes: attack }] });
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.ok(html.includes('&lt;/script&gt;&lt;script src=&quot;'));
  assert.ok(html.includes('&amp;&#39;&quot;'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script src'));
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<style>'));
  for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(SLIDES_CSP.includes(directive));
  assert.ok(!SLIDES_CSP.includes("script-src 'unsafe-inline'"));
});

test('CSP permits exactly the fixed navigation script and hash stays synchronized', () => {
  const html = buildSlidesHtml(deck);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0][1], SLIDES_NAVIGATION_SCRIPT);
  assert.equal(SLIDES_SCRIPT_HASH, 'sha256-' + createHash('sha256').update(scripts[0][1]).digest('base64'));
  assert.equal((SLIDES_CSP.match(/sha256-/g) || []).length, 1);
  assert.ok(SLIDES_CSP.includes(`script-src '${SLIDES_SCRIPT_HASH}'`));
});

test('fixed canvas navigation: buttons, dots, keys, trusted parent messages, Escape and 50px swipe', () => {
  const element = () => ({ hidden: false, disabled: false, style: {}, listeners: {}, attributes: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute(name, value) { this.attributes[name] = value; } });
  const slides = [element(), element()];
  const dots = [element(), element()];
  const ids = Object.fromEntries(['stage', 'previous', 'next', 'counter'].map(id => [id, element()]));
  const events = {};
  const sent = [];
  const parent = { postMessage: (...args) => sent.push(args) };
  const context = { innerWidth: 640, innerHeight: 200, window: { parent }, document: { getElementById: id => ids[id], querySelectorAll: selector => selector === '.slide' ? slides : dots }, addEventListener: (name, fn) => { events[name] = fn; } };
  runInNewContext(SLIDES_NAVIGATION_SCRIPT, context);
  assert.equal(ids.counter.textContent, '1 / 2');
  assert.equal(slides[1].hidden, true);
  assert.equal(ids.previous.disabled, true);
  assert.ok(ids.stage.style.transform.includes(String(200 / 720)));
  ids.next.listeners.click();
  assert.equal(ids.counter.textContent, '2 / 2');
  assert.equal(ids.next.disabled, true);
  dots[0].listeners.click();
  assert.equal(slides[1].hidden, true);
  events.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(slides[0].hidden, true);
  events.message({ source: {}, data: { type: 'navigate', direction: 'prev' } });
  assert.equal(ids.counter.textContent, '2 / 2');
  events.message({ source: parent, data: { type: 'navigate', direction: 'prev' } });
  assert.equal(ids.counter.textContent, '1 / 2');
  const swipe = (dx, dy = 0) => { events.touchstart({ touches: [{ clientX: 100, clientY: 100 }] }); events.touchend({ changedTouches: [{ clientX: 100 + dx, clientY: 100 + dy }] }); };
  swipe(-49); assert.equal(ids.counter.textContent, '1 / 2');
  swipe(-50, 100); assert.equal(ids.counter.textContent, '1 / 2');
  swipe(-50); assert.equal(ids.counter.textContent, '2 / 2');
  events.keydown({ key: 'Escape' });
  assert.equal(sent[0][0].type, 'close-fullscreen');
  assert.equal(sent[0][1], '*');
  assert.match(buildSlidesHtml(deck), /width:1280px;height:720px/);
  assert.match(buildSlidesHtml(deck), /class="slide" aria-label="Slide 2" hidden/);
});

test('workspace snapshot accepts Slides but rejects raw HTML in current or historical content', () => {
  const state = emptyState();
  const artifact = { id: 'slides-1', title: deck.title, kind: 'Slides', content: serializeSlides(deck), versions: [], createdAt: 'now', updatedAt: 'now' };
  state.workspaces[0].data.artifacts.push(artifact);
  assert.equal(validateState(state), state);
  artifact.content = '<html>not structured</html>';
  assert.throws(() => validateState(state), /structured JSON/);
  artifact.content = serializeSlides(deck);
  artifact.versions.push({ id: 'v1', createdAt: 'then', content: '<script>evil</script>' });
  assert.throws(() => validateState(state), /structured JSON/);
});

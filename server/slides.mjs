// Pure module shared by the server and the browser. No DOM or Node dependencies.
// Only structured text enters this renderer. Never accept generated HTML/scripts.
export const SLIDES_LIMITS = Object.freeze({ slides: 40, title: 240, body: 6000, notes: 4000, content: 300000 });
export class SlidesValidationError extends Error {
  constructor(message) { super(message); this.name = 'SlidesValidationError'; this.status = 422; this.code = 'VALIDATION'; }
}
const invalid = message => { throw new SlidesValidationError(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function exactKeys(value, allowed) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('Slides must contain structured text, not HTML or extra fields.');
}
function text(value, field, limit, nonempty = false) {
  if (typeof value !== 'string' || value.length > limit || (nonempty && !value.trim())) invalid(`Invalid slide ${field} (maximum ${limit} characters).`);
  return value;
}
export const SLIDES_PARAMETERS_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['title', 'slides'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 240, description: 'Presentation title.' },
    slides: { type: 'array', minItems: 1, maxItems: 40, items: {
      type: 'object', additionalProperties: false, required: ['title', 'body'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 240 },
        body: { type: 'string', maxLength: 6000, description: 'Plain text body. HTML and Markdown are displayed literally; use line breaks for paragraphs or bullets.' },
        notes: { type: 'string', maxLength: 4000, description: 'Optional speaker notes, hidden in the presentation.' },
      },
    } },
  },
});
export function validateSlides(value) {
  exactKeys(value, ['title', 'slides']);
  const title = text(value.title, 'presentation title', SLIDES_LIMITS.title, true);
  if (!Array.isArray(value.slides) || value.slides.length < 1 || value.slides.length > SLIDES_LIMITS.slides) invalid('A presentation requires 1–40 slides.');
  const slides = value.slides.map(slide => {
    exactKeys(slide, ['title', 'body', 'notes']);
    const result = { title: text(slide.title, 'title', SLIDES_LIMITS.title, true), body: text(slide.body, 'body', SLIDES_LIMITS.body) };
    if (slide.notes !== undefined) result.notes = text(slide.notes, 'notes', SLIDES_LIMITS.notes);
    return result;
  });
  const deck = { title, slides };
  if (JSON.stringify(deck).length > SLIDES_LIMITS.content) invalid('Presentation content exceeds 300000 characters.');
  return deck;
}
export function parseSlidesContent(content) {
  if (typeof content !== 'string' || content.length > SLIDES_LIMITS.content) invalid('Invalid Slides JSON size.');
  let value;
  try { value = JSON.parse(content); } catch { invalid('Slides content must be structured JSON, not HTML.'); }
  return validateSlides(value);
}
export function serializeSlides(value) { return JSON.stringify(validateSlides(value)); }
const escape = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// CSP hash is deliberately fixed to this exact, data-free navigation script.
// The focused test verifies it whenever navigation changes.
export const SLIDES_NAVIGATION_SCRIPT = `(() => {
'use strict';
const stage = document.getElementById('stage');
const slides = Array.from(document.querySelectorAll('.slide'));
const dots = Array.from(document.querySelectorAll('[data-slide]'));
const previous = document.getElementById('previous');
const next = document.getElementById('next');
const counter = document.getElementById('counter');
let index = 0;
function resize() {
  const scale = Math.min(innerWidth / 1280, innerHeight / 720);
  stage.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
}
function show(value) {
  index = Math.max(0, Math.min(slides.length - 1, value));
  slides.forEach((slide, i) => { slide.hidden = i !== index; });
  dots.forEach((dot, i) => { dot.setAttribute('aria-current', String(i === index)); });
  previous.disabled = index === 0;
  next.disabled = index === slides.length - 1;
  counter.textContent = (index + 1) + ' / ' + slides.length;
}
previous.addEventListener('click', () => show(index - 1));
next.addEventListener('click', () => show(index + 1));
dots.forEach((dot, i) => dot.addEventListener('click', () => show(i)));
addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); show(index + (event.key === 'ArrowRight' ? 1 : -1));
  } else if (event.key === 'Escape') {
    window.parent.postMessage({ type: 'close-fullscreen' }, '*');
  }
});
addEventListener('message', event => {
  if (event.source !== window.parent || !event.data || event.data.type !== 'navigate') return;
  if (event.data.direction === 'prev') show(index - 1);
  if (event.data.direction === 'next') show(index + 1);
});
let touchStart = null;
addEventListener('touchstart', event => {
  touchStart = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
}, { passive: true });
addEventListener('touchcancel', () => { touchStart = null; });
addEventListener('touchend', event => {
  if (!touchStart || !event.changedTouches.length) return;
  const dx = event.changedTouches[0].clientX - touchStart.x;
  const dy = event.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy)) show(index + (dx < 0 ? 1 : -1));
}, { passive: true });
addEventListener('resize', resize);
show(0); resize();
})();`;
export const SLIDES_SCRIPT_HASH = 'sha256-ev5Wt4bKBl6YpO+xCSnQQXS63u+TzRNHFMJkDnz+UYQ=';
export const SLIDES_CSP = `default-src 'none'; script-src '${SLIDES_SCRIPT_HASH}'; script-src-attr 'none'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;

export function buildSlidesHtml(input) {
  const deck = typeof input === 'string' ? parseSlidesContent(input) : validateSlides(input);
  const sections = deck.slides.map((slide, i) => `<section class="slide" aria-label="Slide ${i + 1}"${i ? ' hidden' : ''}><div class="eyebrow">${escape(deck.title)}</div><h1>${escape(slide.title)}</h1><div class="body">${escape(slide.body)}</div>${slide.notes === undefined ? '' : `<aside hidden class="speaker-notes">${escape(slide.notes)}</aside>`}</section>`).join('');
  const dots = deck.slides.map((_, i) => `<button type="button" class="dot" data-slide="${i}" aria-label="Go to slide ${i + 1}" aria-current="${i === 0}"></button>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${SLIDES_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(deck.title)}</title><style>
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#101820;color:#14272e;font-family:Arial,Helvetica,sans-serif}button{font:inherit}#stage{position:absolute;left:50%;top:50%;width:1280px;height:720px;transform-origin:center;background:#f4f3ed;overflow:hidden}.slide{display:flex;flex-direction:column;position:absolute;inset:0;padding:58px 80px 118px;border-top:10px solid #247b79}.slide[hidden]{display:none}.eyebrow{flex-shrink:0;font-size:16px;letter-spacing:2px;text-transform:uppercase;color:#42615f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}h1{flex-shrink:0;font-size:56px;line-height:1.08;letter-spacing:-1.7px;margin:26px 0;max-height:182px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.body{flex:1;min-height:0;font-size:29px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto}nav{position:absolute;bottom:0;left:0;right:0;height:90px;display:flex;align-items:center;gap:18px;padding:12px 44px;background:#e5ebe5;border-top:1px solid #ccd7cf}.step{border:1px solid #a7bbb1;border-radius:8px;padding:10px 16px;background:#fff;color:#183e3d;cursor:pointer}.step:disabled{opacity:.4;cursor:default}.dots{display:flex;align-items:center;justify-content:center;gap:9px;flex:1;flex-wrap:wrap;max-height:56px}.dot{width:13px;height:13px;border:1px solid #527773;border-radius:50%;padding:0;background:transparent;cursor:pointer}.dot[aria-current=true]{background:#247b79}button:focus-visible{outline:3px solid #225cba;outline-offset:4px}#counter{font-size:18px;min-width:67px;text-align:center;color:#305450}
</style></head><body><main id="stage" aria-label="${escape(deck.title)}">${sections}<nav aria-label="Slide navigation"><button type="button" id="previous" class="step" aria-label="Previous slide">← Previous</button><div class="dots">${dots}</div><span id="counter" aria-live="polite">1 / ${deck.slides.length}</span><button type="button" id="next" class="step" aria-label="Next slide">Next →</button></nav></main><script>${SLIDES_NAVIGATION_SCRIPT}</script></body></html>`;
}

import DOMPurify from "dompurify";

// Static, offline previews only. This policy belongs inside the opaque-origin
// sandboxed iframe; never reuse the HTML as markup in the parent application.
export const WEBPAGE_PREVIEW_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function buildWebpagePreview(content: string): string {
  // Fragment sanitization loses head styles from complete generated documents.
  // Whole-document mode preserves them while DOMPurify removes event handlers.
  const clean = DOMPurify.sanitize(content, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "meta", "base", "link", "svg", "math"],
    FORBID_ATTR: ["src", "srcset", "action", "formaction", "poster", "xlink:href", "ping", "background", "srcdoc", "target", "download"],
  });
  const doc = new DOMParser().parseFromString(clean, "text/html");
  // Permit navigation within this document, never to another website. Keep only
  // simple mailto addresses (no headers/body or protocol tricks). Sandbox still
  // prevents top navigation, popups, scripts and form submission.
  for (const element of doc.querySelectorAll("[href]")) {
    const href = element.getAttribute("href") || "";
    const fragment = /^#[^\s"'<>`]*$/u.test(href);
    const email = /^mailto:[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(href);
    if (element.tagName !== "A" || (!fragment && !email)) element.removeAttribute("href");
    else if (fragment) element.setAttribute("href", "about:srcdoc" + href);
  }
  // Trusted CSP comes first, before any preserved styles. No external resource
  // URLs can load, even when they occur in CSS url(), @import or escaped tokens.
  const policy = `<meta http-equiv="Content-Security-Policy" content="${WEBPAGE_PREVIEW_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1">`;
  return `<!doctype html><html><head>${policy}${doc.head.innerHTML}</head>${doc.body.outerHTML}</html>`;
}

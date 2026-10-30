import { useEffect, useMemo, useRef } from "react";
import type { SlideDeck } from "./types";
// Shared pure renderer: the browser and server use exactly the same CSP/script.
import { buildSlidesHtml as renderHtml, parseSlidesContent as parseContent } from "../server/slides.mjs";

export const parseSlidesContent: (content: string) => SlideDeck = parseContent;
export const buildSlidesHtml: (content: string | SlideDeck) => string = renderHtml;

export function SlidesPreview({ content, title }: { content: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const result = useMemo(() => {
    try { return { html: buildSlidesHtml(content), error: "" }; }
    catch (e) { return { html: "", error: e instanceof Error ? e.message : "Invalid Slides content." }; }
  }, [content]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      // Opaque-origin iframe messages have origin "null". Check the actual
      // source window, never trust message data or a shared null origin alone.
      if (!frame.current || event.source !== frame.current.contentWindow || event.data?.type !== "close-fullscreen") return;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  if (result.error) return <p role="alert">{result.error}</p>;
  return <iframe ref={frame} className="local-web-frame" title={title + " · Slides"} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={result.html} />;
}

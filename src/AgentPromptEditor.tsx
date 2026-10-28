import { useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { Modal } from "./ui";

const promptTags = ["p", "br", "strong", "b", "em", "i", "s", "strike", "code", "pre", "blockquote", "h1", "h2", "h3", "ul", "ol", "li", "hr"];
export function sanitizePromptHtml(value: string) {
  const container = document.createElement("div");
  container.innerHTML = DOMPurify.sanitize(typeof value === "string" ? value : "", { ALLOWED_TAGS: [...promptTags, "div"], ALLOWED_ATTR: [] });
  // Native contenteditable and clipboard HTML use DIV for line boundaries.
  // Convert the boundaries before removing wrappers, otherwise lines concatenate.
  for (const div of [...container.querySelectorAll("div")].reverse()) {
    const fragment = document.createDocumentFragment();
    const previous = div.previousSibling;
    const isBoundary = previous?.nodeType === Node.ELEMENT_NODE && /^(BR|P|DIV|H[1-6]|PRE|BLOCKQUOTE|UL|OL|LI|HR)$/.test((previous as Element).tagName);
    if (previous && !isBoundary) fragment.append(document.createElement("br"));
    while (div.firstChild) fragment.append(div.firstChild);
    fragment.append(document.createElement("br"));
    div.replaceWith(fragment);
  }
  return DOMPurify.sanitize(container.innerHTML, { ALLOWED_TAGS: promptTags, ALLOWED_ATTR: [] });
}
export function promptTextFromHtml(html: string) {
  const container = document.createElement("div");
  container.innerHTML = html;
  let text = "";
  const newline = () => { if (text && !text.endsWith("\n")) text += "\n"; };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { text += node.textContent || ""; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName;
    if (tag === "BR") { text += "\n"; return; }
    const block = /^(P|H[1-6]|PRE|BLOCKQUOTE|UL|OL|LI|HR)$/.test(tag);
    if (block) newline();
    for (const child of node.childNodes) visit(child);
    if (block) newline();
  };
  for (const node of container.childNodes) visit(node);
  return text.replace(/\u00a0/g, " ").replace(/\r\n/g, "\n").trim();
}
function escapeText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/** Transactional browser-native rich editor; no prompt execution or network calls. */
export default function AgentPromptEditor({ text, html, onApply, onClose }: {
  text: string;
  html: string;
  onApply: (text: string, html: string) => void;
  onClose: () => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editor.current) {
      editor.current.innerHTML = html ? sanitizePromptHtml(html) : "<p>" + escapeText(text).replace(/\n/g, "<br>") + "</p>";
      editor.current.focus();
    }
  }, []);
  const command = (name: string, value?: string) => {
    editor.current?.focus();
    document.execCommand(name, false, value);
  };
  const tools: [string, string, string?][] = [
    ["Heading 1", "formatBlock", "h1"], ["Heading 2", "formatBlock", "h2"], ["Heading 3", "formatBlock", "h3"],
    ["Bold", "bold"], ["Italic", "italic"], ["Strikethrough", "strikeThrough"],
    ["Inline code", "code"], ["Bullet list", "insertUnorderedList"], ["Ordered list", "insertOrderedList"],
    ["Blockquote", "formatBlock", "blockquote"], ["Code block", "formatBlock", "pre"],
    ["Horizontal rule", "insertHorizontalRule"], ["Undo", "undo"], ["Redo", "redo"],
  ];
  return <Modal title="System prompt" onClose={onClose} wide footer={<>
    <button type="button" className="btn" onClick={onClose}>Close</button>
    <button type="button" className="btn primary" onClick={() => {
      const clean = sanitizePromptHtml(editor.current?.innerHTML || "");
      const plain = promptTextFromHtml(clean);
      onApply(plain, plain ? clean : "");
    }}>OK</button>
  </>}>
    <div className="prompt-editor-toolbar" role="toolbar" aria-label="Prompt formatting">
      {tools.map(([label, name, value]) => <button type="button" className="btn small" key={label} aria-label={label} title={label}
        onMouseDown={e => e.preventDefault()} onClick={() => {
          if (name === "code") {
            const selection = getSelection();
            const code = selection && editor.current?.contains(selection.anchorNode) ? selection.toString() : "";
            command("insertHTML", "<code>" + escapeText(code || "code") + "</code>");
          } else command(name, value);
        }}>{label}</button>)}
    </div>
    <div ref={editor} className="prompt-rich-editor" contentEditable suppressContentEditableWarning role="textbox" aria-label="System prompt" aria-multiline="true"
      onPaste={e => {
        e.preventDefault();
        const html = e.clipboardData.getData("text/html");
        if (html) command("insertHTML", sanitizePromptHtml(html));
        else command("insertText", e.clipboardData.getData("text/plain"));
      }}
      onDrop={e => {
        e.preventDefault();
        const html = e.dataTransfer.getData("text/html");
        if (html) command("insertHTML", sanitizePromptHtml(html));
        else command("insertText", e.dataTransfer.getData("text/plain"));
      }} />
    <p className="demo-note">Edits apply only when you choose OK. Closing discards this edit; nothing is sent to a model.</p>
  </Modal>;
}

import { useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { Modal } from "./ui";

export function sanitizePromptHtml(value: string) {
  return DOMPurify.sanitize(value, {
    ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "s", "strike", "code", "pre", "blockquote", "h1", "h2", "h3", "ul", "ol", "li", "hr"],
    ALLOWED_ATTR: [],
  });
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
      const plain = editor.current?.innerText.trim() || "";
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

import type { ReactNode } from "react";

/** Small, escaped Markdown subset. Raw HTML and remote images never execute here. */
function inline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g);
  return parts.map((part, i) => {
    if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>;
    return part;
  });
}
export default function AnswerMarkdown({ content }: { content: string }) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const result: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], key = i;
    if (/^\s*```/.test(line)) {
      const language = line.trim().slice(3), code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      result.push(<pre key={key} aria-label={language ? language + " code" : "Code"}><code>{code.join("\n")}</code></pre>); continue;
    }
    if (!line.trim()) continue;
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { const text = inline(heading[2]); result.push(heading[1].length === 1 ? <h2 key={key}>{text}</h2> : heading[1].length === 2 ? <h3 key={key}>{text}</h3> : <h4 key={key}>{text}</h4>); continue; }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line), items: ReactNode[] = [];
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      do { items.push(<li key={i}>{inline(lines[i].replace(pattern, ""))}</li>); i++; } while (i < lines.length && pattern.test(lines[i]));
      i--; result.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>); continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || "")) {
      const cells = (value: string) => value.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(s => s.trim());
      const headings = cells(line), rows: string[][] = []; i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      i--; result.push(<div className="rt-answer-table" key={key}><table><thead><tr>{headings.map((cell, n) => <th key={n}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, n) => <tr key={n}>{row.map((cell, j) => <td key={j}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    if (/^>\s?/.test(line)) { result.push(<blockquote key={key}>{inline(line.replace(/^>\s?/, ""))}</blockquote>); continue; }
    result.push(<p key={key}>{inline(line)}</p>);
  }
  return <div className="rt-markdown">{result}</div>;
}

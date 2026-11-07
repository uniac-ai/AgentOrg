import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remend from "remend";

const PLUGINS = [remarkGfm];

/**
 * Markdown as an agent writes it, GitHub-flavored (tables, lists, strikethrough), safe to render
 * as it streams: remend first closes what is still open (a `**` without its pair, an unfinished
 * fence or table row), so a reply doesn't flicker between markup and text. Raw HTML is shown as
 * text, never rendered.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="kit-md">
      <ReactMarkdown remarkPlugins={PLUGINS}>{remend(text)}</ReactMarkdown>
    </div>
  );
}

import { useLayoutEffect, useRef } from "react";
import { MusicPlayer, musicJobId } from "./MusicPlayer";
import { Markdown } from "./Markdown";
import { api } from "../api";
import type { Item } from "../transcript";
import { t } from "../i18n";
import { assistantText } from "../voice";
import { splitContext } from "../context-blocks";

/** How much of the conversation the window shows: enough to find what was just said. */
const SHOWN = 30;

/**
 * The conversation so far, in a window beside the orb like Files and pictures.
 *
 * Voice mode puts the chat away, and with it any way to check what was
 * understood or to read a number that went by too fast. This shows it
 * without ending voice mode: what was said, as transcribed, and what
 * came back, as written — which is also the only way to see a reply that was
 * interrupted before it was spoken, or the error that took its place.
 *
 * A reply is markdown, as in the chat, so a list or a code block is not a flat
 * string beside the orb, and sits in a speech bubble like what you said.
 */
export function VoiceConversation({ sessionId, items }: { sessionId: string; items: Item[] }) {
  // Reuse the main chat's framing parser, showing only the person's words here.
  const list = items
    .map(item => item.kind === "user" ? { ...item, text: splitContext(item.text).text } : item)
    .filter(item => (item.kind === "user" && (item.text || item.images?.length)) || (item.kind === "assistant" && item.text.trim()) || (item.kind === "tool" && musicJobId(item.output)) || (item.kind === "notice" && item.tone === "error"))
    .slice(-SHOWN);
  const viewport = useRef<HTMLDivElement>(null);
  const last = list.at(-1);
  const lastLength = last?.kind === "assistant" ? last.text.length : 0;
  useLayoutEffect(() => {
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last?.id, lastLength]);
  return <div ref={viewport} className="voice-conversation-list">
      {!list.length && <p className="voice-conversation-empty">{t("Nothing has been said yet.")}</p>}
      {list.map(item => item.kind === "user"
        ? <div key={item.id} className="voice-said is-user">
            {item.text && <p>{item.text}</p>}
            {item.images?.length ? <div className="voice-said-pictures">{item.images.map(image => <img key={image.name} src={api.imageUrl(sessionId, image.name)} alt="" loading="lazy" />)}</div> : null}
          </div>
        : item.kind === "assistant"
          ? <div key={item.id} className="voice-said is-agent md">
              {/* Markdown, as in the chat: a reply is shown while it is
                  written, so its unclosed fence or half-written link has to
                  render as what it is about to be, not flicker. */}
              <Markdown parseIncompleteMarkdown isAnimating={!item.done}>{assistantText(item)}</Markdown>
            </div>
          : item.kind === "tool" && musicJobId(item.output)
            ? <div key={item.id} className="w-full min-w-0" data-voice-music-job={musicJobId(item.output)}>
                <MusicPlayer sessionId={sessionId} jobId={musicJobId(item.output)!} controlsOnly />
              </div>
          : item.kind === "notice"
            // A failure, which the chat shows as a line of its own and voice mode would otherwise only have said.
            ? <div key={item.id} role="alert" className="voice-said is-error">{item.portal ? t(item.text) : item.text}</div>
            : null)}
  </div>;
}

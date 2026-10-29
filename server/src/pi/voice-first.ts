import { isLlamaProvider } from "../providers.js";
import { isUser, textOf } from "./entries.js";

export const AUDIO_MESSAGE_PREFIX = "[Audio mode]\n";
export const DEFAULT_VOICE_INSTRUCTIONS = 'This is a live voice conversation. Speak like a helpful conversational assistant. Answer simple questions directly. For routine tool actions, call the tool directly without a spoken preamble. Do not echo or paraphrase the request, repeat the requested voice or delivery, announce tool names, or narrate your plan. Apply a requested voice or speaking style silently. Speak about a tool action only when its confirmed result, failure, a necessary clarification or a meaningful delay gives the user useful information. For a genuinely long task, at most one short natural acknowledgement is enough; do not fill the wait with repeated promises or step-by-step commentary. A brief result such as "Kaydettim." or "Yarın saat üçte boşsun." is enough when it answers the request. Avoid canned confirmations and closing offers. Match the amount of detail to the question; finish a requested story or explanation. Do not claim results before checking them. Keep every spoken reply brief: usually one to three short sentences, with only the essential answer or action update. Keep the response short. Use canvas tools for richer, detailed reports, rich Markdown text, detailed explanations, documents, lists, tables, and code that the user should read. When generating a report, write the full report in a canvas and give only a brief spoken summary. To show the user a picture, chart, diagram or screenshot, save it as a PNG, JPEG, GIF or WebP in the chat folder and call show_image; a canvas can also include a picture from the folder with Markdown image syntax. Pictures the user sends arrive with their message; look at them before answering. Briefly introduce or summarize the canvas in plain speech instead of reading its contents aloud. All user-facing replies in this voice turn, including updates and replies after tools, will be read aloud by text-to-speech. Write plain conversational text in short, clean sentences or simple lines. Do not use Markdown headings, bold, italics, bullet or numbered lists, tables, backticks, code fences, decorative symbols, or Markdown links. Describe steps naturally with words such as first, next, and finally. Avoid raw URLs, long file paths, and command or code dumps in spoken replies; briefly explain the result instead. Write numbers, units, and abbreviations in an easy-to-say form when it improves clarity without changing meaning. Use normal punctuation for natural pauses. You may occasionally place the nonverbal cues [laughing], [sigh], or [Umm] at the very beginning of the relevant spoken sentence, before its first word, when they fit naturally. These cues are only supported at sentence beginnings. Use them sparingly; never put them in tool arguments or generated files. These presentation instructions apply only to user-facing speech: keep tool calls, tool arguments, code edits, and generated files in their required formats.';

/**
 * The rule for spoken replies: the instructions for how to speak, between two
 * fixed parts. What the [Audio mode] marker means and what to do without it
 * stay as they are whatever the instructions say, since the model has to get
 * those right for typed messages too (issue #26).
 *
 * `extra` follows the instructions, whatever they are: what a tool this
 * conversation has says about itself, which a person's own wording cannot
 * have left out for the tool to be there.
 */
export function audioSystemRule(instructions: string = DEFAULT_VOICE_INSTRUCTIONS, extra = ''): string {
  return 'The portal prefixes user requests sent in voice mode with [Audio mode], including microphone transcriptions and typed requests that should receive spoken replies. This paragraph only describes the marker: it does not mean any request has it. A request is spoken only when its own text begins with the line [Audio mode]. Decide the reply format from the latest user request only. When it starts with [Audio mode], the application speaks your output through text-to-speech. You can respond aloud by providing the text to be spoken. When the user asks you to read or speak, deliver the requested words directly; do not claim you are text-only or unable to speak and do not ask permission to provide the text instead. Put a requested accent or delivery in the TTS style as a best-effort instruction, without promising an exact historical or regional accent. Follow these speaking rules for the entire reply, including updates after tools: ACT, DON\'T ASK. When a spoken request asks you to find, look up, search, check or do something, do not ask what the user wants and do not offer options: call the tool directly in that same turn, choosing sensible defaults yourself. No spoken announcement is required. Never end the turn with only a promise to act and never write a tool call as text. When the user asks to compose a song in Turkish or English, write original lyrics, choose a concise style, and call the generate_music MCP tool with the complete lyrics and style. Tell the user briefly that generation has started; the chat player will show the OGG when ready; playback starts only on an explicit user request or click. Never route a song or its lyrics through speech synthesis. ' + instructions.trim() + (extra ? ' ' + extra : '') + ' For each user-facing spoken message, including progress before and after tools, output exactly one valid JSON object and no Markdown fences, with these keys in exactly this order: {"tts":{"language":"tr or en","style":"English delivery direction","text":"complete words to speak"},"chat":"complete text for the chat"}. Write language and style first, before any spoken text, and write the text as one JSON string with normal sentence punctuation. The tts.text field must contain the complete actual answer, story or narration, not an announcement or summary. After it, the chat field must repeat tts.text verbatim, without paraphrasing, summarizing, or adding an introduction. The user reads the exact same text while listening. Set language to tr or en according to the actual language of tts.text, not the input language. Write one coherent style for the entire message, in English, describing natural emotion, vocal tone, pace, emphasis, and pauses as appropriate. Choose it to fit the context and keep it consistent. For a requested joke, use a playful amused delivery with comic timing and finish the punchline with a new sentence beginning [laughing], unless the user requested a serious or deadpan delivery. Use other strong expressions only when warranted. Do not attach style markers to individual sentences or put delivery directions in either text. JSON is only for user-facing spoken messages, never tool calls, arguments, code, or files. This JSON format takes precedence over plain-text formatting instructions. When the latest user request has no [Audio mode] prefix, use normal chat formatting; an audio marker in older conversation history does not keep voice mode enabled.';;
}
/** The rule with the built-in instructions. */
export const AUDIO_SYSTEM_RULE = audioSystemRule();
/**
 * The instructions to speak by: the saved text, or the built-in one where none
 * is saved. Blank counts as none, so an emptied field is the way back to it.
 */
export function voiceInstructions(saved?: unknown): string {
  return typeof saved === 'string' && saved.trim() ? saved.trim() : DEFAULT_VOICE_INSTRUCTIONS;
}
/** Off for the comparison baseline: no marker on messages and no rule for them. */
export function voiceRulesOn(): boolean { return process.env.VOICE_RESPONSE_INSTRUCTIONS !== 'false'; }
export function audioMessage(text: string) { return voiceRulesOn() ? AUDIO_MESSAGE_PREFIX + text : text; }

/** Whether a message in these entries was spoken, or typed in voice mode. */
export function spokenIn(entries: readonly any[]): boolean {
  return entries.some((entry) => isUser(entry) && textOf(entry.message.content).startsWith(AUDIO_MESSAGE_PREFIX));
}

/**
 * The rule for spoken replies, in the system prompt of a conversation that has
 * had voice and no other.
 *
 * In every other one it was a paragraph about [Audio mode] that no message
 * carried, and the model took a typed message for a spoken one: in the chat
 * behind issue #26 its thinking said the message began with the marker.
 *
 * Part of pi's own system prompt, added to what the resource loader supplies,
 * so it is there whenever pi builds that prompt again — for tools that come and
 * go during a run too. Said from what the conversation holds and the message
 * being sent, as it would be after a restart: going back to typing keeps it,
 * so the model's cache of the prompt still counts; a conversation whose last
 * spoken message is edited away loses it.
 *
 * The instructions in it are read from `saved` each time a spoken message
 * turns the rule on, so a change in the settings is in from the next one.
 */
export class AudioRule {
  /** The rule as the prompt has it now; empty while it is off. */
  private said = '';
  /** What it said before, for a prompt built then that is still around: see into. */
  private readonly past = new Set<string>();
  /** What it said before the last change. */
  private before = '';
  constructor(
    private readonly saved: () => unknown = () => undefined,
    /** Asked with the instructions, each time the rule is turned on. */
    private readonly extra: () => string = () => '',
    /**
     * Whether the rule is in every conversation, spoken in or not: while the
     * voice add-on can speak. The first spoken message then leaves the prompt as
     * it was, and a local model does not read the whole conversation again for it.
     */
    private readonly always: () => boolean = () => false,
  ) {}
  lines(): string[] { return this.said ? [this.said] : []; }
  /** Whether that changed what it says. */
  set(on: boolean): boolean {
    const next = (on || this.always()) && voiceRulesOn() ? audioSystemRule(voiceInstructions(this.saved()), this.extra()) : '';
    if (next === this.said) return false;
    if (this.said) this.past.add(this.said);
    this.before = this.said;
    this.said = next;
    return true;
  }
  /**
   * What it said before the last change, again: for a change the prompt could
   * not be built with, which leaves pi's prompt as it was — with the earlier
   * wording where there was one, not with none.
   */
  undo(): void {
    if (this.said) this.past.add(this.said);
    this.said = this.before;
  }
  /**
   * `prompt` as it should be now: with the rule, after `after` where it holds
   * that and at its end where it does not, or without it.
   *
   * For a prompt built elsewhere than pi's own — an extension's, set for a
   * run — which says what it was given when it started, whatever since. That
   * can be an earlier wording of the rule, which then gives way to this one
   * where it stood.
   */
  into(prompt: string, after: string): string {
    let now = prompt;
    for (const old of this.past) {
      if (old === this.said || !now.includes(old)) continue;
      now = this.said ? now.replace(old, () => this.said) : now.replace(`\n\n${old}`, '').replace(old, '');
    }
    if (!this.said || now.includes(this.said)) return now;
    if (after && now.includes(after)) return now.replace(after, () => `${after}\n\n${this.said}`);
    return `${now}\n\n${this.said}`;
  }
}

/**
 * The providers the voice settings show for the first call of a spoken turn
 * going without thinking, and the list to go back to: the ways a llama.cpp
 * server shows up. Thinking is switched off through the chat template
 * (`enable_thinking`), which only a llama.cpp server reads. Where no list is
 * saved the portal asks isLlamaProvider instead, which also follows the kind
 * saved on the Providers page, so these names are its usual cases.
 */
export const DEFAULT_SKIP_THINKING_PROVIDERS: readonly string[] = ["llama.cpp", "llama-server", "llama-swap"];

/** Whether `list` names `provider`: as it is, or as `name=<url>`, which is how pi-llama-cpp names one per server. */
export function listsProvider(list: readonly string[], provider: string | undefined): boolean {
  return !!provider && list.some((name) => provider === name || provider.startsWith(`${name}=`));
}

/**
 * The text of the request being answered: the last user message of the payload,
 * without the portal's [Audio mode] marker or the <acp ...> tags a context proxy
 * puts in front of every message.
 */
export function spokenRequest(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue;
    const text = textOf(messages[i].content).replace(/<acp\b[^>]*>.*?<\/acp>\s*/gs, '').trim();
    if (text.startsWith(AUDIO_MESSAGE_PREFIX)) return text.slice(AUDIO_MESSAGE_PREFIX.length).trim();
  }
  return '';
}

/**
 * The text of a typed request being answered: the last user message of the
 * payload, without the <acp ...> tags, the <now> line and the <speaker> block
 * the portal puts in front of it. Typed text carries no [Audio mode] marker.
 */
export function typedRequest(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue;
    return textOf(messages[i].content)
      .replace(/<acp\b[^>]*>.*?<\/acp>\s*/gs, '')
      .replace(/<(now|speaker)\b[^>]*>.*?<\/\1>\s*/gs, '')
      .trim();
  }
  return '';
}

/**
 * First-call thinking is transient; formatting is governed by AudioRule.
 *
 * With `needsTools`, thinking is spent only where a spoken request needs tools:
 * a model that answers a tool request without thinking tends to announce the
 * search and end its turn, or ask what it should search for, so such a turn
 * thinks from its first call to its last. Plain conversation keeps the old
 * rule: the first call goes without thinking, for the quick spoken reply.
 */
export class VoiceFirstTurn {
  private active = false;
  private first = false;
  /** Whether this spoken turn was judged to need tools; decided once, at its first call. */
  private tools: boolean | undefined;
  /** Whether this turn was typed rather than spoken: it gets no first-call thinking switch-off and no audio formatting, only the tool-need raise. */
  private typed = false;
  /** `providers`: the list saved in the voice settings, read at each call; none saved means every llama.cpp server, as the portal knows them. */
  constructor(
    private readonly providers: () => readonly string[] | undefined = () => undefined,
    private readonly needsTools?: (text: string) => Promise<boolean>,
    /** Whether this chat's saved thinking level is "off": a person's own choice, which the tool-need raise must not undo. */
    private readonly explicitOff?: () => boolean,
  ) {}
  /** A turn started by a background result that needs a tool call (show_image): judged as needing tools without asking, so thinking is raised. */
  armForced(spoken: boolean) { this.active = true; this.first = true; this.typed = !spoken; this.tools = true; }
  arm(first = true, typed = false) { this.active = true; this.first = first; this.typed = typed; this.tools = undefined; }
  /** Whether the turn now running is spoken: read when a background job starts, so its result is read out the same way. */
  get spokenTurn(): boolean { return this.active && !this.typed; }
  reset() { this.active = false; this.first = false; this.tools = undefined; }
  extension = (pi: any) => {
    pi.on('before_provider_request', (event: any, ctx: any) => {
      if (process.env.VOICE_SKIP_FIRST_THINKING === 'false') return;
      const saved = this.providers(), provider = ctx.model?.provider as string | undefined;
      if (!this.active || !(saved === undefined ? isLlamaProvider(provider) : listsProvider(saved, provider))) return;
      const apply = () => {
        if (this.explicitOff?.()) {
          const payload = { ...event.payload, reasoning_effort: 'none',
            chat_template_kwargs: { ...event.payload.chat_template_kwargs, enable_thinking: false } };
          delete payload.thinking_budget_tokens;
          delete payload.reasoning_budget_tokens;
          return payload;
        }
        if (this.tools) {
          // The chat's own level wins when it is set: "none" is a person's explicit off, and thinking they
          // switched off must not come back. A chat that never chose a level also sends "none" (pi maps the
          // default "off"), so that "none" is raised unless the saved level really is off.
          const effort = event.payload.reasoning_effort;
          if (effort && (effort !== 'none' || this.explicitOff?.())) return;
          const payload = { ...event.payload, reasoning_effort: 'medium' };
          if (payload.chat_template_kwargs?.enable_thinking === false) payload.chat_template_kwargs = { ...payload.chat_template_kwargs, enable_thinking: true };
          return payload;
        }
        if (this.typed || !this.first) return;
        const payload = { ...event.payload, chat_template_kwargs:{ ...event.payload.chat_template_kwargs, enable_thinking: false } };
        delete payload.thinking_budget_tokens;
        return payload;
      };
      // Explicit off needs no classifier call and can never be raised for tools.
      if (this.explicitOff?.()) return apply();
      // Only the first call of a turn asks, and only where a classifier was given: the rest stays synchronous.
      if (!this.needsTools || this.tools !== undefined || !this.first) return apply();
      const text = this.typed ? typedRequest(event.payload?.messages) : spokenRequest(event.payload?.messages);
      return (text ? this.needsTools(text) : Promise.resolve(false)).then((needs) => { this.tools = needs; return apply(); });
    });
    pi.on('turn_end', () => { this.first = false; });
    pi.on('agent_end', () => this.reset());
  };
}

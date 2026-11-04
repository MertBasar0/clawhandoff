// Only top-level lines can mark a turn, and only a top-level fenced block can report its result.
function* browserMarkdownParts(text: string) {
  let fence = "";
  let info = "";
  let opensAtMargin = false;
  let bodyStart = 0;
  let offset = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const end = offset + rawLine.length;
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1]!.startsWith(fence) && !match[2]) {
        // An indented fence can be a list example. It hides markers, but cannot own a result.
        if (opensAtMargin && line.startsWith(fence)) {
          yield { kind: "block" as const, info, bodyStart, bodyEnd: offset, end };
        }
        fence = "";
      }
    } else if (match && !(match[1]![0] === "`" && match[2]!.includes("`"))) {
      fence = match[1]!;
      opensAtMargin = line.startsWith(fence);
      info = match[2]!.trim().toLowerCase();
      bodyStart = end + 1;
    } else {
      yield { kind: "line" as const, text: line, start: offset };
    }
    offset = end + 1;
  }
}

// Keep the current marker itself in the stored receipt. A later reply marker makes
// ownership ambiguous (null); unrelated bubbles have no match (undefined).
function browserReplySection(text: string, expected: string): string | null | undefined {
  let start = -1;
  for (const part of browserMarkdownParts(text)) {
    if (part.kind !== "line") continue;
    if (start >= 0 && /^Bridge-Reply: \S+$/.test(part.text)) return null;
    if (part.text === expected) start = part.start;
  }
  return start >= 0 ? text.slice(start) : undefined;
}

export function terminalBrowserResultJson(text: string): string | undefined {
  const reply = text.trimEnd();
  for (const part of browserMarkdownParts(reply)) {
    if (part.kind === "block" && part.info === "handoff-result" && part.end === reply.length) {
      return reply.slice(part.bodyStart, part.bodyEnd).trim();
    }
  }
  return undefined;
}

// Runs in the operator's selected chat tab. Read only the rendered transcript, never browser
// credentials, page stores or network APIs. OpenClaw's copy-as-Markdown text retains code fences.
export const browserTranscriptScript = String.raw`(expectedUrl, turnKey) => {
  const browserMarkdownParts = ${browserMarkdownParts};
  const replySection = ${browserReplySection};
  const url = location.href;
  const page = { url, ready: false, busy: false, messages: [] };
  if (url !== expectedUrl) return page;
  // The router can retain the previous chat's DOM in an inactive pane.
  const threads = Array.from(document.querySelectorAll('main .chat-thread[role="log"]')).filter(thread => {
    const pane = thread.closest('.chat-pane-cache__pane');
    return (!pane || pane.classList.contains('chat-pane-cache__pane--active')) &&
      !thread.closest('[inert], [aria-hidden="true"]');
  });
  if (threads.length !== 1) return page;
  const thread = threads[0], scope = thread.closest('.chat-pane-cache__pane') || thread.closest('main');
  const outsideThread = sel => {
    const el = scope.querySelector(sel);
    return el && !el.closest('.chat-thread') ? el : null;
  };
  // The question dock and queue editor can both precede the real composer in this pane.
  const composers = Array.from(scope.getElementsByTagName('textarea')).filter(el =>
    el.getAttribute('aria-autocomplete') === 'list' && el.closest('.agent-chat__input--chat') &&
    !el.closest('.chat-thread, [inert], [hidden], [aria-hidden="true"]'));
  if (thread.classList.contains('chat-thread--route-loading') || composers.length !== 1) return page;
  const composerLabel = composers[0].getAttribute('aria-label')?.trim();
  if (!composerLabel) return page;
  const sendBtn = outsideThread('button.chat-send-btn--send:not(.chat-send-btn--dictation-commit)');
  const stopBtn = outsideThread('button.chat-send-btn--stop');
  page.ready = true;
  page.busy = !!(stopBtn || scope.querySelector('.chat-send-btn--stop, .chat-send-btn--sending, [data-chat-streaming="true"]'));
  page.controls = {
    composerLabel,
    sendLabel: sendBtn ? (sendBtn.getAttribute('aria-label') || sendBtn.textContent || '').trim() : '',
    stopLabel: stopBtn ? (stopBtn.getAttribute('aria-label') || stopBtn.textContent || '').trim() : '',
  };
  if (!turnKey) return page; // Preflight and send control discovery only need readiness.
  const bubbles = Array.from(thread.querySelectorAll('.chat-bubble[data-message-id]')).slice(-64);
  for (const bubble of bubbles) {
    if (bubble.parentElement.closest('.chat-bubble[data-message-id]')) continue;
    const group = bubble.closest('.chat-group');
    if (!group) continue;
    const user = group.classList.contains('user');
    if (!user && (!group.classList.contains('assistant') ||
        group.matches('.chat-group--forwarded, .chat-group--turn-block'))) continue;
    const raw = bubble.getAttribute('data-message-text') || '';
    const firstLine = raw.split('\n', 1)[0].trimEnd();
    const settledFooter = user || (!group.hasAttribute('data-chat-streaming') &&
      !bubble.classList.contains('streaming') &&
      !!group.querySelector(':scope > .chat-group-footer:not([aria-hidden="true"]) .chat-group-footer__meta'));
    const fullMsg = !user && bubble.messageActions && bubble.messageActions.fullMessage;
    const loading = !!fullMsg && (!fullMsg.state || fullMsg.state.status !== 'loaded') &&
      !bubble.querySelector('.chat-message-load-error');
    // Keep other turns' boundaries without copying their contents out of the browser.
    const ownRequest = user && !group.classList.contains('chat-group--peer') &&
      firstLine === "Bridge-Turn: " + turnKey;
    const sendStatus = ownRequest ? group.querySelector('[data-send-state]') : null;
    const sendState = sendStatus ? (sendStatus.getAttribute('data-send-state') || 'unconfirmed') : '';
    const reply = !user && settledFooter && !loading && raw.length <= 256000
      ? replySection(raw, "Bridge-Reply: " + turnKey) : undefined;
    page.messages.push({
      role: user ? 'user' : 'assistant', text: ownRequest ? firstLine : reply ?? '',
      ...(reply === null ? { ambiguousReply: true } : {}),
      ...(sendState ? { sendState, ...(sendState !== 'waiting-reconnect' ? { unconfirmed: true } : {}) } : {}),
      ...(!user && !settledFooter ? { settling: true } : {}),
      ...(loading ? { loading: true } : {}),
    });
  }
  return page;
}`;

export function wrapBrowserPrompt(idempotencyKey: string, prompt: string): string {
  return [
    `Bridge-Turn: ${idempotencyKey}`,
    "",
    prompt,
    "",
    "For this browser handoff, start your final answer with the following plain-text line by itself.",
    `Bridge-Reply: ${idempotencyKey}`,
    "Then give your assessment and finish with the required handoff-result JSON block. Start both fence lines in column one.",
  ].join("\n");
}

export interface BrowserTurnObservation {
  state: "absent" | "pending" | "running" | "completed" | "uncertain";
  text?: string;
}

interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  unconfirmed?: boolean;
  ambiguousReply?: boolean;
  sendState?: string;
  settling?: boolean;
  loading?: boolean;
}

export function inspectBrowserTurn(snapshot: string, idempotencyKey: string): BrowserTurnObservation {
  const page = JSON.parse(snapshot) as { ready: boolean; busy: boolean; messages: TranscriptMessage[] };
  if (!page.ready) return { state: "uncertain" };
  const request = `Bridge-Turn: ${idempotencyKey}`;
  const reply = `Bridge-Reply: ${idempotencyKey}`;
  const requests = page.messages.flatMap((message, index) =>
    message.role === "user" && message.text === request ? [index] : []);
  if (requests.length === 0) return { state: "absent" };
  if (requests.length !== 1) return { state: "uncertain" };

  const requestIndex = requests[0]!;
  const requestMsg = page.messages[requestIndex];
  if (requestMsg?.sendState === "waiting-reconnect") return { state: "pending" };
  // The control UI can display optimistic, queued or failed sends as ordinary user bubbles.
  if (requestMsg?.unconfirmed || requestMsg?.sendState) return { state: "uncertain" };
  const later = page.messages.slice(requestIndex + 1);
  const nextUser = later.findIndex(message => message.role === "user");
  const answers = nextUser < 0 ? later : later.slice(0, nextUser);
  let matched: string | undefined;
  for (const message of answers) {
    if (message.role !== "assistant" || message.settling || message.loading) continue;
    const section = browserReplySection(message.text, reply);
    if (message.ambiguousReply || section === null) return { state: "uncertain" };
    if (section === undefined) continue;
    if (matched !== undefined) return { state: "uncertain" };
    matched = section;
  }
  if (nextUser < 0 && (page.busy || answers.some(message => message.settling || message.loading))) {
    return { state: "running" };
  }
  if (matched !== undefined) {
    // The ordinary bridge result parser handles a missing/malformed result conservatively.
    return { state: "completed", text: matched };
  }
  return { state: nextUser >= 0 || answers.length > 0 ? "uncertain" : "running" };
}

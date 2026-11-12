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
export const browserTranscriptScript = String.raw`(expectedUrl, turnKey, uuidRoute) => {
  const browserMarkdownParts = ${browserMarkdownParts};
  const replySection = ${browserReplySection};
  const url = location.href.replace(/\?openclaw_mount_recovery=\d+$/, "");
  // health starts as "loading" and becomes "ready" only once everything below checks out.
  const page = { url, ready: false, busy: false, health: 'loading', messages: [] };
  if (location.protocol === 'chrome-error:') {
    page.health = 'error_page';
    return page;
  }
  const offline = typeof navigator === 'object' && navigator && navigator.onLine === false;
  const shown = el => !!el && !el.closest('[inert], [hidden], [aria-hidden="true"]');
  const sameUuidRoute = !!uuidRoute && url.startsWith(uuidRoute.prefix) && (() => {
    const tail = url.slice(uuidRoute.prefix.length);
    if (!tail || /[/?#]/.test(tail)) return false;
    try {
      const seg = decodeURIComponent(tail.startsWith("~~") ? tail.slice(1) : tail);
      return !["main", "global", "boot", "sessions"].includes(seg.toLowerCase()) &&
        /^(?:.*-)?([0-9a-f]{32})$/i.exec(seg)?.[1]?.toLowerCase() === uuidRoute.uuid;
    } catch {
      return false;
    }
  })();
  if (url !== expectedUrl && !sameUuidRoute) {
    page.health = 'wrong_url';
    return page;
  }
  // The full-page connection splash replaces the chat while the Gateway is unreachable.
  if (shown(document.querySelector('.gateway-connection-view'))) {
    page.health = offline ? 'offline' : 'disconnected';
    return page;
  }
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
  // Classify the draft here so that its text never leaves the browser.
  const draft = String(composers[0].value || '');
  const draftFirst = draft.split('\n', 1)[0].trimEnd();
  page.draft = !draft.trim() ? 'empty'
    : turnKey && draftFirst === "Bridge-Turn: " + turnKey ? 'request'
    : turnKey && draftFirst === "Bridge-Nudge: " + turnKey ? 'nudge'
    : /^Bridge-(?:Turn|Nudge): idem_[\w-]+$/.test(draftFirst) ? 'bridge_other' : 'text';
  // "Connecting… · Saved conversation": the pane shows a saved transcript while the Gateway reconnects.
  const connection = outsideThread('.chat-pane__connection');
  // A send control marked busy without sending is the "Loading chat" hold.
  const sendHeld = !!sendBtn && sendBtn.getAttribute('aria-busy') === 'true' &&
    !sendBtn.classList.contains('chat-send-btn--sending');
  page.health = offline ? 'offline' : shown(connection) ? 'disconnected' : sendHeld ? 'loading' : 'ready';
  page.busy = !!(stopBtn || scope.querySelector('.chat-send-btn--stop, .chat-send-btn--sending, [data-chat-streaming="true"]'));
  page.controls = {
    composerLabel,
    sendLabel: sendBtn ? (sendBtn.getAttribute('aria-label') || sendBtn.textContent || '').trim() : '',
    stopLabel: stopBtn ? (stopBtn.getAttribute('aria-label') || stopBtn.textContent || '').trim() : '',
  };
  // A saved or loading transcript can be stale, so a chat that is not ready reports no messages.
  if (page.health !== 'ready') return page;
  page.ready = true;
  if (!turnKey) return page; // Preflight and send control discovery only need readiness.
  // A run failure notice ("Unable to finish this reply") sits between bubbles in thread order.
  const rows = Array.from(thread.querySelectorAll('.chat-bubble[data-message-id], [data-run-failure]')).slice(-64);
  for (const bubble of rows) {
    if (bubble.getAttribute('data-run-failure') !== null) {
      page.messages.push({ role: 'failure', text: '',
        ...(bubble.querySelector('button.chat-run-failure__retry') ? { retryable: true } : {}) });
      continue;
    }
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
    const loadError = !user && !!bubble.querySelector('.chat-message-load-error');
    const loading = !!fullMsg && (!fullMsg.state || fullMsg.state.status !== 'loaded') && !loadError;
    // Keep other turns' boundaries without copying their contents out of the browser.
    const ownRequest = user && !group.classList.contains('chat-group--peer') &&
      firstLine === "Bridge-Turn: " + turnKey;
    // The bridge's own nudge resumes this turn. Only its marker leaves the browser.
    const nudge = user && !ownRequest && !group.classList.contains('chat-group--peer') &&
      firstLine === "Bridge-Nudge: " + turnKey;
    const sendStatus = ownRequest ? group.querySelector('[data-send-state]') : null;
    const sendState = sendStatus ? (sendStatus.getAttribute('data-send-state') || 'unconfirmed') : '';
    const reply = !user && settledFooter && !loading && !loadError && raw.length <= 256000
      ? replySection(raw, "Bridge-Reply: " + turnKey) : undefined;
    page.messages.push({
      role: user ? 'user' : 'assistant', text: ownRequest ? firstLine : reply ?? '',
      // Progress is fingerprinted by message identity and length, never by content.
      id: bubble.getAttribute('data-message-id') || '', size: raw.length,
      ...(nudge ? { nudge: true } : {}),
      ...(reply === null ? { ambiguousReply: true } : {}),
      ...(sendState ? { sendState, ...(sendState !== 'waiting-reconnect' ? { unconfirmed: true } : {}) } : {}),
      ...(!user && !settledFooter ? { settling: true } : {}),
      ...(loading ? { loading: true } : {}),
      ...(loadError ? { loadError: true } : {}),
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

/**
 * A short follow-up that resumes a failed or stalled turn. It carries its own marker so the
 * turn's original request stays unique and the turn still ends with the same reply marker.
 */
export function wrapBrowserNudge(
  idempotencyKey: string,
  published?: { url: string; headSha: string },
): string {
  return [
    `Bridge-Nudge: ${idempotencyKey}`,
    "",
    "Your reply to this handoff stopped before it finished: the chat showed it could not be completed, or it went quiet without a final answer.",
    "Continue from where you stopped. Check which actions already completed before retrying anything, and never repeat a push or a publish that already happened.",
    ...(published ? [
      `GitHub already shows ${published.url} at ${published.headSha} with the verified tree, so the push is done. Do not push, force-push or publish again. Finish only what is left, such as the pull request description, and report.`,
    ] : []),
    "Start your final answer with the following plain-text line by itself.",
    `Bridge-Reply: ${idempotencyKey}`,
    "Then give your assessment and finish with the required handoff-result JSON block. Start both fence lines in column one.",
  ].join("\n");
}

export interface BrowserTurnObservation {
  state: "absent" | "pending" | "running" | "completed" | "uncertain" | "failed";
  text?: string;
  /** True when uncertainty comes solely from a brief unlabelled idle gap between tool calls. */
  transientIdle?: boolean;
  /** Changes whenever the visible turn changes. Unchanged over time means no progress. */
  progress?: string;
  /** The chat is idle and nothing answered the request (or the latest resume) yet. */
  idleWithoutAnswer?: boolean;
  /** Bridge nudges already visible in this turn. */
  nudges?: number;
  /** The failure notice offers the Control UI's own "Try again" action. */
  retryable?: boolean;
}

interface TranscriptMessage {
  role: "user" | "assistant" | "failure";
  text: string;
  id?: string;
  size?: number;
  nudge?: boolean;
  retryable?: boolean;
  unconfirmed?: boolean;
  ambiguousReply?: boolean;
  sendState?: string;
  settling?: boolean;
  loading?: boolean;
  loadError?: boolean;
}

export function inspectBrowserTurn(
  snapshot: string,
  idempotencyKey: string,
  alreadyDispatched = false,
): BrowserTurnObservation {
  const page = JSON.parse(snapshot) as { ready: boolean; busy: boolean; messages: TranscriptMessage[] };
  // A loading or disconnected chat can show a stale saved transcript. It is not an observation.
  if (!page.ready) return { state: "uncertain" };
  const request = `Bridge-Turn: ${idempotencyKey}`;
  const reply = `Bridge-Reply: ${idempotencyKey}`;
  const requests = page.messages.flatMap((message, index) =>
    message.role === "user" && message.text === request ? [index] : []);
  if (requests.length > 1) return { state: "uncertain" };
  if (requests.length === 0 && !alreadyDispatched) return { state: "absent" };

  let later: TranscriptMessage[];
  if (requests.length === 1) {
    const requestIndex = requests[0]!;
    const requestMsg = page.messages[requestIndex];
    if (requestMsg?.sendState === "waiting-reconnect") return { state: "pending" };
    // The control UI can display optimistic, queued or failed sends as ordinary user bubbles.
    if (requestMsg?.unconfirmed || requestMsg?.sendState) return { state: "uncertain" };
    later = page.messages.slice(requestIndex + 1);
  } else {
    // Submission was already confirmed in an earlier poll; the user bubble scrolled or
    // reloaded out of the rendered tail window while the remote agent executed tool calls.
    later = page.messages;
  }

  // A user message ends the turn, except the bridge's own nudge and the continuation the
  // Control UI sends when the operator presses "Try again" on a failure notice.
  let nudges = 0;
  let nextUser = -1;
  for (let i = 0; i < later.length; i += 1) {
    const message = later[i]!;
    if (message.role !== "user") continue;
    if (message.nudge || later[i - 1]?.role === "failure") {
      if (message.nudge) nudges += 1;
      continue;
    }
    nextUser = i;
    break;
  }
  const segment = nextUser < 0 ? later : later.slice(0, nextUser);
  const progress = fingerprint(segment, page.busy);
  const answers = segment.filter(message => message.role === "assistant");
  let matched: string | undefined;
  let hasLoadError = false;
  for (const message of answers) {
    if (message.loadError) hasLoadError = true;
    if (message.settling || message.loading) continue;
    const section = browserReplySection(message.text, reply);
    if (message.ambiguousReply || section === null) return { state: "uncertain" };
    if (section === undefined) continue;
    if (matched !== undefined) return { state: "uncertain" };
    matched = section;
  }
  if (nextUser < 0 && (page.busy || answers.some(message => message.settling || message.loading))) {
    return { state: "running", progress, nudges };
  }
  if (hasLoadError) return { state: "uncertain" };
  if (matched !== undefined) {
    // The ordinary bridge result parser handles a missing/malformed result conservatively.
    return { state: "completed", text: matched };
  }
  if (nextUser >= 0) return { state: "uncertain" };
  const last = segment[segment.length - 1];
  if (last?.role === "failure") {
    return { state: "failed", progress, nudges, ...(last.retryable ? { retryable: true } : {}) };
  }
  if (requests.length === 0) return { state: "uncertain", transientIdle: true, progress, nudges };
  const resumedAt = segment.map(message => message.role).lastIndexOf("user");
  return segment.slice(resumedAt + 1).some(message => message.role === "assistant")
    ? { state: "uncertain", transientIdle: true, progress, nudges }
    : { state: "running", idleWithoutAnswer: true, progress, nudges };
}

function fingerprint(segment: TranscriptMessage[], busy: boolean): string {
  let hash = 0x811c9dc5;
  const text = JSON.stringify([busy, segment.map(m =>
    [m.role, m.id ?? "", m.size ?? m.text.length, m.settling ? 1 : 0, m.loading ? 1 : 0])]);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${segment.length}:${hash.toString(16)}`;
}

function hasUnfencedLine(text: string, expected: string): boolean {
  let fence = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trimStart();
    const match = /^(`{3,}|~{3,})/.exec(trimmed);
    if (match) {
      const marker = match[1]!;
      if (!fence) fence = marker;
      else if (trimmed.startsWith(fence) && trimmed.slice(marker.length).trim() === "") fence = "";
      continue;
    }
    if (!fence && rawLine.trimEnd() === expected) return true;
  }
  return false;
}

// Runs in the operator's selected chat tab. Read only the rendered transcript, never browser
// credentials, page stores or network APIs. OpenClaw's copy-as-Markdown text retains code fences.
export const browserTranscriptScript = String.raw`(expectedUrl, turnKey) => {
  const hasUnfencedLine = (text, expected) => {
    let fence = '';
    for (const rawLine of text.split(/\r?\n/)) {
      const trimmed = rawLine.trimStart(), m = /^(\x60{3,}|~{3,})/.exec(trimmed);
      if (m) {
        if (!fence) fence = m[1];
        else if (trimmed.startsWith(fence) && trimmed.slice(m[1].length).trim() === '') fence = '';
        continue;
      }
      if (!fence && rawLine.trimEnd() === expected) return true;
    }
    return false;
  };
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
  const composer = outsideThread('textarea[aria-autocomplete="list"], textarea[aria-label]:not(.chat-queue__edit-input)');
  if (thread.classList.contains('chat-thread--route-loading') || !composer) return page;
  const sendBtn = outsideThread('button.chat-send-btn--send:not(.chat-send-btn--dictation-commit)');
  const stopBtn = outsideThread('button.chat-send-btn--stop');
  page.ready = true;
  page.busy = !!(stopBtn || scope.querySelector('.chat-send-btn--stop, .chat-send-btn--sending, [data-chat-streaming="true"]'));
  page.controls = {
    composerLabel: composer.getAttribute('aria-label') || '',
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
    const raw = (bubble.getAttribute('data-message-text') || '').trim();
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
    const reply = !user && settledFooter && !loading && raw.length <= 256000 &&
      hasUnfencedLine(raw, "Bridge-Reply: " + turnKey);
    page.messages.push({
      role: user ? 'user' : 'assistant', text: ownRequest ? firstLine : reply ? raw : '',
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
    "Then give your assessment and finish with the required fenced handoff-result JSON block.",
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
  const matches = answers.filter(message => message.role === "assistant" &&
    !message.settling && !message.loading && hasUnfencedLine(message.text, reply));
  if (matches.length > 1) return { state: "uncertain" };
  if (nextUser < 0 && (page.busy || answers.some(message => message.settling || message.loading))) {
    return { state: "running" };
  }
  if (matches.length === 1) {
    // The ordinary bridge result parser handles a missing/malformed result conservatively.
    return { state: "completed", text: matches[0]!.text };
  }
  return { state: nextUser >= 0 || answers.length > 0 ? "uncertain" : "running" };
}

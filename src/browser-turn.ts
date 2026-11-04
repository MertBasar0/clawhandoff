// Runs in the operator's selected chat tab. Read only the rendered transcript, never browser
// credentials, page stores or network APIs. OpenClaw's copy-as-Markdown text retains code fences.
export const browserTranscriptScript = String.raw`(expectedUrl, turnKey) => {
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
  if (thread.classList.contains('chat-thread--route-loading') ||
      !scope.querySelector('textarea[aria-label]')) return page;
  page.ready = true;
  page.busy = !!scope.querySelector('.chat-send-btn--stop, .chat-send-btn--sending, [data-chat-streaming="true"]');
  if (!turnKey) return page; // Preflight only needs readiness.
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
    // Keep other turns' boundaries without copying their contents out of the browser.
    const ownRequest = user && !group.classList.contains('chat-group--peer') &&
      firstLine === "Bridge-Turn: " + turnKey;
    const reply = !user && firstLine === "Bridge-Reply: " + turnKey &&
      group.querySelector('.chat-group-footer') && raw.length <= 64000;
    page.messages.push({
      role: user ? 'user' : 'assistant', text: ownRequest ? firstLine : reply ? raw : '',
      ...(ownRequest && group.querySelector('[data-send-state]') ? { unconfirmed: true } : {}),
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
  state: "absent" | "running" | "completed" | "uncertain";
  text?: string;
}

interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  unconfirmed?: boolean;
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
  // The control UI can display optimistic, queued or failed sends as ordinary user bubbles.
  if (page.messages[requestIndex]?.unconfirmed) return { state: "uncertain" };
  const later = page.messages.slice(requestIndex + 1);
  const nextUser = later.findIndex(message => message.role === "user");
  const answers = nextUser < 0 ? later : later.slice(0, nextUser);
  const matches = answers.filter(message => message.role === "assistant" &&
    message.text.split("\n", 1)[0]?.trimEnd() === reply);
  if (matches.length > 1) return { state: "uncertain" };
  if (page.busy && nextUser < 0) return { state: "running" };
  if (matches.length === 1) {
    // The ordinary bridge result parser handles a missing/malformed result conservatively.
    return { state: "completed", text: matches[0]!.text };
  }
  return { state: nextUser >= 0 || answers.length > 0 ? "uncertain" : "running" };
}

/**
 * Browser-side recovery for browser handoffs: what the bridge does when the configured chat tab
 * is still loading, has lost its Gateway connection, or cannot load at all. Everything here is
 * pure so each state transition can be tested without Chrome.
 */

/** What the chat tab shows, as the transcript projection reports it. */
export type BrowserPageHealth =
  /** Transcript and composer are usable and the Control UI is connected. */
  | "ready"
  /** The route, transcript or send control is still loading ("Loading chat"). */
  | "loading"
  /** The Control UI shows its connection notice ("Connecting… · Saved conversation") or splash. */
  | "disconnected"
  /** Chrome reports that it has no network. */
  | "offline"
  /** The tab shows Chrome's own network error page instead of the chat. */
  | "error_page"
  /** The tab shows another page than the configured chat. */
  | "wrong_url"
  /** No tab shows the configured chat. */
  | "missing";

/** The composer content, classified inside the page. Draft text never leaves the browser. */
export type BrowserDraftKind =
  | "empty"
  /** This turn's own `Bridge-Turn` request. */
  | "request"
  /** This turn's own `Bridge-Nudge`. */
  | "nudge"
  /** A `Bridge-Turn` or `Bridge-Nudge` draft of another turn, left behind by an earlier attempt. */
  | "bridge_other"
  /** Anything else, such as the operator's own draft. The bridge never clears it. */
  | "text";

/**
 * Why a browser turn is not progressing, reported in `orchestratorDirective.condition`.
 * The first four keep `POLL_ATTACH`; the last two need a person and use `RESTORE_BROWSER`.
 */
export type BrowserCondition =
  | "chat_loading"
  | "chat_disconnected"
  | "request_typed_unsent"
  | "published_reply_pending"
  | "browser_offline"
  | "chat_unreachable";

function envMs(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export interface BrowserRecoveryLimits {
  /** Pause between two reads of the chat. */
  pollMs: number;
  /** How long the Control UI may load or reconnect on its own before the bridge reloads the tab. */
  settleGraceMs: number;
  /** How long a reload may take to bring the chat back before it counts as failed. */
  reloadSettleMs: number;
  /** Reloads (or reopens) in a row without one ready read. Then the chat needs a person. */
  maxReloads: number;
  /** Timeout passed to Chrome for one reload or reopen. */
  navigationTimeoutMs: number;
  /** A claimed request that is neither in the composer nor in the transcript for this long is uncertain. */
  unsentConfirmMs: number;
  /** Minimum time between two GitHub checks of one publish turn. */
  publishCheckIntervalMs: number;
}

/** Defaults, each overridable with the named environment variable (milliseconds or a count). */
export const BROWSER_RECOVERY_DEFAULTS: Readonly<BrowserRecoveryLimits> = Object.freeze({
  pollMs: 1_200,
  settleGraceMs: 15_000,
  reloadSettleMs: 45_000,
  maxReloads: 3,
  navigationTimeoutMs: 30_000,
  unsentConfirmMs: 120_000,
  publishCheckIntervalMs: 60_000,
});

export const BROWSER_RECOVERY_ENV: Readonly<Record<keyof BrowserRecoveryLimits, string>> = Object.freeze({
  pollMs: "CLAWHANDOFF_BROWSER_POLL_MS",
  settleGraceMs: "CLAWHANDOFF_BROWSER_SETTLE_GRACE_MS",
  reloadSettleMs: "CLAWHANDOFF_BROWSER_RELOAD_SETTLE_MS",
  maxReloads: "CLAWHANDOFF_BROWSER_MAX_RELOADS",
  navigationTimeoutMs: "CLAWHANDOFF_BROWSER_NAVIGATION_TIMEOUT_MS",
  unsentConfirmMs: "CLAWHANDOFF_BROWSER_UNSENT_CONFIRM_MS",
  publishCheckIntervalMs: "CLAWHANDOFF_PUBLISH_CHECK_INTERVAL_MS",
});

export function browserRecoveryLimits(env: NodeJS.ProcessEnv = process.env): BrowserRecoveryLimits {
  const limits = {} as BrowserRecoveryLimits;
  for (const key of Object.keys(BROWSER_RECOVERY_DEFAULTS) as Array<keyof BrowserRecoveryLimits>) {
    limits[key] = envMs(BROWSER_RECOVERY_ENV[key], BROWSER_RECOVERY_DEFAULTS[key], env);
  }
  return limits;
}

/** Per-turn recovery memory. It lives in the bridge process, like the stall clock. */
export interface BrowserRecoveryState {
  /** When the chat was first seen not ready since the last ready read. */
  unhealthySince?: number;
  /** Reloads or reopens since the last ready read. */
  reloads: number;
  lastReloadAt?: number;
  /** A reload or page load failed with a Chrome network error. */
  networkFailure?: boolean;
}

export type BrowserRecoveryStep =
  | { kind: "wait"; condition: "chat_loading" | "chat_disconnected" }
  | { kind: "reload"; reopen: boolean }
  | { kind: "give_up"; condition: "browser_offline" | "chat_unreachable" };

/**
 * Decides what to do about a chat that is not ready. The chat is never treated as an answer or
 * as a stopped run while it is not ready: the bridge waits, reloads within bounds, or asks a person.
 */
export function decideBrowserRecovery(
  state: BrowserRecoveryState,
  health: Exclude<BrowserPageHealth, "ready">,
  now: number,
  limits: BrowserRecoveryLimits,
): BrowserRecoveryStep {
  const since = state.unhealthySince ?? now;
  const condition = health === "loading" ? "chat_loading" as const : "chat_disconnected" as const;
  const settling = state.lastReloadAt !== undefined && now - state.lastReloadAt < limits.reloadSettleMs;
  // A reload already failed with a Chrome network error. Another one would show the same error page.
  if (state.networkFailure) return { kind: "give_up", condition: "browser_offline" };
  // Chrome says it has no network. A short drop recovers by itself, so only a lasting one needs a person.
  if (health === "offline") {
    return now - since < limits.settleGraceMs ? { kind: "wait", condition } : { kind: "give_up", condition: "browser_offline" };
  }
  if (settling) return { kind: "wait", condition };
  // A missing tab or Chrome's error page cannot recover by itself. A wrong page is the operator's.
  const recoversAlone = health === "loading" || health === "disconnected";
  if (health === "wrong_url") return { kind: "give_up", condition: "chat_unreachable" };
  if (recoversAlone && state.reloads === 0 && now - since < limits.settleGraceMs) return { kind: "wait", condition };
  if (state.reloads >= limits.maxReloads) {
    return { kind: "give_up", condition: health === "error_page" ? "browser_offline" : "chat_unreachable" };
  }
  return { kind: "reload", reopen: health === "missing" };
}

/** Records a not-ready read. Returns the state to keep. */
export function noteUnhealthy(state: BrowserRecoveryState, now: number): BrowserRecoveryState {
  return state.unhealthySince === undefined ? { ...state, unhealthySince: now } : state;
}

/** A ready read ends the episode: grace, reload count and network failure start over. */
export function noteHealthy(): BrowserRecoveryState {
  return { reloads: 0 };
}

export type ReloadOutcome = "reloaded" | "offline" | "blocked" | "failed" | "unsupported";

export function noteReload(state: BrowserRecoveryState, outcome: ReloadOutcome, now: number): BrowserRecoveryState {
  return {
    ...state,
    unhealthySince: state.unhealthySince ?? now,
    reloads: state.reloads + 1,
    lastReloadAt: now,
    ...(outcome === "offline" ? { networkFailure: true } : {}),
  };
}

/** The human step for a chat the bridge cannot recover by itself. */
export function browserRestoreStep(
  condition: "browser_offline" | "chat_unreachable",
  health: BrowserPageHealth,
  reloads: number,
): string {
  if (condition === "browser_offline") {
    return "Chrome cannot load pages although the bridge reached it" +
      (reloads ? ` (${reloads} reload(s) tried)` : "") +
      ". If other sites also fail in Chrome while the network works outside it, quit Chrome completely and start it again, " +
      "keep one tab at the configured Robo chat URL and allow remote debugging, then attach again. The turn is kept and nothing is resent.";
  }
  const what = health === "wrong_url"
    ? "The chat tab shows another page"
    : health === "missing"
      ? "No tab shows the configured chat, and reopening it did not help"
      : `The chat did not finish loading or reconnecting after ${reloads} reload(s)`;
  return `${what}. Open exactly one tab at the configured Robo chat URL, wait until its transcript and composer load, ` +
    "then attach again. The turn is kept and nothing is resent.";
}

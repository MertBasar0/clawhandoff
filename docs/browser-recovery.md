# Browser recovery for browser handoffs

A browser handoff drives a Robo chat in Chrome. Before this change, the bridge treated anything other than a ready chat as a failure of the turn. On 2026-11-12 one publish turn showed three problems:

1. **Typed but not sent.** The chat was still loading ("Loading chat"), so its send control was disabled and labelled with that reason. The bridge typed the whole `Bridge-Turn` request, could not click send, marked the turn `uncertain` and asked for a person.
2. **Disconnected page.** The pane showed "Connecting… · Saved conversation", a saved transcript while the Control UI reconnected to its Gateway. The bridge read that transcript as an idle Robo, flapped between `running` and `uncertain`, and tried to type a `Bridge-Nudge`. Meanwhile Robo had already pushed to the pull request. The bridge never noticed, because it only looked at the chat.
3. **Chrome lost connectivity.** Chrome could not load any page while the network worked outside it.

This document describes how the bridge now handles each case. It keeps its guarantees: a request is sent at most once, nothing is typed into a chat that is not ready, and no nudge can lead to a second push.

## Page health

The transcript script runs in the chat tab and reports `health` together with the transcript projection:

| `health` | What the tab shows | How it is recognized |
| --- | --- | --- |
| `ready` | Transcript and composer, connected | everything below is absent |
| `loading` | The route, transcript or send control is still loading | no single active thread or composer, `chat-thread--route-loading`, or a send button with `aria-busy="true"` that is not sending |
| `disconnected` | "Connecting…", "Reconnecting…", "Offline" and similar, often with "Saved conversation" | a visible `.chat-pane__connection` in the active pane, or the `.gateway-connection-view` splash |
| `offline` | Chrome reports no network | `navigator.onLine === false` |
| `error_page` | Chrome's own network error page | `location.protocol === "chrome-error:"`, or the last known chat tab now lists a `chrome-error://` URL |
| `wrong_url` | Another page | the URL is not the configured chat |
| `missing` | No tab shows the chat | `list_pages` has no matching tab |

A chat that is not `ready` reports no messages. Its saved transcript can be stale, so the bridge never reads it as progress, as an answer, or as Robo having stopped.

The script also classifies the composer content as `draft`: `empty`, `request` (this turn's `Bridge-Turn`), `nudge` (this turn's `Bridge-Nudge`), `bridge_other` (a bridge draft for another message) or `text` (anything else). The draft text itself never leaves the browser.

## Recovering a chat that is not ready

Each browser turn keeps a recovery episode in the bridge process. A ready read ends the episode.

1. **Grace.** A `loading` or `disconnected` chat usually recovers by itself. The bridge waits up to `settleGraceMs` before acting.
2. **Reload.** Then it reloads the tab with Chrome DevTools MCP `navigate_page` (`type: "reload"`, `handleBeforeUnload: "dismiss"`). Dismissing the "leave page?" prompt means a page holding unsent offline changes is not reloaded and keeps them. A `missing` tab is opened again with `new_page`, in the background, without waiting for a grace period. After each reload the bridge waits `reloadSettleMs` before trying again.
3. **Give up.** After `maxReloads` reloads in a row without one ready read, the turn returns `RESTORE_BROWSER` with `condition: "chat_unreachable"`.
4. **Chrome without network.** A reload that fails with a Chrome network error (`net::ERR_*` other than `ERR_ABORTED`), an `offline` chat that lasts beyond the grace period, or reloads that only ever show Chrome's error page return `RESTORE_BROWSER` with `condition: "browser_offline"`. Its reason names the human step: quit Chrome completely, start it again, keep one tab at the chat URL, and attach again.

None of this changes the turn's state. A `RESTORE_BROWSER` turn stays `running` (or `uncertain` if its submission was never confirmed), nothing is resent, and the next `bridge_handoff_attach` continues where the bridge left off. Time spent not ready does not count toward `recovery.idleStallMs`: the stall clock starts over once the chat is ready again. The bridge never types a nudge while the chat is not ready, because every send first requires a ready, idle chat.

## Sending a request exactly once

`ChromeChat.send` inspects the composer before it claims the turn:

- A `Bridge-Turn` or `Bridge-Nudge` draft of another message, left by an earlier attempt, is cleared first, so drafts do not pile up. Any other draft belongs to the operator. The bridge stops with `BUSY_ACTIVE_TURN` and does not touch it.
- A chat that is not ready raises `BrowserNotReady` before the claim. Nothing was typed, so the attach loop simply recovers the chat and tries again.

After the claim, the bridge types the request and clicks send only if the chat is ready and idle and exactly one enabled send control exists. Otherwise the outcome is `typed`: the request waits in the composer. The Control UI keeps composer drafts across reloads.

The attach loop then handles an **unsent own turn**: the transcript has no `Bridge-Turn` with the turn's key, but the composer holds this turn's request. Once the chat is ready and idle, the bridge checks that the composer holds exactly the request text and clicks send. A durable flag (`handoff_turns.browser_resend_claimed`) allows this automatic click once per turn, across restarts. If the request is still unsent after that click, the turn becomes `uncertain` and asks the operator to press send. The bridge never clicks when the transcript already shows the key, for example when the operator already sent the request by hand.

A claimed request that appears neither in the composer nor in the transcript for `unsentConfirmMs` becomes `uncertain`. It is never typed again.

## Reconciling a publish turn against GitHub

For an `authorize_publish` turn with `gitContext.updatePullRequest`, the pull request head says whether the push already happened, whatever the chat shows. The bridge checks it with `gh` at most once per `publishCheckIntervalMs`, and always before it nudges:

- **Head has the verified tree.** The publication landed. The publication ledger records the pull request as `open_verified`, so the publish gate refuses any further `authorize_publish`. A still-open turn returns `POLL_ATTACH` with `condition: "published_reply_pending"` (for example while Robo still edits the pull request description). Other directives mention the landed publication in their reason. A nudge then says that GitHub already shows the push and that Robo must not push, force-push or publish again, only finish what is left.
- **Head still at `expectedHeadSha`.** Nothing landed yet. The turn continues as usual.
- **Head moved to another tree.** Someone else changed the pull request. The bridge does not nudge, and the turn becomes `uncertain` with that note.
- **The lookup failed.** The chat state stands on its own, and a nudge keeps its general rule never to repeat a push.

If Robo stays quiet after the last nudge, the turn still becomes `uncertain`. Its reason then states that the publication landed and only Robo's final reply is missing.

## Directives and conditions

`orchestratorDirective.condition` tells the orchestrator why a browser turn is waiting:

| `condition` | `action` | Meaning |
| --- | --- | --- |
| `chat_loading` | `POLL_ATTACH` | The chat is still loading. The bridge waits or reloads within bounds. |
| `chat_disconnected` | `POLL_ATTACH` | The chat is reconnecting or shows a saved conversation. Not yet observed, not a stopped Robo. |
| `request_typed_unsent` | `POLL_ATTACH` | The request is in the composer. The bridge sends it once when the chat is ready. |
| `published_reply_pending` | `POLL_ATTACH` | GitHub shows the publication. Robo's reply is still pending. Do not authorize again. |
| `chat_unreachable` | `RESTORE_BROWSER` | The chat did not recover after bounded reloads, or the tab shows another page. |
| `browser_offline` | `RESTORE_BROWSER` | Chrome cannot load pages. Restart Chrome, then attach again. |

`RESTORE_BROWSER` is new. The orchestrator relays the human step from `reason` and attaches again afterwards. It never starts a new handoff for the same work.

## Limits

All limits are named constants in `src/browser-health.ts`. Each environment variable takes milliseconds, or a count for `maxReloads`.

| Limit | Default | Environment variable |
| --- | --- | --- |
| `pollMs` | 1.2 s | `CLAWHANDOFF_BROWSER_POLL_MS` |
| `settleGraceMs` | 15 s | `CLAWHANDOFF_BROWSER_SETTLE_GRACE_MS` |
| `reloadSettleMs` | 45 s | `CLAWHANDOFF_BROWSER_RELOAD_SETTLE_MS` |
| `maxReloads` | 3 | `CLAWHANDOFF_BROWSER_MAX_RELOADS` |
| `navigationTimeoutMs` | 30 s | `CLAWHANDOFF_BROWSER_NAVIGATION_TIMEOUT_MS` |
| `unsentConfirmMs` | 2 min | `CLAWHANDOFF_BROWSER_UNSENT_CONFIRM_MS` |
| `publishCheckIntervalMs` | 1 min | `CLAWHANDOFF_PUBLISH_CHECK_INTERVAL_MS` |

The recovery episode and the publication check live in the bridge process, like the stall clock. A restarted bridge starts a new episode. The one automatic send of a typed request is recorded in SQLite.

## Limits of this design

- A reload needs Chrome DevTools MCP's `navigate_page`, and a reopen needs `new_page`. Without them, each attempt counts as a failed reload and the bridge asks a person sooner.
- The connection notice is recognized by its DOM class. When the Control UI merges the pane header into its own chrome, the per-pane notice is not rendered. The bridge then relies on the splash, the held send control and `navigator.onLine`.
- More than one tab at the chat URL is still the operator's to fix. The bridge does not choose between them.
- Robo's own stalls on the server side (for example a sub-session that never returns) are outside this design. The existing `recovery.busyStallMs` rule still applies to them.

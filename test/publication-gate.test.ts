import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { BridgeService } from "../src/bridge-service.js";
import { BridgeError, type BridgeConfig } from "../src/types.js";
import { createTempGitFixture } from "./helpers/git-fixture.js";

async function preparePublication(t: TestContext, reportedSha?: string) {
  const fixture = createTempGitFixture();
  const head = fixture.commitFile("README.md", "verified tree", "prepare candidate");
  const ref = "refs/heads/main";
  fixture.git(["push", "origin", ref]);
  const statePath = join(fixture.rootDir, "gateway.json");
  const originalEnv = process.env.FAKE_GATEWAY_STATE_FILE;
  process.env.FAKE_GATEWAY_STATE_FILE = statePath;
  const queuedTurnReplies = ["ready_for_publish_gate", "completed"].map((disposition) => ({
    replyText: "```handoff-result\n" + JSON.stringify({ disposition, candidateRef: ref,
      candidateCommitSha: reportedSha ?? head, summaryDelta: disposition, blockers: [], claimedChecks: [] }) + "\n```",
  }));
  writeFileSync(statePath, JSON.stringify({ queuedTurnReplies, openPrs: [] }));
  const config: BridgeConfig = {
    dataDir: fixture.rootDir,
    ghCliPath: resolve("test/helpers/fake-gh-cli.mjs"),
    targets: { robo: { targetId: "robo", url: "https://gateway.example", authMode: "direct-token",
      agentId: "main", cliPath: resolve("test/helpers/fake-openclaw-cli.mjs") } },
  };
  let service = new BridgeService(config);
  t.after(() => {
    service.close();
    if (originalEnv === undefined) delete process.env.FAKE_GATEWAY_STATE_FILE;
    else process.env.FAKE_GATEWAY_STATE_FILE = originalEnv;
    fixture.cleanup();
  });
  const ready = await service.startHandoff({ targetId: "robo", envelope: {
    schemaVersion: "0.2", requestId: "gate-test", workspaceId: "workspace", title: "Publish verified commit",
    outcome: "Publish a draft after exact commit verification.", mode: "publish_unchanged", publisherOwner: "remote_gated",
    gitContext: { repoId: "example/repo", remoteUrlOrPath: fixture.originBareDir, pinnedBaseCommitSha: head,
      pinnedSourceCommitSha: head, expectedTreeSha: fixture.revParse("HEAD^{tree}"), sourceRemoteRef: ref },
    requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
    acceptanceCriteria: ["Only the approved commit is published"],
  } });
  assert.equal(ready.orchestratorDirective.action, reportedSha ? "CONTINUE_AUTONOMOUSLY" : "AUTHORIZE_REMOTE_PUBLISH");
  const { handoffId } = ready;
  return {
    authorize: () => service.continueHandoff({ handoffId, intent: "authorize_publish", message: "Publish the verified commit." }),
    verify: () => service.verifyGit({ handoffId, candidateRef: ref }),
    restart: () => { service.close(); service = new BridgeService(config); },
    moveHead: () => {
      fixture.git(["commit", "--allow-empty", "-m", "another commit with the same tree"]);
      fixture.git(["push", "origin", ref]);
      return fixture.revParse("HEAD");
    },
    statePath,
  };
}

test("Stage 1 must bind the target's reported commit to the reachable head", async (t) => {
  const gate = await preparePublication(t, "a".repeat(40));
  await assert.rejects(gate.authorize, (err: unknown) =>
    err instanceof BridgeError && err.code === "CONTRACT_VIOLATION");
  assert.equal(JSON.parse(readFileSync(gate.statePath, "utf8")).rpcCounts["chat.send"] ?? 0, 0);
});

test("Stage 2 rejects a moved ref on repeated authorization before sending a publish message", async (t) => {
  const gate = await preparePublication(t);
  gate.moveHead();
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(gate.authorize, (e: unknown) => e instanceof BridgeError && e.code === "CONTRACT_VIOLATION");
  }
  const state = JSON.parse(readFileSync(gate.statePath, "utf8"));
  assert.equal(state.rpcCounts["chat.send"] ?? 0, 0);
});

test("Fresh verification after restart cannot replace a pending publication's authorized commit", async (t) => {
  const gate = await preparePublication(t);
  const pending = await gate.authorize();
  assert.equal(pending.observed.reconciledPrState, "uncertain_in_flight");
  const moved = gate.moveHead();
  const state = JSON.parse(readFileSync(gate.statePath, "utf8"));
  state.openPrs = [{ url: "https://github.com/example/repo/pull/8", headRefName: "main", headRefOid: moved }];
  writeFileSync(gate.statePath, JSON.stringify(state));
  for (let observation = 0; observation < 2; observation++) {
    gate.restart();
    const result = await gate.verify();
    assert.equal(result.observed.observedHeadSha, moved);
    assert.equal(result.observed.reconciledPrState, "uncertain_in_flight");
    await assert.rejects(gate.authorize, (e: unknown) => e instanceof BridgeError && e.code === "RECONCILIATION_UNCERTAIN");
  }
  assert.equal(JSON.parse(readFileSync(gate.statePath, "utf8")).rpcCounts["chat.send"], 1);
});

test("A candidateRef qualified with the handoff repository passes both stages and reconciles the published PR", async (t) => {
  const fixture = createTempGitFixture();
  const head = fixture.commitFile("README.md", "verified tree", "prepare candidate");
  fixture.git(["push", "origin", "refs/heads/main"]);
  const statePath = join(fixture.rootDir, "gateway.json");
  const originalEnv = process.env.FAKE_GATEWAY_STATE_FILE;
  process.env.FAKE_GATEWAY_STATE_FILE = statePath;
  const prUrl = "https://github.com/example/repo/pull/9";
  // Robo's owner/repo:<ref> form, with GitHub's case-insensitive names.
  const reply = (disposition: string, extra: Record<string, unknown> = {}) => "```handoff-result\n" + JSON.stringify({
    disposition, candidateRef: "Example/Repo:refs/heads/main", candidateCommitSha: head,
    summaryDelta: disposition, blockers: [], claimedChecks: [], ...extra,
  }) + "\n```";
  writeFileSync(statePath, JSON.stringify({ openPrs: [], queuedTurnReplies: [
    { replyText: reply("ready_for_publish_gate") },
    { replyText: reply("completed", { prUrl }), createdPr: { number: 9, url: prUrl, headRefName: "main", headRefOid: head } },
  ] }));
  const service = new BridgeService({
    dataDir: fixture.rootDir,
    ghCliPath: resolve("test/helpers/fake-gh-cli.mjs"),
    targets: { robo: { targetId: "robo", url: "https://gateway.example", authMode: "direct-token",
      agentId: "main", cliPath: resolve("test/helpers/fake-openclaw-cli.mjs") } },
  });
  t.after(() => {
    service.close();
    if (originalEnv === undefined) delete process.env.FAKE_GATEWAY_STATE_FILE;
    else process.env.FAKE_GATEWAY_STATE_FILE = originalEnv;
    fixture.cleanup();
  });

  const ready = await service.startHandoff({ targetId: "robo", envelope: {
    schemaVersion: "0.2", requestId: "qualified-ref", workspaceId: "workspace", title: "Publish verified commit",
    outcome: "Publish a draft after exact commit verification.", mode: "publish_unchanged", publisherOwner: "remote_gated",
    gitContext: { repoId: "example/repo", remoteUrlOrPath: fixture.originBareDir, pinnedBaseCommitSha: head,
      pinnedSourceCommitSha: head, expectedTreeSha: fixture.revParse("HEAD^{tree}") },
    requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
    acceptanceCriteria: ["Only the approved commit is published"],
  } });
  assert.equal(ready.observed.reachableRefVerified, true, JSON.stringify(ready.observed.verificationNotes));
  assert.equal(ready.observed.observedHeadSha, head);
  assert.equal(ready.orchestratorDirective.action, "AUTHORIZE_REMOTE_PUBLISH");

  const published = await service.continueHandoff({ handoffId: ready.handoffId, intent: "authorize_publish", message: "Publish the verified commit." });
  assert.equal(published.observed.observedHeadSha, head);
  assert.equal(published.observed.reconciledPrState, "open_verified");
  assert.equal(published.observed.reconciledPrUrl, prUrl);
  assert.equal(published.orchestratorDirective.action, "COMPLETE");

  // A refspec is refused before anything is fetched.
  const refused = await service.verifyGit({ handoffId: ready.handoffId, candidateRef: "example/repo:refs/heads/main:refs/heads/x" });
  assert.equal(refused.observed.reachableRefVerified, false);
  assert.match((refused.observed.verificationNotes ?? []).join("\n"), /Refusing candidateRef/);
});

test("Omitting publisherOwner defaults to remote_gated (unless config overrides defaultPublisherOwner) and mid-handoff updatedLocalRepoPath binds worktree", async (t) => {
  const fixture = createTempGitFixture();
  const baseSha = fixture.commitFile("README.md", "base\n", "base");
  fixture.git(["push", "origin", "main"]);

  const worktreeDir = join(fixture.rootDir, "mid-handoff-wt");
  fixture.git(["worktree", "add", "-b", "robo/feature", worktreeDir, "HEAD"]);
  const featureSha = fixture.commitFile("src/feature.ts", "export const v = 2;\n", "feature", worktreeDir);
  const featureTree = fixture.revParse("HEAD^{tree}", worktreeDir);
  fixture.git(["push", "origin", "robo/feature"], worktreeDir);

  const statePath = join(fixture.rootDir, "gateway.json");
  const originalEnv = process.env.FAKE_GATEWAY_STATE_FILE;
  process.env.FAKE_GATEWAY_STATE_FILE = statePath;
  writeFileSync(
    statePath,
    JSON.stringify({
      queuedTurnReplies: [
        {
          replyText:
            "```handoff-result\n" +
            JSON.stringify({
              disposition: "needs_evidence",
              summaryDelta: "Need candidate branch pushed.",
              blockers: ["Push candidate branch"],
              claimedChecks: [],
            }) +
            "\n```",
        },
        {
          replyText:
            "```handoff-result\n" +
            JSON.stringify({
              disposition: "ready_for_publish_gate",
              candidateRef: "refs/heads/robo/feature",
              candidateCommitSha: featureSha,
              summaryDelta: "Verified feature branch.",
              blockers: [],
              claimedChecks: [],
            }) +
            "\n```",
        },
        {
          createdPr: {
            number: 77,
            url: "https://github.com/example/repo/pull/77",
            headRefName: "robo/feature",
            headRefOid: featureSha,
          },
          replyText:
            "```handoff-result\n" +
            JSON.stringify({
              disposition: "completed",
              candidateRef: "refs/heads/robo/feature",
              candidateCommitSha: featureSha,
              prUrl: "https://github.com/example/repo/pull/77",
              summaryDelta: "Opened draft PR #77 under managed identity.",
              blockers: [],
              claimedChecks: [],
            }) +
            "\n```",
        },
        {
          replyText:
            "```handoff-result\n" +
            JSON.stringify({
              disposition: "completed",
              candidateRef: "refs/heads/robo/feature",
              candidateCommitSha: featureSha,
              summaryDelta: "Ready for configured local owner.",
              blockers: [],
              claimedChecks: [],
            }) +
            "\n```",
        },
      ],
      openPrs: [],
    }),
  );

  const baseConfig: BridgeConfig = {
    dataDir: fixture.rootDir,
    ghCliPath: resolve("test/helpers/fake-gh-cli.mjs"),
    targets: {
      robo: {
        targetId: "robo",
        url: "https://gateway.example",
        authMode: "direct-token",
        agentId: "main",
        cliPath: resolve("test/helpers/fake-openclaw-cli.mjs"),
      },
    },
  };
  const service = new BridgeService(baseConfig);
  const localDefaultService = new BridgeService({ ...baseConfig, defaultPublisherOwner: "local" });
  t.after(() => {
    service.close();
    localDefaultService.close();
    if (originalEnv === undefined) delete process.env.FAKE_GATEWAY_STATE_FILE;
    else process.env.FAKE_GATEWAY_STATE_FILE = originalEnv;
    fixture.cleanup();
  });

  // Turn 1: publisherOwner AND allowManagedPublishStage AND localRepoPath are omitted -> defaults to remote_gated!
  const t1 = await service.startHandoff({
    targetId: "robo",
    envelope: {
      schemaVersion: "0.2",
      requestId: "default-remote-gated-1",
      workspaceId: "ws",
      title: "Implement and gate PR under Robo identity",
      outcome: "Prepare fix and open managed PR after gate.",
      mode: "implement",
      gitContext: {
        repoId: "example/repo",
        remoteUrlOrPath: fixture.originBareDir,
        pinnedBaseCommitSha: baseSha,
      },
      requestedCapabilities: {
        allowCodeEdit: true,
        allowBranchPush: true,
      },
      acceptanceCriteria: ["PR opened under managed bot identity"],
    },
  });
  assert.equal(t1.orchestratorDirective.action, "CONTINUE_AUTONOMOUSLY");

  // Invalid updatedLocalRepoPath fails fast before mutating state.
  await assert.rejects(
    () =>
      service.continueHandoff({
        handoffId: t1.handoffId,
        intent: "counter_evidence_or_followup",
        message: "Bad path",
        updatedLocalRepoPath: join(fixture.rootDir, "does-not-exist"),
      }),
    (err: unknown) => err instanceof BridgeError && err.code === "INVALID_INPUT",
  );

  // Turn 2: bind newly created worktree via updatedLocalRepoPath + new commit/tree -> unlocks AUTHORIZE_REMOTE_PUBLISH!
  const t2 = await service.continueHandoff({
    handoffId: t1.handoffId,
    intent: "counter_evidence_or_followup",
    message: "Prepared candidate commit in linked worktree.",
    updatedLocalRepoPath: worktreeDir,
    updatedSourceCommitSha: featureSha,
    updatedSourceRemoteRef: "refs/heads/robo/feature",
    updatedExpectedTreeSha: featureTree,
  });
  assert.equal(t2.orchestratorDirective.action, "AUTHORIZE_REMOTE_PUBLISH");
  assert.equal(t2.observed.treeMatchesExpected, true);

  // updatedLocalRepoPath is rejected on Stage-2 authorize_publish.
  await assert.rejects(
    () =>
      service.continueHandoff({
        handoffId: t1.handoffId,
        intent: "authorize_publish",
        message: "Sneak path change during publish",
        updatedLocalRepoPath: worktreeDir,
      }),
    (err: unknown) => err instanceof BridgeError && err.code === "INVALID_CONTRACT_CONFLICT",
  );

  // Turn 3: Stage-2 authorize_publish opens and reconciles PR #77.
  const t3 = await service.continueHandoff({
    handoffId: t1.handoffId,
    intent: "authorize_publish",
    message: "Authorize managed draft PR.",
  });
  assert.equal(t3.observed.reconciledPrState, "open_verified");
  assert.equal(t3.orchestratorDirective.action, "COMPLETE");

  // Reset openPrs so we also prove config-level defaultPublisherOwner="local" override when envelope omits publisherOwner.
  const gw = JSON.parse(readFileSync(statePath, "utf8"));
  gw.openPrs = [];
  writeFileSync(statePath, JSON.stringify(gw));

  const localTurn = await localDefaultService.startHandoff({
    targetId: "robo",
    envelope: {
      schemaVersion: "0.2",
      requestId: "config-override-local-1",
      workspaceId: "ws",
      title: "Config defaultPublisherOwner override",
      outcome: "Verify candidate for configured local publisher.",
      mode: "verify_only",
      gitContext: {
        repoId: "example/repo",
        localRepoPath: worktreeDir,
        remoteUrlOrPath: fixture.originBareDir,
        pinnedBaseCommitSha: baseSha,
        pinnedSourceCommitSha: featureSha,
        sourceRemoteRef: "refs/heads/robo/feature",
      },
      requestedCapabilities: {
        allowCodeEdit: false,
        allowBranchPush: false,
      },
      acceptanceCriteria: ["Returns PUBLISH_LOCALLY"],
    },
  });
  assert.equal(localTurn.orchestratorDirective.action, "PUBLISH_LOCALLY");
});

async function prepareUpdate(t: TestContext, opts: { foreignHead?: boolean } = {}) {
  const fixture = createTempGitFixture();
  const prHead = fixture.commitFile("README.md", "published before", "current pull request head");
  const candidate = fixture.commitFile("README.md", "refreshed tree", "refresh candidate");
  const tree = fixture.revParse("HEAD^{tree}");
  const ref = "refs/heads/main";
  fixture.git(["push", "origin", ref]);
  const statePath = join(fixture.rootDir, "gateway.json");
  const originalEnv = process.env.FAKE_GATEWAY_STATE_FILE;
  process.env.FAKE_GATEWAY_STATE_FILE = statePath;
  const prUrl = "https://github.com/example/repo/pull/9";
  // The target's managed publication always makes its own commit with the verified tree.
  const publishCommit = "c".repeat(40);
  const reply = (disposition: string) => "```handoff-result\n" + JSON.stringify({
    disposition, candidateRef: ref, candidateCommitSha: candidate, prUrl,
    summaryDelta: disposition, blockers: [], claimedChecks: [],
  }) + "\n```";
  writeFileSync(statePath, JSON.stringify({
    openPrs: [{ number: 9, url: prUrl, headRefName: "feature", headRefOid: opts.foreignHead ? "d".repeat(40) : prHead }],
    commitTrees: { [publishCommit]: tree, ["d".repeat(40)]: "e".repeat(40) },
    queuedTurnReplies: [
      { replyText: reply("ready_for_publish_gate") },
      { replyText: reply("completed"), updatedPr: { number: 9, headRefOid: publishCommit } },
    ],
  }));
  const service = new BridgeService({
    dataDir: fixture.rootDir,
    ghCliPath: resolve("test/helpers/fake-gh-cli.mjs"),
    targets: { robo: { targetId: "robo", url: "https://gateway.example", authMode: "direct-token",
      agentId: "main", cliPath: resolve("test/helpers/fake-openclaw-cli.mjs") } },
  });
  t.after(() => {
    service.close();
    if (originalEnv === undefined) delete process.env.FAKE_GATEWAY_STATE_FILE;
    else process.env.FAKE_GATEWAY_STATE_FILE = originalEnv;
    fixture.cleanup();
  });
  const envelope = (gitContext: Record<string, unknown> = {}) => ({
    schemaVersion: "0.2" as const, requestId: "update-pr", workspaceId: "workspace", title: "Refresh the pull request",
    outcome: "Update the existing pull request to the verified tree.", mode: "publish_unchanged" as const,
    publisherOwner: "remote_gated" as const,
    gitContext: { repoId: "example/repo", remoteUrlOrPath: fixture.originBareDir, pinnedBaseCommitSha: prHead,
      pinnedSourceCommitSha: candidate, expectedTreeSha: tree, sourceRemoteRef: ref,
      updatePullRequest: { url: prUrl, expectedHeadSha: prHead }, ...gitContext },
    requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
    acceptanceCriteria: ["The pull request ends with exactly the verified tree"],
  });
  return { service, envelope, prUrl, publishCommit, statePath };
}

test("Updating an existing pull request is authorized while its head is unchanged and settles by tree", async (t) => {
  const { service, envelope, prUrl, publishCommit } = await prepareUpdate(t);
  // The pull request is open and the target names it, yet nothing of this handoff landed yet.
  const ready = await service.startHandoff({ targetId: "robo", envelope: envelope() });
  assert.equal(ready.observed.reconciledPrState, "none", JSON.stringify(ready.observed.verificationNotes));
  assert.equal(ready.orchestratorDirective.action, "AUTHORIZE_REMOTE_PUBLISH");

  const published = await service.continueHandoff({ handoffId: ready.handoffId, intent: "authorize_publish", message: "Update it." });
  assert.equal(published.observed.reconciledPrState, "open_verified", JSON.stringify(published.observed.verificationNotes));
  assert.equal(published.observed.reconciledPrUrl, prUrl);
  assert.equal(published.orchestratorDirective.action, "COMPLETE");
  assert.match((published.observed.verificationNotes ?? []).join("\n"), /verified tree/);
  assert.notEqual(publishCommit, published.observed.observedHeadSha);
});

test("Updating a pull request whose head moved to another tree stops before authorization", async (t) => {
  const { service, envelope } = await prepareUpdate(t, { foreignHead: true });
  const ready = await service.startHandoff({ targetId: "robo", envelope: envelope() });
  assert.equal(ready.observed.reconciledPrState, "uncertain_in_flight");
  await assert.rejects(
    service.continueHandoff({ handoffId: ready.handoffId, intent: "authorize_publish", message: "Update it." }),
    (error: unknown) => error instanceof BridgeError && /RECONCILIATION_UNCERTAIN|CONTRACT_VIOLATION/.test(error.code),
  );
});

test("An update contract needs the target tree and a pull request in the handoff repository", async (t) => {
  const { service, envelope } = await prepareUpdate(t);
  for (const gitContext of [
    { expectedTreeSha: undefined },
    { updatePullRequest: { url: "https://github.com/other/repo/pull/9", expectedHeadSha: "a".repeat(40) } },
  ]) {
    await assert.rejects(service.startHandoff({ targetId: "robo", envelope: envelope(gitContext) }),
      (error: unknown) => error instanceof BridgeError && error.code === "INVALID_CONTRACT_CONFLICT");
  }
});

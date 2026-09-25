// QML contract test for the pinned snapshot handoff; no desktop shell is started.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../Background.qml', import.meta.url), 'utf8');
function extract(name) {
  const match = source.match(new RegExp(`^  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'));
  assert.ok(match, `QML function ${name} exists`);
  return match[0];
}

const keyFunction = extract('pinnedStageKey');
const referencesFunction = extract('pinnedLogicalReferences');
const activeFunction = extract('activeStagedSnapshots');
const pruneFunction = extract('pruneStagedPinnedPaths');
const samePathMapFunction = extract('samePathMap');
const rendererUseFunction = extract('rendererUsesSnapshot');
const updateRendererFunction = extract('updateRendererSource');
const flushLeaseFunction = extract('flushPinnedLeaseReleases');
const leaseExitFunction = extract('finishPinnedLeaseRelease');
const validateFunction = extract('isStagedSnapshotPath');
const ensureFunction = extract('ensurePinnedMedia');
const prepareLinkFunction = extract('prepareCurrentLinkState');
const finishLinkFunction = extract('finishCurrentLinkPublication');
const pickFunction = extract('pickForScreens');
const renderFunction = extract('renderPathFor');
const primaryPickFunction = extract('primaryPick');
const expandHomeFunction = extract('expandHome');
const safePathFunction = extract('safePath');
const finishFunction = extract('finishPinnedStage');
const renewFunction = extract('renewPinnedLeaseSnapshots');
const renewExitFunction = extract('finishPinnedLeaseRenewal');
const deactivateFunction = extract('deactivateService');
const syncFunction = extract('syncCurrentLink');
const startLinkFunction = extract('startCurrentLinkPublication');

function context() {
  const state = vm.createContext({
    serviceActive: true,
    screenNames: () => ['DP-1'],
    configFor: () => ({ folder: '/pool', recursive: false, mode: 'single', pinned: '/pool/a.jpg' }),
    poolKeyFor: () => 'pool-key',
    usablePoolFor: () => ['/pool/a.jpg'],
    displayedMap: {},
    incomingMap: {},
    oldMap: {},
    slotAMap: {},
    slotBMap: {},
    independentDisplayPicks: true,
    stagedPinnedPaths: {},
    stagedPinnedLeaseTokens: {},
    pendingPinnedLeaseReleases: [],
    rendererSourcePaths: {},
    inFlightPinnedLeaseReleases: [],
    pinnedLeaseReleaseRetryCount: 0,
    failedPinnedPaths: {},
    currentLinkSnapshotPath: '',
    pendingCurrentLinkSnapshotPath: '',
    inFlightCurrentLinkSnapshotPath: '',
    uncertainCurrentLinkSnapshotPaths: [],
    currentLinkStateReady: true,
    readlinkProc: { running: false },
    hasFolder: () => false,
    configReload: { stop: () => { state.configReloadStopped = true; } },
    scanProc: { running: false },
    pinStageProc: { running: false, command: [] },
    pinLeaseReleaseProc: { running: false, command: [] },
    pinLeaseRenewProc: { running: false, command: [] },
    pinnedLeaseRenewalFailures: 0,
    pinnedLeaseRenewalUnavailable: false,
    pinnedLeaseRenewRetryTimer: {
      restart: () => { state.renewRetryScheduled += 1; },
      stop: () => { state.renewRetryStopped += 1; },
    },
    renewRetryScheduled: 0,
    renewRetryStopped: 0,
    pinnedLeaseReleaseTimer: { restart: () => { state.releaseScheduled += 1; } },
    releaseScheduled: 0,
    pinStagerPath: '/plugin/stage-pinned-media.py',
    stagingCacheRoot: '/home/user/.cache/omarchy/wallpaperomarchymanager/pinned',
    stagingPinFolder: '/pool',
    stagingPinPath: '/pool/a.jpg',
    pythonPath: '/usr/bin/python3',
    pinnedPoolFresh: true,
    hasServiceContext: () => true,
    currentBackgroundDirectory: '/state/current',
    linkPublisherPath: '/plugin/publish-current-background.py',
    linkProc: { command: [], running: false },
    primaryScreenName: () => 'DP-1',
    home: '/home/user',
    root: {
      shuffle: () => {},
      pruneStagedPinnedPaths: () => state.api.pruneStagedPinnedPaths(),
    },
    deferred: [],
    Qt: { callLater: callback => state.deferred.push(callback) },
    console: { warn: () => {} },
  });
  vm.runInContext(`${keyFunction}; ${referencesFunction}; ${activeFunction}; ${samePathMapFunction}; ${pruneFunction}; ${rendererUseFunction}; ${updateRendererFunction}; ${flushLeaseFunction}; ${leaseExitFunction}; ${validateFunction}; ${ensureFunction}; ${prepareLinkFunction}; ${pickFunction}; ${renderFunction}; ${primaryPickFunction}; ${expandHomeFunction}; ${safePathFunction}; ${finishFunction}; ${renewFunction}; ${renewExitFunction}; ${deactivateFunction}; ${syncFunction}; ${startLinkFunction}; ${finishLinkFunction}; this.api = { pinnedStageKey, pinnedLogicalReferences, activeStagedSnapshots, pruneStagedPinnedPaths, rendererUsesSnapshot, updateRendererSource, flushPinnedLeaseReleases, finishPinnedLeaseRelease, isStagedSnapshotPath, ensurePinnedMedia, prepareCurrentLinkState, pickForScreens, renderPathFor, primaryPick, finishPinnedStage, renewPinnedLeaseSnapshots, finishPinnedLeaseRenewal, deactivateService, syncCurrentLink, startCurrentLinkPublication, finishCurrentLinkPublication }`, state);
  return state;
}

const state = context();
const api = state.api;
const key = api.pinnedStageKey('/pool', '/pool/a.jpg');
const snapshotPath = `/home/user/.cache/omarchy/wallpaperomarchymanager/pinned/${'a'.repeat(64)}/media.jpg`;
assert.equal(api.ensurePinnedMedia(), false, 'missing snapshot starts staging and defers selection');
assert.deepEqual(Array.from(state.pinStageProc.command), [
  '/usr/bin/python3', '/plugin/stage-pinned-media.py', '/pool', '/pool/a.jpg', '[]',
], 'stager receives fixed executable/script and folder/pin as separate argv values');
assert.equal(state.pinStageProc.running, true, 'stager is started');
assert.equal(api.pickForScreens()['DP-1'], undefined, 'un-staged source path is never selected for Qt');

const renewal = context();
renewal.stagedPinnedPaths[key] = snapshotPath;
renewal.stagedPinnedLeaseTokens[key] = '9'.repeat(32);
renewal.api.renewPinnedLeaseSnapshots();
assert.deepEqual(Array.from(renewal.pinLeaseRenewProc.command), [
  '/usr/bin/python3', '/plugin/stage-pinned-media.py', '--renew', JSON.stringify([{ path: snapshotPath, lease: '9'.repeat(32) }]),
], 'heartbeat renews the exact active path/token pair through fixed argv');
assert.equal(renewal.pinLeaseRenewProc.running, true, 'lease heartbeat process starts');
const renewalRetry = context();
renewalRetry.api.finishPinnedLeaseRenewal(1);
assert.equal(renewalRetry.pinnedLeaseRenewalFailures, 1, 'failed heartbeat records one retry attempt');
assert.equal(renewalRetry.pinnedLeaseRenewalUnavailable, true, 'failed heartbeat gates future GC-triggering staging');
assert.equal(renewalRetry.renewRetryScheduled, 1, 'failed heartbeat schedules one bounded retry');
renewalRetry.api.finishPinnedLeaseRenewal(0);
assert.equal(renewalRetry.pinnedLeaseRenewalFailures, 0, 'successful heartbeat clears retry state');
assert.equal(renewalRetry.pinnedLeaseRenewalUnavailable, false, 'successful heartbeat reopens staging');
assert.equal(renewalRetry.renewRetryStopped, 1, 'successful heartbeat cancels retry timer');
const emptyRenewal = context();
emptyRenewal.pinnedLeaseRenewalUnavailable = true;
emptyRenewal.api.renewPinnedLeaseSnapshots();
assert.equal(emptyRenewal.pinnedLeaseRenewalUnavailable, false, 'no outstanding snapshots need a lease heartbeat');
const blockedStage = context();
blockedStage.configFor = () => ({ folder: '/pool', recursive: false, mode: 'single', pinned: '/pool/next.jpg' });
blockedStage.usablePoolFor = () => ['/pool/next.jpg'];
blockedStage.stagedPinnedPaths[key] = snapshotPath;
blockedStage.stagedPinnedLeaseTokens[key] = '9'.repeat(32);
blockedStage.pinnedLeaseRenewalUnavailable = true;
assert.equal(blockedStage.api.ensurePinnedMedia(), false, 'lease outage blocks another cache-pruning stage');
assert.equal(blockedStage.pinStageProc.running, false, 'no stage helper runs while known leases are unrenewed');
const inactiveRenewal = context();
inactiveRenewal.serviceActive = false;
inactiveRenewal.stagedPinnedPaths[key] = snapshotPath;
inactiveRenewal.stagedPinnedLeaseTokens[key] = '9'.repeat(32);
inactiveRenewal.api.renewPinnedLeaseSnapshots();
assert.equal(inactiveRenewal.pinLeaseRenewProc.running, false, 'inactive service cannot renew leases forever');
assert.match(source, /id:\s*pinnedLeaseRenewTimer[\s\S]*?interval:\s*12\s*\*\s*60\s*\*\s*60\s*\*\s*1000[\s\S]*?repeat:\s*true[\s\S]*?running:\s*root\.serviceActive[\s\S]*?onTriggered:\s*root\.renewPinnedLeaseSnapshots\(\)/,
  'lease heartbeat timer is active only while the QML service is active and runs below the seven-day TTL');

const teardown = context();
const teardownOldKey = teardown.api.pinnedStageKey('/pool', '/pool/old.jpg');
const teardownOldSnapshotPath = `/home/user/.cache/omarchy/wallpaperomarchymanager/pinned/${'b'.repeat(64)}/media.jpg`;
const teardownCurrentKey = teardown.api.pinnedStageKey('/pool', '/pool/current.jpg');
const teardownCurrentSnapshotPath = `/home/user/.cache/omarchy/wallpaperomarchymanager/pinned/${'c'.repeat(64)}/media.jpg`;
teardown.serviceActive = false;
teardown.stagedPinnedPaths[teardownOldKey] = teardownOldSnapshotPath;
teardown.stagedPinnedLeaseTokens[teardownOldKey] = 'b'.repeat(32);
teardown.stagedPinnedPaths[teardownCurrentKey] = teardownCurrentSnapshotPath;
teardown.stagedPinnedLeaseTokens[teardownCurrentKey] = 'c'.repeat(32);
teardown.currentLinkSnapshotPath = teardownCurrentSnapshotPath;
teardown.pendingCurrentLinkSnapshotPath = snapshotPath;
teardown.displayedMap['DP-1'] = '/pool/old.jpg';
teardown.rendererSourcePaths[JSON.stringify(['DP-1', 'slotA'])] = teardownOldSnapshotPath;
teardown.linkProc.running = true;
teardown.api.deactivateService();
assert.equal(teardown.linkProc.running, true, 'deactivation does not cancel an in-flight atomic publication');
assert.equal(teardown.pendingCurrentLinkSnapshotPath, '', 'deactivation drops unpublished queued link work');
assert.equal(teardown.displayedMap['DP-1'], '/pool/old.jpg', 'renderer maps remain until panel teardown is deferred');
teardown.deferred.shift()();
assert.deepEqual(Object.keys(teardown.displayedMap), [], 'deactivation clears logical renderer maps after panels are torn down');
assert.deepEqual(Object.keys(teardown.rendererSourcePaths), [], 'deactivation clears renderer source references');
assert.equal(teardown.stagedPinnedPaths[teardownCurrentKey], teardownCurrentSnapshotPath, 'currently published link stays leased');
assert.equal(teardown.pendingPinnedLeaseReleases[0].lease, 'b'.repeat(32), 'unreferenced snapshot lease is released on teardown');

const startup = context();
startup.currentLinkStateReady = false;
startup.hasFolder = () => true;
startup.api.prepareCurrentLinkState();
assert.equal(startup.api.ensurePinnedMedia(), false, 'startup waits until the old current-link target is discovered');
assert.equal(startup.pinStageProc.running, false, 'startup does not run cleanup before reading the current link');
assert.equal(startup.readlinkProc.running, true, 'late service activation starts a current-link read');
const linked = context();
linked.currentLinkSnapshotPath = snapshotPath;
assert.deepEqual(Array.from(linked.api.activeStagedSnapshots()), [snapshotPath],
  'current-link snapshot is passed to cleanup even before it has a QML map');

state.pinStageProc.running = false; // model Process.onExited before its result is installed
const snapshotLease = 'c'.repeat(32);
api.finishPinnedStage(0, JSON.stringify({ path: snapshotPath, lease: snapshotLease }));
assert.equal(state.stagedPinnedPaths[key], snapshotPath,
  'successful helper output is stored as the snapshot');
assert.equal(state.stagedPinnedLeaseTokens[key], snapshotLease,
  'successful helper output stores the matching filesystem lease token');
assert.equal(api.isStagedSnapshotPath('/tmp/not-private.jpg'), false, 'outside-cache output is rejected');
assert.equal(state.deferred.length, 1, 'successful staging schedules a fresh shuffle');
assert.equal(api.ensurePinnedMedia(), true, 'existing private snapshot allows selection');
assert.equal(api.pickForScreens()['DP-1'], '/pool/a.jpg', 'logical pin remains in transition state');
assert.equal(api.renderPathFor('/pool/a.jpg'), snapshotPath,
  'Qt renderer receives only the staged snapshot path');
api.syncCurrentLink({ 'DP-1': '/pool/a.jpg' });
assert.equal(state.linkProc.command.at(-1), snapshotPath,
  'published current-background link uses the staged snapshot for a pin');

const queuedLink = context();
queuedLink.stagedPinnedPaths[key] = snapshotPath;
queuedLink.api.syncCurrentLink({ 'DP-1': '/pool/a.jpg' });
const firstTarget = queuedLink.linkProc.command.at(-1);
queuedLink.api.syncCurrentLink({ 'DP-1': '/theme/next.jpg' });
assert.equal(queuedLink.linkProc.command.at(-1), firstTarget,
  'a second current-link request does not overwrite a Process already in flight');
queuedLink.linkProc.running = false;
queuedLink.api.finishCurrentLinkPublication(0);
assert.equal(queuedLink.currentLinkSnapshotPath, firstTarget,
  'completion records the target actually published by the first Process');
assert.equal(queuedLink.linkProc.command.at(-1), '/theme/next.jpg',
  'the latest queued target starts after the first publication exits');

const unstagedPin = context();
assert.equal(unstagedPin.api.renderPathFor('/pool/a.jpg'), '',
  'configured pin with no staged snapshot fails closed instead of reaching Qt by original path');
assert.equal(unstagedPin.api.renderPathFor('/theme/background.jpg'), '/theme/background.jpg',
  'non-pinned theme path keeps the existing pass-through behavior');

const lateStage = context();
lateStage.serviceActive = false;
lateStage.api.finishPinnedStage(0, JSON.stringify({ path: snapshotPath, lease: 'd'.repeat(32) }));
assert.equal(lateStage.stagedPinnedPaths[key], undefined, 'late stage completion is not mapped into an inactive service');
assert.equal(lateStage.pendingPinnedLeaseReleases[0].lease, 'd'.repeat(32), 'late stage completion releases its unused lease');

const invalid = context();
invalid.api.finishPinnedStage(0, JSON.stringify({ path: '/tmp/untrusted/media.jpg', lease: 'd'.repeat(32) }));
assert.equal(invalid.stagedPinnedPaths[key], undefined, 'out-of-cache path is never stored for Qt');
assert.equal(invalid.failedPinnedPaths[key], true, 'invalid successful exit fails closed');
assert.equal(invalid.pendingPinnedLeaseReleases.length, 0,
  'invalid outside-cache output does not create a lease-release request');

const failedStage = context();
failedStage.api.finishPinnedStage(1, JSON.stringify({ path: snapshotPath, lease: '8'.repeat(32) }));
assert.equal(failedStage.pendingPinnedLeaseReleases[0].lease, '8'.repeat(32),
  'valid lease token from a failed stage is queued for release');
assert.equal(failedStage.releaseScheduled, 1,
  'failed stage schedules cleanup for its unconsumed lease');

const retained = context();
retained.stagedPinnedPaths[key] = snapshotPath;
retained.stagedPinnedLeaseTokens[key] = 'a'.repeat(32);
const oldKey = retained.api.pinnedStageKey('/pool', '/pool/old.jpg');
const oldSnapshotPath = `/home/user/.cache/omarchy/wallpaperomarchymanager/pinned/${'b'.repeat(64)}/media.jpg`;
const uncertainLink = context();
uncertainLink.stagedPinnedPaths[key] = snapshotPath;
uncertainLink.stagedPinnedLeaseTokens[key] = '9'.repeat(32);
uncertainLink.currentLinkSnapshotPath = oldSnapshotPath;
uncertainLink.api.syncCurrentLink({ 'DP-1': '/pool/a.jpg' });
uncertainLink.linkProc.running = false;
uncertainLink.api.finishCurrentLinkPublication(1);
assert.equal(uncertainLink.currentLinkSnapshotPath, oldSnapshotPath,
  'failed publication does not claim the requested target is definitely current');
assert.deepEqual(Array.from(uncertainLink.uncertainCurrentLinkSnapshotPaths), [snapshotPath],
  'failed publication retains its possibly-renamed snapshot as uncertain');
assert.ok(uncertainLink.api.activeStagedSnapshots().includes(snapshotPath),
  'uncertain current-link target remains protected from cleanup');
retained.displayedMap['DP-1'] = '/pool/old.jpg';
retained.stagedPinnedPaths[oldKey] = oldSnapshotPath;
retained.stagedPinnedLeaseTokens[oldKey] = 'b'.repeat(32);
assert.deepEqual(Array.from(retained.api.activeStagedSnapshots()), [snapshotPath, oldSnapshotPath],
  'current pin and the prior displayed snapshot are leased through the transition');
retained.api.pruneStagedPinnedPaths();
assert.deepEqual(Object.keys(retained.stagedPinnedPaths), [key, oldKey], 'transition keeps both render paths until completion');
retained.displayedMap = { 'DP-1': '/pool/a.jpg' };
retained.currentLinkSnapshotPath = oldSnapshotPath;
retained.api.pruneStagedPinnedPaths();
assert.deepEqual(Object.keys(retained.stagedPinnedPaths), [key, oldKey], 'current-link snapshot stays leased until publication changes');
assert.equal(retained.pendingPinnedLeaseReleases.length, 0, 'renderer-map change alone does not release the published link target');
retained.inFlightCurrentLinkSnapshotPath = snapshotPath;
retained.api.finishCurrentLinkPublication(0);
assert.deepEqual(Object.keys(retained.stagedPinnedPaths), [key], 'old snapshot mapping is released after link publication succeeds');
assert.equal(JSON.stringify(retained.pendingPinnedLeaseReleases),
  JSON.stringify([{ path: oldSnapshotPath, lease: 'b'.repeat(32) }]), 'mapping removal queues only its lease token for release');
assert.equal(retained.releaseScheduled, 1, 'lease release is delayed until after renderer bindings update');
retained.api.flushPinnedLeaseReleases();
assert.deepEqual(Array.from(retained.pinLeaseReleaseProc.command), [
  '/usr/bin/python3', '/plugin/stage-pinned-media.py', '--release', JSON.stringify([{ path: oldSnapshotPath, lease: 'b'.repeat(32) }]),
], 'QML releases lease through the fixed helper argv');

const rendererHeld = context();
rendererHeld.stagedPinnedPaths[oldKey] = oldSnapshotPath;
rendererHeld.stagedPinnedLeaseTokens[oldKey] = 'e'.repeat(32);
rendererHeld.rendererSourcePaths[JSON.stringify(['DP-1', 'slotB'])] = oldSnapshotPath;
rendererHeld.api.pruneStagedPinnedPaths();
assert.equal(rendererHeld.stagedPinnedPaths[oldKey], oldSnapshotPath,
  'renderer sourcePath keeps its snapshot mapping leased after logical maps change');
assert.equal(rendererHeld.pendingPinnedLeaseReleases.length, 0,
  'no lease is released while a renderer reports the path');
rendererHeld.api.updateRendererSource('DP-1', 'slotB', '');
assert.equal(rendererHeld.stagedPinnedPaths[oldKey], undefined,
  'clearing renderer sourcePath allows the mapping to be pruned');
assert.equal(rendererHeld.pendingPinnedLeaseReleases[0].lease, 'e'.repeat(32),
  'renderer source change queues the matching lease token');

const releaseRetry = context();
releaseRetry.pendingPinnedLeaseReleases = [{ path: oldSnapshotPath, lease: 'f'.repeat(32) }];
releaseRetry.api.flushPinnedLeaseReleases();
assert.equal(JSON.stringify(releaseRetry.inFlightPinnedLeaseReleases),
  JSON.stringify([{ path: oldSnapshotPath, lease: 'f'.repeat(32) }]), 'release batch remains tracked while helper runs');
releaseRetry.pinLeaseReleaseProc.running = false;
releaseRetry.api.finishPinnedLeaseRelease(1);
assert.equal(JSON.stringify(releaseRetry.pendingPinnedLeaseReleases),
  JSON.stringify([{ path: oldSnapshotPath, lease: 'f'.repeat(32) }]), 'failed release keeps its token pending');
assert.equal(releaseRetry.releaseScheduled, 1, 'failed release schedules one bounded retry');
releaseRetry.pinLeaseReleaseProc.running = false;
releaseRetry.api.flushPinnedLeaseReleases();
releaseRetry.api.finishPinnedLeaseRelease(0);
assert.equal(releaseRetry.pendingPinnedLeaseReleases.length, 0, 'successful retry clears pending leases');
assert.equal(releaseRetry.inFlightPinnedLeaseReleases.length, 0, 'successful retry clears inflight leases');

console.log('Pinned staging QML wiring checks passed.');

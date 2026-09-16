'use strict';

///////////////////////////////////////////////////////////////////////////////
// wavedash.js - SP13KTRA on the Wavedash platform: a leaderboard per circuit, achievements, cloud-synced bests
//
// Loaded by the dev page and the enhanced build only: the 13k build never concatenates it. The platform injects
// window.Wavedash before the page's scripts; anywhere else (the dev page, the public GitHub page) it is absent and
// every hook does nothing. The game calls two hooks, each as `wavedashMode && hook()` with NO arguments, so the 13k
// build (wavedashMode a const 0) folds the whole call away (a folded call keeps any argument that is itself a call,
// WAVEDASH.md trap 9.2): wdInit() at the end of gameInit (game.js), wdFinish() after a finish writes the save
// (vehicle.js). The achievement identifiers must match tools/wavedash-setup.js, and every SDK name read here must be
// in build.js's Wavedash name check.
// Spec: docs/superpowers/specs/2026-09-14-wavedash-design.md. Field guide: WAVEDASH.md.
//
// Names (Frank, 2026-09-15): boards TRACK_1..TRACK_8 and achievements ACH_01_FINISH, ACH_02_WIN_TRACK_1 .. ACH_09_WIN_TRACK_8,
// ACH_10_UNLOCK_ALL, ACH_11_WIN_ALL, numbered because Wavedash offers no ordering and lists achievements by identifier
// (the circuit names REDSHIFT.. and WIN_REDSHIFT.. until then). Display names are set in the dev portal

const wd = () => wavedashMode && window.Wavedash; // read at call time, so a mock installed after load still works
const wdFile = 'bests.json'; // the cloud save: {places: '<a digit per circuit>', times: [<seconds per circuit, 0 = none>]}
const wdBoards = []; // per circuit, a promise of its leaderboard id (0 after a failure, so the next finish asks again)
let wdQueue = Promise.resolve(); // cloud syncs run one at a time: two would interleave on the SDK's local copy of the file
// a failed SDK call says why in the console (the enhanced build keeps console): a playtest that shows no board or toast can be read in devtools
const wdWarn = (what, r) => console.warn('Wavedash: ' + what + ' failed', r && r.message || r);

// circuit c's leaderboard id, a promise, asked for once and cached (0 after a failure, so the next finish asks again). ONLY
// getOrCreateLeaderboard creates a board: the REST admin route can set a board's displayName and visible but answers "Leaderboard
// not found" for one that does not exist yet (2026-09-15), so a circuit nobody had finished had no board to show. wdInit asks for
// all eight at startup, and every board is then there to be named and shown in the portal
const wdBoard = c =>
{
    const board = 'TRACK_' + (c+1);
    return wdBoards[c] ||= wd().getOrCreateLeaderboard(board, 0, 2) // ascending, shown as milliseconds
        .then(r => r.success ? r.data.id : (wdWarn('getOrCreateLeaderboard ' + board, r), wdBoards[c] = 0))
        .catch(e => (wdWarn('getOrCreateLeaderboard ' + board, e), wdBoards[c] = 0));
};

function wdInit()
{
    if (!wd()) return;
    wd().init(); // until this runs the platform shows its loading screen over the game
    for (let c = 0; c < circuitCount; ++c)
        wdBoard(c); // every circuit's board exists from the first launch, not from the first finish there
    // (the arrow-key guard that kept the platform page from scrolling lives in input.js since 2026-09-16: every embed needs it, not this one alone)
    wdAchieve(); // from this device's save
    wdSync();
}

// a finish (never a death or a debug skip), called once the save holds the new bests
function wdFinish()
{
    if (!wd()) return;
    const c = currentCircuit, board = 'TRACK_' + (c+1), score = Math.round(raceTime*1000); // this race's time in milliseconds: the board keeps the best
    // a failure warns, an upload still unanswered after 10 s warns, and a success is one info line with its rank (every stage was a
    // warning for one diagnostic playtest, which proved the uploads land: rank 1 on TRACK_1, 2026-09-15)
    let answered = 0;
    setTimeout(() => answered || console.warn('Wavedash: ' + board + ' upload still unanswered after 10 s'), 1e4);
    wdBoard(c)
        .then(id => id ? wd().uploadLeaderboardScore(id, score, true) : (answered = 1, 0)) // no board: its failure has warned already
        .then(r => (answered = 1, r && (r.success ? console.log('Wavedash: ' + board + ' score ' + score + ' ms uploaded, rank ' + r.data?.globalRank, r.data) : wdWarn('uploadLeaderboardScore ' + board, r))))
        .catch(e => (answered = 1, wdWarn('uploadLeaderboardScore ' + board, e)));
    wdAchieve();
    wdSync();
}

// every achievement the saved bests have earned, as its index in the one order every platform shares: 0 a finish (any circuit, any
// place), 1..8 first place on that track, 9 every track unlocked (finishing UMBRA, the seventh, unlocks the eighth), 10 first place on
// all, 11 the secret Supernova (the player exploded in a race this session). Wavedash (wdAchieve) and Newgrounds (newgrounds.js,
// ngAchieve) both unlock from it, so no platform can disagree with the menu
function achievementsEarned()
{
    const earned = [];
    /[1-8]/.test(bestPlaces) && earned.push(0);
    for (let c = 0; c < circuitCount; ++c)
        bestPlaces[c] == 1 && earned.push(c+1);
    circuitsUnlocked() == circuitCount && earned.push(9);
    /^1+$/.test(bestPlaces) && earned.push(10);
    achievementExploded && earned.push(11);
    return earned;
}

// the secret Supernova (Frank, 2026-09-15, a joke achievement): set when the player explodes in a race (wdExplode, ngExplode). Not
// saved: both platforms keep an unlock themselves, and a refused one is retried like the rest while the page stays open
let achievementExploded = 0;

// achievement i's Wavedash identifier (tools/wavedash-setup.js): ACH_01_FINISH, ACH_02_WIN_TRACK_1 .. ACH_09_WIN_TRACK_8, ACH_10_UNLOCK_ALL,
// ACH_11_WIN_ALL, ACH_12_EXPLODE
const wdAchievementId = i => !i ? 'ACH_01_FINISH' : i < 9 ? 'ACH_0' + (i+1) + '_WIN_TRACK_' + i : i < 10 ? 'ACH_10_UNLOCK_ALL' : i < 11 ? 'ACH_11_WIN_ALL' : 'ACH_12_EXPLODE';

// the player exploded in a race, as the race ends (vehicle.js): the secret Supernova
function wdExplode()
{
    achievementExploded = 1;
    wdAchieve();
}

// every achievement from the saved bests (setAchievement is safe to repeat). The SDK
// answers false and DROPS the unlock until it has loaded the player's stats and achievements and the game's achievement ids
// (StatsManager.isReady, @wvdsh/sdk-js 1.3.48), which takes a moment after load: every unlock from the save at init was lost
// that way (2026-09-15). So a refused unlock is tried again every 2 s, and warned about only after a minute of refusals
let wdAchieveTries = 0, wdAchieveTimer = 0;
function wdAchieve()
{
    if (!wd()) return;
    const ids = achievementsEarned().map(wdAchievementId);
    // a throw counts as a refusal: the SDK's synchronous calls can throw (apiCallSync rethrows and never catches the manager's
    // own call), and one uncaught here stopped the game's first frame for good, a black screen (2026-09-15)
    const refused = ids.filter(id => { try { return !wd().setAchievement(id, true); } catch(e) { return 1; } });
    if (!refused.length)
        wdAchieveTries = 0;
    else if (++wdAchieveTries <= 30)
        wdAchieveTimer ||= setTimeout(() => (wdAchieveTimer = 0, wdAchieve()), 2e3);
    else
        wdWarn('setAchievement ' + refused.join(' '), 'refused for a minute: the SDK never became ready, or it does not know the id');
}

// download, merge, upload what the cloud lacks. downloadRemoteFile fails the same way for no file and for no network, so
// only remoteFileExists answering false counts as an empty cloud: a device that cannot read the cloud never writes it
function wdSync()
{
    if (!wd()) return;
    wdQueue = wdQueue
        .then(() => wd().downloadRemoteFile(wdFile))
        .then(r => r.success ? wd().readLocalFile(wdFile).then(bytes => bytes && wdParse(bytes)) : // an unreadable local copy (null) ends the sync
            wd().remoteFileExists(wdFile).then(e => e.success ? !e.data && wdParse() : (wdWarn('remoteFileExists', e), 0))) // 0: never the warning's return value as a cloud
        .then(cloud =>
        {
            if (!cloud) return;
            const [localChanged, cloudBehind] = wdMerge(cloud);
            localChanged && (writeSaveData(), wdAchieve()); // the menu reads the bests live, so a late download just lights it up
            return cloudBehind && wd().writeLocalFile(wdFile, wdEncode()).then(ok => ok && wd().uploadRemoteFile(wdFile));
        })
        .catch(e => wdWarn('cloud sync', e)); // localStorage stays the save: a failed call loses nothing
}

// the cloud file's bests, or empty bests for no file or a malformed one (the next upload repairs it); a download whose local copy
// cannot be read at all (null) never gets here: wdSync ends that sync without writing
function wdParse(bytes)
{
    try
    {
        const o = JSON.parse(new TextDecoder().decode(bytes));
        if (/^[0-8]+$/.test(o.places) && o.places.length == circuitCount && o.times.length == circuitCount &&
            o.times.every(t => typeof t == 'number' && t >= 0 && t < 1e9))
            return o;
    }
    catch(e) {}
    return {places: '0'.repeat(circuitCount), times: Array(circuitCount).fill(0)};
}

// per circuit the better of this device and the cloud, the smaller nonzero place and time, so a device only ever gains;
// returns [this device gained something, the cloud lacks something]
function wdMerge(cloud)
{
    let places = '', times = [], localChanged = 0, cloudBehind = 0;
    const better = (a, b) => a && b ? min(a, b) : a || b;
    for (let c = 0; c < circuitCount; ++c)
    {
        const lp = bestPlaces[c]|0, cp = cloud.places[c]|0, lt = +bestTimes[c] || 0, ct = cloud.times[c];
        const p = better(lp, cp), t = better(lt, ct);
        localChanged |= p != lp || t != lt;
        cloudBehind |= p != cp || t != ct;
        places += p;
        times[c] = t;
    }
    localChanged && (bestPlaces = places, bestTimes = times);
    return [localChanged, cloudBehind];
}

// this device's bests as the cloud file's bytes
const wdEncode = () => new TextEncoder().encode(JSON.stringify({places: bestPlaces,
    times: Array.from({length: circuitCount}, (_, c) => +bestTimes[c] || 0)}));

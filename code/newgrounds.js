'use strict';

///////////////////////////////////////////////////////////////////////////////
// newgrounds.js - SP13KTRA on Newgrounds: medals and a scoreboard per circuit
//
// Loaded by the dev page and the enhanced build only, after wavedash.js, whose achievementsEarned it shares, so the medals can never
// disagree with the Wavedash achievements or the menu; the 13k build never concatenates it. Newgrounds plays the game in an iframe
// whose address carries ngio_session_id for a logged-in player: anywhere else, or before the ids below are filled in, every hook does
// nothing. The game calls two hooks, each as `newgroundsMode && hook()` with NO arguments, so the 13k build folds them away (as
// wavedash.js): ngInit() in gameInit and ngFinish() after a finish writes the save (vehicle.js). No cloud save: the bests stay in
// localStorage (Frank, 2026-09-15).
//
// Ported from the LittleJS Newgrounds plugin (local/newgrounds.js, Frank, 2026-09-15) with three changes: no Medal class (the game
// has none), fetch instead of synchronous XHR (the plugin's two blocking calls at start froze the page for a logged-in player), and
// the browser's crypto.subtle instead of CryptoJS for the AES-128 encryption (the same secure field, about 11 KB less). Names read off
// an object here must stay out of build.js's MANGLE_PROPS, which lists get, add and name: no Map, no Set, and no name key in an object
// literal (build.js's Newgrounds name check).

// from the project's API Tools on newgrounds.com (Frank, 2026-09-15); Newgrounds assigns the medal and scoreboard ids
const ngAppId = '62781:SKEa7Fu7';
// the AES-128 / Base64 encryption key is BLANK HERE and must stay blank: it lives in newgrounds.key, which git ignores, and build.js
// writes it into the enhanced build's source (Frank, 2026-09-15: not on the public GitHub). The dev page and the public page have no
// key, so their Newgrounds hooks stay off; tools/public-sync.js refuses to copy a game file that holds the key
const ngKey = '';
// medal ids in achievementsEarned order: Chequered Flag (finish a race), Redshift .. Race the Spectrum (a win on track 1 .. 8), Open Road (every circuit unlocked), Full Spectrum (a win on all), Supernova (secret: explode in a race)
const ngMedals = [92365, 92366, 92367, 92368, 92369, 92370, 92371, 92372, 92373, 92374, 92375, 92376];
// scoreboard ids per circuit, track 1 .. 8: Standard, Low to High, Time, this race's time in milliseconds
const ngBoards = [16186, 16187, 16188, 16189, 16190, 16191, 16192, 16193];

// the session read at call time (a regex: URLSearchParams' get is in MANGLE_PROPS); 0 off Newgrounds, logged out or with no key
const ngSession = () => newgroundsMode && ngAppId && ngKey && (location.search.match(/[?&]ngio_session_id=([^&]*)/) || 0)[1];
const ngUnlocked = {}; // medal id: 1 once Newgrounds lists it unlocked or an unlock is on its way (a failed unlock clears it)
let ngReady = Promise.resolve(), ngCryptoKey; // ngReady: the medal list at start, so no unlock goes out before it is known
const ngWarn = (what, r) => console.warn('Newgrounds: ' + what + ' failed', r && r.message || r);

function ngInit()
{
    if (!ngSession()) return;
    // the medals the player already has, so a start unlocks only what the save earned since; a failed list unlocks everything earned
    ngReady = ngCall('Medal.getList').then(d => d && d.medals.map(m => m.unlocked && (ngUnlocked[m.id] = 1))).then(ngAchieve);
    setInterval(() => ngCall('Gateway.ping'), 6e4); // keeps the session alive, as the plugin does
}

// a finish (never a death or a debug skip), called once the save holds the new bests
function ngFinish()
{
    if (!ngSession()) return;
    const c = currentCircuit, board = ngBoards[c], score = Math.round(raceTime*1000); // this race's time in milliseconds: the board ranks the lowest first
    board && ngCall('ScoreBoard.postScore', {id: board, value: score})
        .then(d => d && console.log('Newgrounds: track ' + (c+1) + ' score ' + score + ' ms posted'));
    ngReady = ngReady.then(ngAchieve);
}

// the player exploded in a race, as the race ends (vehicle.js): the secret Supernova
function ngExplode()
{
    achievementExploded = 1; // wavedash.js's, set here too so neither hook depends on the other
    if (!ngSession()) return;
    ngReady = ngReady.then(ngAchieve);
}

// unlocks every medal the saved bests have earned that the player does not have yet
function ngAchieve()
{
    if (!ngSession()) return;
    for (const i of achievementsEarned())
    {
        const id = ngMedals[i];
        id && !ngUnlocked[id] && (ngUnlocked[id] = 1, ngCall('Medal.unlock', {id}).then(d => d || (ngUnlocked[id] = 0))); // a failure is tried again on the next finish
    }
}

// one call through the Newgrounds.io gateway, encrypted as the plugin does: the call's JSON {component, parameters} under AES-128-CBC
// with a random 16-byte IV, the IV then the ciphertext in base64 as call.secure, parameters 0. Resolves to the component's data on
// success, else 0 after a console warning; it never rejects
async function ngCall(component, parameters)
{
    try
    {
        const iv = crypto.getRandomValues(new Uint8Array(16));
        const key = await (ngCryptoKey ||= crypto.subtle.importKey('raw', Uint8Array.from(atob(ngKey), c => c.charCodeAt(0)), 'AES-CBC', false, ['encrypt']));
        // the algorithm from string pairs, not {name: 'AES-CBC', iv}: name is in MANGLE_PROPS, and the renamed key made every call in the
        // enhanced build fail with "Algorithm: name: Missing" (test/newgrounds-walk.js, 2026-09-15; the Node test runs the unmangled source)
        const secret = new Uint8Array(await crypto.subtle.encrypt(Object.fromEntries([['name', 'AES-CBC'], ['iv', iv]]), key, new TextEncoder().encode(JSON.stringify({component, parameters}))));
        const body = new FormData;
        body.append('input', JSON.stringify({app_id: ngAppId, session_id: ngSession(), call: {component, parameters: 0, secure: btoa(String.fromCharCode(...iv, ...secret))}}));
        const r = await (await fetch('https://newgrounds.io/gateway_v3.php', {method: 'POST', body})).json();
        const data = r.result && r.result.data;
        if (r.success && data && data.success)
            return data;
        ngWarn(component, data && data.error || r.error);
    }
    catch(e)
    {
        ngWarn(component, e);
    }
    return 0;
}

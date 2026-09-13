'use strict';

///////////////////////////////////////////////////////////////////////////////
// debug.js - build flags and the dev-only tools
//
// Loads FIRST. In a release build this whole file is replaced by release.js
// (enhanced) or releaseJS13K.js (13k), which declare the same names as `const 0`
// plus empty stubs for every function below, so terser folds every `debug &&`,
// `devMode` and `freeCamMode` branch out of the shipped game. The names and the
// stub list in those two files must stay in step with this one.
//
// Owns: the flags, the dev counters the readout and the tests read (averageFPS,
// glDrawCalls, glStaticBytes...), the free cam, the top-down map view, the dev
// key handling, the console commands and the screenshot/text download helpers.
//
// Entry points, all called from game.js under `debug &&`: debugInit() after
// inputInit (it chains onto the mouse handler), debugUpdate() each frame before
// the game update, debugDraw() at the end of the frame. Other files write the
// counters under `debug &&` (game.js, webgl.js, draw.js, track.js) and vehicle.js
// reads testTurn; game.js reads freeCamPos/freeCamRot to place the camera. The
// dev keys that ship in the dev build only (Home, M, N, R, +/-) live in game.js;
// everything behind devMode lives here.

const debug = 1;
let enhancedMode = 1; // the enhanced build: gamepad, WASD, aspect clamp (const 0 in releaseJS13K.js)
let enableAsserts = 1;
let devMode = 0; // the dev() console command toggles it (the Home key until 2026-09-13); every dev key needs it, so a visitor to the public page plays the plain game. Saved in localStorage.SP13KDEV (devSet), so a reload stays in dev mode
let topDownMode = 0, topDownZoom = 1, topDownPan; // T: an orthographic map view straight down over the loop (glPreRender, updateCamera); the wheel zooms, WASD pans
let downloadLink, debugMesh, debugCapture, debugCanvas;

// a debug skip of d quarter laps (N, and 1/2): world placement through place(), then the gates
// crossed are counted, so a skip is a way along the lap and twelve of them finish the race
// (before, a skip landed past its gates and the lap never counted); it poisons the run, so
// no placing is recorded
function debugSkip(d)
{
    playerVehicle.place(playerVehicle.s + d*lapDistance/4);
    debugCatchGates();
}

// after any dev relocation: the gates catch up with the player's route position (both ways) and the lap follows, with
// the lap beeps when it moves on to a new lap. Every relocation needs it: the 3/4 creep moved the craft past gates
// without counting them, so the next gate stayed behind and no gate or lap counted for the rest of the race, and a
// skip over the line counted the lap in silence (2026-09-13). The run is poisoned for records
function debugCatchGates()
{
    const v = playerVehicle;
    while (v.s >= v.nextGate) ++v.gates, v.nextGate += lapDistance/8;
    while (v.gates && v.s < v.nextGate-lapDistance/8) --v.gates, v.nextGate -= lapDistance/8;
    const lap = max(0, Math.floor((v.gates-1)/8));
    if (lap > playerLap) lapBeeps = 3;
    v.lap = playerLap = lap;
    debugSkipped = 1;
}

let debugInfo=0, debugSkipped=0; // the readout, on with dev mode; the run used a skip, so no record time

// dev mode on or off, with its readout, remembered for the next load
function devSet(on)
{
    debugInfo = devMode = on ? 1 : 0;
    on ? localStorage.SP13KDEV = 1 : delete localStorage.SP13KDEV;
}

let freeCamPos, freeCamRot, mouseDelta;
const freeCamSaveName = 'SP13KFREECAM'; // the free cam bookmark (debugInit); freeCamRestore = [s, x] of the player to reseat
let freeCamRestore, freeCamStarted = 0; // freeCamStarted: the free cam has taken its pose and asked for the pointer once (debugUpdate)
// dev flags (the release files declare these as const 0 so terser folds every branch)
let clampAspectRatios = 1;
let testLevel, quickStart, disableAiVehicles, testDrive, freeCamMode, testLevelInfo;
quickStart = localStorage.SP13KQUICK|0; // the quick() console command, remembered (game.js reads it at load)

// dev CONSOLE COMMANDS (words in the devtools console instead of number keys); debugInit
// lists them at startup. Each is a plain global function
const devCommands = {
    dev: 'dev mode on/off, remembered across reloads: every dev key ([ ] N F T + - and the rest) works only in it',
    quick: 'quick start on/off, remembered across reloads (reloads now): straight into the race, no title or countdown',
    menu: 'menu start on/off, remembered across reloads (reloads now): the page opens on the menu',
    unlock: 'unlock every circuit (a last place on each)',
    places: 'random best placings and best times',
    finish: 'finish the race now: the lap count completes and the real finish path runs, as a skip',
    regions: 'show the UI click regions (the menu rows) on/off',
};
let showRegions = 0;
function dev() { devSet(!devMode); return 'dev mode ' + (devMode ? 'on: the dev keys work' : 'off'); }
function regions() { showRegions = !showRegions; return 'regions ' + (showRegions ? 'on' : 'off'); }

// the click regions, as game.js tests them (hud.js calls this under debug && showRegions)
function drawRegions()
{
    const ctx = mainContext, W = mainCanvasSize.x, H = mainCanvasSize.y;
    ctx.strokeStyle = '#0f0'; ctx.lineWidth = 1;
    for (let c = 0; c <= circuitCount; ++c) // row circuitCount is the TEAM button
        ctx.strokeRect(menuRowX()*W, (menuRowY(c)-menuRowSize(c)*.45)*H, ((menuRowW[c]+1)/2-menuRowX())*W, menuRowSize(c)*.9*H);
}

function quick()
{
    quickStart ? delete localStorage.SP13KQUICK : localStorage.SP13KQUICK = 1;
    location.reload();
}

function menu() // the page opens on the menu (debugInit sets menuMode from the flag)
{
    localStorage.SP13KMENU ? delete localStorage.SP13KMENU : localStorage.SP13KMENU = 1;
    location.reload();
}

function unlock() { bestPlaces = '8'.repeat(circuitCount); writeSaveData(); return 'every circuit unlocked'; }
function places() // random placings and times (a minute to four) on every circuit, saved
{
    bestPlaces = Array.from({length: circuitCount}, () => randInt(8)+1).join('');
    bestTimes = Array.from({length: circuitCount}, () => rand(60, 240));
    writeSaveData();
    return 'best placings ' + bestPlaces + ', times ' + bestTimes.map(t => formatTimeString(t));
}

function finish()
{
    if (titleScreenMode || gameOverTime) return 'not racing';
    playerLap = raceLaps; debugSkipped = 1;
    return 'finishing';
}

let testTurn = 0; // analog steer for the drift suite (keyboard turn is binary): vehicle.js reads it under `debug &&`
let averageFPS = 0, glBatchCountTotal, glDrawCalls; // the readout's counters, written under `debug &&` in game.js / webgl.js
let glUploadBytes=0, glLiveBuffers=0, glStaticBytes=0, glStaticUploads=0, worldBuildCount=0, roadPanels=[]; // resource lifecycle counters for the circuits/world-probe tests
let skylineSites; // [x, z, margin, height] per placed scenery piece, recorded under `debug &&` in buildScenery

// ASSERT is an empty function in the release, but its ARGUMENTS still ship: gate
// a call whose arguments do work behind `debug &&` (see Vector3's constructor)
function ASSERT(assert, output)
{ enableAsserts&&(output ? console.assert(assert, output) : console.assert(assert)); }
function LOG() { console.log(...arguments); }

// the free cam's rotations (the shipped game turns only constant vectors, written out inline)
function debugVectorMethods()
{
    Vector3.prototype.copy = function() { return vec3(this.x, this.y, this.z); } // the tests and the free cam (the game uses scale(1): copy went for size on 2026-09-13)
    Vector3.prototype.rotateX = function(a)
    {
        const c=Math.cos(a), s=Math.sin(a);
        return vec3(this.x, this.y*c - this.z*s, this.y*s + this.z*c);
    }
    Vector3.prototype.rotateY = function(a)
    {
        const c=Math.cos(a), s=Math.sin(a);
        return vec3(this.x*c - this.z*s, this.y, this.x*s + this.z*c);
    }
}

///////////////////////////////////////////////////////////////////////////////
// init: mouse look, the free cam bookmark and the key legend

function debugInit()
{
    debugVectorMethods();
    freeCamPos = vec3();
    freeCamRot = vec3();
    mouseDelta = vec3();
    localStorage.SP13KDEV && devSet(1); // a reload stays in dev mode
    localStorage.SP13KMENU && (menuMode = 1); // the menu() command: open on the menu

    // free cam mouse look, chained onto input.js's mouse steer handler (debugInit runs after
    // inputInit; assigning onmousemove here used to be overwritten by it, which killed the look)
    onwheel = (e)=> topDownZoom *= e.deltaY > 0 ? 1.25 : .8; // the top-down view's zoom
    const steerDown = onmousedown; // a click in the free cam takes the pointer back after Escape released it (a gesture, once)
    onmousedown = (e)=> { steerDown(e); freeCamMode && !document.pointerLockElement && mainCanvas.requestPointerLock()?.catch(()=>0); };
    const steerMove = onmousemove;
    onmousemove = (e)=>
    {
        steerMove(e);
        if (freeCamMode)
        {
            mouseDelta.x += e.movementX/mainCanvasSize.x;
            mouseDelta.y += e.movementY/mainCanvasSize.y;
        }
    }
    debugCanvas = document.createElement('canvas'); // screenshot compositing surface (0 key)
    downloadLink = document.createElement('a');

    // the free cam bookmark: while the free cam is on, its circuit, pose and the player's
    // spot are saved every frame, and a reload jumps straight back there, skipping the
    // title and countdown, so a tweak-reload loop keeps the same view. leaving the free
    // cam clears it
    const mark = localStorage[freeCamSaveName];
    if (mark)
    {
        const [c, px, py, pz, rx, ry, rz, s, x] = mark.split(',').map(Number);
        currentCircuit = c;
        freeCamPos = vec3(px, py, pz);
        freeCamRot = vec3(rx, ry, rz);
        freeCamRestore = [s, x]; // the player is reseated on the first debugUpdate, once the world exists
        titleScreenMode = 0;
        devSet(1); freeCamMode = 1;
    }
    console.log(
`SP13KTRA dev keys (debug build only, and only in dev mode: type dev() to turn it on; dev mode is ${devMode ? 'ON' : 'off'})
  M      music on/off (every build, no dev mode needed)
  [ ]    previous / next circuit: restarts the race there (title or mid-race)
  R      in race: restart
  N      skip a quarter lap, gates counted (poisons the run: no placing recorded)
  F G    free cam from play (WASD/QE, Shift = fast, mouse look)
  T      top-down map view of the whole circuit (wheel zooms, WASD pans, [ ] browse)
  1 2    back / forward a quarter lap       3 4  hold: z -1000 / +1000 per frame
  5      map      0  save a screenshot
  Q      autodrive (testDrive)     V  spawn a racer     U  win sound
  + -    hold: time x10 / x.1
console commands (type one, with the parentheses)
${Object.entries(devCommands).map(([k, d]) => '  ' + (k+'()').padEnd(10) + d).join('\n')}
quick start is ${quickStart ? 'ON' : 'off'}, menu start is ${localStorage.SP13KMENU ? 'ON' : 'off'}`);
}

///////////////////////////////////////////////////////////////////////////////
// per-frame dev keys and the free cam

function debugUpdate()
{
    // every dev key needs dev mode (the dev() console command): the public page is this build, and a visitor pressing [ ]
    // opened locked circuits, F or T turned dev mode on (2026-09-13, Frank)
    if (!devMode)
        return;

    // [ ] jump to the previous / next circuit and restart the race there (title or mid-race)
    if (keyWasPressed('BracketLeft') || keyWasPressed('BracketRight'))
    {
        currentCircuit = mod(currentCircuit + (keyWasPressed('BracketRight')?1:-1), circuitCount);
        titleScreenMode = 0;
        gameStart();
    }
    if (keyWasPressed('KeyF') || keyWasPressed('KeyG')) // free cam straight from play
        toggleFreeCam();
    if (keyWasPressed('KeyT')) // top-down map view, from anywhere; the loop is fitted again each time it opens
        topDownMode = !topDownMode, topDownZoom = 1, topDownPan = vec3();
    if (topDownMode && !freeCamMode) // pan a fiftieth of the loop radius a frame, scaled by the zoom
        topDownPan = topDownPan.add(vec3(keyIsDown('KeyD')-keyIsDown('KeyA'),0,keyIsDown('KeyW')-keyIsDown('KeyS')).scale(trackMapRadius*.02*topDownZoom));
    if (freeCamMode)
    {
        if (freeCamRestore) // a reload into the bookmark: reseat the player, skip the countdown
        {
            playerVehicle.place(...freeCamRestore);
            startCountdown = 0;
            debugCatchGates();
            freeCamRestore = 0;
        }
        if (!freeCamStarted)
        {
            // just toggled on, or a reload: grab the pointer ONCE and start the free cam from
            // wherever the game camera is right now. (Asking whenever the lock was not held asked
            // every frame after Escape released it: Chrome refused with "too many pointer lock
            // requests" and the pose snapped back each frame; a click asks again)
            freeCamStarted = 1;
            mainCanvas.requestPointerLock()?.catch(()=>0); // a reload has no gesture yet: the next click locks
            freeCamPos = cameraPos.copy();
            freeCamRot = cameraRot.copy();
        }
        // write the bookmark every frame (see debugInit)
        localStorage[freeCamSaveName] = [currentCircuit, freeCamPos.x, freeCamPos.y, freeCamPos.z,
            freeCamRot.x, freeCamRot.y, freeCamRot.z, playerVehicle.s, playerVehicle.localX];

        // WASD strafe/forward, Q/E down/up, in camera space
        const input = vec3(
            keyIsDown('KeyD') - keyIsDown('KeyA'),
            keyIsDown('KeyE') - keyIsDown('KeyQ'),
            keyIsDown('KeyW') - keyIsDown('KeyS'));

        const moveSpeed = keyIsDown('ShiftLeft') ? 500 : 100; // units per frame
        const turnSpeed = 2; // radians per window-width of mouse travel
        const moveDirection = input.rotateX(freeCamRot.x).rotateY(-freeCamRot.y);
        freeCamPos = freeCamPos.add(moveDirection.scale(moveSpeed));
        freeCamRot = freeCamRot.add(vec3(mouseDelta.y,mouseDelta.x).scale(turnSpeed));
        freeCamRot.x = clamp(freeCamRot.x, -PI/2, PI/2); // never flip over the pole
        mouseDelta = vec3();
    }

    // relocations: world placement through place(), and every one poisons the record
    if (keyWasPressed('Digit1') || keyWasPressed('Digit2'))
        debugSkip(keyWasPressed('Digit2') ? 1 : -1); // a quarter lap back / forward
    if (keyIsDown('Digit3') || keyIsDown('Digit4'))
    {
        // held: creep along the route 1,000 route units a frame
        const v = keyIsDown('Digit4') ? 1e3 : -1e3;
        playerVehicle.place(playerVehicle.s+v);
        debugCatchGates();
    }
    if (keyWasPressed('Digit5'))
        showMap = !showMap;
    if (keyWasPressed('Digit0'))
        debugCapture = 1; // debugDraw composites and saves the frame
    if (keyWasPressed('KeyQ') && !freeCamMode) // Q is "down" while the free cam has the keys
        testDrive = !testDrive
    if (keyWasPressed('KeyU'))
        sound_win.play();
    if (debug && keyWasPressed('KeyV')) // an extra rival just behind the player, random grid slot
        vehicles.push(new Racer(playerVehicle.s-1300, 0, randInt(fieldSize-1)))
    //if (!document.hasFocus())
    //    testDrive = 1;
}

function toggleFreeCam()
{
    freeCamMode = !freeCamMode;
    if (!freeCamMode)
    {
        delete localStorage[freeCamSaveName]; // leaving the free cam drops the bookmark
        document.exitPointerLock();
        freeCamStarted = 0;
        cameraPos = vec3(); // updateCamera reseats these next frame
        cameraRot = vec3();
    }
}

///////////////////////////////////////////////////////////////////////////////
// draw: the readout, screenshots and scratch renders

function debugDraw()
{
    if (!debug)
        return;

    // fps / vertices / draw calls / craft count, hidden from screenshots
    if (debugInfo && !debugCapture)
        drawHUDText((averageFPS|0) + 'fps / ' + glBatchCountTotal + ' / ' + glDrawCalls + ' / ' + vehicles.length, .98,.16,.03, WHITE, 'right');

    const c = mainCanvas;
    const context = mainContext;

    if (testDrive && !titleScreenMode)
        drawHUDText('AUTO', .02,.2,.04,rgb(1,0,0),'left');

    if (debugCapture)
    {
        // the WebGL canvas and the 2D HUD canvas are separate layers: composite them
        // over black into debugCanvas and download that
        debugCapture = 0;
        const context = debugCanvas.getContext('2d');
        debugCanvas.width = mainCanvas.width;
        debugCanvas.height = mainCanvas.height;
        context.fillStyle = '#000';
        context.fillRect(0,0,mainCanvas.width,mainCanvas.height);
        context.drawImage(glCanvas, 0, 0);
        context.drawImage(mainCanvas, 0, 0);
        debugSaveCanvas(debugCanvas);
    }

    // test render: set debugMesh from the console to spin any mesh in front of the camera
    debugMesh && debugMesh.render(buildMatrix(cameraPos.add(vec3(0,400,1000)), vec3(0,time,0), vec3(200)), WHITE);

    if (0) // world cube
    {
        const r = vec3(0,-cameraRot.y,0);
        const m1 = buildMatrix(vec3(2220,1e3,2e3), r, vec3(200));
        cubeMesh.render(m1, hsl(0,.8,.5));
    }

    if (0)
    {
        // test noise
        context.fillStyle = '#fff';
        context.fillRect(0, 0, 500, 500);
        context.fillStyle = '#000';
        for(let i=0; i < 1e3; i++)
        {
            const n = noise1D(i/129-time*9)*99;
            context.fillRect(i, 200+n, 9, 9);
        }
    }

    glRender(); // flush anything the scratch renders above queued
}

///////////////////////////////////////////////////////////////////////////////
// downloads (screenshots, dumped text) through a hidden anchor

function debugSaveCanvas(canvas, filename='screenshot', type='image/png')
{ debugSaveDataURL(canvas.toDataURL(type), filename); }

function debugSaveText(text, filename='text', type='text/plain')
{ debugSaveDataURL(URL.createObjectURL(new Blob([text], {'type':type})), filename); }

function debugSaveDataURL(dataURL, filename)
{
    downloadLink.download = filename;
    downloadLink.href = dataURL;
    downloadLink.click();
}

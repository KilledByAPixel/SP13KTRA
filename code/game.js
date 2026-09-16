'use strict';

///////////////////////////////////////////////////////////////////////////////
// game.js: the game loop, race state, chase camera and save data.
//
// Owns the top-level race state every other file reads (time, frame, levelInfo,
// vehicles, playerVehicle, cameraPos/Rot, the countdown and results timers, the
// player's lap/place/energy) and the fixed-step frame loop. Entry points:
//   gameInit()     called once from main.js; creates the canvases and starts the loop
//   gameStart()    (re)builds the world and the grid; also called by debug.js and the
//                  title/results/Escape paths below
//   gameUpdate()   the requestAnimationFrame loop: input, fixed simulation steps,
//                  camera, then drawScene (scene.js), drawHUD (hud.js), debugDraw
//   updateCamera() the chase camera; vehicle.js also calls it to reseat after a death
//   writeSaveData() vehicle.js calls it when a race finishes
// The simulation itself is updateCars/stepVehicle in vehicle.js; the world is built
// by buildTrack in trackGen.js/track.js; the circuit table is levels.js.
///////////////////////////////////////////////////////////////////////////////

// settings (the build flags - clampAspectRatios, testDrive, quickStart... - are declared
// in the flags file that heads the concat order, so terser can fold them here AND in
// the files before this one; see releaseJS13K.js)
const pixelate = 0;        // low-res canvas mode: off (only matters under clampAspectRatios)
const canvasFixedSize = 0;
const frameRate = 60;
const timeDelta = 1/frameRate; // the fixed simulation step, seconds
const pixelateScale = 3;
const random = new Random;     // the shared generator (track.js uses it for stars, clouds and scenery)
let autoPause = enhancedMode;  // pause on focus loss: enhanced build only
let autoFullscreen = 0;

// setup
const laneWidth = 700;             // the road half-width is laneWidth*1.6*laneCount (trackGen.js); pads sit on lane centres
const trackSegmentLength = 100;    // route units per segment: s advances 100 per sample
const cameraBoomZ = 1200; // pulled back: smaller craft, more road, speed reads better (eases out on a boost: updateCamera)
// the starting grid: fieldSize staggered slots, pole nearest the line, one row per slot
const slotZ = s => 2400 - s*520;
const slotX = s => (s%2?1:-1)*800;
const testStartZ = quickStart&&!testLevelInfo?5e3:0;

// race setup
const lapTrackSegments = 4000;  // segments per closed loop
const lapDistance = lapTrackSegments*trackSegmentLength; // route units per lap (400,000; world length is routeScale times that)
const raceLaps = 3;
const circuitCount = 8; // one per racer (ten until 2026-09-13: ALBEDO folded into UMBRA, then the angular ULTRAVIOLET went for the music's space)
let currentCircuit = 0;
let levelInfo; // active circuit biome, pinned for the whole race
let playerLap, playerPlace; // the results card shows lastRacePlace (racePlace, always assigned with it, went on 2026-09-13)

const fieldSize = 8;   // craft in a race: the player and 7 rivals (a field of 20 was tried: from the front you never see them)
let lastRacePlace = fieldSize; // grid order carries over from the last finish
let playerCraft = 0;   // the player's colour, 0..5 of racerColors, picked on the menu

let mainCanvasSize; // set every frame from the window in gameUpdate
let menuStick; // the gamepad stick's latched direction in the menu (dev and enhanced builds)
let mainCanvas, mainContext; // the 2D HUD canvas over the WebGL one (glCanvas, webgl.js)
let time, frame, frameTimeLastMS, frameTimeBufferMS, paused, focusPaused; // averageFPS lives in debug.js (dev-only readout)
let startCountdown, gameOverTime;
let raceTime, playerWin;
let titleScreenMode = 1, menuMode = 0; // menuMode: the title's menu screen (circuit and craft select, hud.js)
let trackSeed = 1331; // the world's random seed: every circuit is preset

///////////////////////////////
// game variables

let cameraPos, cameraRot, cameraRoll=0; // cameraRoll: the bank lean in DEGREES, applied on the view matrix only (webgl.js)
let track, vehicles, playerVehicle; // vehicles[0] is the player at a race start (the menu's craft pick swaps the reference)

///////////////////////////////
// startup

function gameInit()
{
    if (enhancedMode)
    {
        console.log(`SP13KTRA by Frank Force`);
        console.log(`www.frankforce.com 🦄🌈`);
    }

    if (quickStart || testLevel)
        titleScreenMode = 0;

    glInit();

    document.body.appendChild(mainCanvas = document.createElement('canvas'));
    mainContext = mainCanvas.getContext('2d');
    // the page's CSS, set here so it rides roadroller instead of deflate: the 13k shell has
    // no <style> tag at all (-21 against the tag, and property sets beat one cssText string
    // by 9). The enhanced shell adds its centring transform
    document.body.style.margin=0; document.body.style.background=BLACK;
    mainCanvas.style.position=glCanvas.style.position='absolute';

    drawInit();
    inputInit()
    debug && debugInit(); // after inputInit: it chains the free cam's look onto the mouse steer handler
    initLevelInfos();
    gameStart();
    // the Wavedash platform (wavedash.js): once the game can draw, and before the first frame, so a throw in that frame cannot leave
    // the game behind the platform's loading screen (init dismisses it; the frame still paints in this same task). Caught, so a throw
    // from the SDK can never stop gameUpdate from starting the loop: one did, a black screen on the playtest (2026-09-15)
    if (wavedashMode)
        try { wdInit(); } catch(e) { console.error('Wavedash: init failed', e); }
    // Newgrounds (newgrounds.js), caught the same way: nothing it does may stop the first frame
    if (newgroundsMode)
        try { ngInit(); } catch(e) { console.error('Newgrounds: init failed', e); }
    gameUpdate();
}

///////////////////////////////
// a race (or the title's attract lap): rebuild the world, seat the grid, seat the camera

function gameStart()
{
    time=frame=frameTimeLastMS=frameTimeBufferMS=raceTime=playerLap=playerWin=0;
    contactTimes=[]; lowBeepTime=lapBeepTime=lapBeeps=0; // the craft-contact cooldowns and the sound timers (vehicle.js): the clock restarts at 0 each race, so a timer left over from the last race delayed the lap beeps to mid-lap and held back the low-energy tick (post-deadline fix, 2026-09-13)
    startCountdown=quickStart || titleScreenMode ? 0 : 4; // 3, 2, 1, GO
    levelInfo=testLevelInfo || levelInfoList[currentCircuit];
    gameOverTime=0;
    cameraPos=vec3();
    cameraRot=vec3();
    vehicles=[];
    buildTrack(); // same circuit reuses buffers, a new one disposes the old world (track.js)
    musicLoad(); // a new circuit's loop from its seed, from the top; the same circuit carries on (music.js)
    playerPlace=fieldSize;

    // the player always takes the BACK slot; the rivals fill the rest
    // in order (their colour goes by grid order, their skill by colour: vehicle.js)
    const slot=fieldSize-1; // ALWAYS THE BACK (Frank, 2026-09-16): the grid slot was the last finishing place, so a win put you on pole and an old save could hand a returning player pole for ever (he found his js13k save doing exactly that). One grid for everyone also makes leaderboard times comparable, and it is smaller
    vehicles.push(playerVehicle=new Vehicle(slotZ(slot),slotX(slot),hsl(...racerColors[playerCraft]),playerCraft));
    if(!disableAiVehicles) for(let i=0,s=0;i<fieldSize-1;++i,++s)
    {
        if(s==slot) ++s; // skip the player's slot
        vehicles.push(new Racer(slotZ(s),slotX(s),i));
    }
    if(titleScreenMode) // attract mode: the field spread down the road a fifth of a lap in, for the camera to look at
    {
        // the player craft (vehicles[0]) starts at the BACK (80000-i*750 until the post-deadline fix: once the traffic rule worked in the
        // menu, rivals held back behind a player craft started in front, and it led the field 68% of the time; reversed it sits in the
        // pack, 3.7 of 8 and never in front, local/attract-order-probe.js START=1; a lower autodrive skill built over the limit).
        // A camera tweak, 3f88bb4, put the minus back and dropped this comment with it; found again 2026-09-16, free either way
        for(let i=0;i<vehicles.length;++i) vehicles[i].place(80000+i*750,slotX(i));
        // a warm-up: three seconds of the attract race run before the first frame, so a circuit picked in the menu opens on a
        // field already at speed with its trails, not parked in a line (Frank, 2026-09-13). The clock runs on from there.
        // Enhanced build only: in the 13k build it cost 28 bytes
        if(enhancedMode) for(;frame<180;) time=frame++/frameRate, updateCars();
    }
    enhancedMode && (craftCameras=[]); // a new field: the kept cameras belong to the old craft objects
    if(debug) debugSkipped=0; // a fresh race can set a record again
    cameraRot.y=playerVehicle.heading;
    for(let i=99;i--;) updateCamera(); // run the camera's easing to rest so the first frame is seated
}

///////////////////////////////
// one fixed simulation step: title/race flow, then the vehicles

function gameUpdateInternal()
{
    if (titleScreenMode)
    {
        // the title shows the logo over the attract lap; Space or a click opens the MENU,
        // where a click on a name or Up/Down (wrapping) picks the circuit from the unlocked list, the TEAM button or Left/Right
        // the craft, Space or a click on the selected name races, and Escape returns to the title. Results
        // return to the menu. The attract race never restarts on its own: the field laps until a new
        // circuit or a race (a restart every 60 s went on 2026-09-13, Frank: they just keep racing)
        let go = keyWasPressed('Space') || enhancedMode && (keyWasPressed('Enter') || keyWasPressed('NumpadEnter') || isUsingGamepad && (gamepadWasPressed(0)||gamepadWasPressed(9))); // enhanced: Enter as Space (Frank, 2026-09-15)
        if (!freeCamMode) // the free cam has the keys and the mouse (debug.js) and hides the HUD: the title and the menu ignore them (the else below is the menu's)
        if (!menuMode)
            (go || mousePressed) && (menuMode = 1, sound_checkpoint.play(.5));
        else if (!(enhancedMode && helpMenu())) // the HELP card takes the menu's input while it is open, and on the frame it opens or closes (help.js)
        {
            // the mouse: a click on a circuit's name selects it, a click on the selected name
            // races, anywhere else does nothing. The click has to land on the name itself:
            // hud.js records each row's measured right edge (menuRowW, in mouseX units) and
            // menuRowAt is the one hit test (the hover previews it). A locked name just bumps
            let pick = 0, craft = 0;
            const c = mousePressed ? menuRowAt() : -1;
            if (c >= 0) enhancedMode && c > circuitCount + 1 ? toggleFullscreen() : enhancedMode && c > circuitCount ? go = 1 : c == circuitCount ? craft = 1 : c >= circuitsUnlocked() ? sound_bump.play(.5,.7) : c == currentCircuit ? go = 1 : pick = c - currentCircuit; // (row circuitCount is the TEAM button; the enhanced menu's row circuitCount+1 is PLAY)
            if (go)
            {
                titleScreenMode = 0;
                gameStart();
            }
            if (keyWasPressed('Escape'))
                menuMode = 0;

            pick ||= keyWasPressed('ArrowDown') - keyWasPressed('ArrowUp'); // the arrow keys browse the menu in every build (the 13k build's went for WASD on 2026-09-13, -11, and came back in the post-deadline fixes once the any-key mouse-mode fix made room: a menu that only the mouse could browse)
            if (enhancedMode && isUsingGamepad) // the left stick, latched, browses the menu too (dev and enhanced builds, 2026-09-13); the d-pad is in it already (input.js copies it in: reading the buttons as well moved two rows)
            {
                const s = gamepadStick(0), d = vec3(abs(s.x) > .5 ? sign(s.x) : 0, abs(s.y) > .5 ? sign(s.y) : 0);
                pick ||= -(d.y != menuStick?.y && d.y);
                craft += d.x != menuStick?.x && d.x;
                menuStick = d;
            }
            if (pick)
            {
                // the circuit: only unlocked ones, every circuit up to the one after the last
                // finished (the dev [ ] keys browse all), wrapping; one circuit alone stays put
                // (a reload of the same one looked like a glitch); the world rebuilds
                const c = mod(currentCircuit + pick, circuitsUnlocked());
                if (c != currentCircuit)
                {
                    currentCircuit = c;
                    sound_charge.play(.5);
                    gameStart();
                    writeSaveData(); // the pick is saved: a reload opens on the circuit last played
                }
            }

            craft += keyWasPressed('ArrowRight') - keyWasPressed('ArrowLeft');
            if (craft)
            {
                // the craft, by Left/Right or a click on the TEAM button: one of the six band
                // colours, never black or white. You BECOME that craft where it is in the attract
                // lap and the camera cuts over; no restart. The old craft stays in the field as a rival
                playerCraft = mod(playerCraft + craft, 6);
                sound_checkpoint.play(.5);
                playerVehicle = vehicles.find(v=>v.racerIndex==playerCraft);
                // the enhanced build has been keeping a camera behind this craft all along (craftCameras), so the cut lands on one
                // already in the moving steady state. The 13k build re-seats with the craft frozen, which is close but not seated:
                // measured drift after the cut, 37 units kept against 658 frozen, and 1012 with the old 2.3-frame setback, which
                // shoved the camera 2,545 units back and let it slide forward for 40 frames (local/camera-switch-probe.js, 2026-09-16)
                const kept = enhancedMode && craftCameras[playerCraft];
                if (kept)
                    cameraPos = kept.pos, cameraRot = kept.rot;
                else
                {
                    cameraRot.y = playerVehicle.heading;
                    for(let i=60;i--;) updateCamera();
                }
                writeSaveData(); // the craft choice is saved
            }
        }
    }
    else
    {
        if (startCountdown && time >= 4-startCountdown)
        {
            // one beep a second, higher on GO
            --startCountdown;
            sound_beep.play(1,startCountdown?1:2);
        }

        // results: Space/click after a second, or 12 s on their own, leave the results card
        if (gameOverTime && time-gameOverTime > 1 && (keyWasPressed('Space') || mousePressed || enhancedMode && (keyWasPressed('Enter') || keyWasPressed('NumpadEnter') || isUsingGamepad && (gamepadWasPressed(0)||gamepadWasPressed(9)))) || gameOverTime && time-gameOverTime > 12)
        {
            // any finish advances the grand prix (the finale's wraps to the opener); a death
            // retries: finishing is enough, there is no podium rule
            if (playerWin)
            {
                currentCircuit = (currentCircuit+1)%circuitCount;
                writeSaveData();
            }

            // back to the title, which shows the next circuit (or the same one to retry)
            titleScreenMode = 1;
            gameStart();
        }
        if (keyWasPressed('Escape') || enhancedMode && isUsingGamepad && gamepadWasPressed(8))
        {
            // go back to title screen; after a win the enhanced build advances like Space does (the 13k build
            // leaves Escape on the same circuit, the unlock and records already saved; 2026-09-13)
            enhancedMode && playerWin && (currentCircuit = (currentCircuit+1)%circuitCount, writeSaveData());
            sound_charge.play();
            titleScreenMode = 1;
            gameStart();
        }
        // (R restart lives in enhancedModeUpdate: it is a dev/enhanced key, not a 13k one)

        if (!startCountdown && !gameOverTime)
        {
            // race mode: the clock runs from GO until the results card
            raceTime += timeDelta;
            // course-viewing skip: dev only (debug=0 const in the release build, so terser
            // drops this), gates counted, and it poisons the run (debug.js debugSkip)
            debug && devMode && keyWasPressed('KeyN') && debugSkip(1);
        }
    }
    updateCars(); // player, rivals, contacts, laps and the finish (vehicle.js); runs on the title too
}

///////////////////////////////
// the frame loop: size the canvas, catch up the fixed steps, draw

function gameUpdate(frameTimeMS=0)
{
    requestAnimationFrame(gameUpdate); // first (last until the post-deadline fix): an exception anywhere in a frame then costs that frame, not the game
    if (!clampAspectRatios)
        mainCanvasSize = vec3(mainCanvas.width=innerWidth, mainCanvas.height=innerHeight); // the 13k build: the canvas is the window
    else
    {
        // enhanced build: clamp the aspect and letterbox
        const innerAspect = innerWidth / innerHeight;
        if (canvasFixedSize)
        {
            mainCanvas.width  = mainCanvasSize.x;
            mainCanvas.height = mainCanvasSize.y;
        }
        else
        {
            const minAspect = .45, maxAspect = 3;
            const correctedWidth = innerAspect > maxAspect ? innerHeight * maxAspect :
                    innerAspect < minAspect ? innerHeight * minAspect : innerWidth;
            if (pixelate)
            {
                const w = correctedWidth / pixelateScale | 0;
                const h = innerHeight / pixelateScale | 0;
                mainCanvasSize = vec3(mainCanvas.width = w, mainCanvas.height = h);
            }
            else
                mainCanvasSize = vec3(mainCanvas.width=correctedWidth, mainCanvas.height=innerHeight);
        }

        // fit to window by adding space on top or bottom if necessary
        const fixedAspect = mainCanvas.width / mainCanvas.height;
        mainCanvas.style.width  = glCanvas.style.width  = innerAspect < fixedAspect ? '100%' : '';
        mainCanvas.style.height = glCanvas.style.height = innerAspect < fixedAspect ? '' : '100%';
    }

    if (enhancedMode)
    {
        if (paused)
        {
            // the fixed-step loop below skips its input calls while paused (no time
            // accrues), so the pause keys poll here
            inputUpdate();
            if (engineSound) engineSound.stop(), engineSound = 0; // the fixed step is skipped: stop the engine loop here (updateCars restarts it)
            if (focusPaused && document.hasFocus()) // a focus-loss pause ends when focus returns
                paused = focusPaused = 0;
            if (keyWasPressed('Space') || isUsingGamepad && (gamepadWasPressed(0)||gamepadWasPressed(9)))
            {
                paused = focusPaused = 0;
                sound_checkpoint.play(.5);
            }
            if (keyWasPressed('Escape') || isUsingGamepad && gamepadWasPressed(8))
            {
                // go back to title screen
                paused = 0;
                sound_charge.play();
                titleScreenMode = 1;
                gameStart();
            }
            inputUpdatePost();
        }
    }

    // update time keeping
    let frameTimeDeltaMS = frameTimeMS - frameTimeLastMS;
    frameTimeLastMS = frameTimeMS;
    if (debug && devMode) // everything inside the gate, so the release ships none of it
    {
        // held + runs time ten times faster, held - a tenth, in dev mode (any visitor to the public page could, until 2026-09-13)
        const debugSpeedUp   = keyIsDown('Equal') || keyIsDown('NumpadAdd');      // +
        const debugSpeedDown = keyIsDown('Minus') || keyIsDown('NumpadSubtract'); // -
        frameTimeDeltaMS *= debugSpeedUp ? 10 : debugSpeedDown ? .1 : 1;
    }
    debug && (averageFPS = lerp(.05, averageFPS, 1e3/(frameTimeDeltaMS||1))); // dev readout only
    frameTimeBufferMS += paused ? 0 : frameTimeDeltaMS;
    frameTimeBufferMS = min(frameTimeBufferMS, 42); // slow framerate: three catch-up steps at most, then the game slows rather than spirals. 42, not 50 (until the post-deadline fix): after any stall, every gameStart included, 50 ran exactly three steps and left the buffer ON the one-or-two-steps boundary, so 60 Hz frame times rounded to .1 ms froze and doubled a third of the frames; 42 leaves it mid-frame (local/step-pacing-sim.js)

    // update multiple frames if necessary in case of slow framerate
    for (;frameTimeBufferMS >= 0; frameTimeBufferMS -= 1e3/frameRate)
    {
        time = frame++ / frameRate;
        gameUpdateInternal();
        // gated at the CALL: terser leaves an emptied function and its call behind
        // (function t(){} ... t()), a folded && leaves nothing
        enhancedMode && enhancedModeUpdate();
        musicMuted ^= keyWasPressed('KeyM'); // the music on or off, every build (it sat in enhancedModeUpdate, so the 13k build had no M until 2026-09-13); the sound effects stay
        debug && debugUpdate();
        inputUpdate();
        musicUpdate(); // the title and results loop (music.js): starts, stops and retries by state and focus

        if (enhancedMode && !titleScreenMode)
        if (keyWasPressed('KeyP') || isUsingGamepad && gamepadWasPressed(9))
        if (!gameOverTime)
        {
            paused = 1;
            sound_checkpoint.play(.5,.5);
        }

        enhancedMode && titleScreenMode && menuMode && updateCraftCameras(); // before the real camera, so it leaves the globals as it found them
        updateCamera();

        inputUpdatePost();
    }

    // draw: the WebGL scene, the 2D HUD over it, then the dev overlay
    glPreRender(mainCanvasSize);
    drawScene();
    drawHUD();
    debug && debugDraw();
}

///////////////////////////////
// enhanced build only: focus handling and the dev/enhanced keys (gated at the call)

function enhancedModeUpdate()
{
    if (document.hasFocus())
    {
        if (autoFullscreen && !isFullscreen())
            toggleFullscreen();
        autoFullscreen = 0;
    }

    if (!titleScreenMode && autoPause && !document.hasFocus())
        paused = focusPaused = 1; // pause when losing focus

    // F toggles fullscreen from anywhere, the title, the menu and a race alike (Frank, 2026-09-15; the menu's FULL SCREEN row is the
    // same toggle for a mouse or a thumb). In dev mode F is the free camera, so the dev page keeps that until dev() is off
    if (keyWasPressed('KeyF') && !(debug && devMode))
        toggleFullscreen();

    if (keyWasPressed('KeyR') && !titleScreenMode) // restart
    {
        titleScreenMode = 0;
        sound_lose.play(1,2);
        gameStart();
    }
}

///////////////////////////////
// the chase camera: behind and above the player, following the travel direction,
// kept above the nearby road. The dev free camera (debug.js) overrides it at the end.

// enhanced only: while the menu is up, keep a camera behind every selectable craft as if it were the player's, so changing team cuts to
// one already in the MOVING steady state. Re-seating with the craft frozen lands close but not seated, and the camera then slides into
// place over half a second, which is the glitch (drift after the cut: 37 units kept, 658 frozen; local/camera-switch-probe.js, 2026-09-16).
// updateCamera works on the globals, so they are swapped around each craft's run and put back
let craftCameras = [];
function updateCraftCameras()
{
    const v0=playerVehicle, pos0=cameraPos, rot0=cameraRot, roll0=cameraRoll, fov0=boostFov;
    for(const v of vehicles)
        if(v.racerIndex<6 && v!=v0)
        {
            const k=craftCameras[v.racerIndex] ||= {pos:pos0.scale(1), rot:rot0.scale(1)};
            playerVehicle=v, cameraPos=k.pos, cameraRot=k.rot;
            updateCamera();
            k.pos=cameraPos, k.rot=cameraRot;
        }
    playerVehicle=v0, cameraPos=pos0, cameraRot=rot0, cameraRoll=roll0, boostFov=fov0;
}

function updateCamera()
{
    const v=playerVehicle;
    const boost=v.boostTime>time;
    //cameraBoomZ=lerp(.08,cameraBoomZ,boost?1200:1200); // the boom eases out 300 units on a boost
    boostFov=lerp(.1,boostFov,boost); // the lens widens on a boost (glPreRender)

    // the camera follows the travel direction with a 30% lean toward the nose, so a
    // slide shows the craft swung across the screen rather than the world spinning
    const travel=v.speed>1000?Math.atan2(v.velocity.x,v.velocity.z):v.heading; // below 1000 units/s the velocity direction is noise: use the heading
    cameraRot.y+=clampAngle(travel+clampAngle(v.heading-travel)*.3-cameraRot.y)*.2; // yaw ease per step
    const f=vec3(Math.sin(cameraRot.y),0,Math.cos(cameraRot.y)); // the camera's own forward on the ground plane
    const target=v.pos.subtract(f.scale(cameraBoomZ)).addSelf(vec3(0,900)); // boom length back along it, 900 units up

    // keep the boom above the nearby road without a general scenery collider: project the
    // target onto the route (hinted a boom length behind the player), clamp it 500 units
    // inside the walls and never let it sink under the road plus 650
    const r=projectRoute(target,v.s-cameraBoomZ/routeScale), info=r.info;
    const x=r.x, surface=info.point(x,650);
    target.addSelf(info.right.scale(x-r.x));
    target.y=max(target.y,surface.y);

    cameraPos=cameraPos.lerp(target,.5);                        // position ease
    cameraRot.x=lerp(.12,cameraRot.x,.26+info.pitch*.5);         // look down .26 rad plus half the road's pitch (positive pitch = descending, track.js)
    cameraRoll=lerp(.08,cameraRoll,-Math.atan(info.roll)*19);  // roll with a third of the road's bank, in degrees (19 of 57.3; .3 before the post-deadline fix, tuned while the roll was wrong on half the corners; 17 and 18 built a byte or two bigger, 19 the same as 17.2). Until the post-deadline fix it was cameraRot.z, which buildMatrix turns about WORLD Z after the yaw: right facing +Z, the wrong way facing -Z, a nod facing +-X; glPreRender now rolls the view matrix in camera space (local/roll-axis-probe.js)

    if(freeCamMode)
    {
        cameraPos=freeCamPos.copy();
        cameraRot=freeCamRot.copy();
        cameraRoll=0; // the free camera does not lean with the player's bank
    }
    if(topDownMode) // the dev map view (debug.js): 500k straight up over the loop's centre plus the pan; glPreRender goes orthographic
    {
        cameraPos=trackMapCenter.add(topDownPan).addSelf(vec3(0,5e5,0));
        cameraRot=vec3(PI/2,0,0); cameraRoll=0; // pitch only: vec3(s) is (s,s,s)
    }
}

///////////////////////////////////////
// save data

// one key, comma joined: the circuit shown, the last finishing place, the craft colour,
// the best placing per circuit as one digit each (0 = never finished), then each circuit's best finishing time in seconds (0 or empty = none). The menu
// shows the placing with the time under it and browses up to the circuit after the last one
// finished (the placings alone were the record until 2026-09-13). Older SP13K saves are ignored
// (the migration was dropped in the size pass). Read once at load, here, after the
// declarations above; written on a craft pick and a finish (vehicle.js)
const saveName = 'SP13KTRA';
// the enhanced build survives denied storage (a SecurityError stopped the page before gameInit; 2026-09-13), no progress
// kept; the 13k build folds to the plain read and write
const saveData=((enhancedMode ? (()=>{try{return localStorage[saveName]}catch(e){}})() : localStorage[saveName]) || '').split(',');
currentCircuit = mod(saveData[0]*1 || 0, circuitCount); // never index past the circuit table
// (the saved finishing place is still WRITTEN, so the positional save keeps its shape for older saves, but nothing reads it: the grid is fixed)
playerCraft = mod(saveData[2]*1 || 0, 6);
let bestPlaces = (saveData[3] || '').padEnd(circuitCount, 0); // a string of circuitCount digits
let musicMuted = 0, bestTimes = saveData.slice(4).map(Number); // the M key's music-off flag (not saved since 2026-09-13); bestTimes[c] the best finish on circuit c in seconds, 0 for none
const circuitsUnlocked = () => min(circuitCount, bestPlaces.search(/0*$/)+1); // every circuit up to the one after the last finished

function writeSaveData()
{
    // toString joins them (a hole in bestTimes joins as nothing and reads back as 0). The array is written out in both
    // branches so the 13k build folds to exactly the plain write (a shared const survived the fold, +7)
    if (enhancedMode)
        try { localStorage[saveName] = [currentCircuit, lastRacePlace, playerCraft, bestPlaces, ...bestTimes]; } catch(e) {} // denied or full: the session plays on unsaved
    else
        localStorage[saveName] = [currentCircuit, lastRacePlace, playerCraft, bestPlaces, ...bestTimes];
}

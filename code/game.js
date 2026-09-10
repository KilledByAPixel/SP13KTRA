'use strict';

// settings (the build flags - clampAspectRatios, testDrive, quickStart... - are declared
// in the flags file that heads the concat order, so terser can fold them here AND in
// the files before this one; see releaseJS13K.js)
const pixelate = 0;
const canvasFixedSize = 0;
const frameRate = 60;
const timeDelta = 1/frameRate;
const pixelateScale = 3;
const random = new Random;
let autoPause = enhancedMode;
let autoFullscreen = 0;

// setup
const laneWidth = 700;             // thin race-course lanes
const trackSegmentLength = 100;    // length of each segment
const drawDistance = 1e3;          // how many track segments to draw
const cameraPlayerOffset = vec3(0,860,2000); // pulled back: smaller craft, more road, speed reads better (z eases to 2300 on boost: updateCamera)
const playerStartZ = 2e3;
// the starting grid: eight staggered slots, pole nearest the line (also painted on the surface)
const slotZ = s => 2400 - s*520;
const slotX = s => (s%2?1:-1)*800;
const testStartZ = quickStart&&!testLevelInfo?5e3:0;

// race setup
const lapTrackSegments = 4000;  // segments per closed loop
const lapDistance = lapTrackSegments*trackSegmentLength;
const raceLaps = 3;
const circuitCount = 10;
let currentCircuit = 0;
let levelInfo; // active circuit biome, pinned for the whole race
let playerLap, playerPlace, racePlace;
let playerEnergy, playerDeadTime;
let lastRacePlace = 8; // grid order carries over from the last finish
let playerCraft = 0;   // the player's colour, 0..5 of racerColors, picked on the title

let mainCanvasSize;// = pixelate ? vec3(640, 420) : vec3(1280, 720);
let mainCanvas, mainContext;
let time, frame, frameTimeLastMS, frameTimeBufferMS, paused, focusPaused; // averageFPS lives in debug.js (dev-only readout)
let startCountdown, startCountdownTimer, gameOverTimer;
let raceTime, playerWin;
let titleScreenMode = 1;
let trackSeed = 1331;

///////////////////////////////
// game variables

let cameraPos, cameraRot;
let track, vehicles, playerVehicle;

///////////////////////////////

function gameInit()
{
    if (enhancedMode)
    {
        console.log(`SP13KTRA by Frank Force`);
        console.log(`www.frankforce.com 🚗🌴`);
    }

    if (quickStart || testLevel)
        titleScreenMode = 0;

    debug && debugInit();
    glInit();
        
    document.body.appendChild(mainCanvas = document.createElement('canvas'));
    mainContext = mainCanvas.getContext('2d');
    // the canvases' position:absolute (and the enhanced build's centring transform)
    // and the body's margin 0 are the page's own CSS: build.js's shell and index.html

    drawInit();
    inputInit()
    initLevelInfos();
    gameStart();
    gameUpdate();
}

function gameStart()
{
    time=frame=frameTimeLastMS=frameTimeBufferMS=raceTime=playerLap=playerWin=playerDeadTime=0;
    playerEnergy=100; contactTimes=[];
    startCountdown=quickStart || titleScreenMode ? 0 : 4;
    levelInfo=testLevelInfo || levelInfoList[currentCircuit];
    startCountdownTimer=new Timer; gameOverTimer=new Timer;
    cameraPos=vec3(); cameraRot=vec3(); vehicles=[];
    buildTrack();
    playerPlace=8; racePlace=0;
    const slot=clamp(lastRacePlace-1,0,7);
    vehicles.push(playerVehicle=new PlayerVehicle(slotZ(slot),hsl(...racerColors[playerCraft]),playerCraft));
    playerVehicle.place(slotZ(slot),slotX(slot));
    if(!disableAiVehicles) for(let i=0,s=0;i<7;++i,++s)
    {
        if(s==slot) ++s;
        const v=new Racer(slotZ(s),i); v.place(slotZ(s),slotX(s)); vehicles.push(v);
    }
    if(titleScreenMode)
        for(let i=0;i<vehicles.length;++i) vehicles[i].place(80000-i*750,(i%2?1:-1)*800);
    if(debug) debugSkipped=0;
    cameraRot.y=playerVehicle.heading;
    for(let i=99;i--;) updateCamera();
}

function gameUpdateInternal()
{
    if (titleScreenMode)
    {
        // update title screen
        if (keyWasPressed('Space') || mousePressed || enhancedMode && isUsingGamepad && (gamepadWasPressed(0)||gamepadWasPressed(9)))
        {
            titleScreenMode = 0;
            gameStart();
        }
        if (keyWasPressed('ArrowRight') || keyWasPressed('ArrowLeft'))
        {
            // browse circuits from the title screen
            currentCircuit = mod(currentCircuit + (keyWasPressed('ArrowRight')?1:-1), circuitCount);
            sound_checkpoint.play(.5);
            gameStart();
        }
        if (keyWasPressed('ArrowUp') || keyWasPressed('ArrowDown'))
        {
            // pick a craft colour: one of the six band colours, never black or white
            playerCraft = mod(playerCraft + (keyWasPressed('ArrowUp')?1:-1), 6);
            sound_checkpoint.play(.5);
            gameStart(); writeSaveData();
        }
        if (time > 60)
            gameStart(); // restart attract mode
    }
    else
    {
        if (startCountdown > 0 && !startCountdownTimer.active())
        {
            --startCountdown;
            sound_beep.play(1,startCountdown?1:2);
            //speak(startCountdown || 'GO!' );
            startCountdownTimer.set(1);
        }

        if (gameOverTimer.get() > 1 && (keyWasPressed('Space') || mousePressed || enhancedMode && isUsingGamepad && (gamepadWasPressed(0)||gamepadWasPressed(9))) || gameOverTimer.get() > 12)
        {
            // podium finish advances the grand prix
            if (playerWin && racePlace && racePlace <= 3)
            {
                currentCircuit = (currentCircuit+1)%circuitCount;
                writeSaveData();
            }

            // go back to title screen after a while
            titleScreenMode = 1;
            gameStart();
        }
        if (keyWasPressed('Escape') || enhancedMode && isUsingGamepad && gamepadWasPressed(8))
        {
            // go back to title screen
            sound_bump.play(2);
            titleScreenMode = 1;
            gameStart();
        }
        /*if (keyWasPressed('KeyR'))
        {
            titleScreenMode = 0;
            sound_lose.play(1,2);
            gameStart();
        }*/
        
        if (!startCountdown && !gameOverTimer.isSet())
        {
            // race mode
            raceTime += timeDelta;
            if (debug && keyWasPressed('KeyN'))
            {
                // course-viewing skip: dev only (debug=0 const in the release build, so
                // terser drops this) and it poisons the run, same as debug.js's Digit1/2
                playerVehicle.place(playerVehicle.s+lapDistance/4);
                debugSkipped = 1; // a skipped race never writes a record
            }
        }
    }
    updateCars();
}

function gameUpdate(frameTimeMS=0)
{
    if (!clampAspectRatios)
        mainCanvasSize = vec3(mainCanvas.width=innerWidth, mainCanvas.height=innerHeight);
    else
    {
        // more complex aspect ratio handling
        const innerAspect = innerWidth / innerHeight;
        if (canvasFixedSize)
        {
            // clear canvas and set fixed size
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
            // hack: special input handling when paused
            inputUpdate();
            if (focusPaused && document.hasFocus()) // a focus-loss pause ends when focus returns (Frank, 2026-09-09)
                paused = focusPaused = 0;
            if (keyWasPressed('Space') || keyWasPressed('KeyP') || isUsingGamepad && (gamepadWasPressed(0)||gamepadWasPressed(9)))
            {
                paused = focusPaused = 0;
                sound_checkpoint.play(.5);
            }
            if (keyWasPressed('Escape') || isUsingGamepad && gamepadWasPressed(8))
            {
                // go back to title screen
                paused = 0;
                sound_bump.play(2);
                titleScreenMode = 1;
                gameStart();
            }
            inputUpdatePost();
        }
    }

    // update time keeping
    let frameTimeDeltaMS = frameTimeMS - frameTimeLastMS;
    frameTimeLastMS = frameTimeMS;
    if (debug) // +/- to speed/slow time (everything inside the gate, so the release ships none of it)
    {
        const debugSpeedUp   = devMode && (keyIsDown('Equal')|| keyIsDown('NumpadAdd')); // +
        const debugSpeedDown = devMode && (keyIsDown('Minus') || keyIsDown('NumpadSubtract')); // -
        frameTimeDeltaMS *= debugSpeedUp ? 20 : debugSpeedDown ? .1 : 1;
    }
    debug && (averageFPS = lerp(.05, averageFPS, 1e3/(frameTimeDeltaMS||1))); // dev readout only
    frameTimeBufferMS += paused ? 0 : frameTimeDeltaMS;
    frameTimeBufferMS = min(frameTimeBufferMS, 50); // clamp in case of slow framerate

    // update multiple frames if necessary in case of slow framerate
    for (;frameTimeBufferMS >= 0; frameTimeBufferMS -= 1e3/frameRate)
    {
        // increment frame and update time
        time = frame++ / frameRate;
        gameUpdateInternal();
        // gated at the CALL: terser leaves an emptied function and its call behind
        // (function t(){} ... t()), a folded && leaves nothing
        enhancedMode && enhancedModeUpdate();
        debug && debugUpdate();
        inputUpdate();
    
        if (enhancedMode && !titleScreenMode)
        if (keyWasPressed('KeyP') || isUsingGamepad && gamepadWasPressed(9))
        if (!gameOverTimer.isSet())
        {
            // update pause
            paused = 1;
            sound_checkpoint.play(.5,.5);
        }
        
        updateCamera();

        inputUpdatePost();
    }

    //mainContext.imageSmoothingEnabled = !pixelate;
    //glContext.imageSmoothingEnabled = !pixelate;

    glPreRender(mainCanvasSize);
    drawScene();
    drawHUD();
    debug && debugDraw();
    requestAnimationFrame(gameUpdate);
}

function enhancedModeUpdate() // enhanced build only: gated at the call
{
    if (document.hasFocus())
    {
        if (autoFullscreen && !isFullscreen())
            toggleFullscreen();
        autoFullscreen = 0;
    }

    if (!titleScreenMode && autoPause && !document.hasFocus())
        paused = focusPaused = 1; // pause when losing focus

    if (keyWasPressed('Home')) // dev mode
        devMode || (debugInfo = devMode = 1);
    if (keyWasPressed('KeyI')) // debug info
        debugInfo = !debugInfo;
    if (keyWasPressed('KeyM')) // toggle mute
    {
        if (soundVolume)
            sound_bump.play(.4,3);
        soundVolume = soundVolume ? 0 : .3;
        if (soundVolume)
            sound_bump.play();
    }
    if (keyWasPressed('KeyR') && !titleScreenMode) // restart (title R = the dev build's course reroll, debug.js)
    {
        titleScreenMode = 0;
        sound_lose.play(1,2);
        gameStart();
    }
}

function updateCamera()
{
    const v=playerVehicle;
    const boost=v.boostTime>time;
    cameraPlayerOffset.z=lerp(.08,cameraPlayerOffset.z,boost?2300:2000);
    boostFov=lerp(.1,boostFov,boost); // the lens widens on a boost (glPreRender)
    // The chase camera follows the travel direction with a 30% lean toward the nose, so a
    // slide shows the craft swung across the screen rather than the world spinning.
    const travel=v.speed>1000?Math.atan2(v.velocity.x,v.velocity.z):v.heading;
    cameraRot.y+=clampAngle(travel+clampAngle(v.heading-travel)*.3-cameraRot.y)*.12;
    const f=vec3(Math.sin(cameraRot.y),0,Math.cos(cameraRot.y));
    const target=v.pos.subtract(f.scale(cameraPlayerOffset.z)).addSelf(vec3(0,900,0));
    // Keep the boom above the nearby road without a general scenery collider.
    const r=projectRoute(target,v.s-cameraPlayerOffset.z/routeScale), info=r.info;
    const x=clamp(r.x,-info.width+500,info.width-500), surface=info.point(x,650);
    target.addSelf(info.right.scale(x-r.x)); target.y=max(target.y,surface.y);
    cameraPos=cameraPos.lerp(target,.22);
    cameraRot.x=lerp(.12,cameraRot.x,.26+info.pitch*.5);
    cameraRot.z=lerp(.08,cameraRot.z,-Math.atan(info.roll)*.3);
    if(freeCamMode) cameraPos=freeCamPos.copy(),cameraRot=freeCamRot.copy();
}

///////////////////////////////////////
// save data

// one key, comma joined: best time, circuit reached, last finishing place. the 3D rebuild
// changed the game enough that older saves are ignored
const saveName = 'SP13K3D';
const saveData=(localStorage[saveName] || '0,0,8,0').split(',');
let bestTime = saveData[0]*1 || 0;
currentCircuit = mod(saveData[1]*1 || 0, circuitCount); // never index past the circuit table
lastRacePlace = saveData[2]*1 || 8;
playerCraft = mod(saveData[3]*1 || 0, 6);

function writeSaveData()
{
    localStorage[saveName] = [bestTime, currentCircuit, lastRacePlace, playerCraft]; // toString joins them
}

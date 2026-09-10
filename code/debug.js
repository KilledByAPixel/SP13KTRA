'use strict';

const debug = 1;
let enhancedMode = 1;
let enableAsserts = 1;
let devMode = 0;
let downloadLink, debugMesh, debugCapture, debugCanvas;
let debugInfo=0, debugSkipped=0;
let freeCamPos, freeCamRot, mouseDelta;
const js13kBuildLevel2 = 0; // more space is needed for js13k
// dev flags (the release files declare these as const 0 so terser folds every branch)
let clampAspectRatios = 1;
let testLevel, quickStart, disableAiVehicles, testDrive, freeCamMode, testLevelInfo;
let testTurn = 0; // analog steer for the drift suite (keyboard turn is binary): vehicle.js reads it under `debug &&`
let averageFPS = 0, glBatchCountTotal, glDrawCalls; // the I-key readout's counters, written under `debug &&` in game.js / webgl.js
let glUploadBytes=0, glLiveBuffers=0, glStaticBytes=0, glStaticUploads=0, worldBuildCount=0, roadPanels=[];
let skylineSites; // [x, z, margin, landmark, height] per placed scenery piece (height -1 = pylon), recorded under `debug &&` in buildScenery

function ASSERT(assert, output)
{ enableAsserts&&(output ? console.assert(assert, output) : console.assert(assert)); }
function LOG() { console.log(...arguments); }

// the free cam's rotations (the shipped game turns only constant vectors, written out inline)
function debugVectorMethods()
{
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

function debugInit()
{
    debugVectorMethods();
    freeCamPos = vec3();
    freeCamRot = vec3();
    mouseDelta = vec3();
    onmousemove = (e)=> // free cam mouse look (the shipped game has no mouse input at all)
    {
        if (freeCamMode)
        {
            mouseDelta.x += e.movementX/mainCanvasSize.x;
            mouseDelta.y += e.movementY/mainCanvasSize.y;
        }
    }
    debugCanvas = document.createElement('canvas');
    downloadLink = document.createElement('a');
    console.log(
`SP13KTRA dev keys (debug build only; * needs dev mode)
  Home   dev mode        I  debug info        M  mute
  [ ]    previous / next circuit: restarts the race there (title or mid-race)
  R      title: reroll the course seed (session only) / in race: restart
  N      skip a quarter lap (poisons the run: no record)
  F      free cam from play (WASD/QE, Shift = fast, mouse look; implies dev mode) - also G in dev mode
  * 1 2  back / forward a quarter lap     * 3 4  hold: z -1000 / +1000 per frame
  * 5    map      * 6  reroll the course in place      * 0  save a screenshot
  * Q    autodrive (testDrive)     * V  spawn a racer     * U  win sound
  * + -  time x20 / x.1`);
}
function debugUpdate()
{
    // dev conveniences that need no dev mode: [ ] jump to the previous / next
    // circuit and restart the race there (title or mid-race); R on the title
    // rerolls the course seed (was a player key - everything shipped is preset)
    if (keyWasPressed('BracketLeft') || keyWasPressed('BracketRight'))
    {
        currentCircuit = mod(currentCircuit + (keyWasPressed('BracketRight')?1:-1), circuitCount);
        titleScreenMode = 0;
        gameStart();
    }
    if (titleScreenMode && keyWasPressed('KeyR'))
    {
        trackSeed = randInt(1e9);
        sound_pickup.play();
        gameStart();
    }
    if (keyWasPressed('KeyF')) // free cam straight from play: F implies dev mode for WASD/mouse
        devMode = 1, toggleFreeCam();
    if (!devMode)
        return;

    if (keyWasPressed('KeyG'))
        toggleFreeCam();
    if (freeCamMode)
    {
        if (!document.pointerLockElement)
        {
            mainCanvas.requestPointerLock();
            freeCamPos = cameraPos.copy();
            freeCamRot = cameraRot.copy();
        }

        const input = vec3(
            keyIsDown('KeyD') - keyIsDown('KeyA'),
            keyIsDown('KeyE') - keyIsDown('KeyQ'),
            keyIsDown('KeyW') - keyIsDown('KeyS'));

        const moveSpeed = keyIsDown('ShiftLeft') ? 500 : 100;
        const turnSpeed = 2;
        const moveDirection = input.rotateX(freeCamRot.x).rotateY(-freeCamRot.y);
        freeCamPos = freeCamPos.add(moveDirection.scale(moveSpeed));
        freeCamRot = freeCamRot.add(vec3(mouseDelta.y,mouseDelta.x).scale(turnSpeed));
        freeCamRot.x = clamp(freeCamRot.x, -PI/2, PI/2);
        mouseDelta = vec3();
    }

    if (keyWasPressed('Digit1') || keyWasPressed('Digit2'))
    {
        // skip a quarter lap
        const d = keyWasPressed('Digit2') ? 1 : -1;
        playerVehicle.place(playerVehicle.s+d*lapDistance/4);
        debugSkipped = 1;
    }
    if (keyIsDown('Digit3') || keyIsDown('Digit4'))
    {
        const v = keyIsDown('Digit4') ? 1e3 : -1e3;
        playerVehicle.place(playerVehicle.s+v);
        debugSkipped = 1;
    }
    if (keyWasPressed('Digit5'))
        showMap = !showMap;
    if (keyWasPressed('Digit6'))
    {
        // randomize track
        trackSeed = randInt(1e9);
        gameStart();
    }
    if (keyWasPressed('Digit0'))
        debugCapture = 1;
    if (keyWasPressed('KeyQ') && !freeCamMode)
        testDrive = !testDrive
    if (keyWasPressed('KeyU'))
        sound_win.play();
    if (debug && keyWasPressed('KeyV'))
        vehicles.push(new Racer(playerVehicle.s-1300, randInt(7)))
    //if (!document.hasFocus())
    //    testDrive = 1;
}

function toggleFreeCam()
{
    freeCamMode = !freeCamMode;
    if (!freeCamMode)
    {
        document.exitPointerLock();
        cameraPos = vec3();
        cameraRot = vec3();
    }
}

function debugDraw()
{
    if (!debug)
        return;

    if (debugInfo && !debugCapture)
        drawHUDText((averageFPS|0) + 'fps / ' + glBatchCountTotal + ' / ' + glDrawCalls + ' / ' + vehicles.length, vec3(.98,.16),.03, WHITE, 'right');

    const c = mainCanvas;
    const context = mainContext;

    if (testDrive && !titleScreenMode)
        drawHUDText('AUTO', vec3(.02,.2),.04,rgb(1,0,0),'left');

    if (debugCapture)
    {
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

    // test render (the atlas tile viewer went with the atlas)
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

    glRender();
}

///////////////////////////////////////////////////////////////////////////////

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

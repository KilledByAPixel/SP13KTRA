'use strict';

///////////////////////////////////////////////////////////////////////////////
// input.js - keyboard, mouse and (dev/enhanced only) gamepad
//
// Owns the raw input state: a per-key bit field (inputData), the mouse steer
// axis and button bits, and the gamepad arrays. Nothing here knows about the
// game; it only records what the player is pressing.
//
// Entry points: inputInit() installs the window handlers (game.js gameInit, before
// debugInit, which chains the free cam's mouse look onto onmousemove),
// inputUpdate() runs at the top of every frame and inputUpdatePost() at the
// bottom (game.js gameUpdate, both the paused and running paths).
//
// Readers: keyIsDown/keyWasPressed in game.js (title, menu, pause, dev keys) and
// vehicle.js (player controls, mouseX/mouseButtons, gamepadStick); hud.js reads
// mouseX/mouseY for the menu rows; debug.js reads keys for the dev tools; the
// smoke tests poke inputData/mouseX directly.
//
// Keyboard and mouse everywhere; gamepad in the dev and enhanced builds only (gamepadsEnable
// is enhancedMode, a const 0 in the 13k build, so terser folds every gamepad path away).
// Mouse: a click enters mouse mode, in which the pointer steers by how far it sits from
// the centre of the window whether or not a button is held; the left button drives,
// right boosts, a click starts. Any key returns to keyboard mode.
// Touch is deferred until it is designed.
const gamepadsEnable = enhancedMode;
const inputWASDEmulateDirection = enhancedMode; // WASD doubles as the arrows (folded out of the 13k build)

///////////////////////////////////////////////////////////////////////////////
// Input user functions
//
// inputData[code] bits: 1 = held, 2 = pressed this frame, 4 = released this frame.
// keyIsDown returns the raw bit (0/1); the pressed/released tests return 1/0.

const keyIsDown      = (key) => inputData[key] & 1;
const keyWasPressed  = (key) => inputData[key] & 2 ? 1 : 0;

let isUsingGamepad; // enhanced build only; every read is `enhancedMode && isUsingGamepad` so the release folds it
const gamepadIsDown      = (key, gamepad=0) => !!(gamepadData[gamepad][key] & 1);
const gamepadWasPressed  = (key, gamepad=0) => !!(gamepadData[gamepad][key] & 2);
const gamepadStick       = (stick, gamepad=0) => // dead-zoned vec3, y up; zero when nothing is plugged in
    gamepadStickData[gamepad] ? gamepadStickData[gamepad][stick] || vec3() : vec3();

///////////////////////////////////////////////////////////////////////////////
// Input event handlers

let inputData = []; // what keys are down, by e.code
// mouseX -1..1 across the window, mouseY 0..1 down it (the menu's rows); mouseButtons a bit
// per held button (1 left, 2 middle, 4 right); mousePressed: left pressed this frame;
// mouseMode: a click sets it, any key clears it
let mouseX = 0, mouseY = 0, mouseButtons = 0, mousePressed = 0, mouseMode = 0;

function inputInit()
{
    if (gamepadsEnable)
    {
        gamepadData = [];
        gamepadStickData = [];
        gamepadDataValues = [];
        gamepadData[0] = []; // pad 0 always readable, even before the first poll
        gamepadDataValues[0] = [];
    }

    onkeydown = (e)=>
    {
        enhancedMode && (isUsingGamepad = 0); // any key press hands control back to the keyboard
        // (mouse mode ends on the gas key, where the race reads it: vehicle.js. Any key ended it here for a day, Space too, so a mouse player braking on Space lost the mouse steer, Frank 2026-09-14)
        // consume printable keys: Firefox otherwise opens find-as-you-type on WASD, and the
        // page would scroll on space. Ctrl combinations and F-keys stay with the browser
        e.key.length < 2 && !e.ctrlKey && e.preventDefault();
        if (!e.repeat) // auto-repeat must not re-fire "pressed"
        {
            inputData[e.code] = 3; // held + pressed
            if (inputWASDEmulateDirection)
                inputData[remapKey(e.code)] = 3;
        }
    }

    onkeyup = (e)=>
    {
        inputData[e.code] = inputData[e.code]&2|4; // released (the held bit drops with it), keeping a press from this same step: a tap
        // whose down and up both landed before the next step read as never pressed (a quick Space or Escape on a slow frame; 2026-09-13)
        if (inputWASDEmulateDirection)
            inputData[remapKey(e.code)] = inputData[remapKey(e.code)]&2|4;
    }

    onmousemove = (e)=> (mouseX = e.clientX/innerWidth*2-1, mouseY = e.clientY/innerHeight); // vehicle.js scales x by 3 and clamps: full lock a third of the way out
    onmousedown = (e)=> { e.button && e.preventDefault(); mouseButtons |= 1<<e.button; mouseMode = 1; e.button || (mousePressed = 1); }; // preventDefault: a middle click no longer starts the browser's autoscroll (the middle button brakes) // any click: the pointer steers from now on, button or not
    onmouseup = (e)=> mouseButtons &= ~(1<<e.button);
    oncontextmenu = (e)=> e.preventDefault(); // the right button is the boost
    // losing focus stops the engine loop at once: a hidden tab gets no animation frames, so the
    // per-frame focus check in updateVehicles never ran and the loop played on
    onblur = ()=> { engineSound && (engineSound.stop(), engineSound = 0); musicStop(); inputData = [], mouseButtons = 0; }; // held input drops too: the loop stops here, so inputUpdate's focus check never ran and a key held while switching away stayed held (the enhanced build only until the post-deadline fix, +7 in the 13k build). A 13k focus pause here (paused = 1, and onfocus clearing it) worked and went for size, +19

    // WASD to the arrows
    const remapKey = (c) => inputWASDEmulateDirection ?
        c == 'KeyW' ? 'ArrowUp' :
        c == 'KeyS' ? 'ArrowDown' :
        c == 'KeyA' ? 'ArrowLeft' :
        c == 'KeyD' ? 'ArrowRight' : c : c;
}

function inputUpdate()
{
    // clear input when focus is lost (no stuck keys)
    document.hasFocus() || (inputData = [], mouseButtons = 0);
    gamepadsEnable && gamepadsUpdate();
}

function inputUpdatePost()
{
    // keep only the held bit for the next frame
    for (const i in inputData)
        inputData[i] &= 1;
    mousePressed = 0;
}

///////////////////////////////////////////////////////////////////////////////
// gamepad input (dev and enhanced builds)

// one entry per pad index
let gamepadData, gamepadStickData, gamepadDataValues;

// polled every frame by inputUpdate
function gamepadsUpdate()
{
    const clampLength = (v)=> v.mag() > 1 ? v.normalize() : v; // unit circle clamp
    const applyDeadZones = (v)=>
    {
        const min=.2, max=.8; // below .2 is rest, above .8 is full deflection
        const deadZone = (v)=>
            v >  min ?  percent( v, min, max) :
            v < -min ? -percent(-v, min, max) : 0;
        return clampLength(vec3(deadZone(v.x), deadZone(-v.y))); // browser sticks are y-down; flip to y-up
    }

    if (!navigator || !navigator.getGamepads)
        return;

    // only poll when focused, except in dev mode (playing unfocused is handy there)
    if (!devMode && !document.hasFocus())
        return;

    const gamepads = navigator.getGamepads();
    for (let i = gamepads.length; i--;)
    {
        const gamepad = gamepads[i];
        const data = gamepadData[i] || (gamepadData[i] = []);
        const dataValue = gamepadDataValues[i] || (gamepadDataValues[i] = []);
        const sticks = gamepadStickData[i] || (gamepadStickData[i] = []);

        if (gamepad)
        {
            // read analog sticks: axes come in x/y pairs
            for (let j = 0; j < gamepad.axes.length-1; j+=2)
                sticks[j>>1] = applyDeadZones(vec3(gamepad.axes[j],gamepad.axes[j+1]));

            // read buttons into the same held/pressed/released bits as the keyboard
            for (let j = gamepad.buttons.length; j--;)
            {
                const button = gamepad.buttons[j];
                const wasDown = gamepadIsDown(j,i);
                data[j] = button.pressed ? wasDown ? 1 : 3 : wasDown ? 4 : 0;
                dataValue[j] = percent(button.value||0,.1,.9); // dead zone on the analog value
                isUsingGamepad ||= !i && button.pressed; // only pad 0 claims control
            }

            // copy dpad to left analog stick when pressed (buttons 12-15: up down left right)
            const dpad = vec3(
                (gamepadIsDown(15,i)&&1) - (gamepadIsDown(14,i)&&1),
                (gamepadIsDown(12,i)&&1) - (gamepadIsDown(13,i)&&1));
            if (dpad.mag())
                sticks[0] = clampLength(dpad);
        }
    }
}

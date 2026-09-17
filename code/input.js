'use strict';

///////////////////////////////////////////////////////////////////////////////
// input.js - keyboard, mouse and (dev/enhanced only) gamepad
//
// Owns the raw input state: a per-key bit field (inputData), the mouse steer axis and
// button bits, and the gamepad arrays. Nothing here knows about the game; it only records
// what the player is pressing.
//
// Entry points: inputInit() installs the window handlers (game.js gameInit, before
// debugInit, which chains the free cam's mouse look onto onmousemove); inputUpdate() runs
// at the top of every frame and inputUpdatePost() at the bottom (game.js gameUpdate, both
// the paused and running paths).
//
// Readers: keyIsDown/keyWasPressed in game.js (title, menu, pause, dev keys) and vehicle.js
// (player controls, mouseX/mouseButtons, gamepadStick); hud.js reads mouseX/mouseY for the
// menu rows; debug.js reads keys for the dev tools; the smoke tests poke inputData/mouseX
// directly.
//
// Mouse: a click enters mouse mode, in which the pointer steers by how far it sits from the
// centre of the window whether or not a button is held; left drives, right is the turbo,
// middle brakes. vehicle.js ends mouse mode, where the race reads the controls: on the gas
// key, and in the enhanced build on any arrow or WASD. Space and Shift keep it, so a mouse
// player brakes and boosts from the keyboard.
// Gamepad: dev and enhanced builds only (gamepadsEnable is enhancedMode, a const 0 in the
// 13k build, so terser folds every gamepad path away).
// Touch (dev and enhanced builds): the on-screen pad in touch.js fills pad 0 in a race;
// elsewhere a tap is a click.
///////////////////////////////////////////////////////////////////////////////

const gamepadsEnable = enhancedMode;
const inputWASDEmulateDirection = enhancedMode; // WASD doubles as the arrows (folded out of the 13k build)

///////////////////////////////////////////////////////////////////////////////
// Input user functions
//
// inputData[code] bits: 1 = held, 2 = pressed this frame, 4 = released this frame.
// keyIsDown returns the raw bit (0/1); keyWasPressed returns 1/0.

const keyIsDown      = (key) => inputData[key] & 1;
const keyWasPressed  = (key) => inputData[key] & 2 ? 1 : 0;

// enhanced build only; every read is `enhancedMode && isUsingGamepad` so the release folds it
let isUsingGamepad;
const gamepadIsDown      = (key, gamepad=0) => !!(gamepadData[gamepad][key] & 1);
const gamepadWasPressed  = (key, gamepad=0) => !!(gamepadData[gamepad][key] & 2);
const gamepadStick       = (stick, gamepad=0) => // dead-zoned vec3, y up; zero when nothing is plugged in
    gamepadStickData[gamepad] ? gamepadStickData[gamepad][stick] || vec3() : vec3();

///////////////////////////////////////////////////////////////////////////////
// Input event handlers

let inputData = []; // what keys are down, by e.code

// mouseX: -1..1 across the window; mouseY: 0..1 down it (the menu's rows)
// mouseButtons: a bit per held button (1 left, 2 middle, 4 right)
// mousePressed: left pressed this frame
// mouseMode: a click sets it, vehicle.js clears it (the gas key; enhanced: any arrow or WASD)
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

        // mouse mode does not end here: Space and Shift must keep it (vehicle.js decides).
        // consume printable keys: Firefox otherwise opens find-as-you-type on WASD, and the
        // page would scroll on space. Ctrl combinations and F-keys stay with the browser.
        // The arrows too in the enhanced build, which runs framed in somebody's page and
        // would scroll it; that folds out of the 13k build, whose own page has nothing to scroll
        (e.key.length < 2 || enhancedMode && e.key.startsWith('Arrow')) && !e.ctrlKey && e.preventDefault();
        if (!e.repeat) // auto-repeat must not re-fire "pressed"
        {
            inputData[e.code] = 3; // held + pressed
            if (inputWASDEmulateDirection)
                inputData[remapKey(e.code)] = 3;
        }
    }

    onkeyup = (e)=>
    {
        // released (the held bit drops with it), keeping a press from this same step: a tap
        // whose down and up both land before the next step would read as never pressed
        inputData[e.code] = inputData[e.code]&2|4;
        if (inputWASDEmulateDirection)
            inputData[remapKey(e.code)] = inputData[remapKey(e.code)]&2|4;
    }

    // vehicle.js scales x by 3 and clamps: full lock a third of the way out
    onmousemove = (e)=> (mouseX = e.clientX/innerWidth*2-1, mouseY = e.clientY/innerHeight);

    // any click enters mouse mode: the pointer steers from now on, button or not.
    // a real click takes control back from the gamepad, as a key does; isTrusted: touch.js
    // forwards a touch off its pad through here, and that must leave the pad in control.
    // preventDefault for the middle and right buttons only: no autoscroll on the middle
    // click (it brakes), while a left click still focuses a framed game
    onmousedown = (e)=> { enhancedMode && e.isTrusted && (isUsingGamepad = 0); e.button && e.preventDefault(); mouseButtons |= 1<<e.button; mouseMode = 1; e.button || (mousePressed = 1); };
    onmouseup = (e)=> mouseButtons &= ~(1<<e.button);
    oncontextmenu = (e)=> e.preventDefault(); // the right button is the turbo

    // losing focus stops the engine loop and the music at once and drops held input: a
    // hidden tab gets no animation frames, so inputUpdate's focus check never runs, the
    // loop would play on and a key held while switching away would stay held
    onblur = ()=> { engineSound && (engineSound.stop(), engineSound = 0); musicStop(); inputData = [], mouseButtons = 0; };

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

// one entry per pad index: button bits (as inputData), sticks, analog button values 0..1
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

    if (touchUpdate()) // the on-screen touch pad owns pad 0 while it is in use (touch.js)
        return;

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

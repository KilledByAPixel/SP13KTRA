'use strict';

// Keyboard and mouse everywhere; gamepad in the dev and enhanced builds only (gamepadsEnable
// is enhancedMode, a const 0 in the 13k build, so terser folds every gamepad path away).
// Mouse (Frank, 2026-09-09): hold the left button to drive, steer by how far the pointer
// sits from the centre of the window, right button brakes, middle boosts, a click starts.
// Touch is deferred until it is designed.
const gamepadsEnable = enhancedMode;
const inputWASDEmulateDirection = enhancedMode;

///////////////////////////////////////////////////////////////////////////////
// Input user functions

const keyIsDown      = (key) => inputData[key] & 1;
const keyWasPressed  = (key) => inputData[key] & 2 ? 1 : 0;
const keyWasReleased = (key) => inputData[key] & 4 ? 1 : 0;

let isUsingGamepad; // enhanced build only; every read is `enhancedMode && isUsingGamepad` so the release folds it
const gamepadIsDown      = (key, gamepad=0) => !!(gamepadData[gamepad][key] & 1);
const gamepadWasPressed  = (key, gamepad=0) => !!(gamepadData[gamepad][key] & 2);
const gamepadWasReleased = (key, gamepad=0) => !!(gamepadData[gamepad][key] & 4);
const gamepadStick       = (stick, gamepad=0) =>
    gamepadStickData[gamepad] ? gamepadStickData[gamepad][stick] || vec3() : vec3();
const gamepadGetValue    = (key, gamepad=0) => gamepadDataValues[gamepad][key];

///////////////////////////////////////////////////////////////////////////////
// Input event handlers

let inputData = []; // track what keys are down
let mouseX = 0, mouseButtons = 0, mousePressed = 0; // x -1..1 across the window; a bit per held button; left pressed this frame

function inputInit()
{
    if (gamepadsEnable)
    {
        gamepadData = [];
        gamepadStickData = [];
        gamepadDataValues = [];
        gamepadData[0] = [];
        gamepadDataValues[0] = [];
    }

    onkeydown = (e)=>
    {
        enhancedMode && (isUsingGamepad = 0);
        // consume printable keys: Firefox otherwise opens find-as-you-type on WASD, and the
        // page would scroll on space. Ctrl combinations and F-keys stay with the browser
        e.key.length < 2 && !e.ctrlKey && e.preventDefault();
        if (!e.repeat)
        {
            inputData[e.code] = 3;
            if (inputWASDEmulateDirection)
                inputData[remapKey(e.code)] = 3;
        }
    }

    onkeyup = (e)=>
    {
        inputData[e.code] = 4;
        if (inputWASDEmulateDirection)
            inputData[remapKey(e.code)] = 4;
    }

    onmousemove = (e)=> mouseX = e.clientX/innerWidth*2-1;
    onmousedown = (e)=> { mouseButtons |= 1<<e.button; e.button || (mousePressed = 1); };
    onmouseup = (e)=> mouseButtons &= ~(1<<e.button);
    oncontextmenu = (e)=> e.preventDefault(); // the right button is the brake

    // handle remapping wasd keys to directions
    const remapKey = (c) => inputWASDEmulateDirection ?
        c == 'KeyW' ? 'ArrowUp' :
        c == 'KeyS' ? 'ArrowDown' :
        c == 'KeyA' ? 'ArrowLeft' :
        c == 'KeyD' ? 'ArrowRight' : c : c;
}

function inputUpdate()
{
    // clear input when lost focus (prevent stuck keys)
    document.hasFocus() || (inputData = [], mouseButtons = 0);
    gamepadsEnable && gamepadsUpdate();
}

function inputUpdatePost()
{
    // clear input to prepare for next frame
    for (const i in inputData)
        inputData[i] &= 1;
    mousePressed = 0;
}

///////////////////////////////////////////////////////////////////////////////
// gamepad input (dev and enhanced builds)

// gamepad internal variables
let gamepadData, gamepadStickData, gamepadDataValues;

// gamepads are updated by engine every frame automatically
function gamepadsUpdate()
{
    const clampLength = (v)=> v.length() > 1 ? v.normalize() : v; // unit circle clamp
    const applyDeadZones = (v)=>
    {
        const min=.2, max=.8;
        const deadZone = (v)=>
            v >  min ?  percent( v, min, max) :
            v < -min ? -percent(-v, min, max) : 0;
        return clampLength(vec3(deadZone(v.x), deadZone(-v.y)));
    }

    // return if gamepads are disabled or not supported
    if (!navigator || !navigator.getGamepads)
        return;

    // only poll gamepads when focused or in debug mode (allow playing when not focused in debug)
    if (!devMode && !document.hasFocus())
        return;

    // poll gamepads
    const gamepads = navigator.getGamepads();
    for (let i = gamepads.length; i--;)
    {
        // get or create gamepad data
        const gamepad = gamepads[i];
        const data = gamepadData[i] || (gamepadData[i] = []);
        const dataValue = gamepadDataValues[i] || (gamepadDataValues[i] = []);
        const sticks = gamepadStickData[i] || (gamepadStickData[i] = []);

        if (gamepad)
        {
            // read analog sticks
            for (let j = 0; j < gamepad.axes.length-1; j+=2)
                sticks[j>>1] = applyDeadZones(vec3(gamepad.axes[j],gamepad.axes[j+1]));

            // read buttons
            for (let j = gamepad.buttons.length; j--;)
            {
                const button = gamepad.buttons[j];
                const wasDown = gamepadIsDown(j,i);
                data[j] = button.pressed ? wasDown ? 1 : 3 : wasDown ? 4 : 0;
                dataValue[j] = percent(button.value||0,.1,.9); // apply deadzone
                isUsingGamepad ||= !i && button.pressed;
            }

            // copy dpad to left analog stick when pressed
            const dpad = vec3(
                (gamepadIsDown(15,i)&&1) - (gamepadIsDown(14,i)&&1),
                (gamepadIsDown(12,i)&&1) - (gamepadIsDown(13,i)&&1));
            if (dpad.length())
                sticks[0] = clampLength(dpad);
        }
    }
}

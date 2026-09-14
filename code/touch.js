'use strict';

///////////////////////////////////////////////////////////////////////////////
// touch.js - the on-screen touch gamepad (dev and enhanced builds only: build.js leaves this file
// out of the 13k build, and input.js calls it from gamepadsUpdate, which gamepadsEnable folds away there)
//
// Ported from LittleJS engineInput.js's touch gamepad (2026-09-14): a full-window HTML/SVG overlay
// over the canvas, driven by pointer events with pointer capture, so every finger is its own control
// and both thumbs work at once. It writes the arrays a real gamepad fills (input.js gamepadData and
// gamepadStickData, pad 0) and sets isUsingGamepad, so vehicle.js, the pause and the race read it
// unchanged: the steer line, button 0 gas, 1 brake, 5 turbo, 9 pause (and resume), 8 title.
//
// It shows only in a race (the countdown too) on a touch device, or with the touch() dev command;
// on the title, the menu and the results it is hidden, so a tap arrives as a normal click and the
// click UI works as it is. Paused, it shows RESUME and TITLE instead. While it can show, the race
// HUD moves out of the bottom corners (touchHud, hud.js).
//
// Layout (Frank, 2026-09-14): the buttons are fixed, GAS big in the bottom right corner, TURBO above
// it, BRAKE left of GAS on a wide window and tucked beside TURBO on a tall one (on a thin portrait
// window the wide layout's BRAKE sat over the steer), pause top centre. Steering is a FLOATING
// horizontal line, not a stick (only left and right count): a press anywhere on the left half that
// is not a button re-centres the line under the thumb, and the thumb's sideways offset steers, full
// lock at the line's end. Released, the line rests bottom left to show where it lives.

const touchDevice = window.ontouchstart !== undefined;
let touchForce = debug && localStorage.SP13KTOUCH|0; // the touch() dev command: the pad without a touch screen, driven by the mouse
let touchOverlay, touchSvg, touchLayoutKey, touchControls = [], touchUsed = 0;
// touchRoles: the control each finger holds, by pointerId, in a plain object: never a Map, whose get is on build.js's
// MANGLE_PROPS list, so the enhanced build called a renamed method and threw on every lift (2026-09-14, local/enhanced-touch-probe.js)
let touchButtons = [], touchStick = vec3(), touchRoles = {};
// touchFingers: every finger down on the pad, control or not, by pointerId; touchIdleTime: when one was last down (performance.now)
let touchFingers = {}, touchIdleTime = 0;

// the race HUD makes room for the pad wherever it can show (hud.js reads this behind enhancedMode)
const touchHud = () => touchDevice || touchForce;

// the controls for the current state in window pixels; S, a thumb's reach, scales with the window's short side
function touchLayout(W, H)
{
    const S = clamp(min(W, H)*.2, 50, 120), tall = W < H;
    return paused ? [
        {button:9, x:W/2-S*1.3, y:H*.72, r:S*.55, label:'RESUME'},
        {button:8, x:W/2+S*1.3, y:H*.72, r:S*.55, label:'TITLE'},
    ] : [
        {stick:1, x:S*1.4, y:H-S*1.4, r:S*.8}, // the steer line's rest; r is half its length
        {button:0, x:W-S*1.1, y:H-S*1.1, r:S*.7, label:'GAS'},
        {button:1, x:W-S*(tall ? 2.35 : 2.7), y:H-S*(tall ? 2.35 : .8), r:S*.5, label:'BRAKE'},
        {button:5, x:W-S*1.1, y:H-S*(tall ? 2.7 : 2.5), r:S*.5, label:'TURBO'}, // lower on a wide window: at 2.7 it overlapped the minimap under the lap
        {button:9, x:W/2, y:S*.45, r:S*.3, label:'II', fade:1}, // fade: hidden while playing (touchUpdate), touchable always
    ];
}

function touchInit()
{
    const o = touchOverlay = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;z-index:9;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none';
    touchSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    touchSvg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:.5;font-family:sans-serif;font-weight:bold';
    o.appendChild(touchSvg);
    o.onpointerdown = touchDown;
    o.onpointermove = touchMove;
    o.onpointerup = o.onpointercancel = touchUp;
    o.oncontextmenu = (e)=> e.preventDefault(); // a long press opens no menu
    document.body.appendChild(o);
}

// rebuild the controls and their shapes (on a resize and when the pause changes)
function touchDraw()
{
    touchControls = touchLayout(innerWidth, innerHeight);
    touchSvg.replaceChildren();
    const shape = (tag, attrs, parent = touchSvg)=>
    {
        const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const k in attrs) e.setAttribute(k, attrs[k]);
        return parent.appendChild(e);
    };
    for (const c of touchControls)
        if (c.stick)
        {
            c.line = shape('line', {stroke:'#fff', 'stroke-width':6, 'stroke-linecap':'round'});
            c.thumb = shape('circle', {r:c.r*.3, fill:'#fff'});
        }
        else
        {
            const g = c.fade ? c.group = shape('g', {style:'transition:opacity .4s'}) : touchSvg; // a fading button's shapes share one group
            c.el = shape('circle', {cx:c.x, cy:c.y, r:c.r, stroke:'#fff', 'stroke-width':3, fill:'none'}, g);
            shape('text', {x:c.x, y:c.y, fill:'#fff', 'text-anchor':'middle', 'dominant-baseline':'central', 'font-size':c.r*(c.label.length > 4 ? .3 : .42)}, g).textContent = c.label;
        }
}

// drop every held control (a relayout, or the pad hiding)
function touchRelease()
{
    touchRoles = {};
    touchFingers = {};
    touchButtons = [];
    touchStick = vec3();
}

// the control a press at p takes: the nearest button in reach, else the steer line anywhere on the left half
function touchHit(p)
{
    let hit, best = 1.4;
    for (const c of touchControls)
    {
        const d = vec3(c.x, c.y).subtract(p).mag()/c.r;
        if (!c.stick && d < best)
            hit = c, best = d;
    }
    return hit || p.x < innerWidth/2 && touchControls.find(c => c.stick);
}

// the thumb's sideways offset from where it landed, full lock at the line's end
const touchApplyStick = (c, p)=> touchStick = vec3(clamp((p.x - c.ax)/c.r, -1, 1), 0);

function touchDown(e)
{
    // preventDefault: no compatibility mouse events, so a touch never enters mouse mode or clicks
    e.preventDefault();
    touchOverlay.setPointerCapture(e.pointerId);
    touchFingers[e.pointerId] = 1;
    isUsingGamepad = touchUsed = 1;
    audioContext ||= new AudioContext; // iOS starts audio only inside the gesture itself
    audioContext.resume();
    const p = vec3(e.clientX, e.clientY), c = touchHit(p);
    if (!c)
        return;
    touchRoles[e.pointerId] = c;
    if (c.stick)
        c.ax = p.x, c.ay = p.y, touchApplyStick(c, p); // the line re-centres under the thumb
    else
        touchButtons[c.button] = 1;
}

function touchMove(e)
{
    const c = touchRoles[e.pointerId];
    c && c.stick && touchApplyStick(c, vec3(e.clientX, e.clientY));
}

function touchUp(e)
{
    delete touchFingers[e.pointerId];
    const c = touchRoles[e.pointerId];
    if (!c)
        return;
    delete touchRoles[e.pointerId];
    if (c.stick)
        touchStick = vec3(), c.ax = c.ay = 0; // back to its rest
    else
        delete touchButtons[c.button];
}

// polled by gamepadsUpdate (input.js) every step and while paused: shows or hides the pad, paints it and
// writes pad 0. Returns 1 when the pad owns pad 0 (the real gamepads are not polled then)
function touchUpdate()
{
    if (!touchHud() || titleScreenMode || gameOverTime)
    {
        if (touchOverlay && touchOverlay.style.display != 'none')
        {
            // hidden: taps are clicks again, and nothing the pad held stays held
            touchOverlay.style.display = 'none';
            touchRelease();
            touchLayoutKey = 0;
            gamepadData[0] = [];
            gamepadStickData[0] = [];
        }
        return 0;
    }

    touchOverlay || touchInit();
    touchOverlay.style.display = '';
    const key = [innerWidth, innerHeight, paused] + '';
    if (key != touchLayoutKey)
        touchLayoutKey = key, touchRelease(), touchDraw();
    // the pause button hides while any finger is down and fades back in two seconds after the last one lifts, touchable all the
    // while (Frank, 2026-09-14: not a button in the middle of the screen the whole race, but a reminder once you stop touching)
    const now = performance.now();
    if (Object.keys(touchFingers).length)
        touchIdleTime = now;
    const idle = now - touchIdleTime > 2e3;
    for (const c of touchControls)
        if (c.group)
            c.group.style.opacity = idle ? 1 : 0;
    for (const c of touchControls)
        if (c.stick)
        {
            const x = c.ax || c.x, y = c.ay || c.y;
            c.line.setAttribute('x1', x - c.r), c.line.setAttribute('x2', x + c.r);
            c.line.setAttribute('y1', y), c.line.setAttribute('y2', y);
            c.thumb.setAttribute('cx', x + touchStick.x*c.r), c.thumb.setAttribute('cy', y);
        }
        else
            c.el.setAttribute('fill', touchButtons[c.button] ? '#fff8' : '#0006');

    if (!touchUsed)
        return 0; // until the pad is touched, a real gamepad still drives

    // the same held/pressed/released bits as a real pad, and the steer with a dead zone
    const data = gamepadData[0], sticks = gamepadStickData[0] || (gamepadStickData[0] = []);
    for (let i = 16; i--;)
    {
        const wasDown = gamepadIsDown(i);
        data[i] = touchButtons[i] ? wasDown ? 1 : 3 : wasDown ? 4 : 0;
    }
    const m = abs(touchStick.x);
    sticks[0] = vec3(m < .15 ? 0 : sign(touchStick.x)*percent(m, .15, .9), 0);
    return 1;
}

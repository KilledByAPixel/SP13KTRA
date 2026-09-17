'use strict';

///////////////////////////////////////////////////////////////////////////////
// touch.js - the on-screen touch gamepad (dev and enhanced builds only)
//
// build.js leaves this file out of the 13k build, and input.js calls it from gamepadsUpdate,
// which gamepadsEnable folds away there.
//
// Ported from LittleJS engineInput.js's touch gamepad: a full-window HTML/SVG overlay over
// the canvas, driven by pointer events with pointer capture, so every finger is its own
// control and both thumbs work at once. It writes the arrays a real gamepad fills (input.js
// gamepadData and gamepadStickData, pad 0) and sets isUsingGamepad, so vehicle.js, the pause
// and the race read it unchanged: the steer line, button 0 gas, 2 brake, 5 turbo, 9 pause
// (and resume), 8 title.
//
// It shows only in a race (the countdown too) on a touch device, or with the touch() dev
// command; on the title, the menu and the results it is hidden, so a tap arrives as a normal
// click and the click UI works as it is. Paused, it shows RESUME and TITLE instead. While it
// can show, the race HUD moves out of the bottom corners (touchHud, hud.js).
//
// Layout: the buttons are fixed.
//   GAS big in the bottom right corner, TURBO above it, pause top centre
//   BRAKE left of GAS on a wide window, tucked beside TURBO on a tall one (on a thin
//     portrait window the wide layout's BRAKE sits over the steer)
//   steering is a horizontal line bottom left, not a stick (only left and right count): a
//     press anywhere on the left half that is not a button takes it, and the thumb's
//     sideways offset from the line's centre steers, full lock at the line's end. The line
//     stays put wherever the thumb lands. With touchSteerFloat it floats instead: a press
//     re-centres it under the thumb, and released it rests bottom left
//
// build.js's MANGLE_PROPS applies to the enhanced build: never call a built-in method whose
// name is on its list here (a Map's get ships renamed and throws).
///////////////////////////////////////////////////////////////////////////////

const touchDevice = window.ontouchstart !== undefined;

// 0: the steer line is fixed bottom left. 1: it re-centres under each new thumb
const touchSteerFloat = 0;

// the touch() dev command: the pad without a touch screen, driven by the mouse
let touchForce = debug && localStorage.SP13KTOUCH|0;
let touchOverlay, touchSvg, touchLayoutKey, touchControls = [], touchUsed = 0;

// touchRoles: the control each finger holds, by pointerId (a plain object, never a Map: see above)
let touchButtons = [], touchStick = vec3(), touchRoles = {};

// touchFingers: every finger down on the pad, control or not, by pointerId
// touchIdleTime: when one was last down (performance.now)
let touchFingers = {}, touchIdleTime = 0;

// the race HUD makes room for the pad wherever it can show (hud.js reads this behind enhancedMode)
const touchHud = () => touchDevice || touchForce;

///////////////////////////////////////////////////////////////////////////////
// iOS audio (Safari's engine, so Chrome on an iPhone too)
//
// Locking the phone or leaving the page interrupts the audio context, and iOS lets a page
// start audio only inside a gesture, often not even resume() there: the frame loop's
// retries in playSamples never count. So every touch on a touch device checks
// (touchAudioWake): an interrupted context, or a suspended one that a gesture already asked
// to resume, is closed and replaced by a fresh one made inside this gesture; a suspended
// one is asked first (a desktop browser's first gesture). The music then starts again from
// the top (its clock was the old context's) and the engine loop restarts.
//
// A dead clock: iOS can also come back from the interruption saying 'running' with a clock
// that never moves again and no sound. touchAudioWatch, every step, notes when the clock
// last moved; running but still for half a second of steady frames is dead, and the next
// touch replaces it too. A frame gap over .2 s (a hidden page gets no frames) or any other
// state restarts the watch, so a page coming back is not called dead before its clock has
// had its chance.

let touchAudioAsked; // the context a gesture already asked to resume
let touchAudioTime = 0, touchAudioMoved = 0, touchAudioSampled = 0, touchAudioDead = 0;

function touchAudioWatch()
{
    const a = audioContext, now = performance.now();
    if (!a)
        return;
    if (a.currentTime != touchAudioTime || now - touchAudioSampled > 200 || a.state != 'running')
        touchAudioTime = a.currentTime, touchAudioMoved = now, touchAudioDead = 0;
    else if (!touchAudioDead && now - touchAudioMoved > 500)
        touchAudioDead = 1;
    touchAudioSampled = now;
}

function touchAudioWake()
{
    const a = audioContext;
    if (a && a.state == 'running' && !touchAudioDead)
        return;
    // replace it: interrupted, or running with a dead clock, or asked already
    if (!a || a.state != 'suspended' || touchAudioAsked == a)
    {
        a && a.close().catch(()=>0);
        audioContext = new AudioContext;
        musicSource = musicEpoch = engineSound = touchAudioDead = 0;
        touchAudioMoved = performance.now();
    }
    else
    {
        a.resume(), touchAudioAsked = a;
    }
}
touchDevice && addEventListener('touchend', touchAudioWake, true);

///////////////////////////////////////////////////////////////////////////////
// page touch handling (touch devices)

// iOS sends a tap's compatibility mouse events after the finger lifts, whatever pointerdown
// prevented, and by then a press that leaves the race (TITLE, or the last touch before the
// results) has hidden the pad, so the mousedown would land on the title as a click and open
// the menu straight away. A mousedown within a second of a touch that began on the pad is
// dropped before input.js's onmousedown sees it; a touch that begins anywhere else clears that.
// touchPadTouchEnd: performance.now() when the last touch that began on the pad lifted
// (Infinity while it is down), else 0
let touchPadTouchEnd = 0;
if (touchDevice)
{
    // iOS's long-press magnifier, text selection and callout, stopped the way LittleJS does:
    // no selection or callout on the page, no browser touch gestures, and every touch's
    // default prevented, so the browser makes no mouse events of its own.
    //   a touch off the pad goes to input.js's mouse handlers instead (the first finger: a
    //     tap on the title, the menu and the results is still a click, and mouse mode stays
    //     as it was, so a tap never steers the race)
    //   a touch that began on the pad is the pad's (its pointer events), even once the pad
    //     has hidden under it
    //   unfocused, the default is kept: it gives the page focus, and the browser's own mouse
    //     events make the click
    document.documentElement.style.cssText += ';user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none';
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
        document.addEventListener(type, e =>
        {
            if (!e.cancelable || !document.hasFocus())
                return;
            e.preventDefault();
            if (touchOverlay && touchOverlay.contains(e.target))
                return;
            onmousemove(e.changedTouches[0]);
            if (type == 'touchstart' && e.touches.length == 1)
            {
                const m = mouseMode;
                onmousedown({button: 0, preventDefault: ()=>0});
                mouseMode = m;
            }
            else if (type != 'touchmove' && !e.touches.length)
                onmouseup({button: 0});
        }, {passive: false});

    addEventListener('touchstart', e => touchPadTouchEnd = touchOverlay && touchOverlay.contains(e.target) ? Infinity : 0, true);
    addEventListener('touchend', () => touchPadTouchEnd &&= performance.now(), true);
    addEventListener('mousedown', e => performance.now() - touchPadTouchEnd < 1e3 && e.stopPropagation(), true);
}

///////////////////////////////////////////////////////////////////////////////
// the pad

// the controls for the current state in window pixels; S, a thumb's reach, scales with the
// window's short side. Buttons are gamepad indices: 2 is X, the brake (1, B, is a turbo)
function touchLayout(W, H)
{
    const S = clamp(min(W, H)*.2, 50, 120), tall = W < H;
    return paused ? [
        {button:9, x:W/2-S*1.3, y:H*.72, r:S*.55, label:'RESUME'},
        {button:8, x:W/2+S*1.3, y:H*.72, r:S*.55, label:'TITLE'},
    ] : [
        // the steer line; r is half its length. Fixed, it is longer: a thumb never lands dead
        // centre on a control that does not come to it (less so on a tall window, where a
        // full-length line crowds BRAKE), level with GAS's centre so both thumbs sit even
        touchSteerFloat ? {stick:1, x:S*1.4, y:H-S*1.4, r:S*.8} : {stick:1, x:S*(tall ? 1.25 : 1.5), y:H-S*1.1, r:S*(tall ? .85 : 1)},
        {button:0, x:W-S*1.1, y:H-S*1.1, r:S*.7, label:'GAS'},
        {button:2, x:W-S*(tall ? 2.35 : 2.7), y:H-S*(tall ? 2.35 : .8), r:S*.5, label:'BRAKE'},
        // lower on a wide window: at 2.7 it overlaps the minimap under the lap
        {button:5, x:W-S*1.1, y:H-S*(tall ? 2.7 : 2.5), r:S*.5, label:'TURBO'},
        // fade: hidden while playing (touchUpdate), touchable always
        {button:9, x:W/2, y:S*.45, r:S*.3, label:'II', fade:1},
    ];
}

function touchInit()
{
    const o = touchOverlay = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;z-index:9;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none';
    touchSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    // the font is the HUD's embedded one (font.js), one weight
    touchSvg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:.5;font-family:"Archivo Black",sans-serif';
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
            // a fading button's shapes share one group
            const g = c.fade ? c.group = shape('g', {style:'transition:opacity .4s'}) : touchSvg;
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

// the control a press at p takes: the nearest button in reach (1.4 radii), else the steer
// line anywhere on the left half
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

// the thumb's sideways offset from the line's centre (floating: from where it landed), full
// lock at the line's end
const touchApplyStick = (c, p)=> touchStick = vec3(clamp((p.x - (c.ax || c.x))/c.r, -1, 1), 0);

function touchDown(e)
{
    // preventDefault: no compatibility mouse events, so a touch never enters mouse mode or clicks
    e.preventDefault();
    touchOverlay.setPointerCapture(e.pointerId);
    touchFingers[e.pointerId] = 1;
    isUsingGamepad = touchUsed = 1;
    touchAudioWake();
    const p = vec3(e.clientX, e.clientY), c = touchHit(p);
    if (!c)
        return;
    touchRoles[e.pointerId] = c;
    if (c.stick)
    {
        if (touchSteerFloat)
            c.ax = p.x, c.ay = p.y; // the line re-centres under the thumb
        touchApplyStick(c, p);
    }
    else
        touchButtons[c.button] = 1;
}

function touchMove(e)
{
    const c = touchRoles[e.pointerId], p = vec3(e.clientX, e.clientY);
    if (!c)
        return;
    if (c.stick)
        return touchApplyStick(c, p);

    // a thumb on a button slides onto another without lifting (GAS up onto TURBO, or across
    // to BRAKE). Off every button it keeps the last; the pause buttons are never slid onto
    const n = touchHit(p);
    if (n && n != c && !n.stick && !n.fade && !paused)
    {
        delete touchButtons[c.button];
        touchRoles[e.pointerId] = n;
        touchButtons[n.button] = 1;
    }
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

// polled by gamepadsUpdate (input.js) every step and while paused: shows or hides the pad,
// paints it and writes pad 0. Returns 1 when the pad owns pad 0 (the real gamepads are not
// polled then)
function touchUpdate()
{
    touchDevice && touchAudioWatch();
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

    // the pause button hides while any finger is down and fades back in two seconds after
    // the last one lifts, touchable all the while: no button in the middle of the screen
    // the whole race, but a reminder once you stop touching
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

    // the same held/pressed/released bits as a real pad, and the steer with a .15 dead zone
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

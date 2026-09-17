'use strict';

///////////////////////////////////////////////////////////////////////////////
// hud.js: everything drawn on the 2D canvas over the WebGL frame.
//
// Owns the minimap (drawMap), the title logo, the menu, countdown, race readouts
// and results card (drawHUD), and the single text style every string uses
// (drawHUDText). drawHUD() is called once per frame from gameUpdate (game.js)
// after drawScene; debug.js calls drawHUDText for its own readouts and toggles
// showMap with the 5 key. game.js hit-tests menu clicks through menuRowAt. It
// reads game state (game.js), the player's craft (vehicle.js), the world map
// points (track.js) and the circuit's colours (levels.js). The enhanced build
// adds the touch layout (drawTouchHUD, beside touch.js's pad), the portrait menu,
// the PLAY and FULL SCREEN rows and help.js's tips; every such branch is behind
// enhancedMode, with the test written out at each use so the 13k build folds it
// away (a local holding the test, used more than once, survives the fold).
///////////////////////////////////////////////////////////////////////////////

let showMap = 1; // dev toggle (debug.js, 5 key); always on in the release

///////////////////////////////////////////////////////////////////////////////
// minimap: bottom right, the true closed circuit shape and every craft on it

function drawMap()
{
    // the title shows only its logo; the results card stands alone
    if (!showMap || titleScreenMode && !menuMode || gameOverTime)
        return;

    // H, the map's size unit: the window height, except (enhanced only)
    //   the portrait menu: the menu's unit, menuUnit() of the height
    //   beside the touch pad: the window's short side, so a portrait phone gets landscape's
    //     proportions
    const ctx = mainContext, W = mainCanvasSize.x, H = enhancedMode && titleScreenMode && getAspect() < 1 ? mainCanvasSize.y*menuUnit() : enhancedMode && !titleScreenMode && touchHud() ? min(W, mainCanvasSize.y) : mainCanvasSize.y;

    // fit the loop to a box about a quarter of the window height; world +z is up on the map.
    // In the menu it is the picture of the circuit: twice the size, centred on the right half
    // (menuMode stays set through a race: the race gets the small corner map)
    const menu = titleScreenMode && menuMode;

    // s: pixels per world unit, a little smaller beside the touch pad, clear of TURBO
    const k = 1+menu, s = H*(enhancedMode && !titleScreenMode && touchHud() ? .1 : .12)*k/trackMapRadius, o = trackMapCenter;

    // strokes and dots scale with the height too: fixed pixels go thin on a big window
    const q = H/540*(1+.6*menu);

    // the box centre: bottom right; the portrait menu centres it above the bottom button;
    // beside the touch pad it sits under the lap (the pad covers the bottom corners)
    const cx = enhancedMode && titleScreenMode && getAspect() < 1 ? W/2 : W-H*(.185+.115*menu), cy = enhancedMode && titleScreenMode && getAspect() < 1 ? mainCanvasSize.y-H*.47 :H*(enhancedMode && !titleScreenMode && touchHud() ? .27 : .815-.115*menu);

    // trackMapPts (track.js) is the loop in real world space, one [x,z] every 8 segments
    ctx.beginPath();
    for(const [x,z] of trackMapPts)
        ctx.lineTo(cx+(x-o.x)*s, cy+(o.z-z)*s);
    ctx.closePath();

    // the start line: a short stroke across the loop at the start sample (s=3000), so the
    // map shows where a lap begins
    const t = track[30], r = t.right.scale(9*q);
    ctx.moveTo(cx+(t.pos.x-o.x)*s-r.x, cy+(o.z-t.pos.z)*s+r.z);
    ctx.lineTo(cx+(t.pos.x-o.x)*s+r.x, cy+(o.z-t.pos.z)*s-r.z);

    // a wide dark stroke under the thin white one, so the loop reads on a light sky
    ctx.lineWidth = 6*q;
    ctx.strokeStyle = BLACK;
    ctx.stroke();
    ctx.lineWidth = 3*q;
    ctx.strokeStyle = WHITE;
    ctx.stroke();

    // craft, from real world X/Z: every craft a small dot in its colour, then the player
    // on top as a bigger dot in its own colour (no ring around it: one hides the rivals
    // just behind)
    const dot = (v, r, color)=>
    {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx+(v.pos.x-o.x)*s, cy+(o.z-v.pos.z)*s, r, 0, 9); // 9 > 2*PI: a full circle
        ctx.fill();
    };
    for(const v of vehicles)
        dot(v, 3*q, v.color);
    dot(playerVehicle, 5*q, playerVehicle.color);
}

///////////////////////////////////////////////////////////////////////////////
// the HUD is one type system: uppercase, heavy sans (drawHUDText), white, with the
// circuit band as the only accent and thin rules instead of boxes (Swiss, not
// chatty). Positions are fractions of the canvas, sizes fractions of its height, and
// anything anchored to a side sits edge(f) in: a margin in height units too.

function drawHUD()
{
    if (freeCamMode || topDownMode)
        return; // the dev free camera and map view show the world clean

    // enhanced: the logo's and the subtitle's fades restart each time the main title appears
    if (enhancedMode)
        titleLogoStart = titleScreenMode && !menuMode ? titleLogoStart || performance.now() : 0;
    titleLogoStart = 0; // the logo's fade is switched off for now (titleLogoWhite stays white)
    if (enhancedMode)
        titleSubtitleStart = titleScreenMode && !menuMode ? titleSubtitleStart || performance.now() : 0;
    drawMap();
    const band = bandColor(); // the circuit's accent colour

    // 60% down, clear of the bottom HUD on a small screen; the touch pad's RESUME and TITLE
    // sit lower, at .72
    if (enhancedMode && paused)
        drawHUDText('PAUSE', .5,.6, .08);

    if (titleScreenMode && menuMode)
    {
        // the menu: the logo small top left, every circuit down the left under it, the
        // chosen one big and white, the other unlocked ones in their wall-light colours,
        // the locked ones small and grey; the minimap big on the right (drawMap); the best
        // placing reads BEST top right, where a race shows its lap.
        // The portrait menu (enhanced only) is one centred column: see menuUnit
        enhancedMode && getAspect() < 1 ? drawLogo(.5, menuUnit()*.14, menuUnit()*.1) : drawLogo(edge(.3), .11, .1);

        // the pointer's row (menuRowAt) previews a click: an unlocked name under it takes
        // the selected look, white on its colour, at its small size, the selected one takes
        // the plain look, and a locked one darkens (a click on it plays the bump, game.js)
        const h = menuRowAt();

        // a list row: the text, and its measured right edge in mouseX units for the hit test
        const row =(c, text, color, shadow) => { drawHUDText(text, menuRowX(), menuRowY(c), menuRowSize(c), color, 'left', 'middle', shadow); menuRowW[c] = (menuRowX()+mainContext.measureText(text).width/mainCanvasSize.x)*2-1; };
        for (let c = 0, n = circuitsUnlocked(); c < circuitCount; ++c)
        {
            const L = levelInfoList[c], lit = (c==currentCircuit) != (c==h), col = L.rainbow ? hsl(time/10, 1, .6) : L.edgeColor; // the finale's name cycles through the hues
            row(c, (c+1)+' '+L.name, c<n ? lit ? WHITE : col : hsl(0,0,c==h?.25:.5), c==currentCircuit && c==h ? WHITE : lit && c<n ? col : 0);
        }

        // the TEAM button, row circuitCount of the same hit test: the word in the craft's
        // colour, its shadow white under the pointer; a click takes the next craft (game.js).
        // It draws at menuRowSize like every other row, so the hit box matches the word.
        // 13k: TEAM, big at the bottom; enhanced: CHANGE TEAM, the list's last row
        row(circuitCount, enhancedMode ? 'CHANGE TEAM' : 'TEAM', playerVehicle.color, h == circuitCount ? WHITE : 0);

        // enhanced: PLAY races the selected circuit, like a click on its name, Space or Enter:
        // big and white on the band, bottom left, centred under the map on a tall window
        if (enhancedMode)
            getAspect() < 1 ? drawMenuCentred(circuitCount + 1, 'PLAY', WHITE, h == circuitCount + 1 ? WHITE : band) : row(circuitCount + 1, 'PLAY', WHITE, h == circuitCount + 1 ? WHITE : band);

        // enhanced: FULL SCREEN, a list row under CHANGE TEAM, only while it can be offered
        // (fullscreenOffer); hidden, its hit box goes too
        if (enhancedMode)
            fullscreenOffer() ? row(circuitCount + 2, 'FULL SCREEN', band, h == circuitCount + 2 ? WHITE : 0) : menuRowW[circuitCount + 2] = -9;
        debug && showRegions && drawRegions(); // the dev regions() command: the click regions over the rows

        // the best placing here: a big numeral under a small BEST, top right, and the best
        // time under that
        const p = bestPlaces[currentCircuit]|0;
        if (p)
        {
            // the portrait menu: BEST, the place and the time on one line over the list
            if (enhancedMode && getAspect() < 1)
            {
                const m = menuUnit();
                drawHUDText('BEST', .05, .25*m, .06*m, band, 'left');
                drawPlace(p, .5, .25*m, .08*m);
                bestTimes[currentCircuit] && drawHUDText(formatTimeString(bestTimes[currentCircuit]), .95, .25*m, .06*m, WHITE, 'right');
            }
            else
            {
                drawHUDText('BEST', edge(-.04), .1, .08, band, 'right');
                drawPlace(p, edge(-.15),.28, .2);
                bestTimes[currentCircuit] && drawHUDText(formatTimeString(bestTimes[currentCircuit]), edge(-.04), .37, .06, WHITE, 'right');
            }
        }
        enhancedMode && helpOpen && drawHelpCard(); // the HELP card over the menu (help.js)
    }
    else if (titleScreenMode)
    {
        // enhanced: sized off a narrow window, or the cover shot's (titleCover)
        drawLogo(.5, enhancedMode ? titleLogoY : .2, enhancedMode ? titleLogoSize() : .15);
        if (enhancedMode)
        {
            // FULL SPECTRUM RACING under the logo, centred like the whole word above it. It
            // waits 1.5 s after the title appears, then fades in over a second
            const s = titleLogoSize();
            drawHUDText('FULL SPECTRUM RACING', .5, titleLogoY + s*.42, s*.3, rgb(1, 1, 1, clamp((performance.now()-titleSubtitleStart)/1e3-1.5, 0, 1)));
        }
    }
    else
    {
        // startCountdown under 4: a race started from the menu draws its first frame before
        // the first countdown step, which would flash a full-size 4
        if (time < 4 && !quickStart && startCountdown < 4)
        {
            // count down over the full HUD: the numbers white, GO in the band, each fading over its second
            const c = startCountdown ? WHITE : band, f = 1-time%1; // f: each numeral's remaining second
            drawHUDText(startCountdown || 'GO', .5,.45, .24+.12*f, rgb(c.r, c.g, c.b, f)); // it shrinks a third as it fades
        }
        if (gameOverTime)
        {
            // results card: one giant placement numeral over the race time, nothing else.
            // There is no win condition and no WIN card: players decide what a win is.
            // A destroyed craft reads OUT instead of a place
            playerVehicle.deadUntil ? drawHUDText('OUT', .5,.55, .36) : drawPlace(lastRacePlace, .55,.55, .36);
            drawHUDText(formatTimeString(raceTime), .5,.65, .06);
        }
        else
        {
            // the touch pad covers the bottom corners (touch.js): the enhanced build's own layout
            if (enhancedMode && touchHud())
                drawTouchHUD(band);
            else
            {
                // the place bottom left (top centre is where the sun is when you drive straight at it)
                drawPlace(playerPlace, edge(.15),.86, .14);

                // energy: a thin rule in the band with a white tip, under the position. Under 25
                // the whole meter inverts twice a second, backing white and rule black (flashing
                // only the rule is invisible once it is short); the rule is white once the craft
                // is destroyed. drawTouchHUD draws the same bar: keep the two in step
                const ctx = mainContext, W = mainCanvasSize.x, H = mainCanvasSize.y;
                const bw = H*.35, bh = H*.02, bx = H*.035, by = H*.92; // the bar box (all off the height: edge)
                const e = bw*playerVehicle.energy/100; // filled width
                const flash = playerVehicle.energy<25 && time%.5<.25;
                ctx.fillStyle = flash ? '#fffa' : '#0006';
                ctx.fillRect(bx-2, by-2, bw+4, bh+4); // translucent backing, 2px larger all round
                ctx.fillStyle = flash ? BLACK : playerVehicle.deadUntil ? WHITE : band;
                ctx.fillRect(bx, by, e, bh);
                ctx.fillStyle = flash ? BLACK : WHITE;
                ctx.fillRect(bx+e-2, by-3, 4, bh+6); // the white tip: 4px wide, 3px proud of the rule

                // time top left; lap and circuit top right (the results card owns the final time)
                drawHUDText(formatTimeString(raceTime), edge(.035),.075, .045, WHITE, 'left');
                drawHUDText('LAP '+(playerLap+1)+'/'+raceLaps, edge(-.035),.075, .045, WHITE, 'right');
                drawHUDText(levelInfo.name, edge(-.035),.115, .028, band, 'right');
            }
            enhancedMode && drawHelpTips(); // the in-race tips until the first finish (help.js)
        }
    }

    if (debugInfo && !titleScreenMode) // dev readout: speed/60 = world units per frame
        drawHUDText((playerVehicle.speed/60|0)+' SPEED', edge(.035),.14, .05, WHITE, 'left');
}

// the race HUD while the touch pad can show (enhanced only: called behind enhancedMode, so
// the 13k build drops it). The pad covers the bottom corners, so the energy bar goes top left
// with the time and then the place under it, and LAP and the circuit name stay top right over
// the map (drawMap moves it under them). Offsets are in units of the window's short side
// (k, width over height on a tall window; drawHUDText scales the sizes the same way), so a
// portrait phone gets landscape's proportions: sized off the height, the bar crosses the
// screen and LAP sits on the pause button
function drawTouchHUD(band)
{
    const ctx = mainContext, k = min(1, getAspect()), u = mainCanvasSize.y*k; // u: the short side in pixels
    drawPlace(playerPlace, edge(.15*k), .28*k, .12); // close under the time

    // the energy bar, as drawHUD draws it (keep the two in step)
    const bw = u*.35, bh = u*.02, bx = u*.035, by = u*.035, e = bw*playerVehicle.energy/100, flash = playerVehicle.energy<25 && time%.5<.25;
    ctx.fillStyle = flash ? '#fffa' : '#0006';
    ctx.fillRect(bx-2, by-2, bw+4, bh+4);
    ctx.fillStyle = flash ? BLACK : playerVehicle.deadUntil ? WHITE : band;
    ctx.fillRect(bx, by, e, bh);
    ctx.fillStyle = flash ? BLACK : WHITE;
    ctx.fillRect(bx+e-2, by-3, 4, bh+6);

    drawHUDText(formatTimeString(raceTime), edge(.035*k), .135*k, .045, WHITE, 'left');
    drawHUDText('LAP '+(playerLap+1)+'/'+raceLaps, edge(-.035*k), .075*k, .045, WHITE, 'right');
    drawHUDText(levelInfo.name, edge(-.035*k), .115*k, .028, band, 'right');
}

///////////////////////////////////////////////////////////////////////////////
// layout helpers and the menu's rows

// the ordinal suffix of a placing
const placeSuffix = p => ['ST','ND','RD'][p-1]||'TH';

// the circuit's accent for the HUD: on the finale it cycles through the hues, a lap of
// the wheel every ten seconds (every other circuit is one hue)
const bandColor = () => levelInfo.rainbow ? hsl(time/10, 1, .6) : levelInfo.lineColor;

// an x from the window's edge in fractions of the height, like every size: f from the left,
// -f from the right, as the canvas fraction drawHUDText takes. (As fractions of the width,
// margins shrink on a narrow window and the race's place runs off the left)
const edge = f => (f < 0) + f/getAspect();

// the menu list's left edge (the portrait menu: a twentieth of the width)
const menuRowX = () => enhancedMode && getAspect() < 1 ? .05 : edge(.05);

// the portrait menu (enhanced only, any window taller than wide): one centred column in units
// of menuUnit() of the height, so it keeps its proportions and fits from a phone to a
// portrait tablet:
//   .14   the logo, small, centred at the top (size .1)
//   .25   BEST with the place and the time on one line
//   .35   the list: rows .08 apart at .06, the selected one .1, then CHANGE TEAM and
//         FULL SCREEN as list rows
//   PLAY locked to the bottom of the screen (its centre .125 up) with the map centred right
//   above it (drawMap, its centre .47 up), so a taller window puts its spare height between
//   the list and the map
// menuRowX/Y/Size switch to it with the test written out at each use, so the 13k build folds
// every one away
const menuUnit = () => min(getAspect(), .55);
const menuRowYTall = c => c > circuitCount + 1 ? menuRowYTall(circuitCount) + menuUnit()*.08 : c > circuitCount ? 1-menuUnit()*.125 : menuUnit()*(.35 + c*.08 + (c > currentCircuit ? .05 : c == currentCircuit ? .025 : 0));
const menuRowSizeTall = c => menuUnit()*(c == circuitCount + 1 ? .15 : c == currentCircuit ? .1 : .06); // PLAY big, the rest list rows

// FULL SCREEN (enhanced only): menu row circuitCount+2, drawn one list row under CHANGE TEAM
// (row circuitCount; PLAY is circuitCount+1), in the band, its shadow white under the
// pointer. Offered only while windowed, where the page may go fullscreen (not an iPhone, not
// a frame that disallows it) and not on Wavedash, whose own interface has a button; Escape or
// the phone's back gesture leaves, and the row comes back. game.js calls draw.js's
// toggleFullscreen on its click, a frame after the press, still inside the browser's user
// activation; the F key (enhancedModeUpdate) toggles fullscreen from anywhere
const fullscreenOffer = () => document.fullscreenEnabled && !isFullscreen() && !window.Wavedash;

// the portrait menu's PLAY button, centred on the middle of the canvas: its measured right
// edge in mouseX units is just its width, and menuRowAt mirrors that for the left
function drawMenuCentred(c, text, color, shadow)
{
    drawHUDText(text, .5, menuRowY(c), menuRowSize(c), color, 'center', 'middle', shadow);
    menuRowW[c] = mainContext.measureText(text).width/mainCanvasSize.x;
}

// the menu's row centres (canvas fractions, drawn on the middle baseline): the selected
// row, twice the size, shifts the rows below it down so the gap around it reads even.
// game.js hit-tests clicks against the same rows: menuRowSize gives a row's text size and
// menuRowW its measured right edge (in mouseX units, written as the menu draws), so a click
// has to land on the name itself, not a fixed box (the dev regions() command draws the boxes).
// Rows past the circuits:
//   circuitCount     13k: TEAM, big (.15), .17 under the list; enhanced: CHANGE TEAM, the
//                    list's last row
//   circuitCount+1   enhanced: PLAY, big (.15), bottom left at .9
//   circuitCount+2   enhanced: FULL SCREEN, one list row under CHANGE TEAM
const menuRowY = c => enhancedMode && getAspect() < 1 ? menuRowYTall(c) : enhancedMode && c > circuitCount + 1 ? menuRowY(circuitCount) + .052 : enhancedMode && c > circuitCount ? .9 : .21 + c*.052 + (c > currentCircuit ? .045 : c == currentCircuit ? .022 : 0) + (c == circuitCount ? enhancedMode ? 0 : .17 : 0);
const menuRowSize = c => enhancedMode && getAspect() < 1 ? menuRowSizeTall(c) : c == (enhancedMode ? circuitCount + 1 : circuitCount) ? .15 : c == currentCircuit ? .1 : .05, menuRowW = [];

// the row under the pointer, locked ones and the rows past the circuits included, or -1:
// on the name itself, .45 of its size each way. The portrait menu's PLAY is centred, so its
// left edge mirrors its right
const menuRowAt = () =>
{
    for (let c = 0; c <= (enhancedMode ? circuitCount + 2 : circuitCount); ++c)
        if (abs(mouseY - menuRowY(c)) < menuRowSize(c)*.45 && mouseX > (enhancedMode && getAspect() < 1 && c == circuitCount + 1 ? -menuRowW[c] : menuRowX()*2-1) && mouseX < menuRowW[c])
            return c;
    return -1;
};

// the logo: SP13KTRA in three pieces around the measured width of 13K, SP right-aligned
// to its left edge, TRA left-aligned to its right, and the 13K itself the only rainbow
// text in the game: white light split across those three glyphs by a gradient that
// slides with time, spanning one logo size either side of x, about the width of 13K.
// x, y are canvas fractions, s a fraction of the height (the title, and the menu's corner)
function drawLogo(x, y, s)
{
    const ctx = mainContext, W = mainCanvasSize.x, px = s*mainCanvasSize.y;

    // the enhanced build's main title and portrait menu centre the whole word on x, not 13K:
    // 13K moves left by half of TRA's width less SP's, measured at the logo's size (the empty
    // text only sets the font). The 13k build and the wide menu's corner logo stay centred
    // on 13K
    if (enhancedMode && (!menuMode || getAspect() < 1))
        drawHUDText('', 0, 0, s), x -= (ctx.measureText('TRA').width - ctx.measureText('SP').width)/2/W;
    const g = ctx.createLinearGradient(x*W-px, 0, x*W+px, 0);
    for(let i=9; i--;)
        g.addColorStop(i/8, hsl(i/8-time*.3, 1, .6));
    drawHUDText('13K', x,y + Math.sin(time)*s*.05, s/.9, g);
    const w = ctx.measureText('13K').width/2/W; // the font is still set from that call
    drawHUDText('SP', x-w,y, s, enhancedMode ? titleLogoWhite() : WHITE, 'right');
    drawHUDText('TRA', x+w,y, s, enhancedMode ? titleLogoWhite() : WHITE, 'left');
}

// the enhanced title's fades (the 13k build folds both uses of titleLogoWhite to WHITE): SP
// and TRA wait while 13K shows alone for a second, then fade in over a second, every time
// the main title appears; the menu's corner logo is full white. Switched off for now: drawHUD
// zeroes titleLogoStart every frame
// titleLogoStart: performance.now() when the main title appeared, 0 while it is not showing
// titleSubtitleStart: the same for FULL SPECTRUM RACING, which has its own fade (drawHUD)
let titleLogoStart = 0;
let titleSubtitleStart = 0;

// the cover shot (enhanced only): 1 makes the main title's logo and subtitle span about 92%
// of the width for a cover screenshot, the logo lower at .3 so the bigger letters clear the top
const titleCover = 0;

// the enhanced title's logo size: .15, less on a narrow window to stay clear of both edges
const titleLogoSize = () => titleCover ? getAspect()*.13 : min(.15, getAspect()*.11);
const titleLogoY = titleCover ? .3 : .2;
const titleLogoWhite = () => titleLogoStart ? rgb(1, 1, 1, clamp((performance.now()-titleLogoStart)/1e3-1, 0, 1)) : WHITE;

// every placing in the game (the race corner, the results card, the menu's BEST) through
// one call, so they read the same: the numeral white and right-aligned at x, its ordinal
// in the band after it at .36 of the size, both on the baseline y. Every caller passes 1-8:
// there is no guard for 0
function drawPlace(p, x, y, s)
{
    drawHUDText(p, x, y, s, WHITE, 'right');
    drawHUDText(placeSuffix(p), x, y, s*.36, bandColor(), 'left');
}

// one type system for every HUD string. size is a fraction of the canvas height, pos a
// fraction of the canvas. A black drop shadow (the same text filled again 4% of its size
// down and right) keeps it legible on a light sky and vanishes against the void;
// it carries the fill's alpha (the countdown fades). Never a stroked rim: canvas line
// rendering is slow, a second fill is not. color may be a canvas gradient (the logo's
// 13K). baseline: 'alphabetic' (the default) or 'middle' (the menu list: even spacing
// whatever font a browser falls back to); shadow: the drop shadow's colour, black unless
// given (the menu's selected name casts its circuit's colour)
function drawHUDText(text, px, py, size, color=WHITE, align='center', baseline='alphabetic', shadow)
{
    // enhanced only: on a tall window a race's text (the HUD, the countdown, the results card)
    // sizes off the short side, so a portrait phone gets landscape's proportions; sized off the
    // height it runs off the screen. The title and the menu keep the height (their hit boxes
    // use menuRowSize). help.js's drawHelpText repeats this scaling to measure: keep in step
    if (enhancedMode && !titleScreenMode)
        size *= min(1, getAspect());
    size *= mainCanvasSize.y; px *= mainCanvasSize.x; py *= mainCanvasSize.y;
    const context = mainContext;

    // enhanced: Archivo Black, embedded by font.js (phones have no Arial Black and fall back
    // to a lighter bold; it has one weight, so no 900, which would fake a bolder one); the
    // 13k build folds this to its arial 900
    context.font = enhancedMode ? `${size}px "Archivo Black",arial,sans-serif` : `900 ${size}px arial,sans-serif`;
    context.textAlign = align;
    context.textBaseline = baseline;
    context.fillStyle = shadow || rgb(0,0,0,color.a); // (a falsy shadow is the black default)
    context.fillText(text, px+size*.04, py+size*.04);
    context.fillStyle = color;
    context.fillText(text, px, py);
}

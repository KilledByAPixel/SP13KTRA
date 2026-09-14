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
// points (track.js) and the circuit's colours (levels.js).
///////////////////////////////////////////////////////////////////////////////

let showMap = 1; // dev toggle (debug.js, 5 key); always on in the release

///////////////////////////////////////////////////////////////////////////////
// minimap: bottom right, the true closed circuit shape and every craft on it

function drawMap()
{
    // trackMapPts (track.js) is the loop in real world space, one [x,z] every 8 segments
    if (!showMap || titleScreenMode && !menuMode || gameOverTime) // the title shows only its logo; the results card stands alone
        return;
    // H: beside the touch pad (enhanced only, touch.js) the map sizes off the window's short side, so a portrait phone gets
    // landscape's proportions (Frank, 2026-09-14). The test is written out at each use: a local used more than once survived
    // in the 13k build (+21), a single use folds away
    // in the portrait menu (enhanced only, a tall window) H is the menu's unit, menuUnit() of the height, and the map sits centred under the list
    const ctx = mainContext, W = mainCanvasSize.x, H = enhancedMode && titleScreenMode && getAspect() < 1 ? mainCanvasSize.y*menuUnit() : enhancedMode && !titleScreenMode && touchHud() ? min(W, mainCanvasSize.y) : mainCanvasSize.y;
    // fit the loop to a box about a quarter of the window height (a fixed 130px was tiny on
    // a desktop window); world +z is up on the map (500 points a frame is cheap). In the
    // menu it is the picture of the circuit: twice the size, centred on the right half
    const menu = titleScreenMode && menuMode; // (menuMode stays set through a race: the race gets the small corner map)
    const k = 1+menu, s = H*(enhancedMode && !titleScreenMode && touchHud() ? .1 : .12)*k/trackMapRadius, o = trackMapCenter; // a little smaller beside the touch pad, clear of TURBO
    const q = H/540*(1+.6*menu); // strokes and dots scale with the height too (fixed pixels went thin on a big window and in the menu's big map)
    const cx = enhancedMode && titleScreenMode && getAspect() < 1 ? W/2 : W-H*(.185+.115*menu), cy = enhancedMode && titleScreenMode && getAspect() < 1 ? mainCanvasSize.y-H*.47 :H*(enhancedMode && !titleScreenMode && touchHud() ? .27 : .815-.115*menu); // box centre; beside the touch pad under the lap (the pad covers the bottom corners)

    ctx.beginPath();
    for(const [x,z] of trackMapPts)
        ctx.lineTo(cx+(x-o.x)*s, cy+(o.z-z)*s);
    ctx.closePath(); // (looks fine without it)

    // the start line: a short stroke across the loop at the start sample (s=3000), so the
    // menu's map shows where a lap begins (2026-09-13)
    const t = track[30], r = t.right.scale(9*q);
    ctx.moveTo(cx+(t.pos.x-o.x)*s-r.x, cy+(o.z-t.pos.z)*s+r.z);
    ctx.lineTo(cx+(t.pos.x-o.x)*s+r.x, cy+(o.z-t.pos.z)*s-r.z);

    // a wide dark stroke under the thin white one, so the loop reads on a light sky (ALBEDO's, gone 2026-09-13)
    ctx.lineWidth = 6*q;
    ctx.strokeStyle = BLACK;
    ctx.stroke();
    ctx.lineWidth = 3*q;
    ctx.strokeStyle = WHITE;
    ctx.stroke();

    // craft, from real world X/Z: every craft a small dot in its colour, then the player
    // on top as a bigger dot in ITS colour (always red before, which is the red rival once you
    // pick another craft; a white ring around it hid the rivals just behind, and went on 2026-09-13, Frank)
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
// the HUD is one type system: uppercase, tracked, weight 900 sans, white, with the
// circuit band as the only accent and thin rules instead of boxes (Swiss, not
// chatty). Positions are fractions of the canvas, sizes fractions of its height, and
// anything anchored to a side sits edge(f) in: a margin in height units too.

function drawHUD()
{
    if (freeCamMode || topDownMode)
        return; // the dev free camera and map view show the world clean

    drawMap();
    const band = bandColor(); // the circuit's accent colour

    if (enhancedMode && paused)
        drawHUDText('PAUSE', .5,.9, .08);

    if (titleScreenMode && menuMode)
    {
        // the menu: the logo small top left, every circuit down the left under it, the
        // chosen one big and white, the other unlocked ones in their wall-light colours,
        // the locked ones small and grey; the minimap big on the right (drawMap); the best
        // placing reads BEST top right, where a race shows its lap. (A big turning showroom
        // craft in the middle got in the way of everything)
        enhancedMode && getAspect() < 1 ? drawLogo(.5, menuUnit()*.14, menuUnit()*.1) : drawLogo(edge(.3), .11, .1); // the portrait menu: small, centred at the top

        // the pointer's row (menuRowAt) previews a click: an unlocked name under it takes
        // the selected look, white on its colour, at its small size, the selected one takes
        // the plain look, and a locked one darkens (a click on it plays the bump, game.js)
        const h = menuRowAt();
        const row = (c, text, color, shadow) => { drawHUDText(text, menuRowX(), menuRowY(c), menuRowSize(c), color, 'left', 'middle', shadow); menuRowW[c] = (menuRowX()+mainContext.measureText(text).width/mainCanvasSize.x)*2-1; };
        for (let c = 0, n = circuitsUnlocked(); c < circuitCount; ++c)
        {
            const L = levelInfoList[c], lit = (c==currentCircuit) != (c==h), col = L.rainbow ? hsl(time/10, 1, .6) : L.edgeColor; // the finale's name cycles through the hues
            row(c, (c+1)+' '+L.name, c<n ? lit ? WHITE : col : hsl(0,0,c==h?.25:.5), c==currentCircuit && c==h ? WHITE : lit && c<n ? col : 0);
        }

        // the TEAM button under the list: the word in the craft's colour, its shadow white
        // under the pointer; a click takes the next craft (game.js). It is row circuitCount of
        // the same hit test, and it draws at menuRowSize like every other row: at a hard .15
        // the hit box was the .1 row's and the top and bottom of the word did not click
        enhancedMode && getAspect() < 1 ? drawTeamCentred(h == circuitCount ? WHITE : 0) : row(circuitCount, 'TEAM', playerVehicle.color, h == circuitCount ? WHITE : 0); // the portrait menu centres it under the map
        debug && showRegions && drawRegions(); // the dev regions() command: the click regions over the rows

        const p = bestPlaces[currentCircuit]|0;
        if (p) // the best placing here: a big numeral under a small BEST, top right, and the best time under that
        {
            if (enhancedMode && getAspect() < 1) // the portrait menu: BEST, the place and the time on one line over the list
            {
                const m = menuUnit();
                drawHUDText('BEST', .05, .3*m, .06*m, band, 'left');
                drawPlace(p, .5, .3*m, .08*m);
                bestTimes[currentCircuit] && drawHUDText(formatTimeString(bestTimes[currentCircuit]), .95, .3*m, .06*m, WHITE, 'right');
            }
            else
            {
            drawHUDText('BEST', edge(-.04), .1, .08, band, 'right');
            drawPlace(p, edge(-.15),.28, .2);
            bestTimes[currentCircuit] && drawHUDText(formatTimeString(bestTimes[currentCircuit]), edge(-.04), .37, .06, WHITE, 'right');
            }
        }
    }
    else if (titleScreenMode)
    {
        drawLogo(.5, .2, enhancedMode ? min(.15, getAspect()*.11) : .15); // on a narrow enhanced window, clear of both edges (it is centred on 13K and TRA is wider than SP: aspect/5 under .6 ran past both edges, and .14 of the aspect touched the right one, Frank 2026-09-14)
    }
    else
    {
        if (time < 4 && !quickStart && startCountdown < 4) // under 4: a race started from the menu draws its first frame before the first countdown step, so a full-size 4 flashed for a frame (the post-deadline fix)
        {
            // count down over the full HUD: the numbers white, GO in the band, each fading over its second
            const c = startCountdown ? WHITE : band, f = 1-time%1; // f: each numeral's remaining second
            drawHUDText(startCountdown || 'GO', .5,.45, .24+.12*f, rgb(c.r, c.g, c.b, f)); // it shrinks a third as it fades
        }
        if (gameOverTime)
        {
            // results card: one giant placement numeral (Grand Prix, not chatty); any finish
            // advances to the next circuit, the finale's to the opener. There is no win
            // condition and no WIN card (one for first on the finale lasted a day: players
            // decide what a win is). A destroyed craft reads OUT instead of a place
            playerVehicle.deadUntil ? drawHUDText('OUT', .5,.55, .36) : drawPlace(lastRacePlace, .55,.55, .36);
            drawHUDText(formatTimeString(raceTime), .5,.65, .06);
        }
        else
        {
            if (enhancedMode && touchHud())
                drawTouchHUD(band); // the touch pad covers the bottom corners (touch.js): the enhanced build's own layout, below
            else
            {
            // the place bottom left (top centre is where the sun is when you drive straight at it)
            drawPlace(playerPlace, edge(.15),.86, .14);

            // energy: a thin rule in the band with a white tip, under the position. Under 25
            // the WHOLE meter inverts twice a second, backing white and rule black (flashing
            // only the rule was invisible once it was short); the rule is white outright on
            // (a bright circuit, ALBEDO, had it white outright until 2026-09-13: its band was ink)
            // the backing, and once the craft is destroyed (drawTouchHUD draws the same bar: keep the two in step)
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
            // (a drift charge meter bottom centre was cut: it read as a dead bar)

            // time top left; lap and circuit top right (the results card owns the final time)
            drawHUDText(formatTimeString(raceTime), edge(.035),.075, .045, WHITE, 'left');
            drawHUDText('LAP '+(playerLap+1)+'/'+raceLaps, edge(-.035),.075, .045, WHITE, 'right');
            drawHUDText(levelInfo.name, edge(-.035),.115, .028, band, 'right');
            }
        }
    }

    if (debugInfo && !titleScreenMode) // dev readout: speed/60 = world units per frame
       drawHUDText((playerVehicle.speed/60|0)+' SPEED', edge(.035),.14, .05, WHITE, 'left');
}

// the race HUD while the touch pad can show (enhanced only: touch.js, called behind enhancedMode, so the 13k build drops it). The
// pad covers the bottom corners, so the energy bar goes top left with the time and then the place under it, and LAP and the
// circuit name stay top right over the map (drawMap moves it under them). Offsets are in units of the window's SHORT side
// (k, width over height on a tall window; drawHUDText scales the sizes the same way), so a portrait phone gets landscape's
// proportions: sized off the height, the bar crossed the screen and LAP sat on the pause button (Frank, 2026-09-14)
function drawTouchHUD(band)
{
    const ctx = mainContext, k = min(1, getAspect()), u = mainCanvasSize.y*k; // u: the short side in pixels
    drawPlace(playerPlace, edge(.15*k), .28*k, .12); // closer under the time (.33 sat too low, Frank)

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

// the ordinal suffix of a placing
const placeSuffix = p => ['ST','ND','RD'][p-1]||'TH';

// the circuit's accent for the HUD: on the finale it cycles through the hues, a lap of
// the wheel every ten seconds (every other circuit is one hue; the finale is all of them)
const bandColor = () => levelInfo.rainbow ? hsl(time/10, 1, .6) : levelInfo.lineColor;

// an x from the window's edge in fractions of the HEIGHT, like every size: f from the left,
// -f from the right, as the canvas fraction drawHUDText takes. Margins as fractions of the
// width shrank on a narrow window and the race's place ran off the left (Frank, 2026-09-13)
const edge = f => (f < 0) + f/getAspect();
const menuRowX = () => enhancedMode && getAspect() < 1 ? .05 : edge(.05); // the menu list's left edge (the portrait menu: a twentieth of the width)

// THE PORTRAIT MENU (enhanced only, a window taller than wide; Frank, 2026-09-14): one column in units of menuUnit() of the
// height, min(aspect, .55), so it keeps its proportions from a phone to a portrait tablet and always fits: the logo small and
// centred at the top (.14), BEST with the place and the time on one line (.3), the list (from .42, rows .08 apart at .06, the
// selected one .1), and at the bottom of the screen TEAM (its centre .125 up) with the map centred right above it (drawMap, its
// centre .47 up; a taller window puts the spare height between the list and the map, Frank). menuRowX/Y/Size switch to it with
// the test written out at each use, so the 13k build folds every one away
const menuUnit = () => min(getAspect(), .55);
const menuRowYTall = c => c == circuitCount ? 1-menuUnit()*.125 : menuUnit()*(.42 + c*.08 + (c > currentCircuit ? .05 : c == currentCircuit ? .025 : 0)); // TEAM locked to the bottom of the screen
const menuRowSizeTall = c => menuUnit()*(c == circuitCount ? .15 : c == currentCircuit ? .1 : .06);

// the portrait menu's TEAM button, centred under the map (Frank, 2026-09-14), in the craft's colour like the wide menu's: centred
// on the middle of the canvas, its measured right edge in mouseX units is just its width, and menuRowAt mirrors that for the left
function drawTeamCentred(shadow)
{
    drawHUDText('TEAM', .5, menuRowY(circuitCount), menuRowSize(circuitCount), playerVehicle.color, 'center', 'middle', shadow);
    menuRowW[circuitCount] = mainContext.measureText('TEAM').width/mainCanvasSize.x;
}

// the menu list's row centres (canvas fractions, drawn on the middle baseline): the
// selected row, twice the size, shifts the rows below it down so the gap around it reads
// even. game.js hit-tests clicks against the same rows: menuRowSize gives a row's text
// size and menuRowW its measured right edge (in mouseX units, written as the menu draws),
// so a click has to land on the name itself, not a fixed box (the dev regions() command
// draws the boxes). Row circuitCount, the TEAM button, sits under the list
const menuRowY = c => enhancedMode && getAspect() < 1 ? menuRowYTall(c) : .27 + c*.052 + (c > currentCircuit ? .045 : c == currentCircuit ? .022 : 0) + (c == circuitCount ? .17 : 0);
const menuRowSize = c => enhancedMode && getAspect() < 1 ? menuRowSizeTall(c) : c == circuitCount ? .15 : c == currentCircuit ? .1 : .05, menuRowW = [];

// the row under the pointer, locked ones and the TEAM button (row circuitCount) included,
// or -1: on the name itself, .45 of its size each way
const menuRowAt = () =>
{
    for (let c = 0; c <= circuitCount; ++c)
        if (abs(mouseY - menuRowY(c)) < menuRowSize(c)*.45 && mouseX > (enhancedMode && getAspect() < 1 && c == circuitCount ? -menuRowW[c] : menuRowX()*2-1) && mouseX < menuRowW[c]) // the portrait menu's TEAM is centred: its left edge mirrors its right
            return c;
    return -1;
};

// the logo: SP13KTRA in three pieces around the measured width of 13K, SP right-aligned
// to its left edge, TRA left-aligned to its right, and the 13K itself the ONLY rainbow
// text in the game: white light split across those three glyphs by a gradient that
// slides with time, spanning one logo size either side of x, about the width of 13K.
// x, y are canvas fractions, s a fraction of the height (the title, and the menu's corner)
function drawLogo(x, y, s)
{
    const ctx = mainContext, W = mainCanvasSize.x, px = s*mainCanvasSize.y;
    const g = ctx.createLinearGradient(x*W-px, 0, x*W+px, 0);
    for(let i=9; i--;)
        g.addColorStop(i/8, hsl(i/8-time*.3, 1, .6));
    drawHUDText('13K', x,y + Math.sin(time)*s*.05, s/.9, g);
    const w = ctx.measureText('13K').width/2/W; // the font is still set from that call
    drawHUDText('SP', x-w,y, s, WHITE, 'right');
    drawHUDText('TRA', x+w,y, s, WHITE, 'left');
}

// every placing in the game (the race corner, the results card, the menu's BEST) through
// one call, so they read the same: the numeral white and right-aligned at x, its ordinal
// in the band after it at .36 of the size, both on the baseline y (every caller passes 1-8: the 0 guard went in a size cut)
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
    // enhanced only: on a tall window a race's text (the HUD, the countdown, the results card) sizes off the SHORT side, width over
    // height, so a portrait phone gets landscape's proportions; sized off the height it ran off the screen (Frank, 2026-09-14). The
    // title and the menu keep the height (their hit boxes use menuRowSize). A statement under a folded const: gone from the 13k build
    if (enhancedMode && !titleScreenMode)
        size *= min(1, getAspect());
    size *= mainCanvasSize.y; px *= mainCanvasSize.x; py *= mainCanvasSize.y; // (x, y as two fractions: a vec3 per call cost more)
    const context = mainContext;
    context.font = `900 ${size}px arial,sans-serif`;
    context.textAlign = align;
    context.textBaseline = baseline;
    context.fillStyle = shadow || rgb(0,0,0,color.a); // (a falsy shadow is the black default)
    context.fillText(text, px+size*.04, py+size*.04);
    context.fillStyle = color;
    context.fillText(text, px, py);
}

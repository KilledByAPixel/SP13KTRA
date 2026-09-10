'use strict';

let showMap = 1;
let mapPts;

function drawMap()
{
    // minimap from the world map (trackGen): the true closed circuit shape
    if (!showMap || !trackMapPts)
        return;
    const c = mainCanvas, ctx = mainContext;
    // fit the loop to a 130px box; world +z is up on the map (500 points a frame is cheap)
    const s = 65/trackMapRadius, o = trackMapCenter;
    mapPts = trackMapPts.map(([x,z]) => [(x-o.x)*s, (o.z-z)*s]);

    const cx = c.width-100, cy = c.height-100;
    ctx.beginPath();
    for(const p of mapPts)
        ctx.lineTo(cx+p[0], cy+p[1]);
    ctx.closePath();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();

    // crafts (player is the big red dot)
    for(const v of vehicles)
    {
        const scale=65/trackMapRadius, p=[(v.pos.x-trackMapCenter.x)*scale,(trackMapCenter.z-v.pos.z)*scale];
        ctx.fillStyle = v == playerVehicle ? '#f00' : v.color;
        ctx.beginPath();
        ctx.arc(cx+p[0], cy+p[1], v == playerVehicle ? 4.5 : 3, 0, 9);
        ctx.fill();
    }
}

// the HUD is one type system: uppercase, tracked, weight 900 sans, white, with the
// circuit band as the only accent and thin rules instead of boxes (spec: Swiss, not
// chatty)
function drawHUD()
{
    if (freeCamMode)
        return;

    drawMap();
    const band = levelInfo.lineColor;

    if (enhancedMode && paused)
        drawHUDText('PAUSE', vec3(.5,.9), .08);

    if (titleScreenMode)
    {
        // the logo: SP13KTRA in three pieces around the measured width of 13K - SP
        // right-aligned to its left edge, TRA left-aligned to its right, and the 13K
        // itself the ONLY rainbow text in the game (Color Law): white light split
        // across those three glyphs by a gradient that slides with time. the gradient
        // spans one logo size either side of centre, about the width of 13K
        const ctx = mainContext, W = mainCanvasSize.x, y = .28;
        const s = enhancedMode && getAspect() < .6 ? getAspect()/5 : 1/9, px = s*mainCanvasSize.y;
        const g = ctx.createLinearGradient(W/2-px, 0, W/2+px, 0);
        for(let i=4; i--;)
            g.addColorStop(i/3, hsl(i/3-time*.3, 1, .6));
        drawHUDText('13K', vec3(.5,y), s, g);
        const w = ctx.measureText('13K').width/2/W; // the font is still set from that call
        drawHUDText('SP', vec3(.5-w,y), s, WHITE, 'right');
        drawHUDText('TRA', vec3(.5+w,y), s, WHITE, 'left');

        // the circuit select, big and at the bottom; no key legend (Frank, 2026-09-09)
        drawHUDText('< '+(currentCircuit+1)+' '+levelInfo.name+' >', vec3(.5,.86), .075, band);

        if (!enhancedMode || time > 5)
        {
            if (bestTime && (!enhancedMode || time%20<10))
                drawHUDText((js13kBuildLevel2?'':'BEST TIME ')+formatTimeString(bestTime), vec3(.5,.96), .035);
        }
    }
    else
    {
        if (startCountdownTimer.active() || startCountdown)
        {
            // count down over the full HUD: the numbers white, GO in the band, each fading over its second
            const c = startCountdown ? WHITE : band;
            drawHUDText(startCountdown || 'GO', vec3(.5,.45), .3, rgb(c.r, c.g, c.b, 1-time%1));
        }
        const placeSuffix = p => ['ST','ND','RD'][p-1]||'TH';
        if (gameOverTimer.isSet())
        {
            // results card: one giant placement numeral, Swiss (spec: Grand Prix, not chatty)
            const podium = racePlace && racePlace <= 3;
            const gpComplete = podium && currentCircuit == circuitCount-1;
            drawHUDText(racePlace, vec3(.5,.42), .36);
            drawHUDText(placeSuffix(racePlace), vec3(.6,.22), .07, band, 'left');
            drawHUDText('TIME  '+formatTimeString(raceTime), vec3(.5,.56), .045);
            drawHUDText(gpComplete ? 'GRAND PRIX COMPLETE' : podium ? levelInfoList[(currentCircuit+1)%circuitCount].name+' NEXT' : 'AGAIN',
                vec3(.5,.74), .045, gpComplete ? band : WHITE);
        }
        else
        {
            // position, bottom left: the numeral white, its ordinal in the band. it used
            // to sit top centre, which is where the sun is when you drive straight at it
            drawHUDText(playerPlace, vec3(.085,.95), .14, WHITE, 'right');
            drawHUDText(placeSuffix(playerPlace), vec3(.087,.95), .05, band, 'left');

            // energy: a thin rule in the band with a white tip, over the position.
            // flashes white when low or while sputtering; white outright on the bright
            // circuit, where the band is ink (lightness .2) and would vanish into the backing
            const ctx = mainContext, W = mainCanvasSize.x, H = mainCanvasSize.y;
            const bw = W*.22, bh = H*.007, bx = W*.02, by = H*.8, e = bw*playerEnergy/100;
            ctx.fillStyle = '#0006';
            ctx.fillRect(bx-2, by-2, bw+4, bh+4);
            ctx.fillStyle = playerDeadTime>time || playerEnergy<25 && time%.5<.25 || levelInfo.trailAlpha<1 ? WHITE : band;
            ctx.fillRect(bx, by, e, bh);
            ctx.fillStyle = WHITE;
            ctx.fillRect(bx+e-2, by-3, 4, bh+6);

        }
        if (!playerWin)
        {
            // time top left; lap and circuit top right (the results card owns the time once the race is won)
            drawHUDText(formatTimeString(raceTime), vec3(.02,.075), .045, WHITE, 'left');
            drawHUDText('LAP '+min(playerLap+1,raceLaps)+'/'+raceLaps, vec3(.98,.075), .045, WHITE, 'right');
            drawHUDText(levelInfo.name, vec3(.98,.115), .028, band, 'right');
        }
    }

    if (debugInfo && !titleScreenMode) // mph
        drawHUDText((playerVehicle.speed/60|0)+' SPEED', vec3(.02,.14), .05, WHITE, 'left');
}

///////////////////////////////////////////////////////////////////////////////

// one type system for every HUD string. size is a fraction of the canvas height,
// pos a fraction of the canvas. a black rim under the fill keeps it legible on
// ALBEDO's white sky and vanishes against the void; the rim carries the fill's alpha
// (the countdown fades). color may be a canvas gradient (the logo's 13K)
function drawHUDText(text, pos, size=.05, color=WHITE, align='center')
{
    size *= mainCanvasSize.y;
    pos = pos.multiply(mainCanvasSize);
    const context = mainContext;
    context.font = `900 ${size}px 'Arial Black',Impact,sans-serif`;
    context.textAlign = align;
    context.lineJoin = 'round';
    context.lineWidth = size*.05+1; // a pixel plus 2.5% of the size outside the glyph
    context.strokeStyle = rgb(0,0,0,color.a);
    context.strokeText(text, pos.x, pos.y);
    context.fillStyle = color;
    context.fillText(text, pos.x, pos.y);
}

'use strict';

///////////////////////////////////////////////////////////////////////////////
// help.js - how to play: in-race tips until the first finish, and the menu's HELP card (Frank, 2026-09-15)
//
// Dev page and enhanced build only: the 13k build never includes this file, and every call into it is behind enhancedMode.
// The wording follows the device in use now (helpDevice): the touch pad, a gamepad, the mouse, else the keyboard.
// TIPS: one line at a time over the race HUD, each shown once per race for 4 s, while no circuit has been finished
// (bestPlaces all 0); a death retry shows them again, the first finish turns them off. Triggers, in priority order: the
// countdown (the controls), 8 s in (the turbo), the first wall hit, energy under 60, the first pad, the first rough shoulder
// (the shoulder rattle's distance counter, bumpDistance, only changes on one) and 25 s in (lift to turn tighter).
// HELP: a word beside TEAM on the menu (the wide menu has no room under TEAM, which sits at the bottom), opened by a click or
// tap on it, H or the gamepad's Y; the card lists the rules and the controls, and any key, click, tap or button closes it.
// hud.js draws them (drawHelpButton, drawHelpCard, drawHelpTips) and game.js gives the open card the menu's input (helpMenu)

const helpNames = {keys: 'KEYBOARD', mouse: 'MOUSE', pad: 'GAMEPAD', touch: 'TOUCH'};
const helpTexts = { // per device: the countdown tip, the turbo tip, the card's controls line
    keys: ['UP GAS · ARROWS STEER · SPACE BRAKE', 'SHIFT: TURBO · IT USES ENERGY', 'UP/W GAS · ARROWS/A D STEER · SPACE BRAKE · SHIFT TURBO · ESC MENU · M MUSIC'],
    mouse: ['LEFT BUTTON GAS · POINT TO STEER · MIDDLE BRAKE', 'RIGHT BUTTON: TURBO · IT USES ENERGY', 'POINT TO STEER · LEFT GAS · RIGHT TURBO · MIDDLE BRAKE'],
    pad: ['A GAS · STICK STEERS · B BRAKE', 'RB: TURBO · IT USES ENERGY', 'STICK STEERS · A/RT GAS · B/LT BRAKE · RB TURBO'],
    touch: ['GAS BOTTOM RIGHT · LEFT THUMB STEERS', 'TURBO BUTTON · IT USES ENERGY', 'LEFT THUMB STEERS · GAS · BRAKE · TURBO'],
};
const helpRules = ['RACE 3 LAPS · FINISH TO UNLOCK THE NEXT TRACK', "WALLS AND CRASHES COST ENERGY · AT ZERO YOU'RE OUT",
    'TURBO USES ENERGY · THE RAINBOW STRIP REFILLS IT', 'YELLOW PADS BOOST YOU · ROUGH EDGES SLOW YOU', 'LET GO OF THE GAS TO TURN TIGHTER'];

const helpCard = 0; // the HELP card is DISABLED for now (Frank, 2026-09-15: too busy, too much text); the in-race tips stay, and so does this code
let helpOpen = 0, helpBox = 0; // the card is showing; the HELP word's hit box {x0, x1 in mouseX units, y, s} as last drawn
let helpRace, helpShown = {}, helpTip = 0, helpTipTime = 0, helpBump = 0; // the race the tips belong to, the tips shown in it, the one showing

const helpDevice = () => touchHud() ? 'touch' : isUsingGamepad ? 'pad' : mouseMode ? 'mouse' : 'keys';

// drawHUDText, shrunk to fit 92% of the width: a long line ran off a phone screen
function drawHelpText(text, x, y, size, color, align = 'center')
{
    const k = titleScreenMode ? 1 : min(1, getAspect()); // drawHUDText's own race scaling
    mainContext.font = `${size*k*mainCanvasSize.y}px "Archivo Black",arial,sans-serif`;
    const w = mainContext.measureText(text).width/mainCanvasSize.x;
    drawHUDText(text, x, y, w > .92 ? size*.92/w : size, color, align);
}

// the menu's input while HELP is involved: true on a frame the card takes (open, or opening or closing it now), so the menu ignores that frame
function helpMenu()
{
    if (!helpCard) return 0; // disabled: no H, no Y, no HELP word (hud.js no longer draws it)
    if (helpOpen)
    {
        if (mousePressed || Object.values(inputData).some(v => v & 2) || gamepadData[0]?.some(v => v & 2))
            helpOpen = 0;
        return 1;
    }
    if (keyWasPressed('KeyH') || isUsingGamepad && gamepadWasPressed(3) || mousePressed && helpAt())
    {
        helpOpen = 1;
        sound_checkpoint.play(.5);
        return 1;
    }
    return 0;
}

// the pointer is on the HELP word
const helpAt = () => helpBox && abs(mouseY - helpBox.y) < helpBox.s*.45 && mouseX > helpBox.x0 && mouseX < helpBox.x1;

// the HELP word: beside TEAM on the wide menu, at the right end of TEAM's row on a tall one; white, its shadow in the craft's colour under the pointer
function drawHelpButton()
{
    const tall = getAspect() < 1, y = menuRowY(circuitCount), s = menuRowSize(circuitCount)*(tall ? .4 : .5);
    const x = tall ? .95 : (menuRowW[circuitCount]+1)/2 + .05/getAspect(); // wide: TEAM's measured right edge plus a gap
    drawHUDText('HELP', x, y, s, WHITE, tall ? 'right' : 'left', 'middle', helpAt() ? playerVehicle.color : 0);
    const w = mainContext.measureText('HELP').width/mainCanvasSize.x;
    helpBox = {x0: (tall ? x-w : x)*2-1, x1: (tall ? x : x+w)*2-1, y, s};
}

// the card over the menu: the rules, then the controls for the device in use and the others smaller
function drawHelpCard()
{
    const d = helpDevice(), band = bandColor();
    mainContext.fillStyle = '#000d';
    mainContext.fillRect(0, 0, mainCanvasSize.x, mainCanvasSize.y);
    drawHelpText('HOW TO PLAY', .5, .13, .08, band);
    helpRules.forEach((line, i) => drawHelpText(line, .5, .24 + i*.065, .036, WHITE));
    drawHelpText('CONTROLS', .5, .6, .05, band);
    drawHelpText(helpTexts[d][2], .5, .68, .036, WHITE);
    Object.keys(helpTexts).filter(k => k != d).forEach((k, i) => drawHelpText(helpNames[k] + ': ' + helpTexts[k][2], .5, .76 + i*.05, .024, hsl(0, 0, .65)));
    drawHelpText(d == 'touch' ? 'TAP TO CLOSE' : d == 'pad' ? 'ANY BUTTON TO CLOSE' : 'ANY KEY OR CLICK TO CLOSE', .5, .95, .028, band);
}

// the in-race tips (called while racing, not on the results card)
function drawHelpTips()
{
    if (/[1-8]/.test(bestPlaces)) return helpTip = 0; // a finish anywhere turns the tips off (and forgets the one that was showing)
    if (helpRace != vehicles) helpRace = vehicles, helpShown = {}, helpTip = 0; // a new race (gameStart builds a new field)
    const v = playerVehicle, d = helpDevice(), rough = bumpDistance != helpBump;
    helpBump = bumpDistance;
    if (helpTip && time - helpTipTime > 4)
        helpTip = 0;
    if (!helpTip)
    {
        const due = [
            ['controls', startCountdown || raceTime < 3, helpTexts[d][0]],
            ['turbo', raceTime > 8, helpTexts[d][1]],
            ['wall', v.wallTime > 0, "WALLS COST ENERGY · AT ZERO YOU'RE OUT"],
            ['energy', v.energy < 60, 'THE RAINBOW STRIP REFILLS ENERGY'],
            ['pad', v.padTime > 0, 'YELLOW PADS BOOST YOU'],
            ['rough', rough, 'ROUGH EDGES SLOW YOU DOWN'],
            ['corner', raceTime > 25, 'LET GO OF THE GAS TO TURN TIGHTER'],
        ].find(([key, when]) => when && !helpShown[key]);
        if (due)
            helpShown[due[0]] = 1, helpTip = due[2], helpTipTime = time;
    }
    if (helpTip)
    {
        const t = time - helpTipTime; // in over .3 s, out over the last .5 s
        drawHelpText(helpTip, .5, .22, .045, rgb(1, 1, 1, clamp(min(t/.3, (4-t)/.5))));
    }
}

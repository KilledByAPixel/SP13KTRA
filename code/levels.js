'use strict';

let levelInfoList;

// the spectrum ladder: [name, hue, sat, ground, laneCount, drop, bump, rainbow, theme, density, sky]
// ground: a plane exists; drop: how far the lowest road sits above it; bump: periodic
// swell amplitude added to the keyframed heights (keep it small on crossing circuits);
// theme picks the circuit's scenery shape (track.js shapes: 0 spike, 1 city block, 2 crystal,
// 3 ziggurat, 4 floating slab, 5 spire, 6 leaning shard, 7 monolith); a quarter of the pieces
// speak the (theme+3)%8 language in the same palette. density scales mid-field groups.
// sky bits (track.js kit): 1 big low sun (else small and high), 2 stars, 4 clouds, 8 eclipse.
// bank, rival skill and pad spacing climb the ladder by formula (LevelInfo)
const circuitTable = [
    ['REDSHIFT',    0,   .9, 1, 4, 1200, 300, 0, 1, 1.2, 5],
    ['FILAMENT',    .06, .9, 1, 4, 2500, 500, 0, 2, .8, 3],
    ['SODIUM',      .13, .9, 1, 3,  800, 600, 0, 0, 1.4, 5],
    ['AURORA',      .35, .8, 1, 3, 1000, 700, 0, 3, 1, 2],
    ['CHERENKOV',   .5,  .9, 1, 3, 1500, 500, 0, 4, .9, 2],
    ['RAYLEIGH',    .6,  .9, 1, 3, 2000, 250, 0, 5, 1.5, 4],
    ['ULTRAVIOLET', .78, .8, 1, 3,  900, 600, 0, 6, 1, 3],
    ['UMBRA',       .72, .15,0, 2,  800, 800, 0, 2, .6, 10],
    ['ALBEDO',      0,   0,  1, 3, 1800, 500, 0, 7, 1, 4],
    ['SP13KTRA',    0,   1,  1, 3, 2200, 250, 1, 1, 1.3, 7],
];

// circuit skeletons: [x, z, radius, height, flags] per corner, x/z/radius in kilo-units,
// height in hundreds (skeleton.js). Edge 0 (corner 0 -> 1) is the start straight and is rotated
// to +z. Each shape is a different polygon family so no two minimaps look alike.
const circuitCorners = [
    // REDSHIFT: wide oval, two long straights, two 180s, mild bank
    [[0,0,45,0],[0,200,45,3],[90,200,45,7],[90,0,45,3]],
    // FILAMENT: kidney, a corridor start straight into a tightening double apex
    [[0,0,32,0,SK_TUNNEL],[0,184,28,6],[56,208,24,12],[104,160,14,9],[88,96,14,5],[112,48,20,3],[64,-16,24,1]],
    // SODIUM: triangle with a waving flank through the forest
    [[0,0,30,0],[0,190,30,6],[160,95,30,12,SK_WAVE]],
    // AURORA: broad S-course, two waving edges, open bank
    [[0,0,40,0],[0,160,30,4,SK_WAVE],[70,220,40,9],[150,190,45,13,SK_WAVE],[150,60,30,6],[80,-10,35,2]],
    // CHERENKOV: a fully banked bowl around the shard, a chicane opposite
    [[0,0,30,0],[0,170,50,8,SK_BANKED],[100,170,50,8,SK_BANKED],[100,0,30,0,SK_CHICANE]],
    // RAYLEIGH: figure eight, a corridor under the second crossing straight elevated 4,000
    [[-15,-15,22,0,SK_TUNNEL],[85,85,22,0],[135,35,22,10],[85,-15,22,40,SK_CROSS],[-15,85,22,40],[-65,35,22,10]],
    // ULTRAVIOLET: angular, three medium corners and one hairpin, narrowing into it
    [[0,0,25,0],[0,160,30,5],[100,200,30,11],[160,140,10,14],[70,120,30,7]],
    // UMBRA: long and narrow, two hairpins joined by waving straights, no ground
    [[0,0,15,0,SK_WAVE],[0,220,12,9],[50,220,12,9,SK_WAVE],[50,0,15,0]],
    // ALBEDO: fast oval with a bright banked bowl and a chicane
    [[0,0,40,0],[0,180,55,6,SK_BANKED],[110,180,55,6,SK_BANKED],[110,0,40,0,SK_CHICANE]],
    // SP13KTRA: everything once - straight, bowl, hairpin, elevated crossing, chicane, wave
    [[0,0,30,0],[0,150,45,0,SK_BANKED],[90,150,45,10,SK_BANKED],[100,40,10,40,SK_CROSS],[-30,70,20,40,SK_CHICANE],[-60,-20,25,15,SK_WAVE|SK_TUNNEL]],
];

// the landmark: [lap fraction, side, distance beyond the wall] - one per circuit
const circuitLandmark = [[.5,1,9000],[.43,-1,7000],[.6,1,8000],[.5,1,9000],[.25,1,6000],[.17,-1,9000],[.6,1,6000],[.25,1,7000],[.25,1,9000],[.5,1,8000]];

class LevelInfo
{
    constructor(level, d)
    {
        // straight into the fields (property names can't be mangled, so name each once)
        let hue, sat;
        [this.name, hue, sat, this.ground, this.laneCount, this.drop, this.bump, this.rainbow, this.theme, this.density, this.sky] = d;
        // the ladder: more bank, faster rivals and sparser pads up the campaign
        this.bankAmp = .5+level*.08; this.rivalSkill = .84+level*.018; this.padWait = .7+level*.1;
        this.hue = hue;

        // near-monochrome palette derived from the band (spec: The Look)
        const bright = level == 8; // ALBEDO is blinding
        // three sky colours: the band overhead, a hue turn in between, a warmer bright horizon
        this.skyColorTop    = hsl(hue, sat*.7, bright?.75:.08);
        this.skyColorMid    = hsl(hue-.06, sat, bright?.85:.22*!this.rainbow); // black on the finale: its spectrum fades into it
        this.skyColorBottom = hsl(hue+.04, sat*.85, bright?.95:.45);
        this.roadColor      = hsl(hue, sat*.3, bright?.7:.09);
        this.lineColor      = hsl(hue, sat, bright?.2:.6);
        this.edgeColor      = hsl(hue, sat, .65, .9);
        this.groundColor    = hsl(hue, sat*.4, bright?.85:.14);
        this.sunColor       = hsl(hue+.05, sat, bright?.9:.65);
        // the void kit: the band at full saturation, pushed to the value the sky is
        // not, so structures read against the bright horizon band as well as against
        // the black void. value carries the separation, hue keeps it in the band
        this.archColor      = hsl(hue, sat, bright?.2:.88);
        // the pop: the band's complement, saturated even on the grey circuits, for lamps,
        // corridors, the landmark and a third of the scenery districts
        this.accentColor    = hsl(hue+.5, max(sat,.6), bright?.35:.6);
        // the glow pass assumes a dark ground: additive trails over a .7 lightness
        // road clip straight to white and swallow the craft flying inside them
        this.trailAlpha     = bright?.35:1;
    }
}

function initLevelInfos()
{
    levelInfoList = circuitTable.map((d,i)=> new LevelInfo(i,d));
}

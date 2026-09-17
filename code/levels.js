'use strict';

////////////////////////////////////////////////////////////////////////////////
// levels.js: the circuit table
//
// Owns: the eight campaign circuits as data, one per racer. circuitTable is the spectrum
// ladder (palette, ground drop, swell, scenery theme, density, sky kit, scenery bits),
// circuitCorners the corner polygons the skeleton builds each loop from. LevelInfo turns
// one table row into the colours and ladder values the rest of the game reads.
//
// Entry point: initLevelInfos() (game.js, at startup) fills levelInfoList, and
// game.js picks levelInfo = levelInfoList[currentCircuit] before buildTrack.
// trackGen.js reads circuitCorners; track.js reads the palette; hud.js reads the
// names for the menu list and the results.
// Load order: skeleton.js must come first because the corner data reads the
// SK_* flags at load.
////////////////////////////////////////////////////////////////////////////////

let levelInfoList;

////////////////////////////////////////////////////////////////////////////////
// The spectrum ladder, one row per circuit:
//   [name, hue, sat, drop, bump, theme, density, sky, scenery]
// drop: how far the lowest road sits above the ground plane (every circuit has one)
// bump: periodic swell amplitude added to the keyframed heights (keep it small on
//   crossing circuits)
// theme: the circuit's scenery shape (buildScenery in track.js): 0 spike, 1 city block,
//   2 crystal, 3 ziggurat, 4 floating slab, 5 spire, 6 crystal again, 7 monolith; a quarter
//   of the pieces speak the (theme+3)%8 language in the same palette
// density: scales the mid-field groups
// sky bits (the track.js kit):
//   1 big low sun (else small and high), 2 stars, 4 clouds, 8 eclipse (also the negative
//   light and the black accent buildings), 16 a giant sun, 32 a two-colour sun (the accent
//   on its halo and outer disc)
// scenery bits (buildScenery, trackGen.js):
//   2 colossal far giants, twice the size
//   4 sparse roadside cues, every 24 samples
//   8 a second recharge strip on the left, halfway round
//   32 a canyon: a plinth of .55-1.25 of the drop under every piece, so the towers climb
//     from the deep ground to about road level
//   64 lifts that range by .4 to .95-1.65, so more of them peak above the road
//   128 a dense infield, the spacing between pieces halved
// bank, rival skill, pad spacing, strip width, lane count and the finale's rainbow climb
// the ladder by formula of the circuit index (LevelInfo)
const circuitTable = [
    ['REDSHIFT',    0,   .9, 1200, 300, 1, 1.2, 5, 0],
    ['FILAMENT',    .06, .9, 2500, 500, 2, .8, 35, 2],
    ['SODIUM',      .13, .9,  800, 600, 0, 1.4, 21, 0],
    // a canyon: the road 24,000 over the ground, the towers on plinths
    ['AURORA',      .35, .8, 24000, 700, 3, 1, 2, 36],
    // a dense infield of floating slabs
    ['CHERENKOV',   .6,  .9, 1500, 500, 4, .9, 2, 138],
    // the figure eight
    ['ULTRAVIOLET', .78, .9, 2000, 250, 5, 1.5, 4, 8],
    // monoliths, grey with a red tinge in the sky (ominous), a canyon like AURORA with
    // taller towers, colossal giants and clouds
    ['UMBRA',       .98, .12, 24000, 800, 7, .6, 14, 110],
    ['SP13KTRA',    0,   1, 2200, 250, 1, 1.3, 7, 8],
];

////////////////////////////////////////////////////////////////////////////////
// Circuit skeletons: [x, z, radius, height, flags] per corner, x/z/radius in kilo-units,
// height in hundreds (skeleton.js). Edge 0 (corner 0 -> 1) is the start straight and is
// rotated to +z. Flags: SK_WAVE/SK_CHICANE bend the edge leaving the corner, SK_CROSS marks
// an elevated deck over another edge, SK_BANKED banks the corner's own arc fully, and SK_ARCH
// runs arches over the edge, half again as big and further apart with SK_BIG, one every 12
// samples with SK_DENSE so it reads as a tunnel.
// Each shape is a different polygon family so no two minimaps look alike.
// The enhanced build mirrors two of them in x before the skeleton is built (trackGen.js).
const circuitCorners = [
    // REDSHIFT: wide oval, two long straights, two 180s, mild bank
    [[0,0,45,0],[0,200,45,3],[90,200,45,7],[90,0,45,3]],
    // FILAMENT: kidney, a low tunnel of dense arches down the start straight into a
    // tightening double apex
    [[0,0,32,0,SK_ARCH|SK_DENSE],[0,184,28,6],[56,208,24,12],[104,160,14,9],[88,96,14,5],[112,48,20,3],[64,-16,24,1]],
    // SODIUM: triangle with a waving flank through the forest, under a run of arches
    [[0,0,30,0],[0,190,30,6],[160,95,30,12,SK_WAVE|SK_ARCH]],
    // AURORA: broad S-course, two waving edges, open bank, a few big open gates over the
    // canyon on the run into the last corner
    [[0,0,40,0],[0,160,30,4,SK_WAVE],[70,220,40,9],[150,190,45,13,SK_WAVE],[150,60,30,6,SK_ARCH|SK_BIG],[80,-10,35,2]],
    // CHERENKOV: a fully banked bowl around the shard, a chicane opposite
    [[0,0,30,0],[0,170,50,8,SK_BANKED],[100,170,50,8,SK_BANKED],[100,0,30,0,SK_CHICANE]],
    // ULTRAVIOLET: figure eight, the second crossing straight elevated 4,000
    [[-15,-15,22,0],[85,85,22,0],[135,35,22,10],[85,-15,22,40,SK_CROSS],[-15,85,22,40],[-65,35,22,10]],
    // UMBRA: long and narrow, two hairpins joined by waving straights (80 wide: 50 reads
    // too thin, 100 by 190 too square)
    [[0,0,15,0,SK_WAVE],[0,220,12,9],[80,220,12,9,SK_WAVE],[80,0,15,0]],
    // SP13KTRA: everything once - straight, bowl, hairpin, elevated crossing, chicane, wave.
    // The big dense tunnel is on the run from the bowl to the hairpin: the waving last edge
    // has only a few samples between its fillets
    [[0,0,30,0],[0,150,45,0,SK_BANKED],[90,150,45,10,SK_BANKED|SK_ARCH|SK_BIG|SK_DENSE],[100,40,10,40,SK_CROSS],[-30,70,20,40,SK_CHICANE],[-60,-20,25,15,SK_WAVE]],
];

////////////////////////////////////////////////////////////////////////////////
// LevelInfo: one circuit's ladder values and palette, built from its table row.
class LevelInfo
{
    constructor(level, d)
    {
        // Destructure the row straight into the fields so each property name is
        // spelled once. Property names are not mangled by themselves: a new field
        // here must also go on MANGLE_PROPS in build.js or it ships unmangled.
        let hue, sat;
        [this.name, hue, sat, this.drop, this.bump, this.theme, this.density, this.sky, this.scenery] = d;

        // The ladder: the finale, the last circuit, is the rainbow one (spectrum sky and rings);
        // four lanes on the first two circuits, three after; more bank, faster rivals and sparser
        // pads up the campaign.
        this.rainbow = level>6; // circuitCount-1 (game.js, which loads later)
        this.laneCount = 3+(level<2);
        this.bankAmp = .5+level*.08;       // bank = bankAmp*turn, clamped to +-.5 (trackGen.js)
        this.rivalSkill = 1.09+level*.011; // AI pace scale (vehicle.js)
        this.padWait = .7+level*.1;        // scales the gap between pad pairs (trackGen.js)
        // the recharge strip: five lanes wide on REDSHIFT, narrowing to two by ULTRAVIOLET,
        // so the first charges come easy
        this.stripWidth = 3500-min(2100,level*420);

        ////////////////////////////////////////////////////////////////////////
        // Near-monochrome palette derived from the band (DESIGN.md: The Look).
        // Three sky colours: the band overhead, a hue turn in between, a warmer bright horizon.
        this.skyColorTop    = hsl(hue, sat*.7, .08);
        this.skyColorMid    = hsl(hue-.06, sat, .22*!this.rainbow); // black on the finale: its spectrum fades out
        this.skyColorBottom = hsl(hue+.04, sat*.85, .45); // also the fog colour
        this.roadColor      = hsl(hue, sat*.3, .09);
        this.lineColor      = hsl(hue, sat, this.rainbow?1:.6); // white on the finale: red clashes with the rainbow
        this.edgeColor      = hsl(hue, sat, .65, .9);
        this.groundColor    = hsl(hue, sat*.4, .14);
        this.sunColor       = hsl(hue+.05, sat, .65);
        // The kit colour: the band at full saturation, pushed to the value the sky is
        // not, so structures read against the bright horizon band as well as against
        // the black void. Value carries the separation; hue keeps it in the band.
        this.archColor      = hsl(hue, sat, .88);
        // The pop: the band's complement, saturated even on the grey circuits, for lamps,
        // the arches and a third of the scenery districts.
        this.accentColor    = hsl(hue+.5, max(sat,.6), .6);
        // The glow pass assumes a dark ground: additive trails over a .7 lightness
        // road clip straight to white and swallow the craft flying inside them.
    }
}

function initLevelInfos()
{
    levelInfoList = circuitTable.map((d,i)=> new LevelInfo(i,d));
}

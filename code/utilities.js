'use strict';

///////////////////////////////////////////////////////////////////////////////
// utilities.js - the small shared toolkit every other file leans on
//
// Owns: scalar math helpers, Vector3, Color, the seeded Random generator and the
// closed-loop index wrapper. Nothing here touches the game state except wrapSegment
// (reads lapTrackSegments from game.js). (The Timer class went on 2026-09-13: the
// countdown reads the clock gameStart zeroes and the results keep gameOverTime, game.js.)
//
// Loads second, right after debug.js (or the release flags file), so ASSERT and
// `debug` exist here but nothing else does yet: keep this file free of game
// globals at load time. Every later file calls in: vec3/rgb/hsl everywhere,
// clampAngle in the steering and camera, Random in trackGen/track, formatTimeString
// in the HUD.
//
// Terser (toplevel: true) drops top-level helpers nothing references, so the
// unused ones below cost nothing in the ZIP. It does NOT drop unused class
// methods: every method on Vector3/Color/Random must earn its place (copy and mul went
// on 2026-09-13; the dev build patches copy back on for the tests and the free cam).

///////////////////////////////////////////////////////////////////////////////
// Math Stuff

const PI = Math.PI;
const abs = (value) => Math.abs(value);
const min = (valueA, valueB) => Math.min(valueA, valueB);
const max = (valueA, valueB) => Math.max(valueA, valueB);
const sign = (value) => value < 0 ? -1 : 1; // sign(0) is 1, unlike Math.sign
const mod = (dividend, divisor) => ((dividend % divisor) + divisor) % divisor; // always non-negative
const clamp = (value, min=0, max=1) => value < min ? min : value > max ? max : value;
const clampAngle = (value) => ((value+PI) % (2*PI) + 2*PI) % (2*PI) - PI; // wrap to -PI..PI
const percent = (value, valueA, valueB) => (valueB-=valueA) ? clamp((value-valueA)/valueB) : 0; // 0..1 of value between A and B; 0 for an empty range
const lerp = (percent, valueA, valueB) => valueA + clamp(percent) * (valueB-valueA); // percent FIRST, and clamped
const rand = (valueA=1, valueB=0) => lerp(Math.random(), valueA, valueB); // unseeded: never use for world generation
const randInt = (valueA, valueB=0) => rand(valueA, valueB)|0;
const smoothStep = (p) => p * p * (3 - 2 * p);

// translate, then rotate (radians, applied x/y/z), then scale: the object matrix
// every Mesh.render / Mesh.combine call builds. Any argument may be 0/undefined
function buildMatrix(pos, rot, scale)
{
    const R2D = 180/PI; // DOMMatrix rotates in degrees
    let m = new DOMMatrix;
    pos && m.translateSelf(pos.x, pos.y, pos.z);
    rot && m.rotateSelf(rot.x*R2D, rot.y*R2D, rot.z*R2D);
    scale && m.scaleSelf(scale.x, scale.y, scale.z);
    return m;
}


// race clock for the HUD and results, m:ss.mmm
function formatTimeString(t)
{
    return `${t/60|0}:${String(t%60|0).padStart(2,0)}.${String(t%1*1e3|0).padStart(3,0)}`;
}

// smooth value noise in -1..1: a fresh Random per integer lattice point, eased between
function noise1D(x)
{
    const hash = x=>(new Random(x)).float(-1,1);
    return lerp(smoothStep(mod(x,1)), hash(x), hash(x+1));
}

///////////////////////////////////////////////////////////////////////////////
// Vector3
//
// World vectors: +Y up, initial forward +Z. Every operation returns a NEW
// vector except addSelf; lerp uses addSelf on its own temporary, so it is safe
// too. Methods that take a vector assert its type in the dev build.

const vec3 = (x, y, z)=> y == undefined ? new Vector3(x, x, x) : new Vector3(x, y, z); // vec3(s) = (s,s,s); vec3(x,y) = (x,y,0); vec3() = (0,0,0)
const isVector3 = (v) => v instanceof Vector3;
const isNumber = (value) => typeof value === 'number';
const ASSERT_VEC3 = (v) => ASSERT(isVector3(v));

class Vector3
{
    constructor(x=0, y=0, z=0)
    {
        // gated: terser inlines the empty release ASSERT but keeps its argument (three
        // calls it cannot prove pure); `debug &&` folds the whole statement away
        debug && ASSERT(isNumber(x) && isNumber(y) && isNumber(z));
        this.x=x; this.y=y; this.z=z;
    }
    add(v) { ASSERT_VEC3(v); return vec3(this.x + v.x, this.y + v.y, this.z + v.z); }
    addSelf(v) { ASSERT_VEC3(v); this.x += v.x, this.y += v.y, this.z += v.z; return this }
    subtract(v) { ASSERT_VEC3(v); return vec3(this.x - v.x, this.y - v.y, this.z - v.z); }
    scale(s) { ASSERT(isNumber(s)); return vec3(this.x * s, this.y * s, this.z * s); }
    dot(v) { return this.x*v.x+this.y*v.y+this.z*v.z; }
    mag() { return (this.x**2 + this.y**2 + this.z**2)**.5; }
    normalize() { const l = this.mag(); return l ? this.scale(1/l) : vec3(1); } // a zero vector normalizes to (1,1,1), not NaN
    cross(v) { ASSERT_VEC3(v); return vec3(this.y*v.z-this.z*v.y, this.z*v.x-this.x*v.z, this.x*v.y-this.y*v.x); }
    lerp(v, p) { ASSERT_VEC3(v); return v.subtract(this).scale(p).addSelf(this); }
    // no rotateX/rotateY here: the shipped game only turned constant vectors, now written
    // out. the free cam's rotates live in debug.js (debugVectorMethods patches them onto
    // the prototype in the dev build only)
    transform(matrix)
    {
        // full affine transform (translation included): points, not directions.
        // draw.js transforms normals with a rotation-only matrix for that reason
        const p = matrix.transformPoint(this);
        return vec3(p.x, p.y, p.z);
    }
}

///////////////////////////////////////////////////////////////////////////////
// Color
//
// Components are 0..1 floats. rgb() with no arguments is opaque white. Colours
// go to the GPU as vertex RGBA and to the 2D HUD through toString (canvas
// coerces a Color assigned to fillStyle/strokeStyle), so toString is live.

const rgb = (r, g, b, a) => new Color(r, g, b, a);
const hsl = (h, s, l, a) => rgb().setHSLA(h, s, l, a); // hue wraps, so hue-time is a free rainbow
const isColor = (c) => c instanceof Color;

class Color
{
    constructor(r=1, g=1, b=1, a=1)
    {
        this.r = r;
        this.g = g;
        this.b = b;
        this.a = a;
    }

    // a new colour `percent` of the way to c (alpha included)
    lerp(c, percent)
    {
        ASSERT(isColor(c));
        return rgb(
            lerp(percent, this.r, c.r),
            lerp(percent, this.g, c.g),
            lerp(percent, this.b, c.b),
            lerp(percent, this.a, c.a),
        );
    }

    // standard HSL -> RGB, in place, returns this so hsl() can chain it
    setHSLA(h, s, l, a=1)
    {
        h = mod(h,1);
        const q = l < .5 ? l*(1+s) : l+s-l*s, p = 2*l-q,
            f = (p, q, t)=> // one channel: hue offset t, wrapped, on the six-segment ramp
                (t = mod(t,1))*6 < 1 ? p+(q-p)*6*t :
                t*2 < 1 ? q :
                t*3 < 2 ? p+(q-p)*(4-t*6) : p;
        this.r = f(p, q, h + 1/3);
        this.g = f(p, q, h);
        this.b = f(p, q, h - 1/3);
        this.a = a;
        return this;
    }

    // CSS colour for the 2D canvas (hud.js assigns Colors straight to fillStyle)
    toString()
    { return `rgb(${this.r*255},${this.g*255},${this.b*255},${this.a})`; }
}

///////////////////////////////////////////////////////////////////////////////
// Random
//
// Seeded xorshift32. The world is deterministic because trackGen seeds the
// shared `random` (game.js) from trackSeed+circuit and then every generator
// draws from it in a fixed order: the CONSUMPTION ORDER IS THE LAYOUT. Adding
// or removing a draw anywhere upstream moves every piece of scenery after it.

class Random
{
    constructor(seed) { this.setSeed(seed); }
    setSeed(seed)
    {
        this.seed = seed+1|0; // +1 so seed 0 is not the xorshift fixed point (0 never leaves 0)
        this.float();this.float();this.float();// warmup: shake off the low-entropy first states of a small seed
    }
    float(a=1, b=0) // a random float in b..a (a alone: 0..a), like rand()
    {
        // xorshift
        this.seed ^= this.seed << 13;
        this.seed ^= this.seed >>> 17;
        this.seed ^= this.seed << 5;
        return b + (a-b) * Math.abs(this.seed % 1e9) / 1e9; // slightly biased low by float error
    }
    int(a, b)         { return this.float(a, b)|0; }
    sign()            { return this.float() < .5 ? -1 : 1; } // one float() per call: the consumption order is the layout
}

///////////////////////////////////////////////////////////////////////////////
// closed-loop track wrapping
//
// The track is a loop of lapTrackSegments (4,000) samples; every index goes
// through wrapSegment. The starting grid sits at negative s, before the start
// line, so wrapping must handle negatives correctly.

const wrapSegment = (i) => mod(Math.floor(i), lapTrackSegments); // floor, not |0: negative s (the grid) must not alias
// (wrapDeltaZ, the shortest signed route distance between two s values, went on 2026-09-13:
// nothing called it once placing moved to raceDistance. Terser had already dropped it)

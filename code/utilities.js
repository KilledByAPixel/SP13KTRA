'use strict';

///////////////////////////////////////////////////////////////////////////////
// Math Stuff

const PI = Math.PI;
const abs = (value) => Math.abs(value);
const min = (valueA, valueB) => Math.min(valueA, valueB);
const max = (valueA, valueB) => Math.max(valueA, valueB);
const sign = (value) => value < 0 ? -1 : 1;
const mod = (dividend, divisor=1) => ((dividend % divisor) + divisor) % divisor;
const clamp = (value, min=0, max=1) => value < min ? min : value > max ? max : value;
const clampAngle = (value) => ((value+PI) % (2*PI) + 2*PI) % (2*PI) - PI;
const percent = (value, valueA, valueB) => (valueB-=valueA) ? clamp((value-valueA)/valueB) : 0;
const lerp = (percent, valueA, valueB) => valueA + clamp(percent) * (valueB-valueA);
const rand = (valueA=1, valueB=0) => lerp(Math.random(), valueA, valueB);
const randInt = (valueA, valueB=0) => rand(valueA, valueB)|0;
const smoothStep = (p) => p * p * (3 - 2 * p);
const isOverlapping = (posA, sizeA, posB, sizeB=vec3()) =>
    abs(posA.x - posB.x)*2 < sizeA.x + sizeB.x && abs(posA.y - posB.y)*2 < sizeA.y + sizeB.y;
function buildMatrix(pos, rot, scale)
{
    const R2D = 180/PI;
    let m = new DOMMatrix;
    pos && m.translateSelf(pos.x, pos.y, pos.z);
    rot && m.rotateSelf(rot.x*R2D, rot.y*R2D, rot.z*R2D);
    scale && m.scaleSelf(scale.x, scale.y, scale.z);
    return m;
}
function shuffle(array)
{
    for(let currentIndex = array.length; currentIndex;)
    {
        const randomIndex = random.int(currentIndex--);
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }
    return array;
}
function formatTimeString(t)
{
    return `${t/60|0}:${String(t%60|0).padStart(2,0)}.${String(t%1*1e3|0).padStart(3,0)}`; // m:ss.mmm
}

function noise1D(x)
{
    const hash = x=>(new Random(x)).float(-1,1);
    return lerp(smoothStep(mod(x,1)), hash(x), hash(x+1));
}

///////////////////////////////////////////////////////////////////////////////
// Vector3

const vec3 = (x, y, z)=> y == undefined ? new Vector3(x, x, x) : new Vector3(x, y, z); // vec3(s) = (s,s,s); vec3(x,y) = (x,y,0)
const isVector3 = (v) => v instanceof Vector3;
const isNumber = (value) => typeof value === 'number';
const ASSERT_VEC3 = (v) => ASSERT(isVector3(v));

class Vector3
{
    constructor(x=0, y=0, z=0)
    {
        // gated: terser inlines the empty release ASSERT but keeps its argument (three
        // calls it can't prove pure) - `debug &&` folds the whole statement away
        debug && ASSERT(isNumber(x) && isNumber(y) && isNumber(z));
        this.x=x; this.y=y; this.z=z;
    }
    copy() { return vec3(this.x, this.y, this.z); }
    add(v) { ASSERT_VEC3(v); return vec3(this.x + v.x, this.y + v.y, this.z + v.z); }
    addSelf(v) { ASSERT_VEC3(v); this.x += v.x, this.y += v.y, this.z += v.z; return this }
    subtract(v) { ASSERT_VEC3(v); return vec3(this.x - v.x, this.y - v.y, this.z - v.z); }
    multiply(v) { ASSERT_VEC3(v); return vec3(this.x * v.x, this.y * v.y, this.z * v.z); }
    scale(s) { ASSERT(isNumber(s)); return vec3(this.x * s, this.y * s, this.z * s); }
    dot(v) { return this.x*v.x+this.y*v.y+this.z*v.z; }
    length() { return (this.x**2 + this.y**2 + this.z**2)**.5; }
    normalize() { const l = this.length(); return l ? this.scale(1/l) : vec3(1); }
    cross(v) { ASSERT_VEC3(v); return vec3(this.y*v.z-this.z*v.y, this.z*v.x-this.x*v.z, this.x*v.y-this.y*v.x); }
    lerp(v, p) { ASSERT_VEC3(v); return v.subtract(this).scale(clamp(p)).addSelf(this); }
    // no dot/rotateX/rotateY: their only shipped callers turned constant vectors, now
    // written out (vehicle.js track normal, scene.js light). the free cam's rotates live in debug.js
    transform(matrix)
    {
        const p = matrix.transformPoint(this);
        return vec3(p.x, p.y, p.z);
    }
}

///////////////////////////////////////////////////////////////////////////////
// Color

const rgb = (r, g, b, a) => new Color(r, g, b, a);
const hsl = (h, s, l, a) => rgb().setHSLA(h, s, l, a);
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

    lerp(c, percent)
    {
        ASSERT(isColor(c));
        percent = clamp(percent);
        return rgb(
            lerp(percent, this.r, c.r),
            lerp(percent, this.g, c.g),
            lerp(percent, this.b, c.b),
            lerp(percent, this.a, c.a),
        );
    }

    setHSLA(h=0, s=0, l=1, a=1)
    {
        h = mod(h,1);
        s = clamp(s);
        l = clamp(l);
        const q = l < .5 ? l*(1+s) : l+s-l*s, p = 2*l-q,
            f = (p, q, t)=>
                (t = mod(t,1))*6 < 1 ? p+(q-p)*6*t :
                t*2 < 1 ? q :
                t*3 < 2 ? p+(q-p)*(4-t*6) : p;
        this.r = f(p, q, h + 1/3);
        this.g = f(p, q, h);
        this.b = f(p, q, h - 1/3);
        this.a = a;
        return this;
    }
    
    toString()      
    { return `rgb(${this.r*255},${this.g*255},${this.b*255},${this.a})`; }
}

///////////////////////////////////////////////////////////////////////////////
// Random

class Random
{
    constructor(seed) { this.setSeed(seed); }
    setSeed(seed) 
    { 
        this.seed = seed+1|0;
        this.float();this.float();this.float();// warmup
    }
    float(a=1, b=0)
    {
        // xorshift
        this.seed ^= this.seed << 13;
        this.seed ^= this.seed >>> 17;
        this.seed ^= this.seed << 5;
        return b + (a-b) * Math.abs(this.seed % 1e9) / 1e9; // bias low values due to float error
    }
    int(a, b)         { return this.float(a, b)|0; }
    sign()            { return this.float() < .5 ? -1 : 1; } // one float() per call: the generator's consumption order is the layout
}

///////////////////////////////////////////////////////////////////////////////

class Timer
{
    // no constructor: every `new Timer` is unset (this.time undefined) until set()
    set(timeLeft=0) { this.time = time + timeLeft; }
    isSet() { return this.time != undefined; }
    active() { return time < this.time; }
    get() { return time - this.time || 0; } // unset: NaN -> 0
}
///////////////////////////////////////////////////////////////////////////////
// closed-loop track wrapping

const wrapSegment = (i) => mod(Math.floor(i), lapTrackSegments); // floor, not |0: negative z (the grid) must not alias
const wrapDeltaZ = (dz) => mod(dz + lapDistance/2, lapDistance) - lapDistance/2;

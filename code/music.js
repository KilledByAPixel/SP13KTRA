'use strict';

///////////////////////////////////////////////////////////////////////////////
// music.js - the loops, baked from seeds
//
// Dark techno with no note data: every part is a modulo of a sixteenth-note count, and
// the harmony is a root table walked every sixteen beats. A whole 128-beat loop is
// rendered by musicBake into one buffer: the SELECTED CIRCUIT'S loop, baked from its seed
// when the circuit changes (musicLoad, at gameStart, with the world rebuild) and playing
// everywhere, the title, the menu, the race and the results card alike, from the top when
// it is baked and carried on through every other change (Frank, 2026-09-13: picking a
// circuit in the menu starts its music at once, and nothing after that restarts it; a
// menu loop of its own and a restart at the race and the results lasted an hour).
// EVERY CIRCUIT HAS ITS OWN LOOP: the bake draws its tempo, key, scale, root walk,
// patterns, melody, groove, kit and timbres from the shared random generator seeded with
// the circuit's integer, all listed in one place at the top of musicBake. Frank listens to
// seeds in tools/music.html and writes the good ones into the table; the seed is the
// composition. (A single loop at 126 with hand-picked numbers until then; every draw's
// set holds the original's value, so one seed plays it.)
// The post pass is what sells it (local/musicNotes.md): a resonant lowpass over the
// melodic part whose cutoff climbs across each phrase and resets, opening fully into the
// drop on beat 112 after the breakdown; an echo; a short pump off every beat; tanh so a
// hot bar crunches instead of clicking. Because the loop is a buffer, all of that is
// three multiplies and an array read per sample.
// NEVER a live scheduler: baking makes timing sample exact with no lookahead code.
// Nothing wraps past the end (a typed array drops the write): the last bar's octave bass
// used to leak into the closed intro. Cost: a 2.7M-float buffer per loop and about half
// a second per bake, mostly the post pass.
//
// Instruments are Sounds (audio.js; paste a ZzFX designer array in): the kick is rendered
// once at load, the snare, hat, bass and lead per loop from the kit and timbre draws (short
// renders, nothing next to the post pass); a note is a render read at a semitone stride
// (nearest sample: some alias grit on the saws, which the filter eats). Callers: game.js
// gameStart calls musicLoad after the world build, gameUpdate calls musicUpdate every frame;
// input.js onblur calls musicStop (a hidden tab gets no frames).
///////////////////////////////////////////////////////////////////////////////

const musicKick  = new Sound([.5,,100,.005,.05,,,,-1]); // a thump sliding down, every loop's (tuned per loop by the drum draw K)
const musicSeeds = [0,638,826,5078,9284,7811,7143,2259]; // one integer per circuit: the seed its loop is baked from (0 is the original loop, by construction: musicBake). The top suggestion of tools/music-candidates-gen.js for each circuit's mood (2026-09-13) until Frank picks by ear in tools/music.html
let musicLoop, musicSeed, musicInfo; // the selected circuit's loop and the seed it holds; the draws, for the tool (debug only)
let musicSource, musicEpoch; // musicEpoch: the audio time the loop started; a later start joins it in progress

// gameStart: a new circuit's loop, from the top; the same circuit carries on
function musicLoad()
{
    if (musicSeed != musicSeeds[currentCircuit])
        musicLoop = musicBake(musicSeed = musicSeeds[currentCircuit]), musicStop(), musicEpoch = 0;
}

// bake one loop from a seed: the full mix, 128 beats
function musicBake(seed)
{
    random.setSeed(seed);

    // THE DRAWS, all up front so this list is the whole design space. SEED 0 IS THE ORIGINAL
    // LOOP BY CONSTRUCTION: r() draws 0 on seed 0, and option 0 of every draw is the original's
    // value (marked *; the modulo shifts put it there). An offset that found the original among
    // the seeds worked until the draws passed 32 bits of combinations (18 draws: about one seed
    // in 113 billion, and there are 4 billion seeds), 2026-09-13.
    //   bpm 138, 126*, 114 or 102 (90 dragged under racing, and halved to 45 in half time).
    //   key: semitones the whole harmony shifts (0*).
    //   scale: minor pentatonic*, major pentatonic, in-sen (the flat second: dark, UMBRA's kind)
    //     or suspended pentatonic; six notes with the octave.
    //   roots: one per sixteen beats in the original's shape (home, home, a, home, home, home,
    //     b, a: a drone that leaves twice), a and b two drawn chords (3* and 5*).
    //   hatBits, bassBits, leadBits: 16-step patterns from one table of eight (bit i = the
    //     sixteenth i of the bar; 0x4444*, 0x4444*, 0x6DB6*); leadPhrases: which 32-beat phrases
    //     the lead plays (four bits, 0 for no lead; 0b1010*).
    //   the MELODY: the lead steps through the scale every sixteenth or every eighth* (S), by a
    //     stride J of 1* (climbing), 5 (falling: 5 is -1 in six), 2 or 4 (leaping by thirds and
    //     fifths) or 3 (rocking between two notes), an octave up or not* (O).
    //   the echo: a dotted eighth* or a dotted sixteenth (E).
    //   the GROOVE G, a kick and a snare pattern as a pair so they agree: four on the floor
    //     with the snare on 2 and 4*, a two-step (kick on 1 and the and of 3), half time (the
    //     snare on 3 alone), a busy floor (a kick on the last eighth, a ghost snare on the last
    //     sixteenth), electro (kick on 1, the and of 2 and the and of 3) and a broken beat (kick
    //     on 1, the e of 2 and the a of 3, with the busy floor's ghost snare).
    //   the drums' tuning K, kick, snare and hat together, -2 to +2 semitones (0*).
    //   the KIT D: a short snare click and a closed hat tick*, or a long snare wash and an open hat.
    //   the TIMBRES: the bass a saw* or a square (a sine with shape curve .3; quieter, it is
    //     louder per peak); the lead a saw* (short), a triangle held longer (a pad's softness) or
    //     a square pluck (a sine with shape curve .2, shortest and quietest).
    //   THE ARRANGEMENT (2026-09-13, Frank: every loop opened the same way at a different tempo;
    //     nothing is sacred but the original): the ENTRANCES F, the beat the kick, snare, hat
    //     and bass come in, each 0, 16 or 32 (0*, 0*, 16*, 0*), so an intro can be bass alone,
    //     drums alone or a slow build; the DRUM LEVEL DG, full*, half or barely there (with the
    //     two sparse grooves below, a loop can have almost no drums); the LEAD LEVEL LG, as mixed*
    //     or forward, the lead the main thing; leadPhrases may be 0, no lead at all; the PAD P, off*
    //     or a long triangle chord (root and fifth) every 16 beats into the filtered stem, so the
    //     phrase sweep opens it and the pump pulses it; the WALKING BASS BM, the root* or a step up
    //     the scale on every beat of the bar.
    //   Two more grooves for the sparse loops: a heartbeat (kick on 1 and 3, no snare) and barely
    //     there (a kick on 1, the snare on 4).
    // (Gone on 2026-09-13: the hat's entry beat, the filter's phrase length and the echo's level
    // for size, the hat's entry back that day as an entrance; the filter's damping, Frank heard
    // every loop as the same resonance; a swing, straight, light or triplet, straight only, Frank.)
    const r = (a, b) => seed && random.int(a, b), // one draw: always 0 on seed 0
        bpm = 138-12*((r(4)+1)%4), key = r(-5,3),
        scale = [[0,3,5,7,10,12],[0,2,4,7,9,12],[0,1,5,7,8,12],[0,2,5,7,10,12]][r(4)],
        R = [3,5,7,10], a = R[r(4)], b = R[(r(4)+1)%4], roots = [0,0,a,0,0,0,b,a],
        pat = [0x4444,0xAAAA,0x6DB6,0xFFFF,0x2222,0x5555,0x8888,0x9999], hatBits = pat[r(8)], bassBits = pat[r(8)], leadBits = pat[(r(8)+2)%8], leadPhrases = (r(16)+10)%16,
        S = 1^r(2), J = 1+r(5), O = 12*r(2), E = r(2),
        G = [[0x1111,0x1010],[0x0401,0x1010],[0x0409,0x0100],[0x5111,0x9010],[0x0441,0x1010],[0x0821,0x9010],[0x0101,0],[0x0001,0x1000]][r(8)],
        K = (r(5)+2)%5-2, D = r(2), B = 1^r(2), T = r(3), V = [[.05,2,1,.05],[.08,1,1,.15],[.035,0,.2,.02]][T],
        u = [16*r(3), 16*r(3), 16*((r(3)+1)%3), 16*r(3)], F = u.map(f => f-Math.min(...u)), // the entrances shifted so the earliest is beat 0: all four late left a silent intro, or a pad alone under the closed filter (FILAMENT's 6881, SODIUM's 826, 2026-09-13)
        DG = [1,.5,.2][r(3)], LG = [1,1.8][r(2)], P = r(2), BM = r(2),
        snare = new Sound([.3,,150,,,.02+D*.02,,,,,,,,3]),
        hat   = new Sound([.03,,1e3,,,.01+D*.04,,,,,,,,9]),
        bass  = new Sound([.08+B*.04,,55,,.12,.1,B*2,B||.3,,,,,,,,,,,.02]),
        lead  = new Sound([V[0]*LG,,,.01,V[3],.08,V[1],V[2],,,,,,,,,,.6,.05]),
        pad   = new Sound([.05,0,110,.5,3,2]); // a triangle at A3: half a second in, three held, two out
    debug && (musicInfo = {seed,bpm,key,scale,roots,hatBits,bassBits,leadBits,leadPhrases,S,J,O,E,G,K,D,B,T,F,DG,LG,P,BM});

    const beat = zzfxR*60/bpm|0, L = beat*128, mix = new Float32Array(L), m = new Float32Array(L);
    let at;

    // one hit at `at`, semi semitones up, at gain g, into one stem array (mix for the drums, m for the melodic part)
    const hit = (stem, sound, semi, g=1) =>
    {
        const s = sound.samples, r = 2**(semi/12); // one render per instrument (Sound), read at the semitone stride
        for (let i = 0; i < s.length/r; ++i)
            stem[at+i] += s[i*r|0]*g; // past the end is dropped (typed array)
    };

    // the form, per sixteenth t: beat b, root r (in the key), brk the breakdown (beats 96-111),
    // bit the step's bit in a 16-step pattern, n the lead note. The kick and snare on the
    // groove's patterns from their entrances at the drum level, out through the breakdown (a
    // sixteenth roll into the drop went for size, 2026-09-13); the hat on its pattern from its
    // entrance, out of the breakdown until it rolls in on the odd sixteenths from beat 106; the
    // bass on its pattern from its entrance on the root (or walking up the scale), an octave down
    // on the last bar of eight, and OUT from the breakdown to the end of the loop (the return on
    // 112 builds without it, back on the restart); the lead walks the scale on its phrases, two
    // saws detuned .12 of a semitone; the pad's chord on every 16th beat, through the breakdown too
    for (let t = 0; t < 512; ++t)
    {
        const b = t>>2, r = roots[b>>4]+key, brk = b>>4==6, bit = 1<<(t&15), n = r+O+scale[(t>>S)*J%6];
        at = t*beat/4|0;
        brk || b<F[0] || G[0]&bit && hit(mix, musicKick, K, DG);
        brk || b<F[1] || G[1]&bit && hit(mix, snare, K, DG);
        b>=F[2] && (brk ? b>105 && t&1 : hatBits&bit) && hit(mix, hat, K, DG);
        bassBits&bit && b>=F[3] && b<96 && hit(m, bass, r-12*((b&7)==7)+BM*scale[b%4]);
        leadBits&bit && leadPhrases>>(b>>5)&1 && b<123 && (hit(m, lead, n), hit(m, lead, n+.12));
        P && !(t%64) && (hit(m, pad, r), hit(m, pad, r+7));
    }

    // the post pass over the melodic stem: a resonant lowpass (Chamberlin state variable,
    // f the cutoff coefficient: .01 about 70 Hz, .41 about 3 kHz, keep it under .5) whose
    // cutoff climbs over each 32-beat phrase (squared: closed longer, opening faster), and
    // through the breakdown climbs in 16 beats so it is wide open at the drop on 112 and stays
    // there; then the echo three sixteenths back at 35%, or half that on E (not wrapped: the
    // end of the buffer is still dry when the start is processed); then a pump off every beat;
    // then into the full mix through tanh
    const d = beat*3/4>>E;
    for (let i = 0, lo = 0, ba = 0, hi; i < L; ++i)
    {
        const p = i/beat, ramp = p < 96 ? p%32/32 : min(1, (p-96)/16);
        const f = .01 + .4*ramp*ramp;
        hi = m[i] - lo - .4*ba; ba += f*hi; lo += f*ba;
        m[i] = lo + (i<d ? 0 : m[i-d])*.35; // (a guarded read: m[i-d]||0 read before the array for the first d samples, about 15% slower warm, 2026-09-13)
        m[i] *= min(min(1, i%beat/2205), (beat-i%beat)/441); // the pump: out over the last 10 ms before a beat, in over 50 ms after (a cut to zero AT the beat clicked on any pattern still sounding there: the original's bass fell between the beats, 2026-09-13)
        mix[i] = Math.tanh(mix[i] + m[i]);
    }
    // the level: every loop scaled to the original's RMS (.14), a boost capped at 2.5, so a loop
    // with barely any drums or no lead is not 12 dB under the finale (2026-09-13; the original
    // is already there, a gain of .99)
    let e = 0;
    for (const x of mix) e += x*x;
    e = min(2.5, .14/Math.sqrt(e/L));
    for (let i = L; i--;) mix[i] *= e;
    return mix;
}

// stop the loop (input.js onblur too)
function musicStop()
{
    musicSource && musicSource.stop();
    musicSource = 0;
}

// every frame: the loop plays, retried until the audio context is running (browsers need a
// gesture first) and while unfocused (playSamples refuses, onblur stops); silent muted. A
// start joins the loop where its clock says it is (a refocus, unmuting), so nothing but a
// new circuit ever restarts it
function musicUpdate()
{
    if (!soundVolume || musicMuted) return musicStop(); // musicMuted: the M key, saved (game.js)
    if (!musicSource && (musicSource = playSamples(musicLoop, 1, 1, musicEpoch ? (audioContext.currentTime-musicEpoch)%(musicLoop.length/zzfxR) : 0)))
        musicSource.loop = 1, musicEpoch ||= audioContext.currentTime;
}

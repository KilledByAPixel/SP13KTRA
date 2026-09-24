'use strict';

///////////////////////////////////////////////////////////////////////////////
// music.js - the loops, baked from seeds
//
// Techno with no note data: every part is a modulo of a sixteenth-note count, and the
// harmony is a root table walked every sixteen beats. A whole 128-beat loop is baked into
// one buffer from the selected circuit's seed (musicSeeds). The seed is the composition:
// the bake draws tempo, key, scale, root walk, patterns, melody, groove, kit and timbres
// from the shared random generator, all listed at the top of musicBakeSteps. Seeds are
// auditioned in tools/music.html, which bakes through the same function.
//
// One looping source plays everywhere: title, menu, race and results. Only a new circuit
// restarts it; any other start (a refocus, unmuting) joins the loop in progress.
//
// The post pass runs the melodic stem through a resonant lowpass whose cutoff climbs over
// each phrase and opens fully into the drop on beat 112, then an echo, a pump off every
// beat and tanh into the full mix.
//
// STEREO (the build flag stereoMusic: off in the 13k build, the Dreamcast export and the
// seed tools): the same notes, a little separation. It is baked as MID AND SIDE: the mono
// stems are untouched and are the mid, and two side stems take only the panned parts at
// their pan p (a part at p is (1-p) of itself on the left and (1+p) on the right, so the
// mid is exactly the mono mix). Kick, snare and bass stay centred; the hat sits .3 right,
// the lead's two detuned voices .5 each side, the pad's root .4 left and fifth .4 right.
// The side runs through the same lowpass (its own state), pump and echo, the echo's
// feedback negated, which is a ping-pong: each repeat of a panned part flips sides. Then
// left and right are tanh(mid -+ side) to first order, tanh(mid) -+ side*(1-tanh(mid)^2),
// levelled on their mid. The bake returns [left, right] instead of one array.
//
// Never a live scheduler: baking makes timing sample exact with no lookahead code.
// Nothing wraps past the loop's end (a typed array drops the write), or the last bar
// would leak into the intro. Cost: a 2.7M-float buffer and about half a second per bake.
//
// Instruments are Sounds (audio.js, ZzFX arrays): the kick and pad render once at load,
// the snare, hat, bass and lead per loop from their draws. A note is a render read at a
// semitone stride (nearest sample: the filter eats the alias grit).
//
// Called from: game.js gameStart (musicLoad, after the world build) and gameUpdate
// (musicUpdate, every frame); input.js onblur (musicStop: a hidden tab gets no frames).
///////////////////////////////////////////////////////////////////////////////

const musicKick  = new Sound([.5,,100,.005,.05,,,,-1]); // a thump sliding down, tuned per loop by the draw K
const musicPad   = new Sound([.05,0,110,.5,3,2]);       // a triangle at A3: .5 s in, 3 held, 2 out

// the seed each circuit's loop is baked from; 0 is the original loop by construction
const musicSeeds = [0,638,826,5078,9284,7811,7143,2259];

// musicLoop, musicSeed: the selected circuit's loop and the seed it was baked from
// musicInfo: the draws, for tools/music.html (debug only)
let musicLoop, musicSeed, musicInfo;

// musicEpoch: the audio time the loop started, so a later start joins it in progress
// musicBaking: the enhanced build's bake in progress (a musicBakeSteps generator), else 0
let musicSource, musicEpoch, musicBaking = 0;

// gameStart: a new circuit's loop from the top; the same circuit carries on.
// enhanced: musicUpdate bakes a slice per frame, the old loop fades out now and the new one
// starts when ready; a newer circuit replaces an unfinished bake. 13k: baked at once
function musicLoad()
{
    if (musicSeed != musicSeeds[currentCircuit])
        enhancedMode ? (musicBaking = musicBakeSteps(musicSeed = musicSeeds[currentCircuit]), musicFade(), musicLoop = 0)
            : (musicLoop = musicBake(musicSeed = musicSeeds[currentCircuit]), musicStop(), musicEpoch = 0);
}

// <bake-at-once> (build.js removes this block from the 13k build, where musicBakeSteps becomes a plain musicBake again)
// bake one loop at once: musicBakeSteps run to its end (tools/music.html and the seed scanner)
function musicBake(seed)
{
    for (const steps = musicBakeSteps(seed);;)
    {
        const s = steps.next();
        if (s.done) return s.value;
    }
}
// </bake-at-once>

// bake one loop from a seed: the full mix, 128 beats. A generator that yields between
// slices of the work, so the enhanced build can spread a bake over frames (musicUpdate)
// instead of freezing at a circuit change. The first slice makes every draw (random is
// shared: nothing may draw between them). The draw block must stay one statement ending
// before the musicInfo line: tools/music-candidates-gen.js cuts it out, runs it on its own
// and hashes its text, comments included
function* musicBakeSteps(seed)
{
    random.setSeed(seed);

    // THE DRAWS, all up front so this list is the whole design space. Seed 0 is the original
    // loop by construction: r() draws 0 on seed 0, and option 0 of every draw is the
    // original's value (marked *; the modulo shifts put it there).
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
    //   the ARRANGEMENT: the ENTRANCES F, the beat the kick, snare, hat
    //     and bass come in, each 0, 16 or 32 (0*, 0*, 16*, 0*), so an intro can be bass alone,
    //     drums alone or a slow build; the DRUM LEVEL DG, full*, half or barely there (with the
    //     two sparse grooves below, a loop can have almost no drums); the LEAD LEVEL LG, as mixed*
    //     or forward, the lead the main thing; leadPhrases may be 0, no lead at all; the PAD P, off*
    //     or a long triangle chord (root and fifth) every 16 beats into the filtered stem, so the
    //     phrase sweep opens it and the pump pulses it; the WALKING BASS BM, the root* or a step up
    //     the scale on every beat of the bar.
    //   Two more grooves for the sparse loops: a heartbeat (kick on 1 and 3, no snare) and barely
    //     there (a kick on 1, the snare on 4).
    const r = (a, b) => seed && random.int(a, b), // one draw: always 0 on seed 0
        bpm = 138-12*((r(4)+1)%4), key = r(-5,3),
        scale = [[0,3,5,7,10,12],[0,2,4,7,9,12],[0,1,5,7,8,12],[0,2,5,7,10,12]][r(4)],
        R = [3,5,7,10], a = R[r(4)], b = R[(r(4)+1)%4], roots = [0,0,a,0,0,0,b,a],
        pat = [0x4444,0xAAAA,0x6DB6,0xFFFF,0x2222,0x5555,0x8888,0x9999], hatBits = pat[r(8)], bassBits = pat[r(8)], leadBits = pat[(r(8)+2)%8], leadPhrases = (r(16)+10)%16,
        S = 1^r(2), J = 1+r(5), O = 12*r(2), E = r(2),
        G = [[0x1111,0x1010],[0x0401,0x1010],[0x0409,0x0100],[0x5111,0x9010],[0x0441,0x1010],[0x0821,0x9010],[0x0101,0],[0x0001,0x1000]][r(8)],
        K = (r(5)+2)%5-2, D = r(2), B = 1^r(2), T = r(3), V = [[.05,2,1,.05],[.08,1,1,.15],[.035,0,.2,.02]][T],
        u = [16*r(3), 16*r(3), 16*((r(3)+1)%3), 16*r(3)], F = u.map(f => f-Math.min(...u)), // shifted so the earliest entrance is beat 0: all four late leaves a silent intro
        DG = [1,.5,.2][r(3)], LG = [1,1.8][r(2)], P = r(2), BM = r(2);
    debug && (musicInfo = {seed,bpm,key,scale,roots,hatBits,bassBits,leadBits,leadPhrases,S,J,O,E,G,K,D,B,T,F,DG,LG,P,BM});
    yield; // the end of the first slice: every draw at once

    // the drawn instruments, one render a slice (together they took about 60 ms)
    const snare = new Sound([.3,,150,,,.02+D*.02,,,,,,,,3]);
    yield;
    const hat   = new Sound([.03,,1e3,,,.01+D*.04,,,,,,,,9]);
    yield;
    const bass  = new Sound([.08+B*.04,,55,,.12,.1,B*2,B||.3,,,,,,,,,,,.02]);
    yield;
    const lead  = new Sound([V[0]*LG,,,.01,V[3],.08,V[1],V[2],,,,,,,,,,.6,.05]);
    yield;

    const beat = zzfxR*60/bpm|0, L = beat*128, mix = new Float32Array(L), m = new Float32Array(L),
        mixS = stereoMusic && new Float32Array(L), mS = stereoMusic && new Float32Array(L); // the side stems (stereo)
    let at;

    // one hit at `at`, semi semitones up, at gain g, into one stem (mix: drums, m: melodic)
    const hit = (stem, sound, semi, g=1) =>
    {
        const s = sound.samples, r = 2**(semi/12); // the render is read at the semitone stride
        for (let i = 0; i < s.length/r; ++i)
            stem[at+i] += s[i*r|0]*g; // past the end is dropped (typed array)
    };

    // the form, per sixteenth t: beat b, root r (in the key), brk the breakdown (beats 96-111),
    // bit the step's bit in a 16-step pattern, n the lead note.
    //   kick, snare: the groove's patterns from their entrances, out through the breakdown
    //   hat: its pattern from its entrance; in the breakdown, a roll on the odd sixteenths
    //     from beat 106
    //   bass: its pattern on the root (or walking up the scale), an octave down on the last
    //     bar of eight, and out from the breakdown to the loop's end (the return on 112
    //     builds without it)
    //   lead: walks the scale on its phrases, two voices detuned .12 of a semitone
    //   pad: root and fifth on every 16th beat, through the breakdown too
    for (let t = 0; t < 512; ++t)
    {
        const b = t>>2, r = roots[b>>4]+key, brk = b>>4==6, bit = 1<<(t&15), n = r+O+scale[(t>>S)*J%6];
        at = t*beat/4|0;
        yield; // a slice every sixteenth (a bar's slice was too long: it can hold pad notes)
        brk || b<F[0] || G[0]&bit && hit(mix, musicKick, K, DG);
        brk || b<F[1] || G[1]&bit && hit(mix, snare, K, DG);
        b>=F[2] && (brk ? b>105 && t&1 : hatBits&bit) && (hit(mix, hat, K, DG), stereoMusic && hit(mixS, hat, K, DG*.3));
        bassBits&bit && b>=F[3] && b<96 && hit(m, bass, r-12*((b&7)==7)+BM*scale[b%4]);
        leadBits&bit && leadPhrases>>(b>>5)&1 && b<123 && (hit(m, lead, n), hit(m, lead, n+.12), stereoMusic && (hit(mS, lead, n, -.5), hit(mS, lead, n+.12, .5)));
        P && !(t%64) && (hit(m, musicPad, r), hit(m, musicPad, r+7), stereoMusic && (hit(mS, musicPad, r, -.4), hit(mS, musicPad, r+7, .4)));
    }

    // the post pass over the melodic stem: a resonant lowpass (Chamberlin state variable,
    // f the cutoff coefficient: .01 about 70 Hz, .41 about 3 kHz, keep it under .5) whose
    // cutoff climbs over each 32-beat phrase (squared: closed longer, opening faster), and
    // through the breakdown climbs in 16 beats so it is wide open at the drop on 112 and stays
    // there; then the echo three sixteenths back at 35%, or half that on E (not wrapped: the
    // end of the buffer is still dry when the start is processed); then a pump off every beat;
    // then into the full mix through tanh
    const d = beat*3/4>>E;
    let loS = 0, baS = 0; // the side's filter state (stereo)
    for (let i = 0, lo = 0, ba = 0, hi; i < L; ++i)
    {
        const p = i/beat, ramp = p < 96 ? p%32/32 : min(1, (p-96)/16);
        const f = .01 + .4*ramp*ramp;
        hi = m[i] - lo - .4*ba; ba += f*hi; lo += f*ba;
        m[i] = lo + (i<d ? 0 : m[i-d])*.35; // a guarded read: m[i-d]||0 before the array is about 15% slower
        // the pump: out over the last 10 ms before a beat, in over 50 ms after
        // (a cut to zero at the beat clicks on any pattern still sounding there)
        m[i] *= min(min(1, i%beat/2205), (beat-i%beat)/441);
        mix[i] = Math.tanh(mix[i] + m[i]);
        if (stereoMusic)
        {
            // the side: the same filter on its own state, the echo's feedback negated (the
            // ping-pong) and the same pump; then through the tanh's slope where the mid sits,
            // tanh(mid -+ side) to first order: one tanh a sample, not two (the side is 11 to
            // 38 dB under the mid), and a centred side is exactly the mono loop
            hi = mS[i] - loS - .4*baS; baS += f*hi; loS += f*baS;
            mS[i] = (loS - (i<d ? 0 : mS[i-d])*.35) * min(min(1, i%beat/2205), (beat-i%beat)/441); // (a shared const survived the 13k fold)
            const s = (mixS[i] + mS[i])*(1 - mix[i]*mix[i]);
            mixS[i] = mix[i] + s; // right
            mix[i] -= s;          // left
        }
        i&32767 || (yield); // a slice every 32,768 samples
    }

    // the level: every loop scaled to the original's RMS (.14), the boost capped at 2.5, so
    // a sparse loop is not 12 dB under a busy one
    // a stereo loop is measured on its mid and both channels take the one gain, so it keeps
    // the mono loop's loudness
    let e = 0, n = 0;
    if (stereoMusic)
        for (let i = 0; i < L; ++i)
        {
            const x = (mix[i] + mixS[i])/2;
            e += x*x;
            i&131071 || (yield); // (the 13k build strips every yield line whole: nothing else may be on it)
        }
    else for (const x of mix)
    {
        e += x*x;
        ++n&131071 || (yield); // sliced too: in one piece it took 55-70 ms
    }
    e = min(2.5, .14/Math.sqrt(e/L));
    for (let i = L; i--;)
    {
        mix[i] *= e;
        stereoMusic && (mixS[i] *= e);
        i&131071 || (yield);
    }
    return stereoMusic ? [mix, mixS] : mix; // stereo: [left, right]
}

// the enhanced build's circuit change: the loop fades out over .25 s and stops (a cut
// mid-wave pops). musicSource is let go at once, so the new loop can start the moment its
// bake is done; playSamples hangs the gain node on the source as volumeNode
function musicFade()
{
    if (musicSource)
    {
        const gain = musicSource.volumeNode.gain, t = audioContext.currentTime;
        gain.setValueAtTime(gain.value, t);
        gain.linearRampToValueAtTime(0, t + .25); // linear: an exponential ramp never reaches 0
        musicSource.stop(t + .25);
    }
    musicSource = 0;
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
    // the enhanced build's bake, about 4 ms a frame, muted or not; when done the new loop
    // starts from its top (nothing plays meanwhile: musicLoad cleared the old one)
    if (enhancedMode && musicBaking)
        for (const end = performance.now() + 4; performance.now() < end;)
        {
            const s = musicBaking.next();
            if (s.done)
            {
                musicLoop = s.value, musicBaking = 0, musicStop(), musicEpoch = 0;
                break;
            }
        }
    if (!soundVolume || musicMuted) return musicStop(); // musicMuted: the M key (game.js)
    if (!musicSource && (!enhancedMode || musicLoop) && (musicSource = playSamples(musicLoop, 1, 1, musicEpoch ? (audioContext.currentTime-musicEpoch)%((stereoMusic ? musicLoop[0] : musicLoop).length/zzfxR) : 0)))
        musicSource.loop = 1, musicEpoch ||= audioContext.currentTime;
}

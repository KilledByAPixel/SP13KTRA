'use strict';

///////////////////////////////////////////////////////////////////////////////
// audio.js - the Sound class, Web Audio playback and the ZzFX synth
//
// Owns: the volume setting, `Sound` (a pre-rendered ZzFX sample buffer with a
// play() that pitches and randomises it), playSamples (the Web Audio plumbing)
// and zzfxG, the ZzFXMicro waveform generator that renders a parameter array
// into samples.
//
// Entry points: sounds.js builds every `new Sound([...])` at load, right after
// this file, so the synth runs once at start-up and play() is cheap. game.js,
// vehicle.js and debug.js call sound_x.play(volume, pitch); vehicle.js keeps the
// engine's returned source node to loop it and bend its playbackRate with speed;
// music.js renders its instruments through Sound and plays its baked loop through
// playSamples. The M key (game.js) mutes the music only; soundVolume 0 silences
// everything, the music and the engine loop included.

///////////////////////////////////////////////////////////////////////////////
// Audio settings

let soundVolume = .3; // master gain

///////////////////////////////////////////////////////////////////////////////
// Sound

class Sound
{
    constructor(zzfxSound)
    {
        // rendered now so play() is cheap
        this.randomness = zzfxSound[1] || 0; // ZzFX's randomness slot is applied per play, not in zzfxG
        this.samples = zzfxG(...zzfxSound);
    }

    // returns the AudioBufferSourceNode so a caller can loop/stop/retune it (the engine)
    play(volume=1, pitch=1)
    {
        // +-randomness as a fraction of the pitch
        const playbackRate = pitch*(1 + this.randomness*(Math.random()*2-1));
        return playSamples(this.samples, volume, playbackRate);
    }
}

///////////////////////////////////////////////////////////////////////////////
// Web Audio playback

let audioContext; // created on the first play, which browsers only allow after a gesture

// play a sample array once; returns the source node, or nothing when it cannot play now.
// samples: one array, or [left, right] for the stereo music loop (stereoMusic, music.js).
// offset: seconds into the samples to start from (the music loop joins in progress)
function playSamples(samples, volume, rate, offset)
{
    if (!audioContext)
        audioContext = new AudioContext;

    // nothing plays unfocused, or sounds carry on in a background window
    if (!document.hasFocus())
        return;

    // a suspended context queues nothing: ask it to resume and drop this sound, so
    // stalled sounds never pile up and play together later
    if (audioContext.state != 'running')
    {
        audioContext.resume();
        return;
    }

    // stereo: a pair of arrays (a sample is a number, with no length)
    const stereo = stereoMusic && samples[0].length,
         buffer = audioContext.createBuffer(stereo ? 2 : 1, stereo || samples.length, zzfxR),
         source = audioContext.createBufferSource();

    stereo ? (buffer.getChannelData(0).set(samples[0]), buffer.getChannelData(1).set(samples[1]))
        : buffer.getChannelData(0).set(samples);
    source.buffer = buffer;
    source.playbackRate.value = rate;

    // createGain is more widely supported than the GainNode constructor
    const gainNode = audioContext.createGain();
    gainNode.gain.value = soundVolume*volume;
    gainNode.connect(audioContext.destination);

    // no stereo panner: the sounds are mono, only the stereo music loop has two channels
    source.connect(gainNode);

    source.start(0, offset);
    enhancedMode && (source.volumeNode = gainNode); // the enhanced build fades the music through it (musicFade)
    return source;
}

///////////////////////////////////////////////////////////////////////////////
// ZzFXMicro - Zuper Zmall Zound Zynth - v1.3.1 by Frank Force
//
// Renders one sound into a plain array of samples in -1..1 (times volume). The
// parameter order is the ZzFX standard, so arrays from the ZzFX designer paste
// straight into sounds.js. Trimmed to what the sound table uses: the randomness
// slot is ignored here (Sound applies it at play time), the tan wave shape, the
// biquad filter (slot 20) and tremolo (19) are cut, modulation (14) is a
// placeholder, and pitchJumpTime (11) is always 0, so the pitch jump lands on
// the first sample and again on every repeat (a rising stair: the win arpeggio).

const zzfxR = 44100; // sample rate
function zzfxG
(
    // parameters
    volume = 1, randomness, frequency = 220, attack = 0, sustain = 0,
    release = .1, shape = 0, shapeCurve = 1, slide = 0, deltaSlide = 0,
    pitchJump = 0, pitchJumpTime, repeatTime = 0, noise = 0, modulation,
    bitCrush = 0, delay = 0, sustainVolume = 1, decay = 0
)
{
    // init parameters: convert Hz and seconds into per-sample radians and counts
    let PI2 = PI*2, sampleRate = zzfxR,
        startSlide = slide *= 500 * PI2 / sampleRate / sampleRate,
        // the first pitch jump lands on the first sample
        startFrequency = frequency = frequency * PI2 / sampleRate + (pitchJump *= PI2 / sampleRate),
        b = [], t = 0, i = 0, r = 0, c = 0, s = 0, f, length;

    // scale by sample rate
    attack = attack * sampleRate + 9; // minimum attack to prevent pop
    decay *= sampleRate;
    sustain *= sampleRate;
    release *= sampleRate;
    delay *= sampleRate;
    deltaSlide *= 500 * PI2 / sampleRate**3;
    repeatTime = repeatTime * sampleRate | 0;

    ASSERT(shape != 3); // sin (0), triangle (1) and saw (2, the music's bass and lead) ship; tan (3) does not

    // generate waveform, one sample per pass; b[i] = s * volume
    for(length = attack + decay + sustain + release + delay | 0;
        i < length; b[i++] = s * volume)
    {
        // bit crush: hold the sample for bitCrush*100 passes. With bitCrush 0 the modulo is
        // `c%0`, NaN, and `!NaN` is true, so no crush means every sample passes: correct here,
        // and load-bearing, but it is undefined behaviour in any other language (the Dreamcast
        // port had to special-case it, 2026-09-20)
        if (!(++c%(bitCrush*100|0)))
        {
            // saw, triangle, sine
            s = shape>1 ? 1-(2*t/PI2%2+2)%2 : shape ? 1-4*abs(Math.round(t/PI2)-t/PI2) : Math.sin(t);

            // envelope: attack ramp, decay to sustainVolume, sustain, release ramp, then
            // silence under the delay tail
            s = sign(s)*(abs(s)**shapeCurve) *
                (i < attack ? i/attack :                 // attack
                i < attack + decay ?                     // decay
                1-((i-attack)/decay)*(1-sustainVolume) :
                i < attack  + decay + sustain ?          // sustain
                sustainVolume :
                i < length - delay ?                     // release
                (length - i - delay)/release *
                sustainVolume :
                0);                                      // post release

            // echo: mix in the sample from `delay` samples ago at half volume
            s = delay ? s/2 + (delay > i ? 0 :
                (i<length-delay? 1 : (length-i)/delay) *
                b[i-delay|0]/2/volume) : s;
        }

        // advance the phase: slide bends the frequency, noise jitters it
        f = frequency += slide += deltaSlide;
        t += f + f*noise*Math.sin(i**5);

        // repeat: restart the pitch envelope every repeatTime, one jump higher
        if (repeatTime && !(++r % repeatTime))
        {
            frequency = startFrequency += pitchJump;
            slide = startSlide;
        }
    }

    return b;
}

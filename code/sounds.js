'use strict';

///////////////////////////////////////////////////////////////////////////////
// sounds.js - the sound table
//
// Every game sound is one ZzFX parameter array, rendered to samples by
// `new Sound` (audio.js) when this file loads. The arrays are ZzFX designer
// output, in the standard slot order:
//   [volume, randomness, frequency, attack, sustain, release, shape, shapeCurve,
//    slide, deltaSlide, pitchJump, pitchJumpTime, repeatTime, noise, modulation,
//    bitCrush, delay, sustainVolume, decay]
// Empty slots take zzfxG's defaults. Shape is 0 sin, 1 triangle or 2 saw (the
// assert in zzfxG); tremolo and filter are cut, pitchJumpTime and modulation are
// ignored: the generator keeps only what this table and the music use. Callers
// pass their own (volume, pitch) to play(), so one sound serves several cues at
// different pitches: the countdown beep goes up an octave on GO.
//
// Callers: game.js (countdown, menu, Escape, pause, mute, restart), vehicle.js
// (engine loop, crash, wall bump, laps, the low-energy tick, the charge blip,
// boost, death, win) and debug.js (the U key). music.js renders its five
// instruments (kick, snare, hat, bass, lead) with the same generator.

const sound_beep = new Sound([,,,.01,.08,.05,1,2,,,,,,,,,.3]); // beep: countdown numerals (game.js), pitch 2 on GO
const sound_engine = new Sound([,,55,,.32,0,,2,,,,,,2,,.1]); // engine: vehicle.js loops the returned source and bends playbackRate with speed
const sound_hit = new Sound([,.3,120,,,.2,,,,,,,,9]); // crash: craft-to-craft contact involving the player
const sound_bump = new Sound([,.3,340,,,.01,,.8,-30,,,,,1,,,,.5,.02]); // bump: wall hits, and a click on a locked circuit in the menu
const sound_checkpoint = new Sound([.3,,980,,,,,3,,,,,,,,.03]); // checkpoint: laps (three beeps), the low-energy tick (pitch 1.5-2), opening the menu, the craft pick, pause/unpause
const sound_win = new Sound([.3,,,.03,,2,1,,,,220,,.1,,,,.3]); // win: the player finishes (and the dev U key)
const sound_lose = new Sound([,,99,,,.5,,3,,4,,,,2,,.2,.4,.1,1]); // lose: death, the R restart
const sound_boost = new Sound([,,,.02,,.8,,3,,-200,40,,.05]); // boost whoosh: pads and held Space
const sound_charge = new Sound([.5,,660,,,,1,,20]); // charge: a rising triangle blip every .3 s on the recharge strip while energy is under 100 (vehicle.js); also the menu's circuit pick, Escape to the title and the mute toggle
const sound_slowBump = new Sound([,,400,.02,,.01,,,-60,,,,.03,1,,,.1,.5]); // rumble: the rough shoulder, one bump every 3,000-4,500 units travelled, louder with speed (vehicle.js)
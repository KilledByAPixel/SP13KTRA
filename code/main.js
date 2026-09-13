'use strict';

/*

SP13KTRA by Frank Force
An anti-gravity grand prix in 13 kilobytes, made for js13kGames

Controls
- Arrows or Mouse = Drive (a click enters mouse mode: the pointer's offset from the
  window centre steers, the left button drives, right boosts;
  Left/Right return to the keys)
- Space or the middle button = Brake
- Left Shift = Boost (costs energy)
- Escape = Title screen
- Menu (Space or a click on the title): Up/Down pick the circuit, Left/Right the
  craft, Space or a click races

Features
- 8 circuits, each a rounded closed polygon with its own palette, sky and scenery
- One custom WebGL renderer: baked meshes, emissive/pulse/spectrum material flags
- Seven AI rivals driving the same vehicle simulation as the player
- Fixed-step physics with substeps, containment and craft contacts
- Energy, boost pads and the recharge strip
- ZzFX sounds and a techno loop baked at load
- Persistent save data (circuit, last place, craft colour, best placing per circuit)
- All written from scratch in vanilla JS

This file is the entry point: it is the last script in the concat order and only
calls gameInit() (game.js) once every other file has loaded.

*/

///////////////////////////////////////////////////

// debug settings: uncomment for a dev session (the flags live in debug.js)
//devMode = debugInfo = 1
//soundVolume = 0
//autoPause = 0
//quickStart = 1
//disableAiVehicles = 1

///////////////////////////////////////////////////

gameInit();

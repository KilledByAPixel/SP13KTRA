'use strict';

const debug = 0;
const enhancedMode = 1;
let debugInfo, debugMesh, devMode;
// build flags (see releaseJS13K.js: declared first so terser can fold them everywhere)
const clampAspectRatios = 1;
const testLevel = 0, quickStart = 0, disableAiVehicles = 0, testDrive = 0, freeCamMode = 0, topDownMode = 0, testLevelInfo = 0;

// the debug.js functions, as empty stubs
function ASSERT() {}
function debugInit() {}
function drawDebug() {}
function debugUpdate() {}
function debugSaveCanvas() {}
function debugSaveText() {}
function debugDraw() {}
function debugSaveDataURL() {}
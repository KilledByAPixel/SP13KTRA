'use strict';

const debug = 0;
const enhancedMode = 1;
let debugInfo, debugMesh, devMode;
const js13kBuildLevel2 = 0; // more space is needed for js13k
// build flags (see releaseJS13K.js: declared first so terser can fold them everywhere)
const clampAspectRatios = 1;
const testLevel = 0, quickStart = 0, disableAiVehicles = 0, testDrive = 0, freeCamMode = 0, testLevelInfo = 0;

// disable debug features
function ASSERT() {}
function debugInit() {}
function drawDebug() {}
function debugUpdate() {}
function debugSaveCanvas() {}
function debugSaveText() {}
function debugDraw() {}
function debugSaveDataURL() {}
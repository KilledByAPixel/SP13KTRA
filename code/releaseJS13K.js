'use strict';

const debug = 0;
const enhancedMode = 0;
let debugInfo, debugMesh, devMode;
// build flags live HERE, first in the concat order: terser folds a const only into
// reads that FOLLOW its declaration, so a flag declared in game.js stays live in
// every file before it (input.js, vehicle.js) and ships the branches it guards
const clampAspectRatios = 0;
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
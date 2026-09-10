'use strict';

let skyMesh, skyKitMesh;
// one world direction for the key light and the sky kit's sun: low on the big-sun circuits
const sunDirection=()=>vec3(-.5,levelInfo.sky&1?.17:.4,.75).normalize();
function drawScene()
{
    drawSky(); drawTrack(); drawScenery(); drawCars();
    drawTrackScenery();
}
function drawSky()
{
    glLightDirection=sunDirection();
    glLightColor=levelInfo.skyColorTop.lerp(WHITE,.9);
    // ambient stays low and tinted by the horizon so unlit faces read dark in the band,
    // not grey: this is where the pop comes from (Frank, 2026-09-08)
    glAmbientColor=levelInfo.skyColorBottom.lerp(WHITE,.3).lerp(BLACK,.65);
    glFogColor=levelInfo.skyColorBottom; // exactly the sky's horizon colour: a fogged ground edge vanishes into it
    glEnableLighting=glEnableFog=0; glSetDepthTest(0,0);
    skyMesh.render(buildMatrix(cameraPos,vec3(0,cameraRot.y))); // the gradient turns with the camera; its horizon is the world's
    skyKitMesh.render(buildMatrix(cameraPos));        // the kit is fixed in world direction
    glSetDepthTest(); glEnableLighting=glEnableFog=1;
}

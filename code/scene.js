'use strict';

///////////////////////////////////////////////////////////////////////////////
// scene.js: the frame's draw order and the sky pass.
//
// Owns the two sky meshes (baked by buildCourseWorld in track.js, disposed by
// disposeWorld when the world changes) and the one world light direction.
// drawScene() is called once per frame from gameUpdate (game.js) after glPreRender;
// the passes it calls live in track.js (drawTrack, drawScenery, drawTrackScenery)
// and vehicle.js (drawCars). sunDirection() is also read by track.js when it bakes
// the sky kit's sun disc.
///////////////////////////////////////////////////////////////////////////////

let skyMesh, skyKitMesh;

// one world direction for the key light and the sky kit's sun: low on the big-sun
// circuits (sky bit 1), higher everywhere else
// the sun's yaw walks the circuits, 2.4 rad on from REDSHIFT's -.59 (the original, ahead-left of the start
// straight): until 2026-09-13 every sun stood in the same place against its start straight and lit every
// skyline the same way. It is the key light too, so the hulls and every face change with it
const sunDirection=()=>{const a=currentCircuit*2.4-.59;return vec3(.9*Math.sin(a),levelInfo.sky&1?.15:.3,.9*Math.cos(a)).normalize();};

///////////////////////////////////////////////////////////////////////////////
// draw order: sky gradient and kit, then opaque road/architecture/craft with depth,
// then the additive trails and glows on top

function drawScene()
{
    drawSky();
    drawTrack();
    drawScenery();
    drawCars();
    drawTrackScenery(); // trails and nozzle glows: additive, drawn last so they sit over everything
}

///////////////////////////////////////////////////////////////////////////////
// the sky pass also sets the frame's lighting and fog, which every later pass reuses

function drawSky()
{
    glLightDirection=sunDirection();
    glLightInvert=levelInfo.sky>>3&1; // the eclipse circuit (sky bit 8, UMBRA) is lit in the negative: the shader takes one minus the lit term, so the faces the eclipsed sun would light are dark and every other face is bright (2026-09-13; flipping the light vector instead lit everything from below and blacked the road)
    glLightColor=levelInfo.skyColorTop.lerp(WHITE,.9);
    // ambient stays low and tinted by the horizon so unlit faces read dark in the band,
    // not grey: that contrast is the pop
    glAmbientColor=levelInfo.skyColorBottom.lerp(WHITE,.3).lerp(BLACK,.65);
    glFogColor=levelInfo.skyColorBottom; // exactly the sky's horizon colour: a fogged ground edge vanishes into it

    // the sky has no depth and is never lit or fogged
    glEnableLighting=0;
    glSetDepthTest(0);
    skyMesh.render(buildMatrix(cameraPos,vec3(0,cameraRot.y))); // the gradient turns with the camera's yaw only, so its horizon is the world's
    skyKitMesh.render(buildMatrix(cameraPos));        // the kit (sun, stars, clouds, eclipse) is baked in world orientation and only follows the camera's position
} // drawTrack, next, sets depth and lighting back (fog stays on from the world build: its writes went in a size cut)

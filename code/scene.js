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
// circuits (sky bit 1), higher everywhere else. Its yaw walks the circuits, 2.4 rad on
// from REDSHIFT's -.59 (ahead-left of the start straight), so every circuit's skyline,
// hulls and faces are lit from a different side.
// umbraSunYaw, enhanced only (the 13k build's circuits never change): by the formula
// UMBRA's eclipse sits 71 degrees off the start straight, at the top edge of the sky the
// race camera sees, and is easy to miss
const umbraSunYaw=3.2;
const sunDirection=()=>{const a=enhancedMode&&currentCircuit==6?umbraSunYaw:currentCircuit*2.4-.59;return vec3(.9*Math.sin(a),levelInfo.sky&1?.15:.3,.9*Math.cos(a)).normalize();};

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
// the sky pass also sets the frame's lighting and fog, which every later pass reuses.
// drawTrack, next, sets depth and lighting back (fog stays on from the world build)

function drawSky()
{
    glLightDirection=sunDirection();
    // the eclipse circuit (sky bit 8, UMBRA) is lit in the negative: the shader takes one
    // minus the lit term, so the faces the eclipsed sun would light are dark and every other
    // face is bright (flipping the light vector instead lights everything from below and
    // blacks the road)
    glLightInvert=levelInfo.sky>>3&1;
    glLightColor=levelInfo.skyColorTop.lerp(WHITE,.9);
    // ambient stays low and tinted by the horizon so unlit faces read dark in the band,
    // not grey: that contrast is the pop
    glAmbientColor=levelInfo.skyColorBottom.lerp(WHITE,.3).lerp(BLACK,.65);
    glFogColor=levelInfo.skyColorBottom; // the sky's horizon colour: a fogged ground edge vanishes into it

    // the sky has no depth and is never lit or fogged
    glEnableLighting=0;
    glSetDepthTest(0);
    // the gradient turns with the camera's yaw only, so its horizon is the world's; the kit
    // (sun, stars, clouds, eclipse) is baked in world orientation and only follows the
    // camera's position
    skyMesh.render(buildMatrix(cameraPos,vec3(0,cameraRot.y)));
    skyKitMesh.render(buildMatrix(cameraPos));
}

'use strict';

///////////////////////////////////////////////////////////////////////////////
// draw.js: the mesh kit and the shape builders that sit on top of webgl.js.
//
// Owns:
//   - the shared persistent meshes: cubeMesh, prismMesh, canopyMesh, the craft hulls
//     (craftSpecs[i].mesh, one per colour index) and the two baked glow fans (glowMeshes)
//   - buildLoft, the ONE shape builder (every hull and kit piece is a loft)
//   - class Mesh: a static vertex buffer with upload/render/dispose and combine (welding)
//   - the immediate-mode push that feeds the stream or a bake: pushGlow (the sky bands push
//     their own corners in track.js: pushGradient and pushSprite went on 2026-09-13)
//   - fullscreen helpers
//
// Entry points and who calls them:
//   drawInit()          game.js, once after glInit
//   buildLoft(stations) vehicle.js (hulls via makeCraftSpec), track.js (kit pieces)
//   Mesh.combine/upload track.js (buildScenery welds one big `stored` mesh)
//   Mesh.render         track.js, vehicle.js, scene.js, debug.js
//   Mesh.dispose        track.js (switching seed/circuit)
//   pushGlow            track.js (nozzle glows, bursts, charge sparks, the sky kit's discs
//                       during a bake)
//   getAspect           hud.js
//   isFullscreen/toggleFullscreen  game.js
//
// Loads after utilities.js (vec3, rgb, buildMatrix, lerp) and webgl.js (glPush,
// glDraw, glRender, glBake, glBind). Everything is in world units; there are no textures.
///////////////////////////////////////////////////////////////////////////////

let cubeMesh, prismMesh, canopyMesh, craftSpecs, glowMeshes;

// only the colours the game reads: a `new Color` at top level is a side effect terser
// must keep, so dev-only colours belong in debug.js instead
const WHITE  = rgb();
const BLACK  = rgb(0,0,0);

///////////////////////////////////////////////////////////////////////////////
// Init: build and upload the shared kit

const getAspect =()=> mainCanvasSize.x/mainCanvasSize.y;

function drawInit()
{
    // the cube is the loft's diamond section turned 45 degrees and scaled back to
    // half-extent 1; the prism is the section with its side points dropped to the base
    // (an upright triangle with a degenerate fourth vertex)
    cubeMesh = new Mesh().combine(buildLoft([[1,1,1,-1],[-1,1,1,-1]]),0,vec3(0,0,PI/4),vec3(2**.5,2**.5,1));
    prismMesh = buildLoft([[1,1,1,-1,0],[-1,1,1,-1,0]]);

    {
        // the canopy: one shared unit loft (nose +z, base at y=0, half extents 1),
        // placed per craft by matrix. a knife point up front, the bubble's shoulder
        // just behind it, cut off square at the back
        canopyMesh = buildLoft([[1,0,.08,0], [.2,1,1,0], [-1,.62,.62,0]]);
    }

    // one hull per racer colour (racerColors, vehicle.js makeCraftSpec), uploaded on its first render
    // like the cube and the canopy (Mesh.render uploads lazily): black is 6, white is 7
    craftSpecs=racerColors.map((_,i)=>makeCraftSpec(i));

    // bake the two glow fans (soft rim and flat disc) at unit size, so pushGlow outside
    // a bake is a single matrix draw instead of a fresh fan of stream vertices
    glEnableFog=0;
    glowMeshes=[0,1].map(soft=>glBake(()=>pushGlow(vec3(),1,WHITE,soft)));
}

///////////////////////////////////////////////////////////////////////////////
// buildLoft: the only shape builder

// the loft: diamond cross sections swept nose to tail, quads between them, capped both ends.
// station = [z, halfWidth, topY, bottomY, sideHeight=.5] in craft units, nose +z, ordered
// nose first; the section points are (left, top, right, bottom) with the sides at
// sideHeight between bottom (0) and top (1): .5 is the hull's diamond, 0 a triangle.
// WINDING: the section is wound CLOCKWISE seen from +z and each quad is pushed as
// [a,a,b,d,c,c] (a,b = the front station's edge, c,d = the same edge one station back),
// which glPush's reversal turns into front-facing triangles; the boundary cycles
// a->b->c->d->a for quad()'s normal. 6 verts per quad keeps the batch's strip parity.
function buildLoft(stations)
{
    const points = [], normals = [];
    const sect = ([z,w,t,b,m=.5]) => [vec3(-w,lerp(m,b,t),z), vec3(0,t,z), vec3(w,lerp(m,b,t),z), vec3(0,b,z)];
    const quad = (a, b, c, d) =>
    {
        // a corner normal ((b-a)x(d-a), corner a's own two edges) degenerates whenever a
        // vertex coincides with its neighbour, which the point nose does. the diagonal
        // cross (c-a)x(d-b) stays non-degenerate there (it only fails if BOTH diagonals
        // collapse) and is the same vector up to scale on a planar quad: within 2.6
        // degrees of the corner normal everywhere a hull is not degenerate
        const n = c.subtract(a).cross(d.subtract(b)).normalize();
        for(const p of [a,a,b,d,c,c])
            points.push(p), normals.push(n);
    };

    // the sides: one quad per section edge between each pair of stations
    for(let i=0; i<stations.length-1; ++i)
    {
        const s1 = sect(stations[i]), s2 = sect(stations[i+1]);
        for(let k=0; k<4; ++k)
            quad(s1[k], s1[(k+1)%4], s2[(k+1)%4], s2[k]);
    }

    // caps: the tail, and the nose reversed (a craft's point nose closes itself; a box needs it)
    const t = sect(stations[stations.length-1]), h = sect(stations[0]);
    quad(t[0], t[1], t[2], t[3]);
    quad(h[3], h[2], h[1], h[0]);
    return new Mesh(points, normals);
}

///////////////////////////////////////////////////////////////////////////////
// Mesh: a static vertex buffer in the shared 12-float format
// (position xyz + material, normal xyz + specularity, RGBA), see glPushVert in webgl.js

class Mesh
{
    constructor(points=[], normals=[])
    {
        this.points = points;
        this.normals = normals;
        this.colors = []; // per-vertex colour and material (emissive) from combine(); absent = white, 0
        this.mats = [];
    }

    // create the GPU buffer. with no data it packs points/normals/colors/mats itself;
    // glBake passes an already packed Float32Array of captured stream vertices
    upload(data)
    {
        if(!data)
        {
            data=new Float32Array(this.points.length*12);
            for(let i=0;i<this.points.length;++i)
            {
                const p=this.points[i], n=this.normals[i], c=this.colors[i]||WHITE, j=i*12;
                // enhanced: the twelve floats written out, no array per vertex (glPushVert does the same); the specularity slot stays the
                // zero a fresh Float32Array already holds. The 13k build keeps the short form and folds this away
                if(enhancedMode)
                    data[j]=p.x, data[j+1]=p.y, data[j+2]=p.z, data[j+3]=this.mats[i]||0, data[j+4]=n.x, data[j+5]=n.y, data[j+6]=n.z, data[j+8]=c.r, data[j+9]=c.g, data[j+10]=c.b, data[j+11]=c.a;
                else
                    data.set([p.x,p.y,p.z,this.mats[i]||0,n.x,n.y,n.z,0,c.r,c.g,c.b,c.a],j);
            }
        }
        this.buf=glContext.createBuffer();
        this.count=data.length/12; // vertices
        debug && (this.bytes=data.byteLength);
        glBind(this.buf);
        glContext.bufferData(gl_ARRAY_BUFFER,data,35044); // STATIC_DRAW
        if(debug) ++glLiveBuffers, glStaticBytes+=this.bytes, ++glStaticUploads;
        return this;
    }

    dispose()
    {
        if(this.buf)
        {
            glContext.deleteBuffer(this.buf);
            if(debug) --glLiveBuffers, glStaticBytes-=this.bytes;
            this.buf=0;
        }
    }

    // flush the stream first so draw order is preserved, upload lazily, then one draw call.
    // `stored` meshes (glBake, buildScenery) take material and specularity from their
    // vertices; the rest use the current glEmissive/glSpecularity/glEnableFog uniforms
    render(transform=new DOMMatrix, color=WHITE)
    {
        glRender();
        this.buf || this.upload();
        glDraw(this.buf,this.count,transform,color,this.stored);
    }

    // weld another mesh in: every loft quad is six verts, so concatenation keeps strip
    // parity and only makes degenerate joins. colour and emissive ride the vertices, so
    // the mesh must render `stored` (vertex materials)
    combine(mesh, pos, rot, scale, color=WHITE, mat=0)
    {
        const m = buildMatrix(pos, rot, scale);
        const m2 = buildMatrix(0, rot); // normals only turn: the kit's faces are axis aligned or near enough
        // the matrices' components read once, then every vertex through plain arithmetic: transformPoint allocated a DOMPoint each, a
        // tenth of a world build (2026-09-15, local/world-hash-probe.js: 627 ms to 558 ms, every circuit's world hash identical).
        // Pushing in a loop instead of map+spread drops a temporary array per piece too. The 13k build keeps the old path, 76 bytes cheaper
        if (enhancedMode)
        {
            const f = matrixFloats(m), f2 = matrixFloats(m2);
            for(const p of mesh.points) this.points.push(matrixApply(f, p.x, p.y, p.z));
            for(const n of mesh.normals) this.normals.push(matrixApply(f2, n.x, n.y, n.z));
        }
        else
        {
            this.points.push(...mesh.points.map(p=>p.transform(m)));
            this.normals.push(...mesh.normals.map(p=>p.transform(m2)));
        }
        for(const p of mesh.points) this.colors.push(color), this.mats.push(mat);
        return this;
    }
}

///////////////////////////////////////////////////////////////////////////////
// Immediate-mode pushes: these go through glPush, so they land in the stream
// (drawn at the next glRender) or, inside glBake, in the mesh being baked

// a triangle fan: a hot centre fading out to a transparent rim (soft), or a flat disc
// (soft=0). it stands in camera XY, which for a round glow is close enough to camera facing.
// The rim runs CLOCKWISE on purpose: glPush pushes the list in REVERSE, so this is the
// order that comes out front facing, the same rule the road quads and the trail ribbon
// follow. Back-face culling is off, so winding no longer hides anything; the rule is kept
// so the geometry stays consistent.
// rot: the fan's facing, the camera's unless a caller (the sky kit) gives its own.
// size is the disc's diameter; flat squashes its height while baking (the sky kit's oval clouds).
function pushGlow(pos, size, color, soft=1, sides=8, rot=cameraRot, flat=1)
{
    // outside a bake, draw the baked unit fan scaled up: one draw, no stream vertices
    // (so `sides` only matters while baking, e.g. the sky kit's discs)
    if(!glCapture)
        return glowMeshes[soft].render(buildMatrix(pos,rot,vec3(size)),color);

    const rim = soft ? rgb(color.r, color.g, color.b, 0) : color;

    // the whole frame is ONE triangle strip, and a strip flips winding on every odd
    // triangle: push an ODD number of verts and everything drawn after this in the batch
    // comes out back facing (with culling on, that ate the sun's scanline bands). the fan
    // is 2*sides+3 verts, so it opens on a doubled first rim point to make the count even.
    // the duplicate is at the FRONT: at the back it would swap two verts of every real
    // triangle
    const points = [], colors = [];
    for(let i=0; i<=sides; ++i)
    {
        const a = i/sides*2*PI, s = Math.sin(a)*size/2, c = Math.cos(a)*size/2*flat;
        const p = vec3(s,c).transform(buildMatrix(pos,rot));
        i || (points.push(p), colors.push(rim)); // the parity vert
        points.push(p);
        colors.push(rim);
        if (i < sides)
            points.push(pos), colors.push(color); // the hot centre between rim points
    }
    glPush(points, 0, colors);
}

///////////////////////////////////////////////////////////////////////////////
// Fullscreen mode

// true while fullscreen is active
function isFullscreen() { return !!document.fullscreenElement; }

function toggleFullscreen()
{
    const element = document.body;
    if (isFullscreen())
    {
        if (document.exitFullscreen)
            document.exitFullscreen();
    }
    else if (element.requestFullscreen)
        element.requestFullscreen();
    else if (element.webkitRequestFullscreen)
        element.webkitRequestFullscreen();
    else if (element.mozRequestFullScreen)
      element.mozRequestFullScreen();
}

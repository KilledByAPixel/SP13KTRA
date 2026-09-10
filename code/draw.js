'use strict';

let cubeMesh, quadMesh, prismMesh, canopyMesh, craftSpecs, glowMeshes;

// only the colours the game reads: a `new Color` is a side effect terser must keep
const WHITE  = rgb();
const BLACK  = rgb(0,0,0);
const YELLOW = rgb(1,1,0);

///////////////////////////////////////////////////////////////////////////////

const getAspect =()=> mainCanvasSize.x/mainCanvasSize.y;

function drawInit()
{
    // ONE shape builder (spec: a small kit). the cube is the loft's diamond section turned
    // 45 degrees and scaled back to half-extent 1; the prism is the section with its side
    // points dropped to the base (an upright triangle with a degenerate fourth vertex)
    cubeMesh = new Mesh([],[]).combine(buildLoft([[1,1,1,-1],[-1,1,1,-1]]),0,vec3(0,0,PI/4),vec3(2**.5,2**.5,1));
    prismMesh = buildLoft([[1,1,1,-1,0],[-1,1,1,-1,0]]);
    {
        // quad
        const points1 = [vec3(-1,1),vec3(1,1),vec3(-1,-1),vec3(1,-1)];
        quadMesh = new Mesh(points1, points1.map(p=>vec3(0,0,1)));
    }
    {
        // the canopy: one shared unit loft (nose +z, base at y=0, half extents 1),
        // placed per craft by matrix. a knife point up front, the bubble's shoulder
        // just behind it, cut off square at the back
        canopyMesh = buildLoft([[1,0,.08,0], [.2,1,1,0], [-1,.62,.62,0]]);
    }
    for(const m of [cubeMesh,quadMesh,prismMesh,canopyMesh]) m.upload();
    craftSpecs=Array.from({length:8},(_,i)=>{
        const s=makeCraftSpec(i); s.mesh=buildLoft(s.stations).upload(); return s;
    });
    glEnableFog=0;
    glowMeshes=[0,1].map(soft=>glBake(()=>pushGlow(vec3(),1,WHITE,soft)));
}

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
        // vertex coincides with its neighbour - exactly what the point nose needs. the
        // diagonal cross (c-a)x(d-b) stays non-degenerate there (only fails if BOTH
        // diagonals collapse) and is the same vector up to scale on a planar quad: ≤2.6°
        // off the corner normal everywhere this hull isn't degenerate.
        const n = c.subtract(a).cross(d.subtract(b)).normalize();
        for(const p of [a,a,b,d,c,c])
            points.push(p), normals.push(n);
    };
    for(let i=0; i<stations.length-1; ++i)
    {
        const s1 = sect(stations[i]), s2 = sect(stations[i+1]);
        for(let k=0; k<4; ++k)
            quad(s1[k], s1[(k+1)%4], s2[(k+1)%4], s2[k]);
    }
    // caps: the tail, and the nose reversed (a craft's point nose closes itself; a box needs it)
    const t = sect(stations[stations.length-1]), h = sect(stations[0]);
    quad(t[0], t[1], t[2], t[3]); quad(h[3], h[2], h[1], h[0]);
    return new Mesh(points, normals);
}

///////////////////////////////////////////////////////////////////////////////

class Mesh
{
    constructor(points, normals)
    {
        this.points = points;
        this.normals = normals;
        this.colors = []; // per-vertex colour and material (emissive) from combine(); absent = white, 0
        this.mats = [];
    }

    upload(data)
    {
        if(!data)
        {
            data=new Float32Array(this.points.length*12);
            for(let i=0;i<this.points.length;++i)
            {
                const p=this.points[i], n=this.normals[i], c=this.colors[i]||WHITE;
                data.set([p.x,p.y,p.z,this.mats[i]||0,n.x,n.y,n.z,0,c.r,c.g,c.b,c.a],i*12);
            }
        }
        this.buffer=glContext.createBuffer(); this.count=data.length/12;
        this.bytes=data.byteLength;
        glBind(this.buffer); glContext.bufferData(gl_ARRAY_BUFFER,data,35044);
        if(debug) ++glLiveBuffers, glStaticBytes+=this.bytes, ++glStaticUploads;
        return this;
    }
    dispose()
    {
        if(this.buffer)
        {
            glContext.deleteBuffer(this.buffer);
            if(debug) --glLiveBuffers, glStaticBytes-=this.bytes;
            this.buffer=0;
        }
    }
    render(transform, color=WHITE)
    {
        glRender();
        this.buffer || this.upload();
        glDraw(this.buffer,this.count,transform,color,this.stored);
    }

    // weld another mesh in: every loft quad is six verts, so concatenation keeps strip
    // parity and only makes degenerate joins
    // colour and emissive ride the vertices; the mesh must render `stored` (vertex materials)
    combine(mesh, pos, rot, scale, color=WHITE, mat=0)
    {
        const m = buildMatrix(pos, rot, scale);
        const m2 = buildMatrix(0, rot); // normals only turn: the kit's faces are axis aligned or near enough
        this.points.push(...mesh.points.map(p=>p.transform(m)));
        this.normals.push(...mesh.normals.map(p=>p.transform(m2)));
        for(const p of mesh.points) this.colors.push(color), this.mats.push(mat);
        return this;
    }
}

///////////////////////////////////////////////////////////////////////////////

function pushGradient(pos, size, color, color2=color)
{
    const mesh = quadMesh;
    const points = mesh.points.map(p=>p.multiply(size).addSelf(pos));
    glPush(points, 0, [color, color, color2, color2]);
}

// a camera facing quad in the flat color it is given (there are no textures)
function pushSprite(pos, size, color)
{
    const points = quadMesh.points.map(p=>
        vec3(p.x*abs(size.x)+pos.x, p.y*abs(size.y)+pos.y, pos.z));
    glPush(points, 0, color);
}

// a triangle fan: a hot centre fading out to a transparent rim (soft), or a flat disc
// (soft=0). it stands in camera XY, which for a round glow is close enough to camera facing.
// NOTE the rim runs CLOCKWISE on purpose: glPush pushes the list in
// REVERSE, so this is the order that comes out front facing (winding = front face,
// the same rule the road quads and the trail ribbon follow). Reverse it and every
// glow in the game silently vanishes into the back face cull.
// rot: the fan's facing, the camera's unless a caller (the sky kit) gives its own
function pushGlow(pos, size, color, soft=1, sides=8, rot=cameraRot)
{
    if(!glCapture)
        return glowMeshes[soft].render(buildMatrix(pos,rot,vec3(size,size,size)),color);
    const rim = soft ? rgb(color.r, color.g, color.b, 0) : color;
    // the whole frame is ONE triangle strip, and a strip flips winding on every odd
    // triangle: push an ODD number of verts and everything drawn after this in the
    // batch comes out back facing and is culled (this is what ate the sun's scanline
    // bands). the fan is 2*sides+3 verts, so it opens on a doubled first rim point to
    // make the count even. the duplicate is at the FRONT: at the back it would swap
    // two verts of every real triangle and cull the fan itself
    const points = [], colors = [];
    for(let i=0; i<=sides; ++i)
    {
        const a = i/sides*2*PI, s = Math.sin(a)*size/2, c = Math.cos(a)*size/2;
        const p = vec3(s,c,0).transform(buildMatrix(pos,rot));
        i || (points.push(p), colors.push(rim)); // the parity vert
        points.push(p);
        colors.push(rim);
        if (i < sides)
            points.push(pos), colors.push(color);
    }
    glPush(points, 0, colors);
}

///////////////////////////////////////////////////////////////////////////////
// Fullscreen mode

/** Returns true if fullscreen mode is active
 *  @return {Boolean}
 *  @memberof Draw */
function isFullscreen() { return !!document.fullscreenElement; }

/** Toggle fullsceen mode
 *  @memberof Draw */
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

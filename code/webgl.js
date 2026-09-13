'use strict';

///////////////////////////////////////////////////////////////////////////////
// webgl.js: the WebGL2 context, the one shader program, and two ways to get
// vertices on screen:
//   - static buffers: Mesh.upload (draw.js) creates them, glDraw binds one and draws it
//     with the object matrix and material uniforms (road chunks, scenery, hulls, sky)
//   - the stream: glPush/glPushVert append to glVertexData, glRender uploads the batch
//     into glStream and draws it as ONE triangle strip (trails and anything drawn
//     between static meshes). Only trails change vertices per frame
//   - glBake runs a draw callback with the stream captured into an array and turns the
//     result into a `stored` Mesh, so pushes made once at build time render as a static
//     buffer every frame after
//
// Also owns the render state other files set directly: glEnableLighting,
// glLightDirection/glLightColor/glAmbientColor (scene.js sets them per frame),
// glEnableFog/glFogColor, glSpecularity/glEmissive (the material of the next pushed
// or non-stored vertices), boostFov (game.js) and the debug counters (debug.js).
//
// Entry points and who calls them:
//   glInit()                     game.js, once
//   glPreRender(size)            game.js, at the top of every frame (clear, projection)
//   glDraw/glRender/glBind       draw.js (Mesh.render/upload), track.js (flush before
//                                a state change), debug.js
//   glPush(points,normals,color) draw.js pushes, track.js (road, walls, trails)
//   glBake(draw)                 draw.js (glow fans), track.js (sky, road chunks)
//   glSetAdditive/glSetDepthTest track.js, vehicle.js, scene.js
//
// World units end to end: the object and view matrices are plain transforms.
///////////////////////////////////////////////////////////////////////////////

let glCanvas, glContext, glShader, glVertexData, glStream, glCapture;
let glBatchCount = 0; // vertices waiting in glVertexData
let glEnableLighting, glLightDirection, glLightInvert, glLightColor, glAmbientColor;
let glEnableFog, glFogColor;
let glSpecularity = 0, glEmissive = 0, boostFov = 0; // boostFov 0..1: the player's boost widens the lens

// the vertex format: 12 floats / 48 bytes per vertex, three vec4 attributes
// [x,y,z,material] [nx,ny,nz,specularity] [r,g,b,a] at byte offsets 0/16/32
const gl_MAX_BATCH = 20000, gl_INDICIES_PER_VERT = 12, gl_VERTEX_BYTE_STRIDE = 48;
const gl_VERTEX_BUFFER_SIZE = gl_MAX_BATCH*gl_VERTEX_BYTE_STRIDE;

// WebGL enum values, spelled out as numbers so they minify
const gl_ARRAY_BUFFER=34962, gl_DYNAMIC_DRAW=35048, gl_FLOAT=5126,
    gl_TRIANGLE_STRIP=5, gl_DEPTH_TEST=2929, gl_BLEND=3042, gl_CULL_FACE=2884,
    gl_POLYGON_OFFSET_FILL=32823, gl_SRC_ALPHA=770, gl_ONE_MINUS_SRC_ALPHA=771,
    gl_DEPTH_BUFFER_BIT=256, gl_COLOR_BUFFER_BIT=16384;

///////////////////////////////////////////////////////////////////////////////
// Context and shader

function glInit()
{
    document.body.appendChild(glCanvas = document.createElement('canvas'));
    glContext = glCanvas.getContext('webgl2', {alpha:false});

    // THE shader. The two GLSL strings below are what ships; this block is the
    // readable version.
    //
    // Attributes (locations 0,1,2 bound by glCreateProgram):
    //   p = position xyz, p.w = material   n = normal xyz, n.w = specularity   c = RGBA
    //
    // Vertex uniforms:
    //   m = projection * inverse(camera)  (glPreRender)      o = object matrix (glDraw)
    //   l = key light direction (xyz), l.w 1 inverts the lit term (abs(l.w-N.l): UMBRA)   g = light colour, BLACK when
    //   a = ambient colour, WHITE when lighting is off           lighting is off
    //   q = the draw's tint: multiplies colour and alpha
    //   u = (glSpecularity, glEmissive, !glEnableFog, stored ? 0 : 1): u.w picks the
    //       uniform material u.y + 2*u.z over the vertex's own p.w / n.w. `stored`
    //       meshes (bakes, scenery) carry their material per vertex.
    //   e = camera position xyz, e.w = time (seconds) for the PULSE/SPECTRUM animation
    //
    // Material decoding, P = emissive(0..1) + 2*nofog + 4*PULSE + 8*SPECTRUM, peeled
    // off high bit first with step():
    //   S = SPECTRUM, U = PULSE, F = nofog, E = emissive = the remaining fraction, or 1
    //   when SPECTRUM (fully emissive). k = (local x + z) * .002 is the position phase.
    //   C = colour, times a moving cosine rainbow when SPECTRUM: phase = time + .2*k
    //       + .004*height + (0,2,4) per channel, so height weighs ten times x+z.
    //   d = lit colour: C * q * (ambient + light * max(0, N.l)), or one minus that when l.w is 1, lerped to plain C*q by
    //       E, then PULSE (U) flashes it toward white by .35+.35*sin(9*time + k), a wave
    //       travelling along position. d.a = c.a * q.a. k and the SPECTRUM height use the
    //       LOCAL vertex position p, not w: every animated mesh is baked in world space
    //       except the finale's sky, which is drawn at the camera, and with w its rainbow
    //       slid with every camera move and flashed at speed.
    //   r = the reflected light vector + specularity (vertex n.w or uniform u.x)
    //   y = camera-to-vertex vector + the nofog flag     z = clip w = camera-forward distance
    //   N is the normal through the object matrix's inverse transpose (uniform scale
    //   would allow the matrix itself; this is the general form).
    //
    // Fragment uniforms: f = fog colour (the sky's horizon colour), g = light colour.
    //   s = d + g * pow(max(R.V, 0), 12) * specularity: a Phong highlight, gone when
    //       lighting is off because g is BLACK.
    //   Fog: none when nofog (y.w > 0), otherwise z*z/8.1e9 clamped, so it is total by
    //   90,000 units (90,000^2 = 8.1e9). It mixes RGB only; alpha passes through, which
    //   is what lets a fogged ground edge vanish into the horizon without fading.
    glShader = glCreateProgram(
        '#version 300 es\n'+
        'uniform mat4 m,o;uniform vec4 l,g,a,q,u,e;'+
        'in vec4 p,n,c;out vec4 d,r,y;out float z;'+
        'void main(){vec4 w=o*vec4(p.xyz,1);gl_Position=m*w;z=gl_Position.w;'+
        'vec3 N=normalize((transpose(inverse(o))*vec4(n.xyz,0)).xyz);'+
        'float P=mix(p.w,u.y+2.*u.z,u.w),S=step(8.,P);P-=8.*S;float U=step(4.,P);P-=4.*U;float F=step(2.,P),E=max(P-2.*F,S),k=(p.x+p.z)*.002;'+
        'vec3 C=c.rgb*mix(vec3(1),.5+.5*cos(e.w+k*.2+p.y*.004+vec3(0,2,4)),S);'+
        'r=vec4(reflect(-l.xyz,N),mix(n.w,u.x,u.w));y=vec4(e.xyz-w.xyz,F);'+
        'd=vec4(mix(C*q.rgb*mix(a.xyz+g.xyz*abs(l.w-max(0.,dot(l.xyz,N))),vec3(1),E),vec3(1),U*(.35+.35*sin(e.w*9.+k))),c.a*q.a);}',
        '#version 300 es\nprecision highp float;'+
        'uniform vec4 f,g;in vec4 d,r,y;in float z;out vec4 c;'+
        'void main(){vec3 s=d.rgb+g.rgb*pow(max(dot(normalize(r.xyz),normalize(y.xyz)),0.),12.)*r.w;'+
        'c=vec4(mix(s,f.rgb,y.w>0.?0.:clamp(z*z/8.1e9,0.,1.)),d.a);}'
    );
    glContext.useProgram(glShader);

    // the stream buffer: gl_MAX_BATCH vertices, refilled by bufferSubData each glRender
    glStream = glContext.createBuffer();
    glBind(glStream);
    glContext.bufferData(gl_ARRAY_BUFFER, gl_VERTEX_BUFFER_SIZE, gl_DYNAMIC_DRAW);
    glVertexData = new Float32Array(gl_MAX_BATCH*12);

    glSetAdditive(0); // blending itself follows the depth mask: glSetDepthTest
    // no back-face culling: the road is seen from below where it twists away, so everything
    // is double sided. Winding hides nothing; lighting uses the explicit normals, so a back
    // face simply reads unlit
}

function glCreateProgram(vs,fs)
{
    const program = glContext.createProgram();
    for(const [source,type] of [[vs,35633],[fs,35632]]) // VERTEX_SHADER, FRAGMENT_SHADER
    {
        const shader = glContext.createShader(type);
        glContext.shaderSource(shader,source);
        glContext.compileShader(shader);
        if (debug && !glContext.getShaderParameter(shader,35713)) // COMPILE_STATUS
            throw Error(glContext.getShaderInfoLog(shader));
        glContext.attachShader(program,shader);
    }
    ['p','n','c'].map((s,i)=>glContext.bindAttribLocation(program,i,s)); // fixed locations so glBind needs no lookups
    glContext.linkProgram(program);
    if (debug && !glContext.getProgramParameter(program,35714)) // LINK_STATUS
        throw Error(glContext.getProgramInfoLog(program));
    return program;
}

///////////////////////////////////////////////////////////////////////////////
// Per-frame setup and draw calls

const glUniform = name => glContext.getUniformLocation(glShader,name);

// bind a buffer and point the three vec4 attributes at its 48-byte vertices
function glBind(buffer)
{
    glContext.bindBuffer(gl_ARRAY_BUFFER,buffer);
    for(let i=0;i<3;++i)
    {
        glContext.enableVertexAttribArray(i);
        glContext.vertexAttribPointer(i,4,gl_FLOAT,0,48,i*16);
    }
}

// start a frame: size the canvas, clear, reset counters, set the projection and camera
function glPreRender(size)
{
    if (glCanvas.width != size.x || glCanvas.height != size.y)
        glCanvas.width=size.x, glCanvas.height=size.y;
    glContext.viewport(0,0,size.x,size.y);
    glContext.depthMask(true);
    glContext.clear(gl_COLOR_BUFFER_BIT|gl_DEPTH_BUFFER_BIT);
    glBatchCount=0;
    if(debug) glDrawCalls=glBatchCountTotal=glUploadBytes=0;

    // Perspective, near 30 / far 400,000: fog is total by 90k and the horizon colour IS
    // the fog colour, so nothing ever shows the far plane.
    // f is the vertical scale (cot of half the vertical FOV): 1.45 is about 69 degrees,
    // a touch wider than 65 so speed reads at the edges; a full boost drops it to 1.2
    // (about 80 degrees). x is scaled by the aspect so pixels stay square.
    // Fog reads clip.w == camera-forward distance, independent of depth encoding.
    const f=1.45-.25*boostFov, near=30, far=400000;
    let projection=new DOMMatrix([f*size.y/size.x,0,0,0, 0,f,0,0,
        0,0,(far+near)/(far-near),1, 0,0,-2*far*near/(far-near),0]);
    if(topDownMode) // the dev map view (debug.js): orthographic, 1.3 loop radii tall times the wheel zoom,
    {              // depth linear over a million units. clip w is 1, so the fog term is nil: no fog, no z-fighting
        const h=trackMapRadius*1.3*topDownZoom;
        projection=new DOMMatrix([size.y/size.x/h,0,0,0, 0,1/h,0,0, 0,0,2e-6,0, 0,0,-1,1]);
    }
    glContext.uniformMatrix4fv(glUniform('m'),false,
        projection.multiply(buildMatrix(cameraPos,cameraRot).inverse()).toFloat32Array());
    glContext.uniform4f(glUniform('e'),cameraPos.x,cameraPos.y,cameraPos.z,time);
}

// one draw call of `count` vertices from `buffer` as a triangle strip, with the current
// light/fog state and this object's matrix and tint. `stored` = the vertices carry
// their own material and specularity (u.w = 0); otherwise the glEmissive /
// glSpecularity / glEnableFog uniforms apply to the whole draw
function glDraw(buffer,count,transform,color,stored)
{
    const set=(s,c)=>glContext.uniform4f(glUniform(s),c.r,c.g,c.b,c.a);
    set('g',glEnableLighting?glLightColor:BLACK); // no light colour = no diffuse, no specular
    set('a',glEnableLighting?glAmbientColor:WHITE); // full ambient = unlit, plain colour
    set('f',glFogColor);
    set('q',color);
    set('l',rgb(glLightDirection.x,glLightDirection.y,glLightDirection.z,glLightInvert));
    set('u',rgb(glSpecularity,glEmissive,!glEnableFog,stored?0:1));
    glContext.uniformMatrix4fv(glUniform('o'),false,transform.toFloat32Array());
    glBind(buffer);
    glContext.drawArrays(gl_TRIANGLE_STRIP,0,count);
    if(debug) ++glDrawCalls, glBatchCountTotal+=count;
}

///////////////////////////////////////////////////////////////////////////////
// The stream: glPush -> glVertexData -> glRender, or captured by glBake

// flush the pending stream vertices as one strip (identity matrix unless given).
// Mesh.render calls this before its own draw so stream and static draws keep their order
function glRender()
{
    if(glCapture || !glBatchCount) return;
    glBind(glStream);
    glContext.bufferSubData(gl_ARRAY_BUFFER,0,glVertexData,0,glBatchCount*12);
    debug && (glUploadBytes+=glBatchCount*48);
    glDraw(glStream,glBatchCount,new DOMMatrix,WHITE,1);
    glBatchCount=0;
}

// run `draw` with every glPush captured into an array instead of the stream, and
// return the result as a `stored` static mesh. The capture is unbounded (glPush skips
// its overflow flush while glCapture is set) and pushGlow emits a real fan during it.
// Flushing first keeps whatever was already pending in draw order
function glBake(draw)
{
    glRender();
    glCapture=[];
    draw();
    const data=new Float32Array(glCapture);
    glCapture=0;
    const mesh=new Mesh;
    mesh.stored=1;
    mesh.upload(data);
    return mesh;
}

///////////////////////////////////////////////////////////////////////////////
// State helpers

// additive: src alpha + dest (1 = ONE), used for trails and glow; else ordinary alpha blending
function glSetAdditive(on) { glContext.blendFunc(gl_SRC_ALPHA,on?1:gl_ONE_MINUS_SRC_ALPHA); }

// blending is on exactly when the pass does not write depth (sky, trails):
// blended opaque draws left hairline cracks between road chunks on some GPUs, where two
// triangles' shared edge each part-covers a pixel and the background blends through; an
// opaque write simply overwrites. The road, scenery and hulls are alpha 1 anyway (the .9
// wall rail becomes solid, which is fine)
function glSetDepthTest(test=1,write=1)
{
    test?glContext.enable(gl_DEPTH_TEST):glContext.disable(gl_DEPTH_TEST); glContext.depthMask(!!write);
    write?glContext.disable(gl_BLEND):glContext.enable(gl_BLEND);
}

///////////////////////////////////////////////////////////////////////////////
// Pushing vertices

const vectorOne=vec3(0,1); // the normal given to vertices that have none (unlit pushes)

// append one shape to the stream as part of the frame's single triangle strip.
// `points` is already in strip order; `color` is one Color for all or an array per point;
// `normals` may be 0 (unlit: sky, glow, trails).
// PARITY: the list is pushed in REVERSE (winding = front face after the flip), wrapped in
// degenerate caps: a repeat of the last point before and of the first point after, which
// join the shape to its neighbours in the strip with zero-area triangles. That adds 2, so
// an even point count stays even and nothing later in the batch flips its facing
function glPush(points,normals,color)
{
    if(!glCapture && glBatchCount+points.length+2>=gl_MAX_BATCH) glRender(); // no room: flush first
    const c=i=>color[i]||color;
    glPushVert(points[points.length-1],vectorOne,c(points.length-1));
    for(let i=points.length;i--;) glPushVert(points[i],normals?normals[i]:vectorOne,c(i));
    glPushVert(points[0],vectorOne,c(0));
}

// one vertex in the 12-float format. The material is the current glEmissive (which may
// carry the PULSE 4 / SPECTRUM 8 bits, e.g. track.js sets 5 for pads and 9 for the
// recharge strip) plus the nofog bit; specularity is the current glSpecularity
function glPushVert(p,n,c)
{
    const data=[p.x,p.y,p.z,glEmissive+2*!glEnableFog,n.x,n.y,n.z,glSpecularity,c.r,c.g,c.b,c.a];
    if(glCapture) glCapture.push(...data);
    else glVertexData.set(data,glBatchCount++*12);
}

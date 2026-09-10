'use strict';

// Persistent meshes and a separate small stream for trails/sparks. World units are
// used end to end; object/view matrices no longer undo a camera-dependent road bend.
let glCanvas, glContext, glShader, glVertexData, glStream, glCapture;
let glBatchCount = 0;
let glEnableLighting, glLightDirection, glLightColor, glAmbientColor;
let glEnableFog, glFogColor;
let glSpecularity = 0, glEmissive = 0, boostFov = 0; // boostFov 0..1: the player's boost widens the lens
const glRenderScale = 1;
const gl_MAX_BATCH = 20000, gl_INDICIES_PER_VERT = 12, gl_VERTEX_BYTE_STRIDE = 48;
const gl_VERTEX_BUFFER_SIZE = gl_MAX_BATCH*gl_VERTEX_BYTE_STRIDE;
const gl_ARRAY_BUFFER=34962, gl_DYNAMIC_DRAW=35048, gl_FLOAT=5126,
    gl_TRIANGLE_STRIP=5, gl_DEPTH_TEST=2929, gl_BLEND=3042, gl_CULL_FACE=2884,
    gl_POLYGON_OFFSET_FILL=32823, gl_SRC_ALPHA=770, gl_ONE_MINUS_SRC_ALPHA=771,
    gl_DEPTH_BUFFER_BIT=256, gl_COLOR_BUFFER_BIT=16384;

function glInit()
{
    document.body.appendChild(glCanvas = document.createElement('canvas'));
    glContext = glCanvas.getContext('webgl2', {alpha:false});
    glShader = glCreateProgram(
        '#version 300 es\n'+
        // e: camera xyz, time. material p.w (or the u.y/u.z uniforms when not stored):
        // emissive 0..1 + 2 nofog + 4 PULSE (flash toward white on a travelling wave) +
        // 8 SPECTRUM (the colour times a moving cosine rainbow of time and position, fully emissive)
        'uniform mat4 m,o;uniform vec4 l,g,a,q,u,e;'+
        'in vec4 p,n,c;out vec4 d,r,y;out float z;'+
        'void main(){vec4 w=o*vec4(p.xyz,1);gl_Position=m*w;z=gl_Position.w;'+
        'vec3 N=normalize((transpose(inverse(o))*vec4(n.xyz,0)).xyz);'+
        'float P=mix(p.w,u.y+2.*u.z,u.w),S=step(8.,P);P-=8.*S;float U=step(4.,P);P-=4.*U;float F=step(2.,P),E=max(P-2.*F,S),k=(w.x+w.z)*.002;'+
        'vec3 C=c.rgb*mix(vec3(1),.5+.5*cos(e.w*2.+k*.2+w.y*.004+vec3(0,2,4)),S);'+
        'r=vec4(reflect(-l.xyz,N),mix(n.w,u.x,u.w));y=vec4(e.xyz-w.xyz,F);'+
        'd=vec4(mix(C*q.rgb*mix(a.xyz+g.xyz*max(0.,dot(l.xyz,N)),vec3(1),E),vec3(1),U*(.35+.35*sin(e.w*9.+k))),c.a*q.a);}',
        '#version 300 es\nprecision highp float;'+
        'uniform vec4 f,g;in vec4 d,r,y;in float z;out vec4 c;'+
        'void main(){vec3 s=d.rgb+g.rgb*pow(max(dot(normalize(r.xyz),normalize(y.xyz)),0.),12.)*r.w;'+
        'c=vec4(mix(s,f.rgb,y.w>0.?0.:clamp(z*z/8.1e9,0.,1.)),d.a);}'
    );
    glContext.useProgram(glShader);
    glStream = glContext.createBuffer();
    glBind(glStream);
    glContext.bufferData(gl_ARRAY_BUFFER, gl_VERTEX_BUFFER_SIZE, gl_DYNAMIC_DRAW);
    glVertexData = new Float32Array(gl_MAX_BATCH*12);
    glSetAdditive(0); glSetCapability(gl_BLEND); glSetCapability(gl_CULL_FACE);
}

function glCreateProgram(vs,fs)
{
    const program = glContext.createProgram();
    for(const [source,type] of [[vs,35633],[fs,35632]])
    {
        const shader = glContext.createShader(type);
        glContext.shaderSource(shader,source); glContext.compileShader(shader);
        if (debug && !glContext.getShaderParameter(shader,35713))
            throw Error(glContext.getShaderInfoLog(shader));
        glContext.attachShader(program,shader);
    }
    ['p','n','c'].map((s,i)=>glContext.bindAttribLocation(program,i,s));
    glContext.linkProgram(program);
    if (debug && !glContext.getProgramParameter(program,35714))
        throw Error(glContext.getProgramInfoLog(program));
    return program;
}

const glUniform = name => glContext.getUniformLocation(glShader,name);
function glBind(buffer)
{
    glContext.bindBuffer(gl_ARRAY_BUFFER,buffer);
    for(let i=0;i<3;++i)
    {
        glContext.enableVertexAttribArray(i);
        glContext.vertexAttribPointer(i,4,gl_FLOAT,0,48,i*16);
    }
}

function glPreRender(size)
{
    if (glCanvas.width != size.x || glCanvas.height != size.y)
        glCanvas.width=size.x, glCanvas.height=size.y;
    glContext.viewport(0,0,size.x,size.y);
    glContext.depthMask(true);
    glContext.clear(gl_COLOR_BUFFER_BIT|gl_DEPTH_BUFFER_BIT);
    glBatchCount=0;
    if(debug) glDrawCalls=glBatchCountTotal=glUploadBytes=0;
    // Ordinary perspective, near 30 / far 400000, vertical FOV 65 degrees (fog is total by
    // 90k and the horizon colour IS the fog colour, so nothing ever shows the far plane).
    // Fog reads clip.w == camera-forward distance, independent of depth encoding.
    const f=1.45-.25*boostFov, near=30, far=400000; // a touch wider than 65 degrees: speed reads at the edges
    const projection=new DOMMatrix([f*size.y/size.x,0,0,0, 0,f,0,0,
        0,0,(far+near)/(far-near),1, 0,0,-2*far*near/(far-near),0]);
    glContext.uniformMatrix4fv(glUniform('m'),false,
        projection.multiply(buildMatrix(cameraPos,cameraRot).inverse()).toFloat32Array());
    glContext.uniform4f(glUniform('e'),cameraPos.x,cameraPos.y,cameraPos.z,time);
}

function glDraw(buffer,count,transform,color=WHITE,stored=0)
{
    const set=(s,c)=>glContext.uniform4f(glUniform(s),c.r,c.g,c.b,c.a);
    set('g',glEnableLighting?glLightColor:BLACK);
    set('a',glEnableLighting?glAmbientColor:WHITE);
    set('f',glFogColor); set('q',color);
    glContext.uniform4f(glUniform('l'),glLightDirection.x,glLightDirection.y,glLightDirection.z,0);
    glContext.uniform4f(glUniform('u'),glSpecularity,glEmissive,!glEnableFog,stored?0:1);
    glContext.uniformMatrix4fv(glUniform('o'),false,transform.toFloat32Array());
    glBind(buffer);
    glContext.drawArrays(gl_TRIANGLE_STRIP,0,count);
    if(debug) ++glDrawCalls, glBatchCountTotal+=count;
}

function glRender(transform=new DOMMatrix)
{
    if(glCapture || !glBatchCount) return;
    glBind(glStream);
    const data=glVertexData.subarray(0,glBatchCount*12);
    glContext.bufferSubData(gl_ARRAY_BUFFER,0,data);
    debug && (glUploadBytes+=data.byteLength);
    glDraw(glStream,glBatchCount,transform,WHITE,1);
    glBatchCount=0;
}

function glBake(draw)
{
    glRender(); glCapture=[];
    draw();
    const data=new Float32Array(glCapture);
    glCapture=0;
    const mesh=new Mesh([],[]);
    mesh.stored=1; mesh.upload(data);
    return mesh;
}

function glSetCapability(cap,on=1) { on?glContext.enable(cap):glContext.disable(cap); }
function glSetAdditive(on) { glContext.blendFunc(gl_SRC_ALPHA,on?1:gl_ONE_MINUS_SRC_ALPHA); }
function glPolygonOffset(units=0)
{ glContext.polygonOffset(-1,-units); glSetCapability(gl_POLYGON_OFFSET_FILL,!!units); }
function glSetDepthTest(test=1,write=1)
{ glSetCapability(gl_DEPTH_TEST,test); glContext.depthMask(!!write); }

const vectorOne=vec3(0,1,0);
function glPush(points,normals,color,cap=1)
{
    if(!glCapture && glBatchCount+points.length+2>=gl_MAX_BATCH) glRender();
    const c=i=>color[i]||color;
    cap && glPushVert(points[points.length-1],vectorOne,c(points.length-1));
    for(let i=points.length;i--;) glPushVert(points[i],normals?normals[i]:vectorOne,c(i));
    cap && glPushVert(points[0],vectorOne,c(0));
}
function glPushVert(p,n,c)
{
    const data=[p.x,p.y,p.z,glEmissive+2*!glEnableFog,n.x,n.y,n.z,glSpecularity,c.r,c.g,c.b,c.a];
    if(glCapture) glCapture.push(...data);
    else glVertexData.set(data,glBatchCount++*12);
}

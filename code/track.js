'use strict';

///////////////////////////////////////////////////////////////////////////////
// track.js: the route frame and the one permanent world built on it.
//
// Owns
// - the route frame over `track` (the 4,000 route samples trackGen.js fills, plain objects):
//   TrackSegmentInfo, sampleRoute, projectRoute, routeFrame, bermStart
// - buildCourseWorld / disposeWorld: the sky gradient and kit, per-sample frames, the
//   minimap points, the ground plane, the scenery mesh and the 63 baked road chunks
// - the draw calls for all of that: drawTrack, drawScenery, drawTrackScenery (trails)
// - buildScenery: the four scenery bands, the arches and the corner arrows
//
// Called from
// - trackGen.js buildTrack: disposeWorld, buildCourseWorld, worldKey
// - scene.js drawScene: drawTrack, drawScenery, drawTrackScenery; drawSky renders the
//   skyMesh/skyKitMesh baked here (the `let` for both lives in scene.js, which loads first)
// - vehicle.js and game.js (camera): TrackSegmentInfo, sampleRoute, projectRoute, routeFrame
// - hud.js minimap: trackMapPts/trackMapCenter/trackMapRadius (declared in trackGen.js,
//   filled here); tests read roadPanels, skylineSites, worldChunks, groundY under debug
//
// A route is navigation metadata. Surface vertices and the camera live in a single
// permanent world; no road positions are rebuilt during simulation or rendering.
// World Z is never race distance: `s` (route units, 100 per sample) is derived from
// position with projectRoute.
///////////////////////////////////////////////////////////////////////////////

let worldChunks=[], worldKey;
const bermStart=.88; // the berm is the outer 12% of the half width

// 0 turns the scenery height envelope off (buildScenery: every piece its own random
// height; Terser folds it out): to compare, or as a size cut
const heightEnvelope=1;

// a pose matrix from an orthonormal frame: columns right, up, forward, translation
function routeFrame(p,right,up,forward)
{
    return new DOMMatrix([right.x,right.y,right.z,0,up.x,up.y,up.z,0,
        forward.x,forward.y,forward.z,0,p.x,p.y,p.z,1]);
}

// the smooth route frame at route distance s (interpolated between two samples)
class TrackSegmentInfo
{
    constructor(s)
    {
        const i=this.segmentIndex=wrapSegment(s/trackSegmentLength),
            u=mod(s/trackSegmentLength,1);
        const a=track[i], b=track[wrapSegment(i+1)];
        this.pos=a.pos.lerp(b.pos,u);
        this.w=a.w;
        this.forward=a.forward.lerp(b.forward,u).normalize();
        this.right=a.right.lerp(b.right,u).normalize();
        // re-orthogonalise after the lerp: up from forward and right, then right again
        this.up=this.forward.cross(this.right).normalize();
        this.right=this.up.cross(this.forward).normalize();
        this.roll=lerp(u,a.roll,b.roll);
        this.pitch=lerp(u,a.pitch,b.pitch);
        this.heading=Math.atan2(this.forward.x,this.forward.z);
    }

    // a world point at lateral x on the road surface, `lift` units above it along the
    // frame's up. The surface is flat, then a quadratic berm rising 80 units at the wall
    // (the bank itself is in the frame's right vector)
    point(x,lift=0)
    {
        return this.pos.add(this.right.scale(x)).addSelf(this.up.scale(80*clamp((abs(x)/this.w-bermStart)/(1-bermStart))**2+lift));
    }
}

const sampleRoute=(s,x,lift=0)=>new TrackSegmentInfo(s).point(x,lift);

// world position -> route distance and lateral offset, searching only the 25 segments
// around `hint` (the craft's last s). The window is what keeps a craft on its own deck
// at a crossing and on its own branch of a hairpin, where the other branch can be
// nearer in space.
function projectRoute(p,hint)
{
    let best=1e30, result=hint;
    const base=Math.floor(hint/trackSegmentLength);
    for(let k=-12;k<=12;++k)
    {
        const i=wrapSegment(base+k), a=track[i].pos, b=track[wrapSegment(i+1)].pos;
        const d=b.subtract(a), v=p.subtract(a), u=clamp(v.dot(d)/d.dot(d)); // nearest point on the segment
        const distance=v.subtract(d.scale(u)).mag();
        if(distance<best)
        {
            best=distance;
            result=(base+k+u)*trackSegmentLength;
        }
    }
    const info=new TrackSegmentInfo(result);
    return {s:result, x:p.subtract(info.pos).dot(info.right), info};
}

///////////////////////////////////////////////////////////////////////////////
// World build: everything for one circuit is baked once, before the first frame.
// Same-circuit retries keep the buffers (worldKey); a new seed or circuit disposes them.

function disposeWorld()
{
    for(const c of [...worldChunks,skylineMesh,skyMesh,skyKitMesh]) c && c.dispose();
    worldChunks=[];
}

function buildCourseWorld()
{
    const N=track.length;
    glEnableFog=0; // baked vertices carry a nofog bit (glPushVert): the sky is never fogged
    const L=levelInfo;

    // The sky: three colours, the mid band 18 degrees up, the horizon colour solid below it.
    // It is drawn first with no depth, so its scale is free: small enough that the SPECTRUM
    // flag's position phase (webgl.js, height weighted) makes under one rainbow up the
    // finale's sky. The finale replaces the two upper bands with six spectrum bands from
    // the horizon up, brightest at the horizon and black by 45 degrees up: the driving
    // camera only sees the first 20 degrees of sky, so the rainbow must start at the horizon.
    skyMesh=glBake(()=>{
        const band=(y,h,a,b=a)=>glPush([vec3(-3e3,y+h,1200),vec3(3e3,y+h,1200),vec3(-3e3,y-h,1200),vec3(3e3,y-h,1200)],0,[a,a,b,b]), grey=k=>rgb(k/8,k/8,k/8);
        if(L.rainbow)
        {
            glEmissive=8; // SPECTRUM: the greys become the moving rainbow in the shader
            for(let k=0;k<6;++k) band(100+k*200,100,grey(5-k),grey(6-k));
            glEmissive=0;
        }
        else
        {
            band(1000,600,L.skyColorTop,L.skyColorMid);
            band(200,200,L.skyColorMid,L.skyColorBottom);
        }
        band(-800,800,L.skyColorBottom);
    });

    // The sky kit is circles only, baked on a 140k sphere in world direction: a sun with a
    // halo (big and low, or small and high), an eclipse for the void, stars, and clouds as
    // rows of spread soft ovals. sky bits: 1 low sun, 2 stars, 4 clouds, 8 eclipse,
    // 16 a giant sun, 32 a two-colour sun (the accent on the halo and the outer disc)
    skyKitMesh=glBake(()=>{
        // the fan faces the origin: its rotation is the direction's pitch and yaw
        const disc=(dir,size,color,soft=1,flat)=>{
            dir=dir.normalize();
            pushGlow(dir.scale(140000),size,color,soft,16,vec3(-Math.asin(dir.y),Math.atan2(dir.x,dir.z)),flat);
        };
        const sky=L.sky, sun=sunDirection(),
            size=sky&16?60000:sky&1?30000:11000, // a giant sun, a big low one, or small and high
            sc=sky&40?L.accentColor:L.sunColor; // the halo: the accent on the eclipse and the two-colour sun
        disc(sun,size*2.4,rgb(sc.r,sc.g,sc.b,.5)); // the halo

        // the sun itself is three soft discs stacked (.7, .95, 1.2 of size): a hot core with no
        // hard rim. Never one opaque fan: it draws a hairline up its seam on some GPUs although
        // the baked seam vertices are bitwise identical (the rasterizer, not the data); a
        // hairline on a soft edge is invisible. The outer disc (k 2) takes the halo's colour,
        // so a two-colour sun has a ring
        for(let k=3;k--;) disc(sun,size*(.7+k*.25),sky&8?BLACK:(k>1?sc:L.sunColor).lerp(WHITE,.3));

        // stars: a thousand hard-edged white discs anywhere above the horizon
        if(sky&2) for(let i=0;i<1e3;++i) disc(vec3(random.float(-1,1),random.float(),random.float(-1,1)),random.float(9,1e3),WHITE,0);

        // clouds: 24 rows of five soft discs, each row spread sideways along its own tangent
        // and jittered a little in height, flattened to .4 of their width (round clouds look
        // odd); the horizon colour lifted toward white, less on big-sun circuits
        if(sky&4) for(let i=0;i<24;++i)
        {
            const yaw=random.float(2*PI),
                d=vec3(Math.sin(yaw),random.float(.04,.3),Math.cos(yaw)),
                c=L.skyColorBottom.lerp(WHITE,L.sky&1?.3:.5);
            c.a=.3;
            for(let k=0;k<5;++k)
                disc(d.add(vec3(Math.cos(yaw),0,-Math.sin(yaw)).scale(random.float(-.2,.2)).addSelf(vec3(0,random.float(-.02,.02)))),random.float(8000,20000),c,1,.4);
        }
    });

    debug && (roadPanels=[]);

    // the frame at every sample: forward toward the next sample, right tilted by the bank
    // (positive roll lowers the right edge, so a right corner banks inward), up from both
    trackMapPts=[];
    for(let i=0;i<N;++i)
    {
        const t=track[i], next=track[wrapSegment(i+1)];
        t.forward=next.pos.subtract(t.pos).normalize();
        const h=Math.atan2(t.forward.x,t.forward.z), r=vec3(Math.cos(h),0,-Math.sin(h)); // flat right vector
        const up=t.forward.cross(r).normalize(), bank=Math.atan(t.roll); // roll is a slope, bank the angle
        t.right=r.scale(Math.cos(bank)).subtract(up.scale(Math.sin(bank)));
        t.up=t.forward.cross(t.right).normalize();
        t.pitch=-Math.asin(t.forward.y); // climbing is negative
        // every 8th sample: the minimap and the scenery's plan queries
        i%8 || trackMapPts.push([t.pos.x,t.pos.z]);
    }

    // the loop's bounding box: minimap centre and half extent, also the scenery's search area
    const mm=a=>[Math.min(...a),Math.max(...a)], [x0,x1]=mm(trackMapPts.map(p=>p[0])), [z0,z1]=mm(trackMapPts.map(p=>p[1]));
    trackMapCenter=vec3((x0+x1)/2,0,(z0+z1)/2);
    trackMapRadius=max(x1-x0,z1-z0)/2;

    // The road is a causeway: the ground plane sits `drop` below the lowest centre sample,
    // but never closer than 150 to a banked outer EDGE (half width times the roll): measured
    // from the centre alone it cuts a ground-coloured wedge across the banked corners.
    groundY=Math.min(...track.map(t=>min(t.pos.y-levelInfo.drop,t.pos.y-t.w*abs(t.roll)-150)));

    // a 200-unit slab whose top face is groundY, its half extent twice the loop's plus
    // 150,000: far past the fog in a race, and the menu camera never sees its edge from above
    groundMatrix=buildMatrix(vec3(trackMapCenter.x,groundY-100,trackMapCenter.z),0,vec3(trackMapRadius*2+150000,100,trackMapRadius*2+150000));

    buildScenery(track[0].w); // the width is constant around a circuit
    skylineMesh.stored=1; skylineMesh.upload(); // stored: the vertices carry colour and glow

    // 63 road chunks of 64 samples, all drawn every frame, never culled: nothing pops
    for(let first=0;first<N;first+=64) worldChunks.push(glBake(()=>buildRoadChunk(first,min(first+64,N))));
    debug && ++worldBuildCount;
    worldKey=currentCircuit;
}

///////////////////////////////////////////////////////////////////////////////
// Road chunks: strips between two route frames, baked once with stored material flags.

function buildRoadChunk(first,end)
{
    glEnableFog=1; // the road is fogged (the sky bake before it turned fog off)
    for(let i=first;i<end;)
    {
        const t=track[i];
        // Short sections at markings; broad, low-poly panels elsewhere. Four samples keep
        // even the banked edge within the craft-scale error budget. Single panels: any
        // marking (roadType), the grid area (the finish checker at samples 2..29) and every
        // 24th sample (the cross line). Panels align to 4, so every 24th sample starts one.
        let step=min(4-i%4,end-i);
        if(t.roadType || i<32 || i%24==0) step=1;
        // never straddle a marking change
        for(let k=1;k<step;++k) if(track[wrapSegment(i+k)].roadType!=t.roadType) step=k;
        debug && roadPanels.push([i,step]);
        const a=new TrackSegmentInfo(i*trackSegmentLength), b=new TrackSegmentInfo((i+step)*trackSegmentLength);

        // a strip from lateral x1 to x2 between the two frames, `lift` above the surface; the
        // normal is always the frame's up
        const strip=(x1,x2,color,lift=0)=>{const n=a.up;glPush([a.point(x2,lift),a.point(x1,lift),b.point(x2,lift),b.point(x1,lift)],[n,n,n,n],color);};
        const w=a.w, ac=levelInfo.archColor;
        glSpecularity=.35;

        // The surface: two strips per side to follow the berm's quadratic rise and a flat centre
        // cut at every lane edge, where an 18-wide piece IS the lane line: a third emissive and a
        // third toward the road colour. Never lifted strips: a 4-sample panel's twisted centre
        // quad strays up to 37 units from a flat strip, so on curve entries lifted lines sink
        // into the road and read as dashes.
        // The centre is a shade lighter every other 24 samples so the road itself reads speed, and
        // the cross line is the whole centre of every 24th (single) panel. No lines under the
        // finish checker (samples 2..29): they bleed through it at glancing angles.
        const checker=i>=2 && i<30, cross=i%24==0 && !checker;
        const road=levelInfo.roadColor.lerp(WHITE,i%48<24?.05:0), line=levelInfo.lineColor.lerp(levelInfo.roadColor,cross?.6:.35);
        const cuts=[-w,-w*.94,-w*bermStart];
        if(!checker) for(let x=-w+laneWidth;x<w-laneWidth/2;x+=laneWidth) cuts.push(x-9,x+9);
        cuts.push(w*bermStart,w*.94,w);
        for(let k=1;k<cuts.length;++k)
        {
            // the lane lines are the even pieces 4..length-4, and the cross line spans the first
            // to the last of them, not berm to berm (it would overhang the outer lane lines)
            const isLine=k>3 && k<cuts.length-3 && (cross || k%2==0);
            glEmissive=isLine?.35:0;
            strip(cuts[k-1],cuts[k],isLine?line:road);
        }

        // the rough shoulder (roadType 3, trackGen.js): the outer two and a half lanes on the
        // padX side carry bright white dashes, one every other 4-sample panel, lifted 8
        if(t.roadType==3 && i&4) glEmissive=.5, strip(t.padX*w*bermStart,t.padX*(w*bermStart-2.5*laneWidth),WHITE,8);

        // Solid wall inner faces (240 tall, facing the road) with a continuous emissive
        // light rail along the top: the readable edge at speed.
        for(const side of [-1,1])
        {
            // the left wall lists its points top first, so both walls face inward
            const x=side*w, normal=a.right.scale(-side), lo=120-120*side, hi=240-lo;
            glEmissive=0; glPush([a.point(x,lo),a.point(x,hi),b.point(x,lo),b.point(x,hi)],[normal,normal,normal,normal],ac.lerp(BLACK,.72));

            // the rail: the wall-light strip along the wall's top, 140 wide, lifted 22 above it
            // so the wall's edge never pokes through on a twisted panel. Dashed: white for 24
            // samples, the band colour for 24, the road shade's rhythm; on the finale the band
            // sweeps the hues like its tunnel
            glEmissive=.65; strip(x-70,x+70,i%48<24?WHITE:levelInfo.rainbow?hsl(i/240,1,.6):levelInfo.edgeColor,262); glEmissive=0;
        }
        glSpecularity=0;

        // The lifted markings sit 15 up: a single-sample panel's twist reaches about 10 (a quarter
        // of a 4-sample panel's), so a smaller lift sinks at curve entries.
        glEmissive=5; // emissive + PULSE (webgl.js): the pads flash toward white
        if(t.roadType==1) strip(t.padX-700,t.padX+700,rgb(1,1,0),15); // a boost pad, 1,400 wide on its lane
        glEmissive=9; // SPECTRUM: one white strip becomes the moving rainbow in the shader
        // the recharge strip, on its padX side
        if(t.roadType==2) strip((w-150)*t.padX,(w-levelInfo.stripWidth)*t.padX,WHITE,15);
        glEmissive=0;

        // the finish line: a checker of 8 cells across the flat width, 4 rows of 7 samples
        // ending at the start line (samples 2..29); each cell is about 1,000 wide by 900 long
        if(checker)
            for(let k=0;k<8;++k) strip((k/4-1)*w*bermStart,((k+1)/4-1)*w*bermStart,(k+((i-2)/7|0))%2?WHITE:BLACK,15);
        i+=step;
    }
}

///////////////////////////////////////////////////////////////////////////////
// Draw functions, in the order scene.js calls them after the sky: road, scenery, then
// (after the craft) the additive trails. Baked vertices are already in world space, so
// the road and scenery render with an identity matrix.

function drawTrack()
{
    glSetDepthTest(); glEnableLighting=1;
    cubeMesh.render(groundMatrix,levelInfo.groundColor); // every circuit has a ground plane
    for(const c of worldChunks) c.render();
}

function drawScenery()
{
    // colour, glow and the finale's spectrum are in the vertices; the GL flags are as
    // drawTrack left them
    skylineMesh.render();
}

// every trail is additive light (the black craft's is white); the head is full alpha and
// fades along the ribbon. A boost widens the ribbon 2.5 times, brightens its whole length
// and swells the nozzle glow, all in the craft's colour: only the white craft rides the
// rainbow (the rainbow is reserved for recharge, the finale and the title)
function drawTrails()
{
    // the ribbon is additive light, like the glows beside it: never fogged. Fog mixes RGB
    // toward the horizon colour without touching alpha, so a fogged additive vertex ADDS
    // the horizon colour at distance instead of fading out -- a far ribbon smeared the sky
    // with its own band of horizon red. The baked glow fans carry their own nofog bit
    // (drawInit), so only these pushed vertices needed it (Frank, 2026-09-19: both the same)
    glEnableFog=0;
    for(const v of vehicles)
    {
        // the explosion: for 1.2 s after a death, six soft discs in the craft's colour around a
        // white core fly outward and fade. deadUntil is the death time plus 2
        const boom=(time-v.deadUntil+2)/1.2;
        if(v.deadUntil && boom<1) for(let k=0;k<7;++k)
        {
            const c=k?v.glowColor:WHITE, a=k*.9;
            pushGlow(v.pos.add(vec3(Math.sin(a)*boom*900,300*boom+k*40,Math.cos(a)*boom*900)),300+1800*boom,rgb(c.r,c.g,c.b,1-boom));
        }

        // a hard hit (wall or craft): a small burst of four discs in the craft's colour for .3 s,
        // so damage shows. hitTime is the hit plus .3, like wallTime
        const hit=1-(v.hitTime-time)/.3;
        if(hit<1) for(let k=0;k<4;++k)
            pushGlow(v.pos.add(vec3(Math.sin(k*1.6)*hit*300,80+k*30,Math.cos(k*1.6)*hit*300)),120+400*hit,rgb(v.glowColor.r,v.glowColor.g,v.glowColor.b,1-hit));

        // charging on the strip (v.charging): three small white sparks circling under the hull
        // (rainbow sparks were invisible: additive rainbow over the rainbow strip adds nothing)
        if(v.charging) for(let k=0;k<3;++k)
        {
            const a=time*9+k*2.1;
            // in the craft's own frame (right/forward/up), 30 under the hull: a world-flat ring
            // would tilt against the hull on a banked strip
            pushGlow(v.pos.add(v.up.cross(v.forward).scale(Math.sin(a)*200)).addSelf(v.forward.scale(Math.cos(a)*200)).addSelf(v.up.scale(-30)),140,WHITE);
        }

        const boost=v.burn; // eased 0..1 (stepVehicle), so a turbo swells in like the throttle does
        let last;

        // the ribbon, newest sample first (vehicle.js unshifts); none on the grid or after a stop
        if(v.speed>1000) for(let j=0;j<v.trail.length;++j)
        {
            // a boost brightens the whole ribbon
            const t=v.trail[j], p=t[0], fade=(1-j/v.trail.length)**(1-boost/2);

            // the white craft (index 7) rides the rainbow, moving along the ribbon and with time;
            // everyone else is their own colour, lifted 10% at the head
            const color=v.racerIndex==7?hsl(j/8+time/3,1,.65):v.glowColor.lerp(WHITE,fade*.1);
            color.a=fade;

            // half width: 2.5 times under boost, half off the gas, a quarter on the brake (throttle -.5)
            const right=t[1].scale((50+75*boost)*(.5+.5*v.throttle));
            if(last)
                glPush([last[0].add(last[1]),last[0].subtract(last[1]),p.add(right),p.subtract(right)],0,color);
            last=[p,right];
        }

        // each nozzle: a soft glow in the craft's colour with a small hard white core, both bigger
        // under boost and never off: a third of the size at rest (the engines are lit on the
        // grid), .15 of it on the brake
        const idle=max(.15,.35+.65*v.throttle);
        for(const p of v.nozzles)
        {
            pushGlow(p,300*idle+400*boost,v.glowColor);
            pushGlow(p,100*idle+150*boost,WHITE,0);
        }
    }
    glEnableFog=1; // back on for the next frame's hulls and canopy, which are not stored meshes
    glRender();
}

function drawTrackScenery()
{
    // depth tested but never written: light never occludes light
    glSetDepthTest(0); glEnableLighting=0; glSetAdditive(1);
    drawTrails();
    glSetAdditive(0);
}

///////////////////////////////////////////////////////////////////////////////
// Scenery fills the world in four bands: speed cues beside the road, mid-field districts,
// an infield fill inside the loop and far giants, plus the arches and the corner arrows.
// Everything welds into ONE stored mesh (skylineMesh) so it is one draw; nothing has a
// collider. Placement draws from `random` LAST in buildTrack so nothing placed before it
// moves.

let skylineMesh, groundMatrix, groundY;

function buildScenery(w)
{
    const body=skylineMesh=new Mesh;

    // on the eclipse circuit (UMBRA) the accent buildings are black silhouettes: a third of
    // its districts and infield, 30% of the cues; the eclipse halo reads
    // levelInfo.accentColor itself
    const theme=levelInfo.theme, N=track.length, ac=levelInfo.archColor, accent=levelInfo.sky&8?BLACK:levelInfo.accentColor;

    // the circuit's scenery palette: the band, its complement, a light neutral; giants are dark
    const palette=[ac.lerp(BLACK,.25),accent,ac.lerp(WHITE,.5)], dark=ac.lerp(BLACK,.55);

    // a pyramid along +z: the loft's diamond section at z=0 tapering to a point at z=1
    const spike=buildLoft([[1,0,0,0],[0,1,1,-1]]);

    // the shape languages (levels.js theme): every piece is loft kit parts welded into the body
    const put=body.combine.bind(body); // (mesh,pos,rot,scale,color,mat)

    // a box of half width r from 600 below the base to height h (sunk so a gap never shows)
    const block=(p,h,r,yaw,c)=>put(cubeMesh,p.add(vec3(0,h/2-300)),vec3(0,yaw),vec3(r,h/2+300,r),c);

    // a thin band around the block at .7 of its height: the lamp ring pulses (.7 emissive + PULSE)
    // in the accent; the finale's is white and rides the spectrum (.7 + SPECTRUM)
    const ring=(p,h,r,yaw)=>put(cubeMesh,p.add(vec3(0,h*.7)),vec3(0,yaw),vec3(r+20,90,r+20),levelInfo.rainbow?WHITE:accent,levelInfo.rainbow?8.7:4.7);

    // a prism standing upright, faintly emissive
    const crystal=(p,h,r,yaw,c)=>put(prismMesh,p.add(vec3(0,h/2)),vec3(0,yaw),vec3(r,h/2,r),c,.35);

    // (p, h, r, yaw, colour) -> welds one piece. rot -PI/2 about x stands the spike up.
    const shapes=[
        // 0 spike
        (p,h,r,yaw,c)=>put(spike,p,vec3(-PI/2,yaw),vec3(r,r,h),c),
        // 1 city block with a lamp ring
        (p,h,r,yaw,c)=>{
            block(p,h,r,yaw,c);
            ring(p,h,r,yaw);
        },
        // 2 crystal
        crystal,
        // 3 ziggurat: three blocks, each 30% smaller
        (p,h,r,yaw,c)=>{for(let k=0;k<3;++k)block(p,h*(1-k*.3),r*(1-k*.3),yaw,c);},
        // 4 floating slab: a thin spike holding a tilted wide slab at h
        (p,h,r,yaw,c)=>{
            put(spike,p,vec3(-PI/2,yaw),vec3(r*.3,r*.3,h),c);
            put(cubeMesh,p.add(vec3(0,h)),vec3(.2,yaw,.15),vec3(r*2,r*.25,r*2),c);
        },
        // 5 spire: a narrow block, a spike on top, a lamp ring
        (p,h,r,yaw,c)=>{
            block(p,h,r*.4,yaw,c);
            put(spike,p.add(vec3(0,h)),vec3(-PI/2,yaw),vec3(r*.4,r*.4,h*.4),c);
            ring(p,h,r*.4,yaw);
        },
        // 6 crystal again (the slot keeps the theme indices in place)
        crystal,
        // 7 monolith: tall and narrow
        (p,h,r,yaw,c)=>block(p,h*1.6,r*.5,yaw,c),
    ];
    debug && (skylineSites=[]);

    // plan queries against the minimap samples (every 8th route sample): the SQUARE of the
    // distance to the nearest one, and an even-odd inside-the-loop test. Every caller compares
    // against a squared threshold, so no square root and no Math.hypot: this runs over 500
    // route points for each of a thousand candidate spots
    const near2=(x,z)=>{
        let d=1e18;
        for(const [px,pz] of trackMapPts) d=min(d,(x-px)**2+(z-pz)**2);
        return d;
    };
    const inside=(x,z)=>{
        let hit=0;
        for(let i=0,j=trackMapPts.length-1;i<trackMapPts.length;j=i++)
        {
            const [ax,az]=trackMapPts[i],[bx,bz]=trackMapPts[j];
            if(az>z!=bz>z && x<(bx-ax)*(z-az)/(bz-az)+ax) hit=!hit;
        }
        return hit;
    };

    // one piece standing on the ground plane, in a colour. Three in four speak the circuit's
    // shape language, the rest the (theme+3)%8 language. Returns 1 if it was placed.
    const piece=(x,z,h,radius,yaw,color)=>{
        const clear=w+radius*2+500; let y=groundY;

        // never inside the road or its walls (radius*2: the floating slab reaches twice its
        // radius sideways)
        if(near2(x,z)<clear**2) return 0;
        debug && skylineSites.push([x,z,radius*2,h]);

        // the height envelope: one slow wave over the ground scales every piece by .5-1.5, so
        // neighbours share a ridge or a shelf instead of each rolling its own height (a
        // wavelength of about 60,000 units: a district 5,000 across sits on one crest)
        const e=heightEnvelope?1+.5*Math.sin((x+z*.7)/12000):1;
        h*=e;
        const shape=random.float()<.75?theme:(theme+3)%8;

        // scenery bit 32, the canyon: a plinth of .55-1.25 of the drop under every piece
        // (mostly from the envelope; .5-1.1 at random without it), so the towers stand in the
        // deep ground and most top out below the road, a few above it. Bit 64 lifts the range
        // by .4, so more peak above (UMBRA)
        if(levelInfo.scenery&32)
        {
            const lift=levelInfo.scenery&64?.4:0, d=levelInfo.drop*(heightEnvelope?.3+lift+.5*e+random.float(.2):random.float(.5+lift,1.1+lift));
            put(cubeMesh,vec3(x,y+d/2,z),vec3(0,yaw),vec3(radius,d/2,radius),color), y+=d;
        }
        shapes[shape](vec3(x,y,z),h,radius,yaw,color);
        return 1;
    };

    // near band: speed cues beside the road, alternating sides, skipping the first 72 samples
    // (the start line and the grid area), each facing the road's heading. Every 12 samples,
    // in a short, short, tall rhythm at a steady setback so they read as a beat at speed
    // (independent random height, width and setback read as scattered posts). The start, 72,
    // must be a multiple of both strides: the counter k below has to be whole
    const step=levelInfo.scenery&4?24:12; // scenery bit 4: sparse cues on the open circuits
    for(let i=72;i<N;i+=step)
    {
        const k=i/step, p=sampleRoute(i*trackSegmentLength,(k%2?1:-1)*(w+1800+random.float(600)));
        piece(p.x,p.z,(k%3==2?2800:1200)+random.float(400),random.float(220,400),trackHeadingCum[i],random.float()<.3?accent:palette[0]);
    }

    // corner arrows: on every chevron sample (trackGen: every 24 samples before and through a
    // corner) one pulsing arrow stands beside the OUTSIDE wall in the wall light colour,
    // pointing into the corner; on the finale they sweep the hues like its tunnel and rail.
    // The prism is rolled a quarter turn so its apex points across the road (chev>0 is a
    // right corner: arrow on the left, apex to +x), then yawed to the road: 800 tall, 800
    // long, 80 thin
    const arrow=side=>new Mesh().combine(prismMesh,0,vec3(0,0,-side*PI/2));
    const arrows=[arrow(-1),0,arrow(1)]; // by chev+1
    for(let i=0;i<N;i+=24) if(track[i].chev)
    {
        const p=sampleRoute(i*trackSegmentLength,-track[i].chev*(w+500),450);
        put(arrows[track[i].chev+1],p,vec3(0,trackHeadingCum[i]),vec3(400,400,40),levelInfo.rainbow?hsl(i/240,1,.6):levelInfo.edgeColor,4.7);
    }

    // arches (SK_ARCH edges): a level lintel across the road on two posts of one height beside
    // the walls, in the accent, set out from the road centre along its HORIZONTAL heading (on
    // the banked frame one post would stand higher under a flat lintel). Four styles from two
    // more flags: SK_BIG half again as tall, thick and wide-spaced, SK_DENSE one every 12
    // samples with a lintel nearly that long, so the run reads as a tunnel with slits
    for(let i=0;i<N;i+=12)
    {
        const f=track[i].flags, big=f&SK_BIG?1.5:1;
        if(!(f&SK_ARCH) || i%(f&SK_DENSE?12:24*big)) continue;
        const h=trackHeadingCum[i], p=sampleRoute(i*trackSegmentLength,0), r=vec3(Math.cos(h),0,-Math.sin(h)), yaw=vec3(0,h),
            d=f&SK_DENSE?600*routeScale-100:300*big, top=2400*big;
        // the finale's tunnel sweeps the hues, a rainbow every 240 samples
        const col=levelInfo.rainbow?hsl(i/240,1,.6):accent;
        put(cubeMesh,p.add(vec3(0,top)),yaw,vec3(w+1100,150*big,d),col);
        for(const side of [-1,1]) put(cubeMesh,p.add(r.scale(side*(w+900))),yaw,vec3(200*big,top+150*big,d),col);
    }

    // mid field: seeded groups with a shared yaw, seeded sideways from the route so the
    // band fills evenly; the groups stay outside the loop except on city circuits (theme 1)
    const R=trackMapRadius+30000, c=trackMapCenter;
    for(let g=0,tries=0;g<60*levelInfo.density&&tries<900;++tries)
    {
        const p=sampleRoute(random.int(N)*trackSegmentLength,random.sign()*(w+random.float(4000,25000))),
            x=p.x, z=p.z;
        if(near2(x,z)<(w+4000)**2 || theme!=1 && inside(x,z)) continue;
        ++g;

        // a district: one colour from the palette per group, so colour reads as place
        const yaw=random.float(2*PI), count=random.int(3,8), color=palette[random.int(3)].lerp(BLACK,random.float(.3));
        for(let k=0;k<count;++k)
            piece(x+random.float(-5000,5000),z+random.float(-5000,5000),random.float(3000,12000),random.float(900,2200),yaw,color);
    }

    // infield: fill the inside of the loop with spaced, varied pieces in the palette so they
    // read as place, not skyline. A thousand random spots; bail when too close to the road or
    // to another infield piece, so the centre fills without crowding (scenery bit 128 halves
    // that spacing: CHERENKOV, about twice the pieces). inside() is even-odd, so a figure
    // eight fills both lobes; a narrow infield simply takes fewer
    const placed=[]; // [x, z, radius] of every infield piece, for the spacing test
    for(let tries=0;tries<1000;++tries)
    {
        const x=c.x+random.float(-trackMapRadius,trackMapRadius), z=c.z+random.float(-trackMapRadius,trackMapRadius),
            h=random.float(4000,26000), r=h*random.float(.12,.2);
        if(near2(x,z)<(w+r*1.5+2500)**2 || !inside(x,z) || placed.some(([px,pz,pr])=>(x-px)**2+(z-pz)**2<((r+pr)*(levelInfo.scenery&128?1.5:3)+3000)**2)) continue;
        placed.push([x,z,r]);
        piece(x,z,h,r,random.float(2*PI),palette[random.int(3)].lerp(BLACK,.3));
    }

    // far skyline: a few dark giants 25k-80k out
    const giant=levelInfo.scenery&2?2:1; // scenery bit 2: colossal giants, twice the size
    for(let g=0,tries=0;g<12&&tries<400;++tries)
    {
        const x=c.x+random.float(-R-50000,R+50000), z=c.z+random.float(-R-50000,R+50000), d=near2(x,z);
        if(d<25000**2 || d>80000**2) continue;
        g+=piece(x,z,random.float(15000,30000)*giant,random.float(2500,4000)*giant,random.float(2*PI),dark);
    }
}

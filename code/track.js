'use strict';

// A route is navigation metadata. Surface vertices and the camera live in a single
// permanent world; no road positions are rebuilt during simulation or rendering.
let worldChunks=[], worldKey;
const bermStart=.88;
const trackProfileY=(x,w,roll=0)=>-x*roll+80*clamp((abs(x)/w-bermStart)/(1-bermStart))**2;

function routeFrame(p,right,up,forward)
{
    return new DOMMatrix([right.x,right.y,right.z,0,up.x,up.y,up.z,0,
        forward.x,forward.y,forward.z,0,p.x,p.y,p.z,1]);
}

class TrackSegmentInfo
{
    constructor(s)
    {
        const i=this.segmentIndex=wrapSegment(s/trackSegmentLength), u=mod(s/trackSegmentLength,1);
        const a=track[i], b=track[wrapSegment(i+1)];
        this.pos=a.pos.lerp(b.pos,u); this.width=lerp(u,a.width,b.width);
        this.forward=a.forward.lerp(b.forward,u).normalize();
        this.right=a.right.lerp(b.right,u).normalize();
        this.up=this.forward.cross(this.right).normalize();
        this.right=this.up.cross(this.forward).normalize();
        this.roll=lerp(u,a.roll,b.roll); this.pitch=lerp(u,a.pitch,b.pitch);
        this.heading=Math.atan2(this.forward.x,this.forward.z);
    }
    point(x=0,lift=0)
    {
        return this.pos.add(this.right.scale(x)).addSelf(this.up.scale(trackProfileY(x,this.width)+lift));
    }
}
const sampleRoute=(s,x=0,lift=0)=>new TrackSegmentInfo(s).point(x,lift);

function projectRoute(p,hint)
{
    let best=1e30, result=hint;
    const base=Math.floor(hint/trackSegmentLength);
    // Continuity excludes another deck or a far-away branch of a hairpin.
    for(let k=-12;k<=12;++k)
    {
        const i=wrapSegment(base+k), a=track[i].pos, b=track[wrapSegment(i+1)].pos;
        const d=b.subtract(a), v=p.subtract(a), u=clamp(v.dot(d)/d.dot(d));
        const distance=v.subtract(d.scale(u)).length();
        if(distance<best) best=distance, result=(base+k+u)*trackSegmentLength;
    }
    const info=new TrackSegmentInfo(result);
    return {s:result, x:p.subtract(info.pos).dot(info.right), info};
}

function disposeWorld()
{
    for(const c of [...worldChunks,skylineMesh,skyMesh,skyKitMesh]) c && c.dispose();
    worldChunks=[];
}

function buildCourseWorld()
{
    const N=track.length;
    glEnableFog=0;
    const L=levelInfo;
    // the sky: three colours, the mid band 18 degrees up, the horizon colour solid below it. it is
    // drawn first with no depth, so its scale is free: small enough that the SPECTRUM flag's
    // world-position phase (webgl.js, height weighted) makes under one rainbow up the finale's sky,
    // which is six flagged bands fading from light to the black mid line
    skyMesh=glBake(()=>{
        const band=(y,h,a,b)=>pushGradient(vec3(0,y,1200),vec3(3000,h),a,b), grey=k=>rgb(k/8,k/8,k/8);
        if(L.rainbow) { glEmissive=8; for(let k=0;k<6;++k) band(500+k*200,100,grey(k+1),grey(k)); glEmissive=0; }
        else band(1000,600,L.skyColorTop,L.skyColorMid);
        band(200,200,L.skyColorMid,L.skyColorBottom);
        band(-800,800,L.skyColorBottom);
    });
    // the sky kit is circles only (Frank's cut, 2026-09-08), baked on a 140k sphere in world
    // direction: a sun with a halo (big and low, or small and high), an eclipse for the void,
    // stars, and clouds as rows of spread soft discs. sky bits: 1 low sun, 2 stars, 4 clouds, 8 eclipse
    skyKitMesh=glBake(()=>{
        const disc=(dir,size,color,soft=1,sides=16)=>{
            dir=dir.normalize(); // the fan faces the origin
            pushGlow(dir.scale(140000),size,color,soft,sides,vec3(-Math.asin(dir.y),Math.atan2(dir.x,dir.z)));
        };
        const sky=L.sky, sun=sunDirection(), size=sky&1?30000:11000, sc=sky&8?L.accentColor:L.sunColor;
        disc(sun,size*2.4,rgb(sc.r,sc.g,sc.b,.5));
        disc(sun,size,sky&8?BLACK:sc.lerp(WHITE,.3),0);
        if(sky&2) for(let i=0;i<200;++i) disc(vec3(random.float(-1,1),random.float(.03,1),random.float(-1,1)),random.float(300,1200),WHITE,0);
        if(sky&4) for(let i=0;i<24;++i)
        {
            const yaw=random.float(2*PI), d=vec3(Math.sin(yaw),random.float(.04,.3),Math.cos(yaw)), c=L.skyColorBottom.lerp(WHITE,L.sky&1?.3:.5); c.a=.3;
            for(let k=0;k<5;++k) disc(d.add(vec3(Math.cos(yaw),0,-Math.sin(yaw)).scale(random.float(-.2,.2)).addSelf(vec3(0,random.float(-.02,.02)))),random.float(8000,20000),c);
        }
    });
    debug && (roadPanels=[]);
    trackMapPts=[];
    for(let i=0;i<N;++i)
    {
        const t=track[i], next=track[wrapSegment(i+1)];
        t.forward=next.pos.subtract(t.pos).normalize();
        const h=Math.atan2(t.forward.x,t.forward.z), r=vec3(Math.cos(h),0,-Math.sin(h));
        const up=t.forward.cross(r).normalize(), bank=Math.atan(t.roll);
        t.right=r.scale(Math.cos(bank)).subtract(up.scale(Math.sin(bank)));
        t.up=t.forward.cross(t.right).normalize();
        t.pitch=-Math.asin(t.forward.y);
        i%8 || trackMapPts.push([t.pos.x,t.pos.z]);
    }
    const xs=trackMapPts.map(p=>p[0]), zs=trackMapPts.map(p=>p[1]);
    trackMapCenter=vec3((Math.min(...xs)+Math.max(...xs))/2,0,(Math.min(...zs)+Math.max(...zs))/2);
    trackMapRadius=max(Math.max(...xs)-Math.min(...xs),Math.max(...zs)-Math.min(...zs))/2;
    // The road is a causeway: the ground plane sits `drop` below the lowest sample.
    groundY=Math.min(...track.map(t=>t.pos.y))-levelInfo.drop;
    groundMatrix=buildMatrix(vec3(trackMapCenter.x,groundY-100,trackMapCenter.z),0,vec3(trackMapRadius+90000,100,trackMapRadius+90000));
    buildScenery(track[0].width);
    skylineMesh.stored=1; skylineMesh.upload(); // stored: the vertices carry colour and glow
    // 63 road chunks, all drawn every frame: nothing pops, and 63 draws is nothing
    for(let first=0;first<N;first+=64) worldChunks.push(glBake(()=>buildRoadChunk(first,min(first+64,N))));
    glSpecularity=glEmissive=0; glEnableFog=1;
    debug && ++worldBuildCount;
    worldKey=trackSeed+':'+currentCircuit;
}

function roadQuad(a,b,c,d,color,normal)
{
    const n=normal || b.subtract(a).cross(c.subtract(a)).normalize();
    glPush([a,b,c,d],[n,n,n,n],color);
}

function buildRoadChunk(first,end)
{
    glEnableFog=1;
    for(let i=first;i<end;)
    {
        const t=track[i];
        // Short sections at markings; broad, low-poly panels elsewhere. Four
        // segments keep even the banked edge within the craft-scale error budget.
        let step=min(4,end-i);
        if(t.roadType || i<32 || i%24==0) step=1;
        for(let k=1;k<step;++k) if(track[wrapSegment(i+k)].roadType!=t.roadType) step=k;
        debug && roadPanels.push([i,step]);
        const a=new TrackSegmentInfo(i*trackSegmentLength), b=new TrackSegmentInfo((i+step)*trackSegmentLength);
        const strip=(x1,x2,color,lift=0)=>roadQuad(a.point(x2,lift),a.point(x1,lift),b.point(x2,lift),b.point(x1,lift),color,a.up);
        const w=a.width, ac=levelInfo.archColor;
        glSpecularity=.35; glEmissive=0;
        const cuts=[-w,-w*.94,-w*bermStart,w*bermStart,w*.94,w];
        for(let k=1;k<cuts.length;++k) strip(cuts[k-1],cuts[k],levelInfo.roadColor);
        // Solid wall inner faces and caps, with a continuous readable light rail.
        for(const side of [-1,1])
        {
            const x=side*w, normal=a.right.scale(-side);
            let q=[a.point(x),a.point(x,240),b.point(x),b.point(x,240)];
            if(side<0) q=[q[1],q[0],q[3],q[2]];
            glPush(q,[normal,normal,normal,normal],ac.lerp(BLACK,.72));
            glEmissive=.65; strip(x-35,x+35,levelInfo.edgeColor,240); glEmissive=0;
        }
        glSpecularity=0;
        for(let x=-w+laneWidth;x<w-laneWidth/2;x+=laneWidth)
            strip(x-6,x+6,levelInfo.lineColor.lerp(levelInfo.roadColor,.65),3);
        if(i%24==0) strip(-w*bermStart,w*bermStart,levelInfo.lineColor.lerp(levelInfo.roadColor,.8),3);
        glEmissive=5; // emissive + PULSE (webgl.js): the warning bands and pads flash toward white
        // corner warning: a band across the outside half of the road on the chevron beat
        // (trackGen), in the wall light colour. chev samples fall on the i%24 single panels
        if(t.chev) strip(t.chev>0?-w*bermStart:w*.3,t.chev>0?-w*.3:w*bermStart,levelInfo.edgeColor,4);
        if(t.roadType==1) strip(t.padX-350,t.padX+350,YELLOW,4);
        glEmissive=9; // SPECTRUM: one white strip becomes the moving rainbow in the shader
        if(t.roadType==2) strip(w-1750,w-150,WHITE,5);
        glEmissive=0;
        if(i>=26 && i<30)
            for(let k=0;k<12;++k) strip((k/6-1)*w*bermStart,((k+1)/6-1)*w*bermStart,(k+i)%2?WHITE:BLACK,5);
        i+=step;
    }
}

function drawTrack()
{
    glSetDepthTest(); glEnableFog=glEnableLighting=1;
    if(levelInfo.ground) cubeMesh.render(groundMatrix,levelInfo.groundColor);
    for(const c of worldChunks) c.render(new DOMMatrix);
}

function drawScenery()
{
    glEnableLighting=glEnableFog=1;
    skylineMesh.render(new DOMMatrix); // colour, glow and the finale's spectrum are in the vertices
}

// every trail is additive light (the black craft's is white); the head is full alpha and
// fades along the ribbon; a boost doubles the ribbon and the nozzle glow and splits the
// trail into spectrum (Frank, 2026-09-10: the rainbow comes from speed, not from a slide)
function drawTrails()
{
    glSetCapability(gl_CULL_FACE,0);
    for(const v of vehicles)
    {
        if(v.speed<1000) continue;
        const boost=v.boostTime>time;
        let last;
        for(let j=0;j<v.trail.length;++j)
        {
            const t=v.trail[j], p=t[0], fade=1-j/v.trail.length;
            const color=v.racerIndex==7||boost?hsl(j/8+time/3,1,.65):v.glowColor.lerp(WHITE,fade*.1);
            color.a=fade*levelInfo.trailAlpha;
            const right=t[1].scale(boost?110:50);
            if(last)
                glPush([last[0].add(last[1]),last[0].subtract(last[1]),p.add(right),p.subtract(right)],0,color);
            last=[p,right];
        }
        for(const p of v.nozzles)
            pushGlow(p,300+400*boost,v.glowColor), pushGlow(p,100+150*boost,WHITE,0);
    }
    glRender(); glSetCapability(gl_CULL_FACE);
}
function drawTrackScenery()
{
    glSetDepthTest(1,0); glEnableLighting=0; glSetAdditive(1);
    drawTrails();
    glSetAdditive(0);
}


///////////////////////////////////////////////////////////////////////////////
// Scenery fills the world in three distance bands from the road, plus corridors and
// one landmark. Everything welds into two meshes (body, lamps) so drawing is unchanged.
let skylineMesh, groundMatrix, groundY;
function buildScenery(w)
{
    const body=skylineMesh=new Mesh([],[]);
    const theme=levelInfo.theme, N=track.length, ac=levelInfo.archColor, accent=levelInfo.accentColor;
    // the circuit's scenery palette: the band, its complement, a light neutral; giants are dark
    const palette=[ac.lerp(BLACK,.25),accent,ac.lerp(WHITE,.5)], dark=ac.lerp(BLACK,.55); // the road floats: no legs
    const spike=buildLoft([[1,0,0,0],[0,1,1,-1]]);
    // the shape languages (levels.js theme): every piece is loft kit parts welded into the body
    const put=(mesh,pos,rot,scale,color,mat)=>body.combine(mesh,pos,rot,scale,color,mat);
    const block=(p,h,r,yaw,c)=>put(cubeMesh,p.add(vec3(0,h/2-300)),vec3(0,yaw),vec3(r,h/2+300,r),c);
    const ring=(p,h,r,yaw)=>put(cubeMesh,p.add(vec3(0,h*.7)),vec3(0,yaw),vec3(r+20,90,r+20),levelInfo.rainbow?WHITE:accent,levelInfo.rainbow?8.7:4.7); // the lamp ring pulses; the finale's is the spectrum
    const crystal=(p,h,r,yaw,c,lean=0)=>put(prismMesh,p.add(vec3(0,h/2-lean*r)),vec3(lean*random.float(-1,1),yaw,lean*random.float(-1,1)),vec3(r,h/2,r),c,.35);
    const shapes=[
        (p,h,r,yaw,c)=>put(spike,p,vec3(-PI/2,yaw),vec3(r,r,h),c),                                   // 0 spike
        (p,h,r,yaw,c,l)=>{block(p,h,r,yaw,c);ring(p,h,r,yaw);l&&put(prismMesh,p.add(vec3(0,h+2500)),vec3(0,yaw),vec3(r,2500,r),accent,4.7);}, // 1 city block, capped landmark
        crystal,                                                                                     // 2 crystal
        (p,h,r,yaw,c)=>{for(let k=0;k<3;++k)block(p,h*(1-k*.3),r*(1-k*.3),yaw,c);},                 // 3 ziggurat
        (p,h,r,yaw,c)=>{put(spike,p,vec3(-PI/2,yaw),vec3(r*.3,r*.3,h),c);put(cubeMesh,p.add(vec3(0,h)),vec3(.2,yaw,.15),vec3(r*2,r*.25,r*2),c);}, // 4 floating slab
        (p,h,r,yaw,c)=>{block(p,h,r*.4,yaw,c);put(spike,p.add(vec3(0,h)),vec3(-PI/2,yaw),vec3(r*.4,r*.4,h*.4),c);ring(p,h,r*.4,yaw);}, // 5 spire
        (p,h,r,yaw,c)=>crystal(p,h,r,yaw,c,.35),                                                     // 6 leaning shard
        (p,h,r,yaw,c)=>block(p,h*1.6,r*.5,yaw,c),                                                    // 7 monolith
    ];
    debug && (skylineSites=[]);
    // plan queries against the minimap samples: nearest route distance/height, inside test
    const nearest=(x,z)=>{
        let d=1e9,y=0;
        for(let i=0;i<trackMapPts.length;++i){const [px,pz]=trackMapPts[i],e=Math.hypot(x-px,z-pz);if(e<d)d=e,y=track[i*8].pos.y;}
        return [d,y];
    };
    const inside=(x,z)=>{
        let hit=0;
        for(let i=0,j=trackMapPts.length-1;i<trackMapPts.length;j=i++){
            const [ax,az]=trackMapPts[i],[bx,bz]=trackMapPts[j];
            if(az>z!=bz>z && x<(bx-ax)*(z-az)/(bz-az)+ax) hit=!hit;
        }
        return hit;
    };
    // one piece standing on the ground (or hung under the void road) in a colour: three in
    // four speak the circuit's shape language, the rest the (theme+3)%8 language
    const piece=(x,z,h,radius,yaw,color,landmark)=>{
        const [d,ry]=nearest(x,z), y=levelInfo.ground?groundY:ry-1500;
        if(d<w+radius*1.5+500) return 0; // never inside the road or its walls
        debug && skylineSites.push([x,z,radius*1.5,landmark,h]);
        shapes[landmark||random.float()<.75?theme:(theme+3)%8](vec3(x,y,z),h,radius,yaw,color,landmark);
        return 1;
    };
    // near band: small frequent speed cues beside the road, alternating sides
    for(let i=64;i<N;i+=6) // dense: they are the speed read
    {
        if(track[i].flags&SK_TUNNEL) continue;
        const p=sampleRoute(i*trackSegmentLength,(i/6%2?1:-1)*(w+800+random.float(0,3200)));
        piece(p.x,p.z,random.float(300,1500),random.float(60,260),trackHeadingCum[i],random.float()<.3?accent:palette[0],0);
    }
    // tunnel edges: a dense tall wall on both sides, opening abruptly at the flag ends
    for(let i=0;i<N;i+=12) if(track[i].flags&SK_TUNNEL) for(const side of [-1,1])
    {
        const p=sampleRoute(i*trackSegmentLength,side*(w+900));
        piece(p.x,p.z,random.float(6000,9000),420,trackHeadingCum[i],accent,0);
    }
    // mid field: seeded groups with a shared yaw, seeded sideways from the route so the
    // band fills evenly; open circuits keep the infield as a vista, cities fill it
    const R=trackMapRadius+30000, c=trackMapCenter;
    for(let g=0,tries=0;g<60*levelInfo.density&&tries<900;++tries)
    {
        const p=sampleRoute(random.int(N)*trackSegmentLength,random.sign()*(w+random.float(4000,25000))), x=p.x, z=p.z, [d]=nearest(x,z);
        if(d<w+4000 || theme!=1 && inside(x,z)) continue;
        ++g;
        // a district: one colour from the palette per group, so colour reads as place
        const yaw=random.float(2*PI), count=random.int(3,8), color=palette[random.int(3)].lerp(BLACK,random.float(.3));
        for(let k=0;k<count;++k)
            piece(x+random.float(-5000,5000),z+random.float(-5000,5000),random.float(3000,12000),random.float(900,2200),yaw,color,0);
    }
    // far skyline: a few giants, then the authored landmark beside its corner
    for(let g=0,tries=0;g<12&&tries<400;++tries)
    {
        const x=c.x+random.float(-R-50000,R+50000), z=c.z+random.float(-R-50000,R+50000), [d]=nearest(x,z);
        if(d<25000 || d>80000) continue;
        g+=piece(x,z,random.float(15000,30000),random.float(2500,4000),random.float(2*PI),dark,0);
    }
    const [at,side,distance]=circuitLandmark[currentCircuit], li=at*N|0;
    for(let k=0;k<6;++k) // step outward until it clears every branch of the route (hairpins)
    {
        const lp=sampleRoute(li*trackSegmentLength,side*(w+distance+k*3000));
        if(piece(lp.x,lp.z,26000,3200,trackHeadingCum[li],accent,1)) break;
    }
}

class TrackSegment
{
    constructor(segmentIndex,pos,width)
    {
        this.pos = pos;    // world centre of this sample (set by the skeleton, never integrated)
        this.width = width;
        this.turn = 0;     // skeleton curvature: 1 = a 25,000-unit radius, sign = toward right
        this.flags = 0;    // SK_* flags of the edge or arc this sample lies on
        this.pitch = this.roll = 0;
        this.roadType = 0; // 0 road, 1 boost pad, 2 recharge strip
        this.padX = 0;     // lateral center of the pad's lane (never undefined: see CLAUDE.md)
        this.chev = 0;     // corner warning band side, 0 = none

    }
}


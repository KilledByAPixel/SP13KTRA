'use strict';

// All velocities are WORLD units / second. Route s is derived from position and
// exists only for navigation, containment and validated race progress.
const raceLine=3000, maxCraftSpeed=32000; // 2026-09-10: 1.5x across the board for speed feel; turn rates 1.35x
let contactTimes=[], engineSound, keySteer=0;
// Closest relative approach within this tick: contact detection only, no impulse solver.
function movementDistance(a,b,p)
{
    const d=b.subtract(a), u=clamp(p.subtract(a).dot(d)/max(1,d.dot(d)));
    return a.add(d.scale(u)).subtract(p).length();
}

function makeCraftSpec(i)
{
    const r = new Random(i*61+7);
    // wide, FLAT, long. half extents: length shortened for a squatter race-distance read;
    // fleet span/length mean .52 vs the reference sheet's .458 (4.08m x 1.87m) - a
    // deliberate exaggeration, not a match
    const bs = vec3(r.float(205,250), r.float(78,100), r.float(345,405));
    const sweep = r.float(.82,.92);  // how far back along the hull the wingtips sit
    const taper = r.float(.5,.72);   // trailing edge width vs wingspan
    const wingX = r.float(.74,1);    // wingspan
    // the loft: stations nose to tail, [z, halfWidth, topY, bottomY]. FEISAR proportions,
    // measured off the reference sheet: in plan it is one long triangle from the nose
    // point out to the wingtips at 82-92% back (.4 of the span at 35%, .74 at 62%, on
    // the reference's near straight leading edge), then the trailing edge cuts back in;
    // in profile the keel is near flat and the deck ridge climbs the whole way, so no
    // two facets share a pitch. deck datum is y=40.
    const L = bs.z, W = bs.x*wingX, H = bs.y;
    return {
        bs,
        w: W,                         // half wingspan (tracks the 170 collision half-width: 165-214)
        t: W*taper,                   // half trailing edge
        engines: 1+i%3,               // engine glow count
        tail: vec3(0, 40+H*.17, -L-30), // nozzle centroid (craft space): sparks AND the trail leave here
        stations:
        [
            // nose: a true point (top==bottom) - buildLoft's diagonal quad normal stays
            // non-degenerate there, unlike a corner normal
            [L, 0, 40, 40],
            [L*.3, W*.4, 40+H*.35, 40-H*.12],        // 35% back
            [-L*.24, W*.74, 40+H*.72, 40-H*.2],      // 62% back, under the canopy
            [L*(1-2*sweep), W, 40+H*.78, 40-H*.24],  // wingtips, the widest station
            [-L, W*taper, 40+H*.5, 40-H*.18],        // trailing edge
        ],
    };
}

// the rainbow grid: 7 rivals (player is red) - white is unsplit light, nearly perfect
// the eight craft colours: the player takes one of the first six on the title (Up/Down), the
// seven rivals take the rest, black and white always among them (hsl(0,0,1) is exactly WHITE)
const racerColors = [[0,.8,.5],[.08,1,.5],[.14,1,.5],[.33,.9,.4],[.6,1,.5],[.8,.8,.55],[0,0,.05],[0,0,1]];
// rivals by grid order: [skill, home circuit with a skill bump] (spec: The Field)
// skills measured (Task 5): a WIDE ladder. With everyone weaving the pads, a narrow
// .92-1.02 ladder put all seven in the rubber band's linear region - one blob 3-12k
// behind the player (100% bunched). The top two station-keep in the linear region;
// below the band's saturation edge each .03 of skill is ~1.5 s at the finish on a
// pad-rich circuit and ~1.6 s on a pad-poor one (c4 has a third of c0's pad hits and
// heavier corners - a wider ladder that evened out c0 dropped c4's tail half a lap)
const racerInfoList = [[.84,1],[.87,2],[.90,3],[.93,5],[.96,6],[1,7],[1.04,9]];

// pad seeking, shared by the rivals and the autodrive yardstick: the lane centre of the
// nearest pad group within 80 segments, if it is at most one lane-change away
// (laneWidth*1.6: adjacent lane 700 qualifies, a 2-lane 1400 dive does not) - else
// undefined. Groups are 4-6 segments long, so a stride of 4 never skips one.
function padSeekX(seg, x)
{
    for(let k=0; k<80; k+=4)
    {
        const t = track[wrapSegment(seg+k)];
        if (t.roadType == 1)
            return abs(x-t.padX) < laneWidth*1.6 ? t.padX : undefined;
    }
}


class Vehicle
{
    constructor(s,color=WHITE,index=7)
    {
        this.color=color; this.racerIndex=index; this.craft=craftSpecs[index];
        this.glowColor=index==6?WHITE:color.lerp(WHITE,.15); // additive light in the craft's own colour; black would vanish, so it burns white
        this.mesh=this.craft.mesh;
        this.velocity=vec3(); this.trail=[]; this.energy=100;
        this.speed=this.playerTurn=this.driftCharge=this.driftTime=0;
        this.boostTime=this.deadUntil=this.boostPower=0;
        this.padTime=this.wallTime=-1;
        this.sliding=this.slideEnd=0; this.grip=14; // power slide state (stepVehicle)
        this.gates=this.lap=this.raceDistance=0; this.nextGate=raceLine;
        this.nozzles=[];
        this.place(s);
    }
    place(s,x=0)
    {
        const info=new TrackSegmentInfo(s);
        this.s=s; this.localX=x; this.pos=info.point(x,80);
        this.previousPosition=this.pos.copy(); this.velocity=vec3();
        this.heading=info.heading; this.up=info.up; this.forward=info.forward;
        this.sliding=0; this.grip=14;
    }
    craftMatrix(p=this.pos,yaw=this.heading)
    {
        const f=vec3(Math.sin(yaw),0,Math.cos(yaw));
        const forward=f.subtract(this.up.scale(f.dot(this.up))).normalize();
        const right=this.up.cross(forward).normalize();
        return routeFrame(p,right,this.up,forward).multiply(buildMatrix(0,vec3(0,0,-this.playerTurn*.14)));
    }
    recordTrail()
    {
        const m=this.craftMatrix(), tail=this.craft.tail.transform(m);
        this.trail.unshift([tail,this.up.cross(this.forward).normalize()]);
        if(this.trail.length>36) this.trail.pop();
    }
    draw()
    {
        this.nozzles=[];
        if(this.deadUntil>time) return;
        const m=this.craftMatrix(), S=this.craft, H=S.w, bs=S.bs;
        // Shared fixed hull silhouette, flattened onto the supporting road frame.
        glSetDepthTest(1,0); glEnableLighting=0;
        const support=new TrackSegmentInfo(this.s);
        this.mesh.render(routeFrame(support.point(this.localX,6),support.right,support.up,support.forward)
            .rotate(0,(this.heading-support.heading)*180/PI,0).scaleSelf(1,.01,1),rgb(0,0,0,.3)); // scaleSelf: DOMMatrix.scale would collide with the mangled Vector3.scale (build.js)
        glSetDepthTest(); glSpecularity=.75; glEnableLighting=1;
        this.mesh.render(m,this.color);
        glEmissive=.5;
        canopyMesh.render(m.multiply(buildMatrix(vec3(0,40+bs.y*.5,-bs.z*.22),vec3(-.1,0,0),vec3(H*.28,bs.y*.55,bs.z*.26))),this.color.lerp(WHITE,.35));
        glEmissive=1;
        const spread=S.t*.62/max(1,S.engines-1), boost=this.boostTime>time;
        for(let e=0;e<S.engines;++e)
        {
            const x=(2*e-S.engines+1)*spread;
            this.nozzles.push(vec3(x,S.tail.y,S.tail.z).transform(m));
            // the flame: a short emissive bar that stretches back while boosting
            cubeMesh.render(m.multiply(buildMatrix(vec3(x,S.tail.y,-bs.z-8-40*boost),0,vec3(S.t*.3/S.engines,bs.y*.13,18+50*boost))),this.isBraking?WHITE:this.glowColor);
        }
        glEmissive=glSpecularity=0;
    }
}
class Racer extends Vehicle
{
    constructor(s,k) // k: grid order 0..6; the colour is the k-th one the player did not take
    {
        const c=k+(k>=playerCraft);
        super(s,hsl(...racerColors[c]),c); [this.skill,this.home]=racerInfoList[k];
        this.lineOffset=(k%3-1)*320;
    }
}
class PlayerVehicle extends Vehicle {}

function driveAI(v)
{
    const info=new TrackSegmentInfo(v.s), seg=info.segmentIndex;
    const look=1800+v.speed*.16;
    let x=padSeekX(seg,v.localX) ?? (trackRacingLine[seg]*.35+(v.lineOffset||0));
    let targetSpeed=maxCraftSpeed*(v.skill||.96)*levelInfo.rivalSkill;
    let corner=0;
    for(let k=0;k<100;k+=10) corner=max(corner,abs(track[wrapSegment(seg+k)].turn));
    targetSpeed*=clamp(1-corner*.2,.35,1); // a 10,000 radius (turn 2.5) halves the pace
    if(v.home==currentCircuit) targetSpeed*=1.04;
    // Restrained assistance changes target pace, never directly changes position.
    if(v!==playerVehicle) targetSpeed*=clamp(1+(playerVehicle.raceDistance-v.raceDistance)/250000,.97,1.06);
    for(const other of vehicles)
    {
        if(other===v) continue;
        const d=other.pos.subtract(v.pos), ahead=d.dot(v.forward), side=d.dot(info.right);
        if(ahead>0 && ahead<3400 && abs(side)<650 && raceTime>2)
        {
            x=clamp(v.localX+(side>0?-900:900),-info.width+700,info.width-700);
            if(ahead<1000 && v.speed>other.speed) targetSpeed=min(targetSpeed,other.speed*.98);
        }
    }
    const target=sampleRoute(v.s+look,x).subtract(v.pos);
    const error=clampAngle(Math.atan2(target.x,target.z)-v.heading);
    const steer=clamp(error*3,-1,1);
    const brake=v.speed>targetSpeed+1350 || corner>1.6 && v.speed>16500; // under a 15,000 radius: slide it
    return {steer,gas:v.speed<targetSpeed,brake,boost:0};
}

function containCraft(v,hint)
{
    const r=projectRoute(v.pos,hint), info=r.info;
    const slip=clampAngle(v.heading-info.heading);
    const extent=abs(Math.cos(slip))*240+abs(Math.sin(slip))*400;
    const edge=info.width-extent, x=clamp(r.x,-edge,edge);
    let wall=x!==r.x;
    if(wall)
    {
        const side=sign(r.x), outward=v.velocity.dot(info.right)*side;
        v.pos.addSelf(info.right.scale(x-r.x));
        if(outward>0) v.velocity=v.velocity.subtract(info.right.scale(side*outward));
        if(outward>750 && time>v.wallTime)
        {
            v.velocity=v.velocity.scale(.8); v.energy=max(0,v.energy-10); v.wallTime=time+.3;
            v===playerVehicle && sound_bump.play(.5,.7);
        }
        else v.velocity=v.velocity.scale(.993);
        v.driftTime=v.driftCharge=v.sliding=0;
    }
    // Arcade support corrects normal height, preserving free tangential motion. The
    // smooth route frame gives height, orientation and the tangent plane: the rendered
    // road is within 5 units of it (circuits-test mesh error), so the hull never pops.
    const surface=info.point(x,80);
    v.pos.addSelf(info.up.scale(surface.subtract(v.pos).dot(info.up)));
    const speed=v.velocity.length();
    const tangent=v.velocity.subtract(info.up.scale(v.velocity.dot(info.up)));
    v.velocity=tangent.length()>0?tangent.normalize().scale(speed):vec3();
    v.s=r.s; v.localX=x; v.up=info.up;
    return wall;
}

function stepVehicle(v,c,dt)
{
    v.previousPosition=v.pos.copy();
    if(!Number.isFinite(v.pos.x+v.pos.y+v.pos.z+v.velocity.length()))
        v.deadUntil=time;
    if(v.deadUntil)
    {
        if(time<v.deadUntil) return;
        v.place(v.nextGate-lapDistance/8,0); v.energy=50; v.deadUntil=0; v.trail=[];
        contactTimes=[];
        if(v===playerVehicle)
        {
            cameraRot.y=v.heading;
            for(let i=60;i--;) updateCamera();
        }
    }
    if(v.energy<=0)
    {
        v.deadUntil=time+2; v.velocity=vec3(); v.speed=0; v.driftCharge=v.driftTime=0;
        v===playerVehicle && sound_lose.play(.7); return;
    }
    if(startCountdown) { v.speed=0; return; }
    if(gameOverTimer.isSet()) c={steer:0,gas:0,brake:1,boost:0};
    const speed=v.velocity.length();
    const travel=speed>500?Math.atan2(v.velocity.x,v.velocity.z):v.heading;
    const slip=clampAngle(v.heading-travel), steering=abs(c.steer)>.18;
    // Power slide: grip has a limit. A slide starts from brake+steer at speed and only
    // that. Gas sustains it; it ends when the stick centres, counter-steer kills the slip,
    // or speed is gone.
    if(!v.sliding && steering && speed>4500 && c.brake)
        v.sliding=1, v.slideEnd=0;
    if(v.sliding)
    {
        const ending=!steering || v.driftTime>.2 && abs(slip)<.05;
        v.slideEnd=ending?v.slideEnd+dt:0;
        if(v.slideEnd>.15 || speed<3800) v.sliding=0;
    }
    // grip eases between the slide (1.5/s) and normal (14/s) over a quarter second, so the
    // exit never snaps the craft into a wall
    v.grip=lerp(dt/.25,v.grip,v.sliding?1.5:14);
    v.isBraking=c.brake;
    v.playerTurn=lerp(.3,v.playerTurn,c.steer);
    // the rate floor is high enough to turn away from a wall you have stopped against
    let rate=(v.sliding?2.2:1.9)*clamp(speed/21000,.45,1);
    // the nose cannot swing much past 35 degrees inside the travel direction
    if(v.sliding && sign(c.steer)==sign(slip) && abs(slip)>.6) rate*=.2;
    v.heading+=c.steer*rate*dt;
    const forward=vec3(Math.sin(v.heading),0,Math.cos(v.heading));
    v.forward=forward.subtract(v.up.scale(forward.dot(v.up))).normalize();
    const right=v.up.cross(v.forward).normalize();
    // A slide carves: 60% of the steer rate turns the travel direction directly, so the
    // turn-in is immediate; the low grip leaves the rest as the slip angle the nose shows
    // (steady state about 25 degrees). Pure grip-limited sliding plows for half a second.
    if(v.sliding)
    {
        const a=c.steer*rate*.6*dt;
        v.velocity=v.velocity.scale(Math.cos(a)).addSelf(v.up.cross(v.velocity).scale(Math.sin(a)));
    }
    const side=v.velocity.dot(right);
    v.velocity=v.velocity.subtract(right.scale(side*(1-Math.exp(-v.grip*dt))));
    if(c.boost && v.energy>0)
    {
        v.energy=max(0,v.energy-25*dt); v.boostPower=1;
        if(v.boostTime<time) v===playerVehicle && sound_boost.play(.5);
        v.boostTime=max(v.boostTime,time+.12);
    }
    if(v.sliding)
    {
        v.driftTime+=dt;
        // clean: on the road, real slip, not scraping - contacts already zeroed the state
        if(v.driftTime>.5 && abs(slip)>.05 && abs(slip)<.7)
        {
            v.energy=min(100,v.energy+4*dt); v.driftCharge=min(2,v.driftCharge+dt);
        }
    }
    else
    {
        if(v.driftCharge>.4 && v.boostTime<time) v.boostTime=time+v.driftCharge*.55,v.boostPower=0;
        v.driftTime=v.driftCharge=0;
    }
    const boosted=v.boostTime>time, cap=boosted?(v.boostPower?40000:36000):maxCraftSpeed;
    let accel=boosted?(v.boostPower?20000:13500):c.gas?9600:0;
    if(speed>=cap) accel=0;
    v.velocity.addSelf(v.forward.scale(accel*dt));
    const braking=(c.brake?(v.sliding?2700:10500):c.gas?0:2700)+(v.sliding?1350:0); // sliding scrubs a little
    let newSpeed=max(0,v.velocity.length()-braking*dt);
    if(newSpeed>cap) newSpeed=speed<=cap?cap:max(cap,newSpeed-7500*dt);
    if(v.velocity.length()>0) v.velocity=v.velocity.normalize().scale(newSpeed);
    const before=v.s;
    // Short moves keep containment continuous even at boosts and lap seams.
    const steps=min(16,max(1,Math.ceil(newSpeed*dt/80)));
    let wall=0;
    for(let i=0;i<steps;++i)
    {
        v.pos.addSelf(v.velocity.scale(dt/steps)); wall|=containCraft(v,v.s);
    }
    v.speed=v.velocity.length();
    const info=new TrackSegmentInfo(v.s), t=track[info.segmentIndex];
    // a wall deflects the nose back along the road (3/s), so a nose-in crash never pins the
    // craft: its grip would otherwise turn every bit of speed into the wall
    if(wall) v.heading+=clampAngle(info.heading-v.heading)*min(1,3*dt);
    if(t.roadType==1 && abs(v.localX-t.padX)<laneWidth*.45 && time>v.padTime+.5)
    {
        if(v.boostTime<time) v.boostPower=0;
        v.boostTime=max(v.boostTime,time+.8); v.padTime=time;
        v===playerVehicle && sound_boost.play(.4);
    }
    if(t.roadType==2 && v.localX>info.width-1750) v.energy=min(100,v.energy+60*dt);
    // Ordered gates are route metadata. Teleporting/debug placement is not a lap.
    if(before<v.nextGate && v.s>=v.nextGate && v.s-before<1500)
    {
        ++v.gates; v.nextGate+=lapDistance/8;
        const lap=max(0,Math.floor((v.gates-1)/8));
        if(lap>v.lap && v===playerVehicle)
        {
            playerLap=lap; sound_checkpoint.play(.7);
        }
        v.lap=lap;
    }
    v.raceDistance=v.gates?(v.gates-1)*lapDistance/8+clamp(v.s-(v.nextGate-lapDistance/8),0,lapDistance/8):min(0,v.s-raceLine);
    v.recordTrail();
}

function updateCars()
{
    playerVehicle.energy=playerEnergy;
    for(const v of vehicles)
    {
        let c;
        if(v!==playerVehicle || titleScreenMode || testDrive) c=driveAI(v);
        else
        {
            // keys ramp the steer over about a fifth of a second both ways (Frank: digital lock
            // then straight was too twitchy); the mouse below is direct
            keySteer=lerp(.2,keySteer,keyIsDown('ArrowRight')-keyIsDown('ArrowLeft'));
            c={steer:keySteer,gas:keyIsDown('ArrowUp'),brake:keyIsDown('ArrowDown'),boost:keyIsDown('Space')};
            // mouse: any held button steers by the pointer's distance from centre (full lock a third
            // of the way out); left drives, right brakes, middle boosts. brake+steer slides as on keys
            if(mouseButtons) c.steer=clamp(mouseX*3,-1,1),c.gas|=mouseButtons&1,c.brake|=mouseButtons>>2&1,c.boost|=mouseButtons>>1&1;
            if(debug && testTurn) c.steer=testTurn;
            if(enhancedMode && isUsingGamepad) c.steer=gamepadStick(0).x,c.gas=gamepadIsDown(0),c.brake=gamepadIsDown(1),c.boost=gamepadIsDown(5);
        }
        stepVehicle(v,c,timeDelta);
    }
    checkCraftContacts();
    playerEnergy=playerVehicle.energy; playerDeadTime=playerVehicle.deadUntil;
    if(!titleScreenMode && !startCountdown && !playerDeadTime && !gameOverTimer.isSet() && soundVolume)
    {
        if(!engineSound) engineSound=sound_engine.play(.12);
        if(engineSound) engineSound.loop=true,engineSound.playbackRate.value=.6+playerVehicle.speed/12000;
    }
    else if(engineSound) engineSound.stop(),engineSound=0;
    playerPlace=1+vehicles.filter(v=>v!==playerVehicle && v.raceDistance>playerVehicle.raceDistance).length;
    if(playerLap>=raceLaps && !gameOverTimer.isSet() && !titleScreenMode)
    {
        playerWin=1; racePlace=lastRacePlace=playerPlace; gameOverTimer.set(); sound_win.play();
        if(!(debug && debugSkipped))
        {
            if(!bestTime || raceTime<bestTime) bestTime=raceTime;
            writeSaveData();
        }
    }
}

function checkCraftContacts()
{
    for(let i=0;i<vehicles.length;++i) for(let j=i+1;j<vehicles.length;++j)
    {
        const a=vehicles[i],b=vehicles[j];
        if(a.deadUntil || b.deadUntil || startCountdown) continue;
        const info=new TrackSegmentInfo(a.s), d=b.pos.subtract(a.pos);
        const old=b.previousPosition.subtract(a.previousPosition), move=d.subtract(old);
        // Slab test of the relative motion segment against an expanded craft box.
        // A boost-speed head-on crossing can traverse the entire box in one tick.
        let enter=0, leave=1;
        for(const [axis,size] of [[info.up,220],[info.forward,760],[info.right,480]])
        {
            const p=old.dot(axis), speed=move.dot(axis);
            if(abs(speed)<.001) { if(abs(p)>size) leave=-1; }
            else
            {
                const u=(-size-p)/speed, w=(size-p)/speed;
                enter=max(enter,min(u,w)); leave=min(leave,max(u,w));
            }
        }
        if(enter>leave) continue;
        const key=i*vehicles.length+j;
        if(time>(contactTimes[key]??-1))
        {
            a.velocity=a.velocity.scale(.82); b.velocity=b.velocity.scale(.82);
            a.speed=a.velocity.length(); b.speed=b.velocity.length();
            a.energy=max(0,a.energy-6); b.energy=max(0,b.energy-6);
            a.driftTime=a.driftCharge=a.sliding=b.driftTime=b.driftCharge=b.sliding=0;
            contactTimes[key]=time+.5;
            if(a===playerVehicle || b===playerVehicle) sound_hit.play(.3);
        }
        const side=sign(d.dot(info.right)||j-i), push=info.right.scale(side*20);
        a.pos=a.pos.subtract(push); b.pos.addSelf(push);
        containCraft(a,a.s); containCraft(b,b.s);
    }
}
function drawCars() { for(const v of vehicles) v.draw(); }

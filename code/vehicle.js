'use strict';

///////////////////////////////////////////////////////////////////////////////
// vehicle.js - the craft: hull specs, physics, AI, containment, contacts, trails
//
// Owns everything about a craft once the world exists: the hull shapes, one per
// colour (makeCraftSpec), the Vehicle/Racer classes, the rival AI (driveAI), road
// containment (containCraft), the shared simulation step (stepVehicle), the
// per-step update of every craft (updateCars), craft-versus-craft contacts
// (checkCraftContacts) and drawing (drawCars).
//
// Called from: game.js builds the field (new Vehicle / new Racer) and calls
// updateCars each fixed step; scene.js calls drawCars; draw.js calls makeCraftSpec
// to build the shared hull meshes (craftSpecs); track.js draws each craft's trail
// and nozzle glow from v.trail / v.nozzles; debug.js spawns extra Racers. The
// tests call stepVehicle, driveAI, containCraft and checkCraftContacts directly.
//
// All velocities are WORLD units / second. Route s is derived from position and
// exists only for navigation, containment and validated race progress.
///////////////////////////////////////////////////////////////////////////////

const raceLine=3000, maxCraftSpeed=32000; // route s of the start line; the normal speed cap

// the player's race effects, and only in a race: the attract lap behind the title and
// menu is silent apart from the menu's own cues
const racing=v=>v===playerVehicle && !titleScreenMode;

// timers (seconds): the next low-energy beep, lap beeps left and the next one, the next
// charge blip; contactTimes: per-pair contact cooldown, keyed i*count+j
let contactTimes=[], engineSound, keySteer=0, lowBeepTime=0, lapBeeps=0, lapBeepTime=0, chargeTime=0, bumpDistance=0; // bumpDistance: units of travel left before the next rough-shoulder bump

// feel tunables, shared by the rivals: keySteerEase is the per-frame lerp of the keyboard
// steer toward the key (lower = a softer ramp), steerRate the heading rate in rad/s,
// gripNormal the per-second bleed of sideways velocity (14 was on rails,
// 8 lets every corner drift a touch, 4 is a boat)
const keySteerEase=.12, steerRate=1, gripNormal=8;

// the steer rate off the gas or on the brake (every craft) and the player's on the turbo, as fractions
// of steerRate: some corners are tighter than the rate, so letting go turns faster, and the turbo
// gives less to adjust with. coastSteer was 2 until 2026-09-13; out for an hour that day (it oversteered
// on Frank) and back at 1.5 once UMBRA's corners would not go round without it
const coastSteer=1.5, turboSteer=.75, steerEase=.15; // steerEase: seconds for the multiplier to settle after the gas or turbo changes (a snap was too sudden)
let steerMul=1;

// how much of the speed the grip step keeps as it turns the velocity toward the nose,
// 0..1: at 0 the sideways part is thrown away and a turn off the gas bleeds speed; at 1
// the speed transfers whole into the new direction, so a corner costs only the drag
const gripKeep=1;


///////////////////////////////////////////////////////////////////////////////
// hull specs and the field
///////////////////////////////////////////////////////////////////////////////

// one hull per colour index, built once by draw.js into craftSpecs (with the loft mesh).
// Wide, FLAT, long: the fleet's span/length is about .52 against the reference sheet's
// .458 (4.08m x 1.87m), a deliberate exaggeration for a squatter race-distance read
function makeCraftSpec(i)
{
    const r = new Random(i*61+7);
    const bs = vec3(r.float(205,250), r.float(78,100), r.float(345,405)); // half extents
    const sweep = r.float(.82,.92);  // how far back along the hull the wingtips sit
    const taper = r.float(.5,.72);   // trailing edge width vs wingspan
    const wingX = r.float(.74,1);    // wingspan
    // the loft: stations nose to tail, [z, halfWidth, topY, bottomY], FEISAR proportions
    // measured off the reference sheet. In plan it is one long triangle from the nose
    // out to the wingtips at 82-92% back (.4 of the span at 35%, .74 at 62%, on the
    // near straight leading edge), then the trailing edge cuts back in; in profile the
    // keel is near flat and the deck ridge climbs the whole way, so no two facets share
    // a pitch. The deck datum is y=40
    const L = bs.z, W = bs.x*wingX, H = bs.y;
    return {
        bs,
        w: W,                         // half wingspan
        t: W*taper,                   // half trailing edge
        engines: 1+i%3,               // engine glow count
        tail: vec3(0, 40+H*.17, -L-30), // nozzle centroid (craft space): sparks AND the trail leave here
        mesh: buildLoft(
        [
            // nose: a true point (top==bottom), so buildLoft's diagonal quad normal stays
            // non-degenerate there, unlike a corner normal
            [L, 0, 40, 40],
            [L*.3, W*.4, 40+H*.35, 40-H*.12],        // 35% back
            [-L*.24, W*.74, 40+H*.72, 40-H*.2],      // 62% back, under the canopy
            [L*(1-2*sweep), W, 40+H*.78, 40-H*.24],  // wingtips, the widest station
            [-L, W*taper, 40+H*.5, 40-H*.18],        // trailing edge
        ]),
    };
}

// the eight craft colours as hsl, in rainbow order: red, orange, yellow, green, blue,
// violet, black, white (hsl(0,0,1) is exactly WHITE: unsplit light). The player takes
// one of the first six on the title; the rivals take the rest (Racer), so black and
// white are always rivals. (A field of 20 with twelve muted intermediate colours was
// tried and dropped: from the front you never see them, and eight tells the story)
const racerColors = [[0,.8,.5],[.08,1,.5],[.14,1,.5],[.33,.9,.4],[.6,1,.5],[.8,.8,.55],[0,0,.05],[0,0,1]];

// rival skill and home circuit go by COLOUR (Racer): the six primaries .90-.96, black .98
// and white 1.04, each with one home circuit for a 4% bump (white's is the finale).
// The ladder is deliberately WIDE: a narrow .92-1.02 ladder put every rival in the
// rubber band's linear region, one blob 3-12k behind the player; below its saturation
// edge each .03 of skill is about 1.5 s at the finish on a pad-rich circuit

// pad seeking, shared by the rivals and the autodrive: the lane centre of the nearest
// pad within 80 segments, if it is at most one lane-change away (laneWidth*1.6: the
// adjacent lane qualifies, a two-lane dive does not), else undefined. Pads are 24
// samples long, so a stride of 4 never skips one
function padSeekX(seg, x)
{
    for(let k=0; k<80; k+=4)
    {
        const t = track[wrapSegment(seg+k)];
        if (t.roadType == 1)
            return abs(x-t.padX) < laneWidth*1.6 ? t.padX : undefined;
    }
}

///////////////////////////////////////////////////////////////////////////////
// the craft classes
///////////////////////////////////////////////////////////////////////////////

class Vehicle
{
    constructor(s,x,color,index)
    {
        this.color=color;
        this.racerIndex=index;
        this.craft=craftSpecs[index];
        // the trail is additive light in the craft's own colour, barely lifted (pure
        // colour, not white); black would vanish, so it burns white
        this.glowColor=index==6?WHITE:color.lerp(WHITE,.15);
        this.trail=[];
        this.energy=100;
        this.speed=this.playerTurn=this.throttle=this.burn=0; // throttle: eased gas, burn: eased boost, 0..1 for the engine glow and ribbon
        this.boostTime=this.deadUntil=this.boostPower=0;
        this.padTime=this.wallTime=this.hitTime=-1; // last pad / hard-wall hit, for the cooldowns; hitTime: the damage burst (track.js)
        this.gates=this.lap=this.raceDistance=0; this.nextGate=raceLine; // ordered gates: the first is the start line
        this.place(s,x);
    }

    // seat the craft at rest on the route frame at (s, lateral x): the grid, respawns and dev relocation
    place(s,x=0)
    {
        const info=new TrackSegmentInfo(s);
        this.s=s;
        this.localX=x;
        this.pos=info.point(x,80); // 80 units above the frame
        this.previousPosition=this.pos.scale(1);
        this.velocity=vec3();
        this.heading=info.heading;
        this.up=info.up;
        this.forward=info.forward;
    }

    // one pose for the hull, nozzles and trail: the yaw laid onto the road's up vector,
    // rolled by the steer input (playerTurn) for the visual lean
    craftMatrix()
    {
        const yaw=this.heading, f=vec3(Math.sin(yaw),0,Math.cos(yaw));
        const forward=f.subtract(this.up.scale(f.dot(this.up))).normalize();
        const right=this.up.cross(forward).normalize();
        return routeFrame(this.pos,right,this.up,forward).multiply(buildMatrix(0,vec3(0,0,-this.playerTurn*.14)));
    }

    // push the nozzle point and the ribbon's right vector onto the trail (newest first);
    // track.js draws it as a fading ribbon
    recordTrail()
    {
        const m=this.craftMatrix(), tail=this.craft.tail.transform(m);
        this.trail.unshift([tail,this.up.cross(this.forward).normalize()]);
        if(this.trail.length>36) this.trail.pop();
    }

    draw()
    {
        this.nozzles=[];
        if(this.deadUntil) return; // a rival clears this on respawn; the player never does, so the wreck stays gone
        const m=this.craftMatrix(), S=this.craft, H=S.w, bs=S.bs;

        // the hull, lit and glossy (the GL flags are as drawTrack left them: depth on, lit. The
        // craft shadow went on 2026-09-13: barely visible, and it cut through the ground)
        glSpecularity=.75;
        S.mesh.render(m,this.color);

        // the canopy: a half-emissive diamond over the 62% station, in a lighter tint (.6 toward white since
        // 2026-09-13, .35 before: from behind the dark craft merged into the dark road)
        glEmissive=.5;
        canopyMesh.render(
            m.multiply(buildMatrix(vec3(0,40+bs.y*.5,-bs.z*.22),vec3(-.1,0),vec3(H*.28,bs.y*.55,bs.z*.26))),
            this.color.lerp(WHITE,.6));

        // the engines: 1-3 nozzle points spread across the trailing edge, for the glow pass
        // (track.js drawTrails); there is no flame bar, the nozzle glow is the engine
        const spread=S.t*.62/max(1,S.engines-1);
        for(let e=0;e<S.engines;++e)
            this.nozzles.push(vec3((2*e-S.engines+1)*spread,S.tail.y,S.tail.z).transform(m));
        glEmissive=glSpecularity=0;
    }
}

class Racer extends Vehicle
{
    constructor(s,x,k) // k: grid order 0..fieldSize-2; the colour is the k-th one the player did not take
    {
        const c=k+(k>=playerCraft);
        super(s,x,hsl(...racerColors[c]),c);
        this.skill=c<6?.9+c*.012:.98+(c-6)*.06; // primaries .90-.96, black .98, white 1.04
        this.lineOffset=(k%3-1)*320; // three lanes off the racing line so the field does not stack
    }
}

///////////////////////////////////////////////////////////////////////////////
// AI: produces the same {steer,gas,brake,boost} controls the player does
///////////////////////////////////////////////////////////////////////////////

// Also drives the player on the title screen and under autodrive (testDrive), where
// skill and lineOffset are missing: hence the || fallbacks.
// rival tunables (2026-09-13 tries, Frank: rivals too easy): aiClip, the pace clip before the catch-up as a fraction of the
// normal top speed times the circuit's rivalSkill, so the straights get faster up the ladder too (1.046 on REDSHIFT to 1.12 on
// the finale; a flat 1.05 for an hour, and 1 until then, when the ladder only reached the corners); aiCornerSlow, the pace cut per
// unit of the sharpest turn ahead (.2 until then); aiCornerBrake, speed times turn that brakes (24,000 until then; a player
// only lifts); aiBoostGap, how far behind the player a rival holds its free turbo (8,000 until then; 4,000 crowded him to death);
// aiLine, how much of the racing line a rival follows (.35 until then: it cut every corner tighter than the road allows). A solo
// time trial at skill 1 (local/ai-corner-trial.js) chose .08, 34,000 and .7 over .15, 30,000 and .35: REDSHIFT 48.0 to 47.0 s,
// ULTRAVIOLET 56.1 to 51.4, UMBRA 65.7 to 62.4 (3 wall hits from 0), SP13KTRA 65.4 to 63.0; with no corner brake it died on UMBRA
const aiClip=.96, aiCornerSlow=.08, aiCornerBrake=34000, aiBoostGap=5000, aiLine=.7;
function driveAI(v)
{
    const info=new TrackSegmentInfo(v.s), seg=info.segmentIndex;
    const look=1800+v.speed*.16; // route units of lookahead, growing with speed

    // lateral aim: the nearest reachable pad, else the racing line plus this rival's lane
    let x=padSeekX(seg,v.localX) ?? (trackRacingLine[seg]*aiLine+(v.lineOffset||0));
    let targetSpeed=maxCraftSpeed*(v.skill||.96)*levelInfo.rivalSkill;

    // the sharpest curvature over the next 100 segments sets the corner pace
    let corner=0;
    for(let k=0;k<100;k+=10) corner=max(corner,abs(track[wrapSegment(seg+k)].turn));
    targetSpeed*=clamp(1-corner*aiCornerSlow,.35,1); // at .08 a 10,000 radius (turn 2.5) takes a fifth off the pace
    if(v.racerIndex==currentCircuit) targetSpeed*=1.04;

    // catch-up changes the target pace only, never position: .95-1.1 over a 40k gap (a 20k gap until 2026-09-13: each
    // rival settles where the catch-up cancels its skill, so the gentler slope sets the field twice as far apart, Frank)
    // (the player's own gap is 0: a factor of 1)
    const gap=playerVehicle.raceDistance-v.raceDistance;
    // the pace is clipped to the normal top speed BEFORE the catch-up, so a rival well behind can run past it
    // (clipped after, in stepVehicle, until 2026-09-13: the rubber band could never close on a player on the turbo)
    targetSpeed=min(targetSpeed,maxCraftSpeed*levelInfo.rivalSkill*aiClip)*clamp(1+gap/400000,.98,1.1);

    // traffic: swerve a lane away from a craft close ahead and do not ram it
    for(const other of vehicles)
    {
        if(other===v) continue;
        const d=other.pos.subtract(v.pos), ahead=d.dot(v.forward), side=d.dot(info.right);
        if(ahead>0 && ahead<3400 && abs(side)<650 && raceTime>2) // not in the first two seconds off the grid
        {
            x=clamp(v.localX+(side>0?-900:900),-info.w+700,info.w-700);
            if(ahead<1000 && abs(side)<300 && v.speed>other.speed) targetSpeed=min(targetSpeed,other.speed*.98); // only a craft squarely ahead holds a rival back; one beside it is passed (2026-09-13 try: rivals trailed a coasting player)
        }
    }

    const target=sampleRoute(v.s+look,x).subtract(v.pos);
    const error=clampAngle(Math.atan2(target.x,target.z)-v.heading);
    const steer=clamp(error*3,-1,1);
    // brake when well over pace, or when too fast for the corner ahead: the turning radius is the speed,
    // a turn of 1 is a 25,000 radius, so speed*turn over 25,000 runs wide (a fixed 16,500 into corners
    // under 15,000 until 2026-09-13; the brake only slows a rival: the slide it started went with the player's)
    const brake=v.speed>targetSpeed+1350 || v.speed*corner>aiCornerBrake;
    // full gas with the target as a CAP: gas on-off around the target made the engines
    // flutter; the cap holds the pace and the glow steady. A rival aiBoostGap or more behind holds
    // the same boost the player has, at no energy cost (the player's gap is 0)
    // lift off the gas into a corner the steer rate cannot hold at this speed (at 1 rad/s the turning
    // radius is the speed): off the gas a rival turns at coastSteer, the player's own trick (without the slide, rivals ran wide
    // into ULTRAVIOLET's 22,000 corners and exploded, 2026-09-13; the lift's margin lets the brake wait)
    return {steer,gas:v.speed*corner<21000,cap:targetSpeed,brake,boost:gap>aiBoostGap}
}

///////////////////////////////////////////////////////////////////////////////
// containment: keep a craft on the road and seated on the route frame
///////////////////////////////////////////////////////////////////////////////

// Projects the craft onto the route (hint: the last known s), clamps its rotated
// footprint inside the walls and seats it 80 units above the frame. Returns whether
// a wall was touched this call. Updates v.s, v.localX and v.up.
function containCraft(v)
{
    const r=projectRoute(v.pos,v.s), info=r.info;
    // the footprint's lateral half extent as the hull yaws: 120 square-on, 320 sideways
    // (240/400 kept the hull a ship's width off the wall, which looked unfair)
    const slip=clampAngle(v.heading-info.heading);
    const extent=abs(Math.cos(slip))*120+abs(Math.sin(slip))*320;
    const edge=info.w-extent, x=clamp(r.x,-edge,edge);
    let wall=x!==r.x;
    if(wall)
    {
        const side=sign(r.x), outward=v.velocity.dot(info.right)*side;
        v.pos.addSelf(info.right.scale(x-r.x)); // back inside the wall
        if(outward>0) v.velocity=v.velocity.subtract(info.right.scale(side*outward)); // no motion into the wall
        if(outward>750 && time>v.wallTime)
        {
            // a hard hit: speed and energy penalty, .3 s cooldown
            v.velocity=v.velocity.scale(.8);
            v.energy=max(0,v.energy-10);
            v.wallTime=v.hitTime=time+.3;
            racing(v) && sound_bump.play(.5,.7);
        }
        else v.velocity=v.velocity.scale(.993); // scraping: mild drag
    }

    // arcade support: correct the normal height, keep the tangential motion. The smooth
    // route frame gives height, orientation and the tangent plane; the rendered road is
    // within 5 units of it (circuits-test mesh error), so the hull never pops
    const surface=info.point(x,80);
    v.pos.addSelf(info.up.scale(surface.subtract(v.pos).dot(info.up)));
    const speed=v.velocity.mag();
    const tangent=v.velocity.subtract(info.up.scale(v.velocity.dot(info.up)));
    v.velocity=tangent.mag()>0?tangent.normalize().scale(speed):vec3();
    v.s=r.s;
    v.localX=x;
    v.up=info.up;
    return wall;
}

///////////////////////////////////////////////////////////////////////////////
// the simulation step, shared by the player and the rivals
///////////////////////////////////////////////////////////////////////////////

// c: {steer -1..1, gas, brake, boost, cap?}; dt: the fixed step (1/60). Handles death
// and respawn, the power slide, steering, thrust and braking, substepped movement with
// containment, pads, the recharge strip, the rough shoulder, ordered gates and race
// distance.
function stepVehicle(v,c,dt)
{
    v.previousPosition=v.pos.scale(1);
    v.throttle=lerp(.15,v.throttle,c.brake?-.5:c.gas?1:0); // the engine light follows the gas: off it, it shrinks as at rest; on the brake it eases to -.5, so the ribbon narrows to a quarter and the nozzles to .15 of their size, the brake's feedback (to -1 and out until 2026-09-13, Frank: small, not gone)
    v.burn=lerp(.15,v.burn,v.boostTime>time?1:0); // the boost: the ribbon and nozzles swell and shrink over a few frames, never snap

    // a non-finite state is treated as a death: the respawn below rebuilds it from the route
    if(!isFinite(v.pos.x+v.pos.y+v.pos.z+v.velocity.mag()))
        v.deadUntil=time;
    if(v.deadUntil)
    {
        // the player never respawns: running out of energy ends the race. A rival (and the
        // attract lap's player craft) respawns at the last gate passed with half energy and
        // a fresh trail
        if(time<v.deadUntil || racing(v)) return;
        v.place(v.nextGate-lapDistance/8,0);
        v.energy=50;
        v.deadUntil=0;
        v.trail=[];
        contactTimes=[];
        if(v===playerVehicle)
        {
            // seat the camera behind the respawned craft instead of swinging over
            cameraRot.y=v.heading;
            for(let i=60;i--;) updateCamera();
        }
    }
    if(v.energy<=0 && !(racing(v) && gameOverTime)) // the player cannot die after the finish (2026-09-13)
    {
        // death: the explosion (drawTrails), two seconds stopped, then the respawn above.
        // The player's death ends the race: the results card, dead last on the next grid
        v.deadUntil=time+2;
        v.velocity=vec3();
        v.speed=0;
        if(racing(v))
        {
            sound_lose.play(.7);
            lastRacePlace=fieldSize;
            gameOverTime=time;
        }
        return;
    }
    if(startCountdown) { v.speed=0; return; }
    if(gameOverTime) c={steer:0,brake:1}; // everyone coasts to a stop after the finish

    const speed=v.velocity.mag();
    // (a POWER SLIDE, brake+steer at speed with a low grip, a carve and a charged release burst,
    // went on 2026-09-13: Frank could not get it to work and took the hardest corners faster off
    // the gas; the brake came back the same day as a plain slow-down: Down, the middle button)
    v.playerTurn=lerp(.3,v.playerTurn,c.steer); // the visual lean

    // heading rate: steerRate above 10,500, so the turning radius IS the speed and slowing down
    // turns you tighter (the knee was 21,000 until 2026-09-13: from 9,450 up the radius was a flat
    // 21,000, the coast steer hid it, and without that the rivals died on UMBRA's 12,000 corners; the coast
    // steer came back the same hour at 1.5, the knee stayed),
    // scaled down with speed under it to a .45 floor, high enough to turn away from a wall you
    // have stopped against
    let rate=steerRate*clamp(speed/10500,.45,1);
    // the steer multiplier: the player turns coastSteer times faster off the gas and turboSteer on the
    // turbo, eased over steerEase; ANY craft on the brake or off the gas turns at coastSteer (a rival, or the
    // player's craft when the AI drives it behind the title)
    // the turbo is on while its button is down OR inside a press's committed window (boostPower, below), and only while it
    // can run (energy over 1): the steer and the boost both follow it (the steer followed the button alone until the
    // post-deadline fix: a tap boosted on without the turbo's steer, and an empty turbo steered like a running one)
    const turbo=(c.boost || v.boostPower>time) && v.energy>1;
    const mul=c.brake?coastSteer:turbo&&v===playerVehicle?turboSteer:c.gas?1:coastSteer;
    rate*=v===playerVehicle?steerMul=lerp(dt/steerEase,steerMul,mul):mul;
    v.heading+=c.steer*rate*dt;
    // never backwards: the nose stays within 90 degrees of the road's heading at the
    // craft's route position, rivals included
    const road=new TrackSegmentInfo(v.s).heading;
    v.heading=road+clamp(clampAngle(v.heading-road),-PI/2,PI/2);
    const forward=vec3(Math.sin(v.heading),0,Math.cos(v.heading));
    v.forward=forward.subtract(v.up.scale(forward.dot(v.up))).normalize();
    const right=v.up.cross(v.forward).normalize();

    // grip: bleed the sideways component of velocity at gripNormal per second, then put
    // gripKeep of the speed that took back along the new direction
    const side=v.velocity.dot(right), sp=v.velocity.mag();
    v.velocity=v.velocity.subtract(right.scale(side*(1-Math.exp(-gripNormal*dt))));
    const m=v.velocity.mag();
    if(m) v.velocity=v.velocity.scale(lerp(gripKeep,m,sp)/m);

    // held boost: 25 energy/s for the player (a rival's catch-up boost is free: rivals never charge, so wanting 50
    // energy spent every rival's boost in the first lap, 2026-09-13), full power. It never drains the last unit: at 1
    // the turbo just stops, and only a wall or a craft can finish you. A PRESS COMMITS .5 s (Frank, the post-deadline
    // fix): boostPower holds the end of that window (any non-zero value is a turbo's power), and inside it the turbo
    // runs and drains as if held (.1 felt like a tap, .5 a decision). Until then a free .12 s tail followed every step the button was down, so tapping
    // one step in eight kept full power for an eighth of the energy
    if(turbo)
    {
        v.energy=max(1,v.energy-25*dt*(v==playerVehicle));
        if(v.boostTime<time || !v.boostPower) racing(v) && sound_boost.play(.5), v.boostPower=time+.5; // a press: no boost, or a pad's
        v.boostTime=max(v.boostTime,time+.02); // one step on: no free tail
    }

    // speed caps: normal 32,000 (or the AI's target, c.cap); pads 36,000; held boost 40,000
    const boosted=v.boostTime>time, cap=boosted?(v.boostPower?40000:36000):c.cap||maxCraftSpeed;
    // the brake cuts the gas AND any boost (a boost's thrust ignored the brake until the post-deadline fix, so braking
    // after a pad or on the turbo still gained speed: 13,500 or 20,000 of thrust against the brake's 10,500)
    let accel=c.brake?0:boosted?(v.boostPower?20000:13500):c.gas?9600:0; // units/s^2
    if(speed>=cap) accel=0;
    v.velocity.addSelf(v.forward.scale(accel*dt));
    // deceleration (units/s^2): the brake 10,500, coasting 1,000 (2,700 before: a release
    // should carry), gas 0
    const braking=c.brake?10500:c.gas?0:1000;
    let newSpeed=max(0,v.velocity.mag()-braking*dt);
    // over the cap (a boost that just ended): bleed down at 7,500/s instead of snapping
    if(newSpeed>cap) newSpeed=speed<=cap?cap:max(cap,newSpeed-7500*dt);
    v.velocity=v.velocity.normalize().scale(newSpeed); // (a zero velocity: newSpeed is 0, and normalize's (1,1,1) fallback scales to zero)

    // short moves (80 units, at most 16 of them) keep containment continuous even at
    // boosts and lap seams
    const before=v.s;
    const steps=min(16,max(1,Math.ceil(newSpeed*dt/80)));
    let wall=0;
    for(let i=0;i<steps;++i)
    {
        v.pos.addSelf(v.velocity.scale(dt/steps));
        wall|=containCraft(v);
    }
    v.speed=v.velocity.mag();
    const info=new TrackSegmentInfo(v.s), t=track[info.segmentIndex];
    // a wall deflects the nose back along the road (3/s), so a nose-in crash never pins the
    // craft: its grip would otherwise turn every bit of speed into the wall
    if(wall) v.heading+=clampAngle(info.heading-v.heading)*min(1,3*dt);

    // boost pad (roadType 1): within .95 of a lane of the pad's lane centre, just inside its drawn 1,400 (.45 inside 700 until
    // 2026-09-13: hard to see and to hit, Frank), .3 s cooldown; a weak .8 s boost that never downgrades a held boost.
    // The cooldown was .5 s until the post-deadline fix: the second pad of a pair (120 samples on, trackGen.js) comes .35-.55 s
    // after the first at pad or turbo speed, so it gave no boost and no sound in 20 of 42 runs (local/pad-pair-probe.js)
    if(t.roadType==1 && abs(v.localX-t.padX)<laneWidth*.95 && time>v.padTime+.3)
    {
        if(v.boostTime<time) v.boostPower=0;
        v.boostTime=max(v.boostTime,time+.8); v.padTime=time;
        racing(v) && sound_boost.play(.5, 2);
    }
    // the recharge strip (roadType 2): the outer stripWidth units on the padX side, 60 energy/s.
    // v.charging (drawTrails draws sparks under a charging craft) is on only while energy still rises
    v.charging=t.roadType==2 && v.localX*t.padX>info.w-levelInfo.stripWidth && v.energy<100;
    if(v.charging) v.energy=min(100,v.energy+60*dt);
    // the charge blip: at once on starting to charge (stopping resets the timer), then
    // every .3 s while charging; silent at full energy
    if(racing(v)) v.charging ? time>chargeTime && (chargeTime=time+.3, sound_charge.play(.4)) : chargeTime=0;
    // the rough shoulder (roadType 3, F-Zero's damaged verge): the outer two and a half lanes on the
    // padX side drag anyone on them at 1.5/s, and rattle the player: a bump every 3,000-4,500 units
    // travelled, so it fires faster the faster you go, louder with speed (Drive13K's offroad bumps,
    // Frank 2026-09-13). A held turbo (boostPower, not a pad's boost) skims over it: no drag, no rattle
    if(t.roadType==3 && !(boosted&&v.boostPower) && v.localX*t.padX>info.w*bermStart-2.5*laneWidth)
        v.velocity=v.velocity.scale(1-1.5*dt), racing(v) && (bumpDistance-=v.speed*dt)<0 && (bumpDistance=3e3*(1+Math.random()/2), sound_slowBump.play(clamp(v.speed/32e3)));

    // ordered gates are route metadata. Teleporting/debug placement is not a lap: a gate
    // only counts when crossed forward within 1,500 route units in one step
    if(before<v.nextGate && v.s>=v.nextGate && v.s-before<1500)
    {
        ++v.gates; v.nextGate+=lapDistance/8;
        const lap=(v.gates-1)/8|0; // (gates is at least 1 here)
        if(lap>v.lap && v===playerVehicle)
        {
            playerLap=lap; lap<raceLaps&&(lapBeeps=3); // the checkpoint beep, three times (updateCars), except on the finish: the first beep played under the finish sound (the finish is detected after the beeps below; the post-deadline fix)
        }
        v.lap=lap;
    }
    // race distance for placing: whole sectors passed plus progress inside the current
    // one (clamped, so reversing cannot count); before the first gate it is the negative
    // grid distance to the line
    v.raceDistance=v.gates
        ? (v.gates-1)*lapDistance/8+clamp(v.s-(v.nextGate-lapDistance/8),0,lapDistance/8)
        : min(0,v.s-raceLine);
    v.recordTrail();
}

///////////////////////////////////////////////////////////////////////////////
// the per-step update: controls, every craft, contacts, engine sound, placing, the finish
///////////////////////////////////////////////////////////////////////////////

function updateCars()
{
    // (playerVehicle.energy was copied back INTO the craft here; it is only ever written from the
    // craft below, so the round trip did nothing and went on 2026-09-13. The suites that
    // poke energy set v.energy and playerVehicle.energy together)
    for(const v of vehicles)
    {
        let c;
        if(v!==playerVehicle || titleScreenMode || testDrive) c=driveAI(v);
        else
        {
            // keys ramp the steer over about a fifth of a second both ways (a digital lock
            // was too twitchy); the mouse below is direct
            keySteer=lerp(keySteerEase,keySteer,(keyIsDown('ArrowRight')|keyIsDown('KeyD'))-(keyIsDown('ArrowLeft')|keyIsDown('KeyA'))); // W, A and D beside the arrows in every build (2026-09-13: reading the keys here is far smaller than the enhanced build's remap in the 13k build, +63)
            c={steer:keySteer,gas:keyIsDown('ArrowUp')|keyIsDown('KeyW'),brake:keyIsDown('Space'),boost:keyIsDown('ShiftLeft')}; // Space brakes, left Shift is the turbo (Down and Space until 2026-09-13: Down cannot be held with the steer keys, Frank)
            // mouse mode (a click enters it, any key leaves it, input.js): the pointer steers
            // by its distance from centre even with no button held (full lock a third of the
            // way out); left drives, right is the turbo, middle brakes (a plain slow-down since the drift went on 2026-09-13;
            // a right-button brake with the turbo on Space alone lasted an hour; an automatic gas was
            // too confusing)
            if(mouseMode)
            {
                c.steer=clamp(mouseX*3,-1,1);
                c.gas|=mouseButtons&1;
                c.brake|=mouseButtons>>1&1;
                c.boost|=mouseButtons>>2&1;
            }
            // (steer locks and a follow mode were tried and dropped: plain steering)
            if(debug && testTurn) c.steer=testTurn; // analog steer for the drift suite
            // gamepad: dev and enhanced builds only (folded out of the 13k build)
            if(enhancedMode && isUsingGamepad)
            {
                c.steer=gamepadStick(0).x;
                c.gas=gamepadIsDown(0)||gamepadIsDown(7); // A or the right trigger
                c.brake=gamepadIsDown(1)||gamepadIsDown(2)||gamepadIsDown(6); // B, X or the left trigger
                c.boost=gamepadIsDown(5);
            }
        }
        stepVehicle(v,c,timeDelta);
    }
    checkCraftContacts();

    // the HUD reads the player's state through these globals

    // engine loop: pitch follows speed; silent on the title, the countdown, death, the
    // finish and without focus (playSamples refuses unfocused and onblur stops the loop).
    // It is a looping source, so it must be stopped, and is recreated when needed
    if(!titleScreenMode && !startCountdown && !playerVehicle.deadUntil && !gameOverTime && soundVolume)
    {
        // low energy warning: from 25, where the meter starts flashing, a tick at one volume
        // whose period shrinks from .55 s at 25 to .05 s at zero (an echoing countdown beep
        // under 10 did not read as a warning)
        if(playerVehicle.energy<25 && time>lowBeepTime) lowBeepTime=time+.05+playerVehicle.energy*.02, sound_checkpoint.play(.5,2-playerVehicle.energy/50);
        if(lapBeeps && time>lapBeepTime) lapBeepTime=time+.15, --lapBeeps, sound_checkpoint.play(.7); // a lap: three beeps .15 s apart
        if(!engineSound) engineSound=sound_engine.play(.04);
        if(engineSound)
        {
            engineSound.loop=true;
            engineSound.playbackRate.value=playerVehicle.speed/5e3;
        }
    }
    else if(engineSound)
    {
        engineSound.stop();
        engineSound=0;
    }

    playerPlace=1+vehicles.filter(v=>v.raceDistance>playerVehicle.raceDistance).length;
    // the finish: record the placing and the time (debug skips poison the records)
    if(playerLap>=raceLaps && !gameOverTime && !titleScreenMode)
    {
        playerWin=1;
        lastRacePlace=playerPlace;
        gameOverTime=time;
        sound_win.play();
        if(!(debug && debugSkipped))
        {
            // the best placing on this circuit, one digit per circuit (0 = never finished);
            // the menu shows it and browses up to the circuit after the last one finished
            if(!(bestPlaces[currentCircuit]|0) || playerPlace<bestPlaces[currentCircuit]) bestPlaces=bestPlaces.slice(0,currentCircuit)+playerPlace+bestPlaces.slice(currentCircuit+1);
            // and the best time, kept apart: a better time can come with a worse place (Frank, 2026-09-13)
            bestTimes[currentCircuit]=min(bestTimes[currentCircuit]||1e9,raceTime); // 0 or empty is none
            writeSaveData();
        }
    }
}

///////////////////////////////////////////////////////////////////////////////
// craft-versus-craft contacts
///////////////////////////////////////////////////////////////////////////////

// Tests every pair with a swept box in the road frame of the first craft. A contact
// slows both craft and costs up to 4 energy (once per .5 s per pair) and always
// separates them sideways by 20 units; no physical momentum is exchanged.
function checkCraftContacts()
{
    for(let i=0;i<vehicles.length;++i)
    for(let j=i+1;j<vehicles.length;++j)
    {
        const a=vehicles[i],b=vehicles[j];
        if(a.deadUntil || b.deadUntil || startCountdown) continue;
        const info=new TrackSegmentInfo(a.s), d=b.pos.subtract(a.pos);
        const old=b.previousPosition.subtract(a.previousPosition), move=d.subtract(old);

        // slab test of the relative motion segment against an expanded craft box (half
        // extents: 220 up, 600 along, 360 across, so vertically separated decks never
        // touch; 760/480 hit craft that did not look close). A boost-speed head-on
        // crossing can traverse the entire box in one tick
        let enter=0, leave=1;
        for(const [axis,size] of [[info.up,220],[info.forward,600],[info.right,360]])
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
            // the hit scales with the closing speed, full at 8,000: both lose up to 18% of
            // their speed and 4 energy (6 stacked up in a pack), and any slide or charge.
            // A rub at the same pace is nearly free: a flat cost had a field of 20
            // bleeding out in the first 30 s (3-10 deaths a start, measured)
            const k=clamp(b.velocity.subtract(a.velocity).mag()/8000);
            a.velocity=a.velocity.scale(1-.18*k);
            b.velocity=b.velocity.scale(1-.18*k);
            a.speed=a.velocity.mag();
            b.speed=b.velocity.mag();
            a.energy=max(0,a.energy-4*k);
            b.energy=max(0,b.energy-4*k);
            contactTimes[key]=time+.5;
            if(k>.2) // a rub is silent and shows nothing; a real hit bursts and sounds
            {
                a.hitTime=b.hitTime=time+.3;
                (racing(a) || racing(b)) && sound_hit.play(.3);
            }
        }

        // separate sideways (a stacked pair breaks toward the later grid index) and re-contain both
        const side=sign(d.dot(info.right)||j-i), push=info.right.scale(side*20);
        a.pos=a.pos.subtract(push);
        b.pos.addSelf(push);
        containCraft(a);
        containCraft(b);
    }
}

function drawCars() { for(const v of vehicles) v.draw(); }

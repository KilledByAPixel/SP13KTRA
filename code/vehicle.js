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
// All velocities are world units / second. Route s is derived from position and
// exists only for navigation, containment and validated race progress.
///////////////////////////////////////////////////////////////////////////////

const raceLine=3000, maxCraftSpeed=32000; // route s of the start line; the normal speed cap

// true for the player's craft in a live race: gates its sound effects and its death. The
// attract lap behind the title and menu is silent, and so is the AI driving on once the
// race is over (a pad's boost would play over the results card)
const racing=v=>v===playerVehicle && !titleScreenMode && !gameOverTime;

// contactTimes: per-pair contact cooldown, keyed i*count+j
// timers (seconds): the next low-energy beep, lap beeps left and the next one, the next
// charge blip; bumpDistance: units of travel left before the next rough-shoulder bump
let contactTimes=[], engineSound, keySteer=0, lowBeepTime=0, lapBeeps=0, lapBeepTime=0, chargeTime=0, bumpDistance=0;

// feel tunables. keySteerEase: the per-frame lerp of the keyboard steer toward the key
// (lower = a softer ramp; the player's only). steerRate: the heading rate in rad/s.
// gripNormal: the per-second bleed of sideways velocity (14 is on rails, 8 lets every
// corner drift a touch, 4 is a boat)
const keySteerEase=.15, steerRate=1, gripNormal=8;

// steer rate multipliers. coastSteer: off the gas or on the brake, every craft (some
// corners are tighter than the plain rate, so letting go turns tighter; 2 oversteers).
// turboSteer: the player's on the turbo (less to adjust with). steerEase: seconds for the
// player's multiplier (steerMul) to settle after the gas or turbo changes, never a snap
const coastSteer=1.5, turboSteer=.75, steerEase=.15;
let steerMul=1;

// how much of the speed the grip step keeps as it turns the velocity toward the nose,
// 0..1: at 0 the sideways part is thrown away and a turn off the gas bleeds speed; at 1
// the speed transfers whole into the new direction, so a corner costs only the drag
const gripKeep=1;

///////////////////////////////////////////////////////////////////////////////
// hull specs and the field
///////////////////////////////////////////////////////////////////////////////

// one hull per colour index, built once by draw.js into craftSpecs (with the loft mesh).
// Wide, flat, long: the fleet's span/length is about .52 against the reference sheet's
// .458 (4.08m x 1.87m), a deliberate exaggeration for a squatter race-distance read
function makeCraftSpec(i)
{
    const r = new Random(i*61+7);
    const bs = vec3(r.float(205,250), r.float(78,100), r.float(345,405)); // half extents
    const sweep = r.float(.82,.92);  // how far back along the hull the wingtips sit
    const taper = r.float(.5,.72);   // trailing edge width vs wingspan
    const wingX = r.float(.74,1);    // wingspan, as a fraction of the half extent

    // the loft: stations nose to tail, [z, halfWidth, topY, bottomY]. In plan it is one
    // long triangle from the nose out to the wingtips at 82-92% back (.4 of the span at
    // 35%, .74 at 62%, on the near straight leading edge), then the trailing edge cuts
    // back in; in profile the keel is near flat and the deck ridge climbs the whole way,
    // so no two facets share a pitch. The deck datum is y=40
    const L = bs.z, W = bs.x*wingX, H = bs.y;
    return {
        bs,
        w: W,                           // half wingspan
        t: W*taper,                     // half trailing edge
        engines: 1+i%3,                 // engine glow count
        tail: vec3(0, 40+H*.17, -L-30), // nozzle centroid (craft space): sparks and the trail leave here
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
// one of the first six in the menu; the rivals take the rest (Racer), so black and
// white are always rivals
const racerColors = [[0,.8,.5],[.08,1,.5],[.14,1,.5],[.33,.9,.4],[.6,1,.5],[.8,.8,.55],[0,0,.05],[0,0,1]];

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
        // playerTurn: the eased steer, for the visual lean; throttle: the eased gas (-.5 on
        // the brake) and burn: the eased boost, 0..1, for the engine glow and the ribbon
        this.speed=this.playerTurn=this.throttle=this.burn=0;
        // boostTime: when the boost ends; boostPower: the end of a turbo press's committed
        // window, 0 for a pad's boost; deadUntil: the respawn time, 0 while alive
        this.boostTime=this.deadUntil=this.boostPower=0;
        // padTime: the last pad; wallTime: the end of the hard-wall cooldown; hitTime: the
        // end of the damage burst (track.js)
        this.padTime=this.wallTime=this.hitTime=-1;
        this.gates=this.lap=this.raceDistance=0; this.nextGate=raceLine; // the first gate is the start line
        this.place(s,x);
    }

    // seat the craft at rest on the route frame at (s, lateral x): the grid, respawns and
    // dev relocation
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
        if(this.deadUntil) return; // exploded: nothing to draw until the respawn clears it
        const m=this.craftMatrix(), S=this.craft, H=S.w, bs=S.bs;

        // the hull, lit and glossy (the GL flags are as drawTrack left them: depth on, lit).
        // There is no craft shadow
        glSpecularity=.75;
        S.mesh.render(m,this.color);

        // the canopy: a half-emissive diamond over the 62% station, .6 toward white (any
        // darker and a dark craft merges into the dark road from behind)
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

// a rival. Skill goes by colour; each also has a home circuit, its racerIndex, for a 4%
// bump (driveAI; white's is the finale). The ladder is deliberately wide: a narrow
// .92-1.02 one puts every rival in the catch-up's linear region, one blob behind the player
class Racer extends Vehicle
{
    // k: grid order 0..fieldSize-2; the colour is the k-th one the player did not take
    constructor(s,x,k)
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

// rival tunables:
//   aiClip: the pace clip before the catch-up, as a fraction of the normal top speed times
//     the circuit's rivalSkill, so the straights get faster up the ladder as well as the corners
//   aiCornerSlow: the pace cut per unit of the sharpest turn ahead
//   aiCornerBrake: speed times turn above which a rival brakes (a player only lifts);
//     with no corner brake at all a rival dies on UMBRA
//   aiBoostGap: how far behind the player a rival starts holding its free turbo (at 4,000
//     the boosting pack crowds the player to death)
//   aiLine: how much of the racing line a rival follows (at .35 it cuts every corner tighter
//     than the road allows)
//   aiPaceFloor: the traffic cap never paces a rival below this fraction of its own target
const aiClip=.96, aiCornerSlow=.08, aiCornerBrake=34000, aiBoostGap=5000, aiLine=.7, aiPaceFloor=.7;

// Also drives the player's craft behind the title and menu, once the race is over and
// under autodrive (testDrive), where skill and lineOffset are missing: hence the ||
// fallbacks. The player's own gap is 0, so its catch-up is 1 and it never boosts
function driveAI(v)
{
    const info=new TrackSegmentInfo(v.s), seg=info.segmentIndex;
    const look=1800+v.speed*.16; // route units of lookahead, growing with speed

    // lateral aim: the nearest reachable pad, else the racing line plus this rival's lane
    let x=padSeekX(seg,v.localX) ?? (trackRacingLine[seg]*aiLine+(v.lineOffset||0));
    let targetSpeed=maxCraftSpeed*(v.skill||.96)*levelInfo.rivalSkill;

    // the sharpest curvature over the next 300 segments, each weighted down by its distance
    // (1-k/400: a turn 280 on counts .3), sets the corner pace, the lift and the corner
    // brake. A short scan sees a hairpin too late to slow from top speed; a plain long one
    // slows every corner on every circuit; the weight brakes early only for the sharpest
    let corner=0;
    for(let k=0;k<300;k+=20) corner=max(corner,abs(track[wrapSegment(seg+k)].turn)*(1-k/400));
    targetSpeed*=clamp(1-corner*aiCornerSlow,.35,1); // at .08 a 10,000 radius (turn 2.5) costs a fifth
    if(v.racerIndex==currentCircuit) targetSpeed*=1.04; // the home circuit

    // catch-up changes the target pace only, never position: .98-1.1, full at a 40k gap.
    // Each rival settles where the catch-up cancels its skill, so the slope spaces the field.
    // The pace is clipped before the catch-up multiplies it, so a rival well behind runs
    // past the normal top speed and can close on a player on the turbo
    const gap=playerVehicle.raceDistance-v.raceDistance;
    targetSpeed=min(targetSpeed,maxCraftSpeed*levelInfo.rivalSkill*aiClip)*clamp(1+gap/400000,.98,1.1);

    // traffic: swerve a lane away from a craft close ahead and do not ram it
    for(const other of vehicles)
    {
        if(other===v) continue;
        const d=other.pos.subtract(v.pos), ahead=d.dot(v.forward), side=d.dot(info.right);
        // not in the first two seconds off the grid: GO lands at time 3 (time, not raceTime,
        // which only runs in a race: the attract field must avoid traffic too)
        if(ahead>0 && ahead<3400 && abs(side)<650 && time>5)
        {
            x=clamp(v.localX+(side>0?-900:900),-info.w+700,info.w-700);
            // only a craft squarely ahead holds a rival back; one beside it is passed. Never
            // below aiPaceFloor of its own target, or the whole field queues behind a crawling
            // player; in a pack everyone is near their target, so the floor never binds there
            if(ahead<1000 && abs(side)<300 && v.speed>other.speed) targetSpeed=min(targetSpeed,max(other.speed*.98,targetSpeed*aiPaceFloor));
        }
    }

    const target=sampleRoute(v.s+look,x).subtract(v.pos);
    const error=clampAngle(Math.atan2(target.x,target.z)-v.heading);
    const steer=clamp(error*3,-1,1);

    // brake when well over pace, or when too fast for the corner ahead: the turning radius
    // is the speed and a turn of 1 is a 25,000 radius, so speed*turn over 25,000 runs wide.
    // The over-pace brake waits while a boost runs: the brake cuts boost thrust, so it would
    // cancel the rival's own pad and catch-up boosts. Without it rivals crash
    const brake=v.boostTime<time&&v.speed>targetSpeed+1350 || v.speed*corner>aiCornerBrake;

    // gas: lifted where speed*turn passes 24,000, a corner the steer rate cannot hold; off
    //   the gas a rival turns at coastSteer, the player's own trick, and the lift's margin
    //   lets the brake wait
    // cap: full gas with the target as a cap (stepVehicle). Gas on-off around the target
    //   makes the engines flutter; the cap holds the pace and the glow steady
    // boost: a rival aiBoostGap or more behind holds the player's turbo, at no energy cost
    return {steer,gas:v.speed*corner<24000,cap:targetSpeed,brake,boost:gap>aiBoostGap}
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
    // (240/400 keeps the hull a ship's width off the wall, which looks unfair)
    const slip=clampAngle(v.heading-info.heading);
    const extent=abs(Math.cos(slip))*120+abs(Math.sin(slip))*320;
    const edge=info.w-extent, x=clamp(r.x,-edge,edge);
    let wall=x!==r.x;
    if(wall)
    {
        const side=sign(r.x), outward=v.velocity.dot(info.right)*side;
        v.pos.addSelf(info.right.scale(x-r.x)); // back inside the wall
        // no motion into the wall
        if(outward>0) v.velocity=v.velocity.subtract(info.right.scale(side*outward));
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

// c: {steer -1..1, gas (0..1 from the enhanced build's gamepad trigger, else 0 or 1), brake,
// boost, cap?}; dt: the fixed step (1/60). Handles death and respawn, steering, grip,
// thrust and braking, substepped movement with containment, pads, the recharge strip,
// the rough shoulder, ordered gates and race distance.
function stepVehicle(v,c,dt)
{
    v.previousPosition=v.pos.scale(1);
    // the engine light follows the gas (enhanced: a partial trigger lights it partway): off
    // the gas it shrinks as at rest; on the brake it eases to -.5, so the ribbon narrows to
    // a quarter and the nozzles to .15 of their size, the brake's feedback (small, not gone)
    v.throttle=lerp(.15,v.throttle,c.brake?-.5:c.gas?enhancedMode?+c.gas:1:0);
    // the boost: the ribbon and nozzles swell and shrink over a few frames, never snap
    v.burn=lerp(.15,v.burn,v.boostTime>time?1:0);

    // a non-finite state is treated as a death: the respawn below rebuilds it from the route
    if(!isFinite(v.pos.x+v.pos.y+v.pos.z+v.velocity.mag()))
        v.deadUntil=time;
    if(v.deadUntil)
    {
        // after the wait, respawn at the last gate passed with half energy and a fresh trail.
        // The player's craft too: its death has ended the race (racing is false from then
        // on) and the AI drives it on; it never respawns inside a live race
        if(time<v.deadUntil || racing(v)) return;
        v.place(v.nextGate-lapDistance/8);
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
    // death: the explosion (drawTrails), two seconds stopped, then the respawn above. The
    // player cannot die once the race is over; in a race its death ends it, and the results
    // card reads OUT from deadUntil
    if(v.energy<=0 && !(v===playerVehicle && gameOverTime))
    {
        v.deadUntil=time+2;
        v.velocity=vec3();
        v.speed=0;
        if(racing(v))
        {
            sound_lose.play(.7);
            gameOverTime=time;
            wavedashMode && wdExplode();   // the secret achievement for exploding (wavedash.js)
            newgroundsMode && ngExplode(); // and its Newgrounds medal (newgrounds.js)
        }
        return;
    }
    if(startCountdown) { v.speed=0; return; }

    const speed=v.velocity.mag();

    // the visual lean. ||0: craftMatrix's DOMMatrix throws on a NaN lean and a lerp from NaN
    // stays NaN, so one poisoned steer would lose every later frame. A non-finite state gets
    // here because the AI worked this step's controls out from it before the reseat above
    // (test/world-systems.js, "invalid movement safely recovers")
    v.playerTurn=lerp(.3,v.playerTurn,c.steer)||0;

    // heading rate: steerRate from 10,500 up, so the turning radius is the speed and slowing
    // down turns you tighter; scaled down with speed under that to a .45 floor, high enough
    // to turn away from a wall you have stopped against
    let rate=steerRate*clamp(speed/10500,.45,1);

    // the turbo is on while its button is down or inside a press's committed window
    // (boostPower, below), and only while it can run (energy over 1): the steer and the
    // boost both follow it, so a tap steers like the turbo it runs and an empty one does not
    const turbo=(c.boost || v.boostPower>time) && v.energy>1;
    // the steer multiplier: any craft on the brake or off the gas turns at coastSteer; the
    // player's turbo turns at turboSteer, and the player's multiplier is eased over steerEase
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
    const side=v.velocity.dot(right);
    v.velocity=v.velocity.subtract(right.scale(side*(1-Math.exp(-gripNormal*dt))));
    const m=v.velocity.mag();
    if(m) v.velocity=v.velocity.scale(lerp(gripKeep,m,speed)/m);

    // the held turbo: 25 energy/s for the player, free for a rival (rivals never charge).
    // It never drains the last unit: at 1 the turbo just stops, and only a wall or a craft
    // can finish you. A press commits .5 s: boostPower holds the end of that window, and
    // inside it the turbo runs and drains as if held, so tapping saves no energy.
    // A non-zero boostPower also marks the running boost as a turbo's, not a pad's
    if(turbo)
    {
        v.energy=max(1,v.energy-25*dt*(v==playerVehicle));
        // a press: no boost was running, or only a pad's
        if(v.boostTime<time || !v.boostPower) racing(v) && sound_boost.play(.5), v.boostPower=time+.5;
        v.boostTime=max(v.boostTime,time+.02); // one step on: no free tail
    }

    // speed caps: normal 32,000 (or the AI's target, c.cap), a pad's boost 39,000, the turbo 40,000
    const boosted=v.boostTime>time, cap=boosted?(v.boostPower?40000:39000):c.cap||maxCraftSpeed;
    // thrust (units/s^2): the gas 9,600 (enhanced: times the 0..1 trigger), any boost 20,000
    // (turbo and pad are equal, written apart so they can differ). The brake cuts the gas
    // and the boost's thrust too, or braking on a boost would still gain speed
    let accel=c.brake?0:boosted?(v.boostPower?20000:20000):c.gas?9600*(enhancedMode?c.gas:1):0;
    if(speed>=cap) accel=0;
    v.velocity.addSelf(v.forward.scale(accel*dt));
    // deceleration (units/s^2): the brake 10,500, coasting 1,000 (a release should carry), gas 0
    const braking=c.brake?10500:c.gas?0:1000;
    let newSpeed=max(0,v.velocity.mag()-braking*dt);
    // over the cap (a boost that just ended): bleed down at 7,500/s instead of snapping
    if(newSpeed>cap) newSpeed=speed<=cap?cap:max(cap,newSpeed-7500*dt);
    // (a zero velocity: newSpeed is 0, and normalize's (1,1,1) fallback scales to zero)
    v.velocity=v.velocity.normalize().scale(newSpeed);

    // short moves (80 units, at most 16 of them) keep containment continuous even at
    // boosts and lap seams
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

    // boost pad (roadType 1): within .95 of a lane of the pad's lane centre, just inside its
    // drawn 1,400; an .8 s boost that never downgrades a held turbo. The cooldown is .3 s:
    // the second pad of a pair (120 samples on, trackGen.js) comes .35-.55 s after the first
    // at pad or turbo speed, and must count
    if(t.roadType==1 && abs(v.localX-t.padX)<laneWidth*.95 && time>v.padTime+.3)
    {
        if(v.boostTime<time) v.boostPower=0;
        v.boostTime=max(v.boostTime,time+.8); v.padTime=time;
        racing(v) && sound_boost.play(.5, 2);
    }

    // the recharge strip (roadType 2): the outer stripWidth units on the padX side, 60 energy/s.
    // v.charging is on only while energy still rises (drawTrails draws sparks under the craft)
    v.charging=t.roadType==2 && v.localX*t.padX>info.w-levelInfo.stripWidth && v.energy<100;
    if(v.charging) v.energy=min(100,v.energy+60*dt);
    // the charge blip: at once on starting to charge (stopping resets the timer), then
    // every .3 s while charging; silent at full energy
    if(racing(v)) v.charging ? time>chargeTime && (chargeTime=time+.3, sound_charge.play(.4)) : chargeTime=0;

    // the rough shoulder (roadType 3): the outer two and a half lanes on the padX side drag
    // anyone on them at 1.5/s and rattle the player: a bump every 3,000-4,500 units travelled,
    // so faster the faster you go, and louder with speed. A held turbo (boostPower, not a
    // pad's boost) skims over it: no drag, no rattle
    if(t.roadType==3 && !(boosted&&v.boostPower) && v.localX*t.padX>info.w*bermStart-2.5*laneWidth)
        v.velocity=v.velocity.scale(1-1.5*dt), racing(v) && (bumpDistance-=v.speed*dt)<0 && (bumpDistance=3e3*(1+Math.random()/2), sound_slowBump.play(clamp(v.speed/32e3)));

    // ordered gates are route metadata. Teleporting/debug placement is not a lap: a gate only
    // counts while the craft is past it by under 1,500 route units. Do not test whether the
    // step started short of the gate: checkCraftContacts re-seats both craft after their
    // steps, and a nudge across a gate would skip it, and so every later one, for good
    if(v.s>=v.nextGate && v.s-v.nextGate<1500)
    {
        ++v.gates; v.nextGate+=lapDistance/8;
        const lap=(v.gates-1)/8|0; // (gates is at least 1 here)
        if(lap>v.lap && v===playerVehicle)
        {
            // the checkpoint beep, three times (updateCars), except on the finishing lap: it
            // would play under the finish sound
            playerLap=lap; lap<raceLaps&&(lapBeeps=3);
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
    for(const v of vehicles)
    {
        let c;
        // the AI drives every rival, and the player's craft behind the title and menu, under
        // autodrive and once the race is over (a finish or a death): the field races on
        if(v!==playerVehicle || titleScreenMode || testDrive || gameOverTime) c=driveAI(v);
        else
        {
            // keys ramp the steer over about a quarter of a second both ways (a digital lock
            // is too twitchy); the mouse below is direct. W, A and D are read beside the
            // arrows here in every build: far smaller in the 13k build than a key remap
            keySteer=lerp(keySteerEase,keySteer,(keyIsDown('ArrowRight')|keyIsDown('KeyD'))-(keyIsDown('ArrowLeft')|keyIsDown('KeyA')));
            // Space brakes (Down cannot be held with the steer keys on many keyboards), left
            // Shift is the turbo; the enhanced build brakes on Down and S too, written as a
            // conditional so the 13k build folds to Space alone
            c={steer:keySteer,gas:keyIsDown('ArrowUp')|keyIsDown('KeyW'),brake:enhancedMode?keyIsDown('Space')|keyIsDown('ArrowDown')|keyIsDown('KeyS'):keyIsDown('Space'),boost:keyIsDown('ShiftLeft')};
            // the gas key hands steering back to the keys, before the mouse steer applies: a
            // click to race from the menu leaves the pointer parked over the list, full left
            // lock, and a keyboard player always gasses to go. Not any key: Space and Shift
            // keep mouse mode, so a mouse player brakes and boosts from the keyboard
            mouseMode &= !c.gas;
            // the enhanced build hands it back on any of the arrows or WASD, or a player
            // steering on the arrows after a click is stuck in mouse control
            if(enhancedMode && (keyIsDown('ArrowLeft')|keyIsDown('ArrowRight')|keyIsDown('ArrowDown')|keyIsDown('KeyA')|keyIsDown('KeyD')|keyIsDown('KeyS')))
                mouseMode=0;
            // mouse mode (a click enters it, input.js): the pointer steers by its distance from
            // centre even with no button held (full lock a third of the way out); left drives,
            // middle brakes, right is the turbo
            if(mouseMode)
            {
                c.steer=clamp(mouseX*3,-1,1);
                c.gas|=mouseButtons&1;
                c.brake|=mouseButtons>>1&1;
                c.boost|=mouseButtons>>2&1;
            }
            if(debug && testTurn) c.steer=testTurn; // a steer override for tests (debug.js)
            // gamepad: dev and enhanced builds only (folded out of the 13k build)
            if(enhancedMode && isUsingGamepad)
            {
                c.steer=gamepadStick(0).x;
                // A full, or the right trigger, analog 0..1 past its dead zone
                c.gas=max(gamepadIsDown(0), gamepadDataValues[0]?.[7]||0);
                c.brake=gamepadIsDown(2)||gamepadIsDown(6); // X or the left trigger, on or off
                c.boost=gamepadIsDown(1)||gamepadIsDown(5); // B or RB
            }
            // the dev free camera has the keys and the mouse: the craft coasts (Q's autodrive,
            // switched on before the free cam, still drives it)
            if(debug && freeCamMode) c={steer:keySteer=0};
        }
        stepVehicle(v,c,timeDelta);
    }
    checkCraftContacts();

    // engine loop: pitch follows speed; silent on the title, the countdown, death, the
    // finish and without focus (playSamples refuses unfocused and onblur stops the loop).
    // It is a looping source, so it must be stopped, and is recreated when needed
    if(!titleScreenMode && !startCountdown && !playerVehicle.deadUntil && !gameOverTime && soundVolume)
    {
        // low energy warning: from 25, where the meter starts flashing, a tick at one volume
        // whose period shrinks from .55 s at 25 to .05 s at zero and whose pitch rises from
        // 1.5 to 2
        if(playerVehicle.energy<25 && time>lowBeepTime) lowBeepTime=time+.05+playerVehicle.energy*.02, sound_checkpoint.play(.5,2-playerVehicle.energy/50);
        // a lap: three beeps .15 s apart
        if(lapBeeps && time>lapBeepTime) lapBeepTime=time+.15, --lapBeeps, sound_checkpoint.play(.7);
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
    // the finish: record the placing and the time (never after a debug skip)
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
            // and the best time, kept apart: a better time can come with a worse place
            bestTimes[currentCircuit]=min(bestTimes[currentCircuit]||1e9,raceTime); // 0 or empty is none
            writeSaveData();
            // the platform hooks, after the save holds the result, with no arguments so the
            // 13k build folds each call away whole: the circuit's Wavedash board, the
            // achievements and the cloud bests (wavedash.js); the Newgrounds scoreboard and
            // medals (newgrounds.js)
            wavedashMode && wdFinish();
            newgroundsMode && ngFinish();
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
        // touch; 760/480 hits craft that do not look close). A boost-speed head-on
        // crossing can traverse the entire box in one tick, hence the sweep
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
            // their speed and 4 energy. A rub at the same pace is nearly free: a flat cost
            // bleeds a packed field out in the first 30 s of a race
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

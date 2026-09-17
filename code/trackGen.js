'use strict';

////////////////////////////////////////////////////////////////////////////////
// trackGen.js: closed-loop circuit generation
//
// Owns: building the `track` array (lapTrackSegments route samples) for the current
// circuit from its skeleton: heights with a swell, bank, the AI racing line, the recharge
// strips, boost pads, rough shoulders and corner warnings, then handing off to
// buildCourseWorld (track.js) for the meshes.
//
// Called from: game.js when a race starts (buildTrack). It returns early while worldKey
// still matches the circuit, so same-circuit retries reuse the built world.
//
// Reads: circuitCorners/levelInfo (levels.js), buildSkeleton and SK_* (skeleton.js),
// laneWidth/lapTrackSegments/lapDistance/trackSeed/currentCircuit (game.js),
// bermStart/worldKey (track.js).
//
// Writes the globals below: vehicle.js steers rivals by trackRacingLine, track.js orients
// scenery by trackHeadingCum and fills the minimap points that hud.js draws, game.js
// converts route distance with routeScale, and the tests hash trackHeadingCum and the pad
// layout.
//
// The track is a loop: every index lookup wraps via wrapSegment.
////////////////////////////////////////////////////////////////////////////////

let trackHeadingCum;   // unwrapped heading per sample (N+1 entries): the generator fingerprint the tests hash
let trackRacingLine;   // per-segment ideal x offset for the AI racers

// the loop in true world space, filled by track.js: [x,z] every 8 segments, its bounding
// box centre and half extent
let trackMapPts, trackMapCenter, trackMapRadius;
let routeScale=1.25;   // world units per route unit (lap length over lapDistance, 1.1-1.55 per circuit)

////////////////////////////////////////////////////////////////////////////////
// Build one closed circuit.
function buildTrack()
{
    if(worldKey===currentCircuit) return; // this world is already built
    disposeWorld();
    const N = lapTrackSegments;
    track = [];

    ////////////////////////////////////////////////////////////////////////////
    // Skeleton: the authored corner polygon. Every circuit is preset, nothing is rerolled.
    let corners=circuitCorners[currentCircuit];

    // SODIUM and CHERENKOV run the other way in the enhanced build, so not every circuit
    // turns the same way. The corner polygon is mirrored in x about its own centre, not
    // about zero, so the loop keeps its footprint and the map draws it in the same place.
    // Every corner reverses and everything derived follows (turn signs, the racing line,
    // chevron sides, and pads and strips, which land in new spots). The 13k build's
    // circuits never change: this folds away there
    if(enhancedMode && (currentCircuit==2 || currentCircuit==4))
    {
        const xs=corners.map(c=>c[0]), twiceCentre=min(...xs)+max(...xs);
        corners=corners.map(c=>[twiceCentre-c[0],...c.slice(1)]);
    }
    const sk=buildSkeleton(corners,N);
    routeScale=sk.len/lapDistance;
    debug && LOG('lap',sk.len|0,'units, spacing',(sk.len/N).toFixed(1));
    trackHeadingCum=new Float64Array(N+1);
    for(let i=0;i<N;++i)
        trackHeadingCum[i+1]=trackHeadingCum[i]+clampAngle(sk.heading[(i+1)%N]-sk.heading[i]);

    ////////////////////////////////////////////////////////////////////////////
    // Heights: the skeleton's keyframes plus a gentle swell of two sine waves.
    // Whole-number frequencies keep the swell seamless across the lap.
    random.setSeed(trackSeed+currentCircuit*31);
    const waves = []; // [frequency in cycles per lap, amplitude, phase]
    for(let k=0; k<2; ++k)
        waves.push([random.int(3,8), levelInfo.bump/(k+1), random.float(2*PI)]);

    ////////////////////////////////////////////////////////////////////////////
    // Segments: position, curvature, flags and bank per sample.
    const width = laneWidth*1.6*levelInfo.laneCount; // half-width: 4,480 on four lanes
    for(let i=0; i<N; ++i)
    {
        let height = sk.y[i];
        for(const [f, a, ph] of waves)
            height += a*Math.sin(2*PI*f*i/N + ph);

        // one route sample, a plain object: buildCourseWorld adds its frame (forward, right,
        // up, pitch); roadType, padX and chev stay undefined until painted, and every read
        // treats that as 0
        const t = track[i] = {pos:vec3(sk.x[i], height, sk.z[i]), w:width, turn:sk.turn[i], flags:sk.flags[i]};

        // Bank into the corner from curvature (bankAmp climbs the ladder), or fully
        // on a BANKED arc; either way clamped to +-.5.
        t.roll = t.flags&SK_BANKED
            ? clamp(t.turn*9,-.5,.5)                 // BANKED: saturates on any real corner
            : clamp(levelInfo.bankAmp*t.turn,-.5,.5);
    }

    // Bank never changes suddenly: two box blurs over 121 samples.
    for(let pass=0; pass<2; ++pass)
    {
        const r = track.map(t=>t.roll);
        for(let i=0; i<N; ++i)
        {
            let sum = 0;
            for(let k=-60; k<=60; ++k) sum += r[wrapSegment(i+k)];
            track[i].roll = sum/121;
        }
    }

    ////////////////////////////////////////////////////////////////////////////
    // Racing line: drift toward the inside of upcoming corners.
    trackRacingLine = new Float64Array(N);
    let lineX = 0;
    for(let i=0; i<2*N; ++i) // two laps: the second pass makes the wrap seam converge
    {
        const j = wrapSegment(i);
        let ahead = 0;
        for(let k=0; k<80; k+=8) // sum the curvature 80 samples ahead
            ahead += track[wrapSegment(j+k)].turn;
        const margin = track[j].w*bermStart-450; // stay on the flat part of the ribbon, 450 short of the berm
        lineX = lerp(.03, lineX, clamp(300*ahead, -margin, margin)); // slow lerp: the line eases, never kinks
        trackRacingLine[j] = lineX;
    }

    ////////////////////////////////////////////////////////////////////////////
    // Pickups. paint marks n samples from i as roadType type with padX x: strips, pads
    // and shoulders share both fields.
    // The recharge strip (roadType 2, padX = the side) is a safe outside line on the right
    // after the grid (samples 60-259; the start is at s=3000, sample 30), levelInfo.stripWidth
    // wide. Scenery bit 8 adds a second one on the LEFT so the charge is not always in the
    // same place: it starts at the first straight enough 200 samples (|turn| under .4, a
    // 62,500 radius) from halfway round; a fixed sample can land on a bend.
    // paint does NOT wrap: a run that starts within n of the end would throw on track[i+k].
    // Every placement below stays clear of it, but the margins are the random stream's, not
    // a rule, so the dev build asserts
    const paint=(i,n,type,x)=>{ debug && ASSERT(i>=0 && i+n<=N, 'paint past the loop end'); for(let k=0;k<n;++k) track[i+k].roadType=type, track[i+k].padX=x; };
    const strip=(i,side)=>paint(i,200,2,side);
    strip(60,1);
    if(levelInfo.scenery&8)
    {
        let i=2000;
        while(i<N-400 && track.slice(i,i+200).some(t=>abs(t.turn)>.4)) i+=10;
        strip(i,-1);
    }

    // Boost pads: pairs that weave exactly one lane across each acceleration straight,
    // 120 samples (a 15,000-unit gap) apart, only where the WHOLE run is straight
    // (|turn| under .1, a 250,000 radius): both pads and 96 samples of run-out past the
    // second, about 12,000 units, a third of a second at pad speed. Checking a single
    // sample lets the second pad start right at a corner; a much longer run-out starves
    // the twisty circuits of pads. padWait spreads the pairs up the ladder.
    for(let i=300;i<N-300;++i)
    {
        if(track.slice(i,i+240).some(t=>abs(t.turn)>.1)) continue;
        const lanes=levelInfo.laneCount;
        let lane=random.int(0,lanes); // 0..lanes-1
        for(let g=0;g<2;++g)
        {
            // A pad is 24 samples, about 3,000 units (shorter reads as a blip). It yields to a
            // strip under ANY of its samples, or it would cut a strip in two. padX is the lane
            // centre, lanes centred on the road.
            if(!track.slice(i,i+24).some(t=>t.roadType)) paint(i,24,1,(lane-(lanes-1)/2)*laneWidth);
            i+=120;

            // The second pad steps one lane in from an edge lane, else a random neighbour.
            lane+=lane==0?1:lane==lanes-1?-1:random.sign();
        }
        i+=random.int(150,300)*levelInfo.padWait|0; // gap before the next pair (plus the loop's ++i)
    }

    // Rough shoulders (F-Zero's damaged verge): 120-sample stretches of the outer two and a
    // half lanes on one side (roadType 3, padX = the side) that drag anyone on them, every
    // 400-700 samples. A stretch that would cross a pad or a strip is skipped whole: skipping
    // only the overlap leaves holes that start and stop the drag. The test window must be the
    // whole painted length, or a pad near its end is overwritten. The side is drawn before
    // the test, so a skip never moves the random stream.
    for(let i=400;i<N-100;i+=random.int(400,700))
    {
        const side=random.sign();
        if(track.slice(i,i+120).some(t=>t.roadType)) continue;
        paint(i,120,3,side);
    }

    ////////////////////////////////////////////////////////////////////////////
    // Corner warnings: every 24 samples (the single road panels), where the road turns
    // more than a set amount over the next 150 samples: the SIGNED sum of turn (1 = a 25,000
    // radius) at eight samples across the window, over 2, so a sweeper adds up while the two
    // halves of a chicane or a wave crest cancel (the sharpest single sample would flag both
    // sides of an S). The warning starts about 75 samples out, once half the window is in
    // the corner.
    // turn>0 is a right-hand corner (heading increases). chev is +1 before a right
    // corner and -1 before a left one; track.js (buildScenery) stands a pulsing arrow
    // beside the -x (left) wall for +1 and the +x wall for -1: the OUTSIDE of the corner.
    for(let i=72; i<N; i+=24)
    {
        let s = 0;
        for(let k=0; k<150; k+=20) s += track[wrapSegment(i+k)].turn;
        if (abs(s) > 2) track[i].chev = sign(s);
    }

    // The skyline field draws from random LAST: nothing placed above moves when it changes.
    buildCourseWorld();
}

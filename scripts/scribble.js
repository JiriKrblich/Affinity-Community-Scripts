'use strict';
// ============================================================
//  Scribble v21 (English)
//  Generates curves (individual lines / continuous zig-zag line /
//  cross-hatch / contour hatch) and clips them into a vector shape
//  or text object (incl. per-character support), so they can later
//  be filled with a Vector Brush to create a scribble effect.
//
//  v21: GUI organised into 4 tabs (pages), like "Transform Objects":
//   on the left a permanent tab selector, Preview/Randomize and
//   presets; on the right two columns per page. Pages: 1 Method &
//   Text (method, per character, seed, line direction), 2 Angle &
//   Density, 3 Curvature (incl. wavelength & phase jitter), 4 Overlap
//   & Output. Functions and parameters unchanged vs v20 (all fields
//   stay effective on hidden pages). Fallback: if hiding groups is not
//   possible, all groups stay visible.
//
//  v20 fix (text with only ONE character): "Convert to Curves" returns
//   a single curve object without children instead of a group for one
//   character. getLetterNodes() then uses the object itself as the only
//   letter.
//  v19 fix (stale preview): OK recalculates if settings changed since
//   the last run.
//  v18: spread transform via the complete parent chain (objects in
//   scaled/rotated groups).
//  v17: Direction change (0–6) for individual curves.
//  v16: curvature option "Wavelength".
//  v15: gradient -100..100, phase jitter 0..100 %.
//  v14: presets in the Desktop AffinityScriptPresets folder.
//  v9: PolyCurveNodeDefinition order; File.create().
//  v8: 4 columns. v7: meander unclipped only for text with
//   "Per Character" OFF. v6: hiddenOriginals reset. v5: meander
//   above. v4: seed, contour hatch, density gradient, randomize
//   button, object names, hole avoidance, warnings.
// ============================================================
const { Document }        = require('/document');
const { DocumentCommand, AddChildNodesCommandBuilder, NodeMoveType, NodeChildType } = require('/commands');
const { Transform, CurveBuilder, PolyCurve } = require('/geometry');
const { Colour }           = require('/colours');
const { FillDescriptor }   = require('/fills');
const { Dialog, DialogResult } = require('/dialog');
const { PolyCurveNodeDefinition } = require('/nodes');
const { LineStyleDescriptor } = require('/linestyle');
const { Selection }         = require('/selections');
const { app }               = require('/application');
const { File, FileSystemApi } = require('/fs');

const doc = Document.current;
if (!doc) throw new Error('No document');
const sel = doc.selection;
const rawSelNodes = [];
for (let i=0;i<sel.length;i++) rawSelNodes.push(sel.at(i).node);
if (!rawSelNodes.length){ app.alert('Please select at least one shape or text object.','Scribble'); throw new Error('no selection'); }
const origSelNodes = flattenSelectionNodes(rawSelNodes);
if (!origSelNodes.length){ app.alert('The selection contains no processable objects.','Scribble'); throw new Error('no processable objects'); }
// Live-confirmed: doc.selection returns a snapshot, not a live object.
const origSel = doc.selection;

function isTextNode(node){
    const tag = node[Symbol.toStringTag] || '';
    return tag === 'ArtTextNode' || tag === 'FrameTextNode';
}
function isContainerLike(node){
    const tag = node[Symbol.toStringTag] || '';
    return tag === 'GroupNode' || tag === 'ContainerNode';
}
function flattenSelectionNodes(nodes){
    const out = [];
    for (const n of nodes){
        if (isContainerLike(n)){
            out.push(...flattenSelectionNodes([...n.children]));
        } else {
            out.push(n);
        }
    }
    return out;
}

// v20: get the letter objects from the result of "Convert to Curves".
// Several characters -> group with one curve object per letter.
// EXACTLY ONE character -> directly a single curve object WITHOUT
// children (then the object itself is the only letter).
function getLetterNodes(converted){
    if (isContainerLike(converted)) return [...converted.children];
    if (converted.curvesInterface) return [converted];
    return [];
}

// Composed transform object-local -> spread (complete parent chain).
function bestTransform(node){
    let comp = null;
    let cur = node;
    while (cur){
        const tag = cur[Symbol.toStringTag] || '';
        if (tag === 'SpreadNode' || tag === 'DocumentNode') break;
        comp = comp ? cur.transform.multiply(comp) : cur.transform.clone();
        cur = cur.parent;
    }
    return comp || Transform.createIdentity();
}

// ── Preset configuration ───────────────────────────────────
const PRESETS_DIR   = app.userDesktopPath + '/AffinityScriptPresets';
const PRESET_PREFIX = 'Scribble_';
function ensurePresetsDir(dir){ try{ FileSystemApi.createDirectories(dir); return true; }catch(e){ return false; } }
function sanitizeName(name){ return String(name||'').trim().replace(/[^a-zA-Z0-9 _\-äöüÄÖÜß]/g,'_').slice(0,80); }
function presetFileName(name){ return PRESET_PREFIX+sanitizeName(name)+'.json'; }
function presetPath(name){ return PRESETS_DIR+'/'+presetFileName(name); }
function savePresetToDisk(name,data){ try{ ensurePresetsDir(PRESETS_DIR); const f=File.create(presetPath(name),'wb'); f.writeStringAsUtf8(JSON.stringify(data,null,2)); f.close(); return true; }catch(e){ return false; } }
function loadPresetFromPath(path){ try{ const buf=File.readAll(path); return JSON.parse(buf.toString('utf8')); }catch(e){ return null; } }
function deletePresetAtPath(path){ try{ FileSystemApi.remove(path); return true; }catch(e){ return false; } }

// ── Seedable random generator ───────────────────────────────
function mulberry32(seed){
    let a = seed >>> 0;
    return function(){
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
let rng = Math.random;
function jitter(lo,hi){ return (lo===0&&hi===0) ? 0 : lo + rng()*(hi-lo); }
function randomInt(lo,hi){ return Math.floor(lo + rng()*(hi-lo+1)); }

// ── Boundary table (position + tangent) in SPREAD coordinates ──
function buildBoundaryTable(host, sampleStep){
    const ppc = host.curvesInterface.polyPolyCurves;
    const xf = bestTransform(host);
    const pts = [];
    for (const pc of ppc){
        for (const curve of pc){
            for (const bz of curve.beziers){
                const len = bz.length;
                const n = Math.max(2, Math.round(len/Math.max(1,sampleStep)));
                for (let s=0; s<n; s++){
                    const t = s/n;
                    const pLocal = bz.evaluate(t);
                    const tanLocal = bz.getTangent(t,true);
                    const pSpread = xf.applyToPoint(pLocal);
                    const tanVec = xf.applyToVector(tanLocal);
                    const tlen = Math.sqrt(tanVec.x*tanVec.x+tanVec.y*tanVec.y) || 1;
                    pts.push({x:pSpread.x, y:pSpread.y, tx:tanVec.x/tlen, ty:tanVec.y/tlen});
                }
            }
        }
    }
    return pts;
}
function makeContainsFn(host){
    const ci = host.curvesInterface;
    const ppc = ci.polyPolyCurves;
    const winding = ci.windingOrder;
    const xfInv = bestTransform(host).inverted;
    return function(ptSpread){
        const local = xfInv.applyToPoint(ptSpread);
        return ppc.containsPoint(local, true, winding, false);
    };
}
function nearestBoundary(table, pt){
    let best=null, bestD=Infinity;
    for (const p of table){
        const dx=p.x-pt.x, dy=p.y-pt.y, d=dx*dx+dy*dy;
        if (d<bestD){ bestD=d; best=p; }
    }
    return best;
}
function tipOffset(table, pt, outDir, amount){
    if (Math.abs(amount) < 1e-6) return {x:pt.x, y:pt.y};
    const nb = nearestBoundary(table, pt);
    let tx=nb.tx, ty=nb.ty;
    if (tx*outDir.x + ty*outDir.y < 0){ tx=-tx; ty=-ty; }
    return {x: pt.x+tx*amount, y: pt.y+ty*amount};
}

// ── Curvature: wave function along a base point sequence ──
let curRefLen = 0;
function polyLen(pts){
    let L=0;
    for (let i=1;i<pts.length;i++){ const dx=pts[i].x-pts[i-1].x, dy=pts[i].y-pts[i-1].y; L+=Math.sqrt(dx*dx+dy*dy); }
    return L;
}
function maxSegLen(items){
    let m=0;
    for (const it of items){ const dx=it.B.x-it.A.x, dy=it.B.y-it.A.y; m=Math.max(m, Math.sqrt(dx*dx+dy*dy)); }
    return m;
}
// ── Direction change (individual curves) ──
function nextRunLength(maxRun){ return randomInt(1, maxRun); }
function applyDirectionRuns(items, maxRun){
    if (!(maxRun > 0)) return items;
    let flip = false;
    let remaining = nextRunLength(maxRun);
    for (const it of items){
        if (flip){ const t=it.A; it.A=it.B; it.B=t; }
        remaining--;
        if (remaining <= 0){ flip = !flip; remaining = nextRunLength(maxRun); }
    }
    return items;
}
function applyDirectionRunsToPolylines(polys, maxRun){
    if (!(maxRun > 0)) return polys;
    let flip = false;
    let remaining = nextRunLength(maxRun);
    for (let i=0;i<polys.length;i++){
        if (flip) polys[i] = polys[i].slice().reverse();
        remaining--;
        if (remaining <= 0){ flip = !flip; remaining = nextRunLength(maxRun); }
    }
    return polys;
}
function sampleLine(A,B,n){
    const pts=[];
    for (let i=0;i<=n;i++){ const t=i/n; pts.push({x:A.x+(B.x-A.x)*t, y:A.y+(B.y-A.y)*t}); }
    return pts;
}
function applyWave(basePoints, curvAmt, curvJl, curvJh, waveType, freq, phaseJit){
    const n = basePoints.length;
    if (n<2) return basePoints.slice();
    const amp = curvAmt + jitter(curvJl,curvJh);
    const phase = jitter(-phaseJit, phaseJit);
    let cum = null;
    if (curRefLen > 0){
        cum = [0];
        for (let i=1;i<n;i++){
            const dx=basePoints[i].x-basePoints[i-1].x, dy=basePoints[i].y-basePoints[i-1].y;
            cum.push(cum[i-1]+Math.sqrt(dx*dx+dy*dy));
        }
    }
    const out = [];
    for (let i=0;i<n;i++){
        const t = cum ? cum[i]/curRefLen : i/(n-1);
        const prev = basePoints[Math.max(0,i-1)], next = basePoints[Math.min(n-1,i+1)];
        const dx = next.x-prev.x, dy = next.y-prev.y;
        const len = Math.sqrt(dx*dx+dy*dy) || 1;
        const nx = -dy/len, ny = dx/len;
        let w;
        if (waveType===0)      w = Math.sin(Math.PI*(t+phase));
        else if (waveType===1) w = Math.sin(2*Math.PI*(t+phase));
        else                   w = Math.sin(2*Math.PI*freq*(t+phase));
        const off = amp*w;
        out.push({x: basePoints[i].x+nx*off, y: basePoints[i].y+ny*off});
    }
    return out;
}
function buildWavyPoints(A,B,curvAmt,curvJl,curvJh,waveType,freq,phaseJit){
    const dist = Math.sqrt((B.x-A.x)*(B.x-A.x)+(B.y-A.y)*(B.y-A.y));
    if (dist < 0.05) return [A,B];
    const n = Math.max(6, Math.round(dist/6));
    return applyWave(sampleLine(A,B,n), curvAmt,curvJl,curvJh,waveType,freq,phaseJit);
}

// ── Safe connector: avoids holes/gaps ──
function buildSafeConnectorWaypoints(A,B,contains,boundaryTable){
    const nSamp = 16;
    let violated = false;
    for (let i=1;i<nSamp;i++){
        const t=i/nSamp;
        if (!contains({x:A.x+(B.x-A.x)*t, y:A.y+(B.y-A.y)*t})){ violated = true; break; }
    }
    if (!violated) return [A,B];
    const mid = {x:(A.x+B.x)/2, y:(A.y+B.y)/2};
    const nb = nearestBoundary(boundaryTable, mid);
    const nx = nb.ty, ny = -nb.tx;
    const testIn = {x:nb.x+nx*2, y:nb.y+ny*2};
    const inward = contains(testIn) ? {x:nx,y:ny} : {x:-nx,y:-ny};
    const via = {x:nb.x+inward.x*4, y:nb.y+inward.y*4};
    return [A, via, B];
}
function buildConnectorPoints(prevEnd, nextStart, contains, boundaryTable, p){
    const waypoints = buildSafeConnectorWaypoints(prevEnd, nextStart, contains, boundaryTable);
    let pts = [];
    for (let i=0;i<waypoints.length-1;i++){
        const seg = buildWavyPoints(waypoints[i],waypoints[i+1],p.curvature*0.4,p.curvJl*0.4,p.curvJh*0.4,p.waveType,p.freq,p.phaseJit);
        if (pts.length===0) pts = pts.concat(seg); else pts = pts.concat(seg.slice(1));
    }
    return pts;
}

// ── Density gradient ───────────────
function effectiveDensity(baseDensity, gradient, frac){
    const g = Math.max(-1, Math.min(1, gradient||0));
    const mult = 1 - g*(2*Math.min(1,Math.max(0,frac))-1);
    return Math.max(0.5, baseDensity*mult);
}

// ── Hatch rows (SPREAD coordinates) ──
function buildRows(contains, gridBB, angleDeg, p){
    const cx=gridBB.x+gridBB.width/2, cy=gridBB.y+gridBB.height/2;
    const R = Math.sqrt(Math.pow(gridBB.width/2,2)+Math.pow(gridBB.height/2,2)) + Math.max(1,p.density)*2 + 10;
    const rows=[];
    let cur=-R;
    while (cur<=R){
        const angRad = (angleDeg + jitter(p.angleJl,p.angleJh)) * Math.PI/180;
        const u = {x:Math.cos(angRad), y:Math.sin(angRad)};
        const v = {x:-Math.sin(angRad), y:Math.cos(angRad)};
        const rowCenter = {x:cx+v.x*cur, y:cy+v.y*cur};
        const pA = {x:rowCenter.x-u.x*R, y:rowCenter.y-u.y*R};
        const nSamp = Math.max(40, Math.round((2*R)/Math.max(2,p.density/3)));
        let prevIn=false, prevPt=pA;
        const crossings=[];
        for (let s=0; s<=nSamp; s++){
            const t=s/nSamp;
            const pt={x:pA.x+u.x*2*R*t, y:pA.y+u.y*2*R*t};
            const isIn = contains(pt);
            if (s>0 && isIn!==prevIn){
                let lo=prevPt, hi=pt, loIn=prevIn;
                for (let it=0; it<22; it++){
                    const mid={x:(lo.x+hi.x)/2, y:(lo.y+hi.y)/2};
                    const midIn=contains(mid);
                    if (midIn===loIn) lo=mid; else hi=mid;
                }
                crossings.push({pt:hi, entering:isIn});
            }
            prevIn=isIn; prevPt=pt;
        }
        const runs=[];
        for (let i=0;i<crossings.length;i++){
            if (crossings[i].entering){
                const next=crossings[i+1];
                if (next && !next.entering){ runs.push({A:crossings[i].pt,B:next.pt,u,v}); i++; }
            }
        }
        if (runs.length) rows.push({offset:cur, runs, u, v});
        const frac = Math.min(1, Math.abs(cur)/R);
        const densEff = effectiveDensity(p.density, p.densityGradient, frac);
        const step = Math.max(0.5, densEff + jitter(p.densJl,p.densJh));
        cur += step;
    }
    return rows;
}

// ── Contour hatch: concentric, form-following rings ──
function buildContourRuns(host, boundaryTable, contains, gridBB, p){
    const R = Math.sqrt(Math.pow(gridBB.width/2,2)+Math.pow(gridBB.height/2,2));
    const allRuns = [];
    let depth = Math.max(0.5, p.density + jitter(p.densJl,p.densJh));
    let emptyRingsInARow = 0;
    let ringIndex = 0;
    while (depth < R*1.2 && emptyRingsInARow < 3 && ringIndex < 300){
        const candidates = boundaryTable.map(pt=>{
            const nx = pt.ty, ny = -pt.tx;
            const testPt = {x:pt.x+nx*1, y:pt.y+ny*1};
            const inward = contains(testPt) ? {x:nx,y:ny} : {x:-nx,y:-ny};
            const cand = {x:pt.x+inward.x*depth, y:pt.y+inward.y*depth};
            return { pt:cand, valid: contains(cand) };
        });
        const runs=[]; let cur=[];
        for (const c of candidates){
            if (c.valid) cur.push(c.pt);
            else { if (cur.length>3) runs.push(cur); cur=[]; }
        }
        if (cur.length>3) runs.push(cur);
        if (runs.length===0) emptyRingsInARow++; else emptyRingsInARow = 0;
        for (const r of runs) allRuns.push(r);
        const frac = Math.min(1, depth/R);
        const densEff = effectiveDensity(p.density, p.densityGradient, frac);
        depth += Math.max(0.5, densEff + jitter(p.densJl,p.densJh));
        ringIndex++;
    }
    return allRuns;
}

// ── Scribble curves for a single mask (SPREAD coordinates) ──
function generateForMask(host, gridBBSpread, p){
    const contains = makeContainsFn(host);
    const boundaryTable = buildBoundaryTable(host, Math.max(2, p.density/4));
    const pc = new PolyCurve();

    function adjRun(run){
        const outA={x:-run.u.x,y:-run.u.y}, outB={x:run.u.x,y:run.u.y};
        const amtA=p.pathOverlap+jitter(p.polJl,p.polJh);
        const amtB=p.pathOverlap+jitter(p.polJl,p.polJh);
        return { A:tipOffset(boundaryTable, run.A, outA, amtA),
                 B:tipOffset(boundaryTable, run.B, outB, amtB) };
    }

    if (p.method===0 || p.method===2){
        const angles = p.method===2 ? [p.angle, p.angle+p.hatchAngle] : [p.angle];
        const all = [];
        for (const ang of angles){
            const rows = buildRows(contains,gridBBSpread,ang,p);
            for (const row of rows){
                for (const run of row.runs){ all.push(adjRun(run)); }
            }
        }
        applyDirectionRuns(all, p.dirRun);
        curRefLen = (p.waveRef===1) ? maxSegLen(all) : 0;
        for (const r of all){
            const pts = buildWavyPoints(r.A,r.B,p.curvature,p.curvJl,p.curvJh,p.waveType,p.freq,p.phaseJit);
            const b = CurveBuilder.create();
            b.beginXY(pts[0].x,pts[0].y);
            for (let i=1;i<pts.length;i++) b.lineToXY(pts[i].x,pts[i].y);
            pc.addCurve(b.createCurve());
        }
        curRefLen = 0;
    } else if (p.method===1){
        const rows = buildRows(contains,gridBBSpread,p.angle,p);
        const seq = []; let dir=1;
        for (const row of rows){
            let runs = row.runs.slice();
            if (dir<0) runs.reverse();
            for (let run of runs){
                let {A,B} = adjRun(run);
                if (dir<0){ const t=A; A=B; B=t; }
                seq.push({A,B});
            }
            dir *= -1;
        }
        curRefLen = (p.waveRef===1) ? maxSegLen(seq) : 0;
        let allPts=[]; let prevEnd=null;
        for (const r of seq){
            if (prevEnd){
                const connPts = buildConnectorPoints(prevEnd, r.A, contains, boundaryTable, p);
                allPts = allPts.concat(connPts.slice(1,-1));
            }
            const segPts = buildWavyPoints(r.A,r.B,p.curvature,p.curvJl,p.curvJh,p.waveType,p.freq,p.phaseJit);
            allPts = allPts.concat(segPts);
            prevEnd = r.B;
        }
        curRefLen = 0;
        if (allPts.length>1){
            const b = CurveBuilder.create();
            b.beginXY(allPts[0].x,allPts[0].y);
            for (let i=1;i<allPts.length;i++) b.lineToXY(allPts[i].x,allPts[i].y);
            pc.addCurve(b.createCurve());
        }
    } else if (p.method===3){
        const runs = buildContourRuns(host, boundaryTable, contains, gridBBSpread, p);
        applyDirectionRunsToPolylines(runs, p.dirRun);
        let ref = 0;
        if (p.waveRef===1){ for (const r of runs) ref = Math.max(ref, polyLen(r)); }
        curRefLen = ref;
        for (const runPts of runs){
            const pts = applyWave(runPts, p.curvature, p.curvJl, p.curvJh, p.waveType, p.freq, p.phaseJit);
            const b = CurveBuilder.create();
            b.beginXY(pts[0].x,pts[0].y);
            for (let i=1;i<pts.length;i++) b.lineToXY(pts[i].x,pts[i].y);
            pc.addCurve(b.createCurve());
        }
        curRefLen = 0;
    }
    return pc;
}

// ── One continuous meander spanning multiple letters ──
function generateContinuousZigzagCombined(letters, gridBBSpread, p){
    const containsFns = letters.map(l => makeContainsFn(l));
    const boundaryTables = letters.map(l => buildBoundaryTable(l, Math.max(2, p.density/4)));
    function containsAny(pt){ for (const fn of containsFns) if (fn(pt)) return true; return false; }
    function whichLetter(pt){ for (let i=0;i<containsFns.length;i++) if (containsFns[i](pt)) return i; return -1; }

    const rows = buildRows(containsAny, gridBBSpread, p.angle, p);

    function adjRunGlobal(run){
        const hA = whichLetter(run.A), hB = whichLetter(run.B);
        const tableA = hA>=0 ? boundaryTables[hA] : boundaryTables[0];
        const tableB = hB>=0 ? boundaryTables[hB] : boundaryTables[0];
        const outA={x:-run.u.x,y:-run.u.y}, outB={x:run.u.x,y:run.u.y};
        const amtA=p.pathOverlap+jitter(p.polJl,p.polJh), amtB=p.pathOverlap+jitter(p.polJl,p.polJh);
        return { A:tipOffset(tableA, run.A, outA, amtA), B:tipOffset(tableB, run.B, outB, amtB) };
    }

    const seq = []; let dir=1;
    for (const row of rows){
        let runs = row.runs.slice();
        if (dir<0) runs.reverse();
        for (let run of runs){
            let {A,B} = adjRunGlobal(run);
            if (dir<0){ const t=A; A=B; B=t; }
            const hostIdx = whichLetter({x:(A.x+B.x)/2, y:(A.y+B.y)/2});
            seq.push({A,B,hostIdx});
        }
        dir *= -1;
    }
    curRefLen = (p.waveRef===1) ? maxSegLen(seq) : 0;
    let allPts=[]; let prevEnd=null; let prevHostIdx=-1;
    for (const r of seq){
        if (prevEnd){
            const table = prevHostIdx>=0 ? boundaryTables[prevHostIdx] : boundaryTables[0];
            const connPts = buildConnectorPoints(prevEnd, r.A, containsAny, table, p);
            allPts = allPts.concat(connPts.slice(1,-1));
        }
        const segPts = buildWavyPoints(r.A,r.B,p.curvature,p.curvJl,p.curvJh,p.waveType,p.freq,p.phaseJit);
        allPts = allPts.concat(segPts);
        prevEnd = r.B; prevHostIdx = r.hostIdx;
    }
    curRefLen = 0;

    const pc = new PolyCurve();
    if (allPts.length>1){
        const b = CurveBuilder.create();
        b.beginXY(allPts[0].x,allPts[0].y);
        for (let i=1;i<allPts.length;i++) b.lineToXY(allPts[i].x,allPts[i].y);
        pc.addCurve(b.createCurve());
    }
    return pc;
}

// ── Determine target masks per object (SPREAD coordinates) ──
function collectTargets(node, perCharacter, tempNodesOut, warnings){
    if (isTextNode(node)){
        doc.executeCommand(DocumentCommand.createTransform(node.selfSelection, Transform.createIdentity(), {duplicateNodes:true}));
        doc.executeCommand(DocumentCommand.createConvertToCurves(doc.selection));
        const grp = doc.selection.at(0).node;
        doc.executeCommand(DocumentCommand.createSetVisibility(grp.selfSelection, true));
        tempNodesOut.push(grp);
        const letters = getLetterNodes(grp);   // v20: for 1 character grp itself is the letter
        if (!letters.length){
            warnings.push('"'+(node.userDescription||node.defaultDescription||'Text')+'": no characters found, skipped.');
            return { targets: [], lettersInfo: null };
        }
        let lettersSel = Selection.createEmpty(doc);
        for (const l of letters) lettersSel.addNode(l);
        doc.executeCommand(DocumentCommand.createSetVisibility(lettersSel, true));

        if (perCharacter){
            return { targets: letters.map(l => ({ host:l, bboxSpread: l.getSpreadBaseBox(false) })), lettersInfo: null };
        } else {
            let ux0=Infinity,uy0=Infinity,ux1=-Infinity,uy1=-Infinity;
            const boxes = letters.map(l => l.getSpreadBaseBox(false));
            for (const bb of boxes){ ux0=Math.min(ux0,bb.x); uy0=Math.min(uy0,bb.y); ux1=Math.max(ux1,bb.x+bb.width); uy1=Math.max(uy1,bb.y+bb.height); }
            const shared = {x:ux0,y:uy0,width:ux1-ux0,height:uy1-uy0};
            return {
                targets: letters.map(l => ({ host:l, bboxSpread: shared })),
                lettersInfo: { letters, bboxSpread: shared }
            };
        }
    } else if (node.curvesInterface){
        return { targets: [{ host:node, bboxSpread: node.getSpreadBaseBox(false) }], lettersInfo: null };
    }
    warnings.push('"'+(node.userDescription||node.defaultDescription||'Object')+'": no curves available, skipped.');
    return { targets: [], lettersInfo: null };
}

function buildScribbleName(p){
    const methodNames = ['Individual Lines','Zig-Zag','Cross-Hatch','Contour Hatch'];
    const m = methodNames[p.method] || 'Scribble';
    return 'Scribble ('+m+', '+Math.round(p.angle)+'°, Density '+Math.round(p.density)+')';
}

// ── Create output node and clip into the target ──
function emitAndClip(host, pc, p, warnings, objLabel){
    if (pc.curveCount===0){
        warnings.push('"'+objLabel+'": no lines generated (density may be too large for the object size).');
        return null;
    }
    const lsd = LineStyleDescriptor.createDefault(Math.max(0.1,p.strokeWidth));
    const penFD = FillDescriptor.createSolid(p.penColour);
    const def = PolyCurveNodeDefinition.create(pc, FillDescriptor.createNone(), penFD, lsd, FillDescriptor.createNone());
    const bld = AddChildNodesCommandBuilder.create();
    bld.addPolyCurveNode(def);
    doc.executeCommand(bld.createCommand());
    doc.executeCommand(DocumentCommand.createSetDescription(doc.selection, buildScribbleName(p)));
    doc.executeCommand(DocumentCommand.createMoveNodes(doc.selection, host, NodeMoveType.Inside, NodeChildType.Main));
    return [...host.children].pop();
}

// ── Meander: do NOT clip, place visibly above host ──
function emitUnclippedAboveHost(host, pc, p, warnings, objLabel){
    if (pc.curveCount===0){
        warnings.push('"'+objLabel+'": no lines generated (density may be too large for the object size).');
        return null;
    }
    const lsd = LineStyleDescriptor.createDefault(Math.max(0.1,p.strokeWidth));
    const penFD = FillDescriptor.createSolid(p.penColour);
    const def = PolyCurveNodeDefinition.create(pc, FillDescriptor.createNone(), penFD, lsd, FillDescriptor.createNone());
    const bld = AddChildNodesCommandBuilder.create();
    bld.addPolyCurveNode(def);
    doc.executeCommand(bld.createCommand());
    const created = doc.selection.at(0).node;
    doc.executeCommand(DocumentCommand.createSetDescription(created.selfSelection, buildScribbleName(p)));
    doc.executeCommand(DocumentCommand.createMoveNodes(created.selfSelection, host, NodeMoveType.After, undefined));
    return created;
}

// ── Meander special handling (text with "Per Character" OFF) ──
function processUnclippedMeander(node, p, warnings){
    if (isTextNode(node)){
        doc.executeCommand(DocumentCommand.createTransform(node.selfSelection, Transform.createIdentity(), {duplicateNodes:true}));
        doc.executeCommand(DocumentCommand.createConvertToCurves(doc.selection));
        const grp = doc.selection.at(0).node;
        const letters = getLetterNodes(grp);   // v20: for 1 character grp itself is the letter
        if (!letters.length){
            warnings.push('"'+(node.userDescription||node.defaultDescription||'Text')+'": no characters found, skipped.');
            grp.delete();
            return;
        }
        let ux0=Infinity,uy0=Infinity,ux1=-Infinity,uy1=-Infinity;
        const boxes = letters.map(l => l.getSpreadBaseBox(false));
        for (const bb of boxes){ ux0=Math.min(ux0,bb.x); uy0=Math.min(uy0,bb.y); ux1=Math.max(ux1,bb.x+bb.width); uy1=Math.max(uy1,bb.y+bb.height); }
        const shared = {x:ux0,y:uy0,width:ux1-ux0,height:uy1-uy0};
        const pc = generateContinuousZigzagCombined(letters, shared, p);
        const label = node.userDescription||node.defaultDescription||'Text';
        const created = emitUnclippedAboveHost(node, pc, p, warnings, label);
        if (created) previewHosts.push(created);
        grp.delete();
    } else if (node.curvesInterface){
        const bboxSpread = node.getSpreadBaseBox(false);
        const pc = generateForMask(node, bboxSpread, p);
        const label = node.userDescription||node.defaultDescription||'Object';
        const created = emitUnclippedAboveHost(node, pc, p, warnings, label);
        if (created) previewHosts.push(created);
    } else {
        warnings.push('"'+(node.userDescription||node.defaultDescription||'Object')+'": no curves available, skipped.');
    }
}

// ── Main loop ────────────────────────────────────────────────
let previewHosts = [];
let previewTemp = [];
let hiddenOriginals = [];
let lastWarningsStr = null;
let lastRunKey = null;   // v19: settings of the last run

// v19: comparable key of the settings (colour as HSLA numbers)
function paramsKey(p){
    let col = null;
    try { const h = p.penColour.hslaf; col = [h.h, h.s, h.l, h.alpha]; } catch(e) {}
    return JSON.stringify(Object.assign({}, p, { penColour: col }));
}

function clearPreview(){
    for (const n of previewHosts){ try{ n.delete(); }catch(e){} }
    previewHosts = [];
    for (const n of previewTemp){ try{ n.delete(); }catch(e){} }
    previewTemp = [];
}
function restoreHiddenOriginals(){
    for (const n of hiddenOriginals){
        try{ doc.executeCommand(DocumentCommand.createSetVisibility(n.selfSelection, true)); }catch(e){}
    }
}

function runOnce(p){
    lastRunKey = paramsKey(p);
    rng = mulberry32(p.seed>>>0);
    clearPreview();
    restoreHiddenOriginals();
    hiddenOriginals = [];
    doc.executeCommand(DocumentCommand.createSetSelection(origSel));
    const warnings = [];
    for (const node of origSelNodes){
        const wantsMeander = p.method===1 && isTextNode(node) && !p.perCharacter;
        if (wantsMeander){
            processUnclippedMeander(node, p, warnings);
            continue;
        }
        const tempOut = [];
        const { targets } = collectTargets(node, p.perCharacter, tempOut, warnings);
        for (const t of targets){
            const pc = generateForMask(t.host, t.bboxSpread, p);
            const label = node.userDescription||node.defaultDescription||'Object';
            const created = emitAndClip(t.host, pc, p, warnings, label);
            if (created) previewHosts.push(created);
        }
        previewTemp = previewTemp.concat(tempOut);

        if (isTextNode(node) && tempOut.length>0){
            if (!hiddenOriginals.some(n => n.isSameNode(node))){
                doc.executeCommand(DocumentCommand.createSetVisibility(node.selfSelection, false));
                hiddenOriginals.push(node);
            }
        }
    }
    doc.executeCommand(DocumentCommand.createSetSelection(origSel));

    const warnStr = warnings.join('\n');
    if (warnings.length>0 && warnStr!==lastWarningsStr){
        app.alert(warnings.join('\n'), 'Scribble – Notes');
    }
    lastWarningsStr = warnStr || null;
}

// ── Dialog (v21: tabs like "Transform Objects") ──────────────
// A narrow, permanently visible column on the left (tab selector,
// preview, presets); two content columns on the right. Each page
// consists of groups in these two columns; when switching, the groups
// of the active page are shown and all others hidden.
const dlg = Dialog.create('Scribble');
dlg.initialWidth = 1000;
dlg.setIsResizable(true);
const cNav = dlg.addColumn(); try { cNav.widthProportion = 0.8; } catch(e) {}
const cA   = dlg.addColumn(); try { cA.widthProportion = 1; } catch(e) {}
const cB   = dlg.addColumn(); try { cB.widthProportion = 1; } catch(e) {}

const PAGES = [[], [], [], []];
function pageGroup(pageIdx, col, title){ const g = col.addGroup(title); PAGES[pageIdx].push(g); return g; }
let pagedOK = true;
function showPage(i){
    if (!pagedOK) return;
    try {
        for (let k=0;k<PAGES.length;k++) for (const g of PAGES[k]) g.isVisible = (k===i);
    } catch(e){
        // Fallback: hiding not possible -> keep everything visible
        pagedOK = false;
        try { for (const pg of PAGES) for (const g of pg) g.isVisible = true; } catch(e2){}
        console.log('Tabs not available: ' + e.message);
    }
}

// --- Left column: always visible
const gNav = cNav.addGroup('Tabs');
const rNav = gNav.addRadioGroup('', ['1  Method & Text','2  Angle & Density','3  Curvature','4  Overlap & Output'], 0);
const gVorschau = cNav.addGroup('Preview');
const btnVorschau = gVorschau.addButton('▶  Preview');
const btnRandom   = gVorschau.addButton('🎲 Randomize');
const gPreset  = cNav.addGroup('Preset');
const btnSavePreset   = gPreset.addButton('💾 Save…');
const btnLoadPreset   = gPreset.addButton('📂 Load…');
const btnDeletePreset = gPreset.addButton('🗑 Delete…');
const gInfo6 = cNav.addGroup('');
gInfo6.addStaticText('','OK = Apply (recalculates if');
gInfo6.addStaticText('','values changed) | Cancel');

// --- Page 1: Method & Text
const gMethod = pageGroup(0, cA, 'Method');
const cbMethod = gMethod.addComboBox('', ['1: Individual Lines','2: Zig-Zag Line','3: Cross-Hatch','4: Contour Hatch'], 0);
const gText = pageGroup(0, cA, 'Text');
const cbPerChar = gText.addCheckBox('Per Character', true);
gText.addStaticText('','Zig-zag on text: with "Per');
gText.addStaticText('','Character" ON it is clipped');
gText.addStaticText('','(like other methods); with');
gText.addStaticText('','"off" a continuous meander');
gText.addStaticText('','spans the word, NOT clipped,');
gText.addStaticText('','sits visibly above. On shapes');
gText.addStaticText('','zig-zag always stays clipped.');
const gSeed = pageGroup(0, cB, 'Random Seed');
const eSeed = gSeed.addUnitValueEditor('Seed','','',null,0,null); eSeed.value=12345;
const btnNewSeed = gSeed.addButton('🎲 New Seed');
const gDir = pageGroup(0, cB, 'Line direction (individual curves)');
const eDirRun = gDir.addUnitValueEditor('Direction change (0-6)','','',null,0,6); eDirRun.value=0;
gDir.addStaticText('','0 = no change. N = max. N lines');
gDir.addStaticText('','in a row with the same direction');
gDir.addStaticText('','(run length random 1..N), then');
gDir.addStaticText('','start/end swapped. For direction-');
gDir.addStaticText('','dependent path brushes.');

// --- Page 2: Angle & Density
const gWinkel = pageGroup(1, cA, 'Angle (°)');
const eAngle  = gWinkel.addUnitValueEditor('Angle','','');       eAngle.value=30;
const eAngleJl= gWinkel.addUnitValueEditor('Jitter Low','','');  eAngleJl.value=-3;
const eAngleJh= gWinkel.addUnitValueEditor('Jitter High','','');  eAngleJh.value=3;
const gHatch = pageGroup(1, cA, 'Hatch Angle (Method 3 only)');
const eHatch = gHatch.addUnitValueEditor('Extra Angle','',''); eHatch.value=60;
const gDichte = pageGroup(1, cB, 'Density (Spacing)');
const eDens   = gDichte.addUnitValueEditor('Spacing','','');      eDens.value=25;
const eDensJl = gDichte.addUnitValueEditor('Jitter Low','','');   eDensJl.value=-4;
const eDensJh = gDichte.addUnitValueEditor('Jitter High','','');  eDensJh.value=4;
const eDensGrad = gDichte.addUnitValueEditor('Gradient (-100..100)','','',null,-100,100); eDensGrad.value=0;
gDichte.addStaticText('','>0 = denser at edge');
gDichte.addStaticText('','<0 = denser at centre');

// --- Page 3: Curvature
const gKruemm = pageGroup(2, cA, 'Curvature');
const eCurv   = gKruemm.addUnitValueEditor('Strength','','');      eCurv.value=8;
const eCurvJl = gKruemm.addUnitValueEditor('Jitter Low','','');    eCurvJl.value=-3;
const eCurvJh = gKruemm.addUnitValueEditor('Jitter High','','');   eCurvJh.value=3;
const cbWave  = gKruemm.addComboBox('Type', ['Half Wave','Full Wave','Frequency'], 0);
const eFreq   = gKruemm.addUnitValueEditor('Frequency','','');     eFreq.value=2;
const gWelle = pageGroup(2, cB, 'Wavelength & Phase');
const cbWaveRef = gWelle.addComboBox('Wavelength', ['Per line (individual)','Uniform (longest line)'], 0);
gWelle.addStaticText('','Uniform: wavelength is based on');
gWelle.addStaticText('','the longest line of the shape;');
gWelle.addStaticText('','short lines (corners) do not');
gWelle.addStaticText('','ripple as a result.');
const ePhase  = gWelle.addUnitValueEditor('Phase Jitter (0-100 %)','','',null,0,100); ePhase.value=15;

// --- Page 4: Overlap & Output
const gOverlap = pageGroup(3, cA, 'Path Overlap');
const eOverlap = gOverlap.addUnitValueEditor('Amount','','');       eOverlap.value=-4;
const eOverlapJl=gOverlap.addUnitValueEditor('Jitter Low','','');   eOverlapJl.value=-4;
const eOverlapJh=gOverlap.addUnitValueEditor('Jitter High','','');  eOverlapJh.value=4;
const gAusgabe = pageGroup(3, cB, 'Output');
const eStroke  = gAusgabe.addUnitValueEditor('Stroke Width','','',null,0.1,null); eStroke.value=2;
const cPenCol  = gAusgabe.addColourPicker('Colour', Colour.createHSLAf({h:0,s:0,l:0.05,alpha:1}));

rNav.selectedIndex = 0;
showPage(0);
try { rNav.setOnValueChangedHandler(() => { showPage(rNav.selectedIndex); }); } catch(e) {}

// ── Read parameters from dialog ─────────────────────────────
function readParams(){
    return {
        method: cbMethod.selectedIndex,
        perCharacter: cbPerChar.value,
        seed: Math.round(eSeed.value||0),
        dirRun: Math.max(0, Math.min(6, Math.round(eDirRun.value||0))),
        angle: eAngle.value||0, angleJl: eAngleJl.value||0, angleJh: eAngleJh.value||0,
        hatchAngle: eHatch.value||0,
        density: Math.max(1, eDens.value||1), densJl: eDensJl.value||0, densJh: eDensJh.value||0,
        densityGradient: Math.max(-1,Math.min(1, (eDensGrad.value||0)/100)),
        pathOverlap: eOverlap.value||0, polJl: eOverlapJl.value||0, polJh: eOverlapJh.value||0,
        curvature: eCurv.value||0, curvJl: eCurvJl.value||0, curvJh: eCurvJh.value||0,
        waveType: cbWave.selectedIndex, freq: Math.max(0.01, eFreq.value||1),
        waveRef: cbWaveRef.selectedIndex,
        phaseJit: Math.max(0,Math.min(1, (ePhase.value||0)/100)),
        strokeWidth: Math.max(0.1, eStroke.value||1),
        penColour: cPenCol.value || Colour.createHSLAf({h:0,s:0,l:0.05,alpha:1})
    };
}

// ── Save/load presets ────────────────────────────────────────
function collectPresetData(){
    const p = readParams();
    const hsl = p.penColour.hslaf;
    return {
        method:p.method, perCharacter:p.perCharacter, seed:p.seed, dirRun:p.dirRun,
        angle:p.angle, angleJl:p.angleJl, angleJh:p.angleJh, hatchAngle:p.hatchAngle,
        density:p.density, densJl:p.densJl, densJh:p.densJh, densityGradient:p.densityGradient,
        pathOverlap:p.pathOverlap, polJl:p.polJl, polJh:p.polJh,
        curvature:p.curvature, curvJl:p.curvJl, curvJh:p.curvJh,
        waveType:p.waveType, freq:p.freq, waveRef:p.waveRef, phaseJit:p.phaseJit,
        strokeWidth:p.strokeWidth, penHSLA: hsl
    };
}
function applyPresetData(d){
    if (d.method!=null) cbMethod.selectedIndex=d.method;
    if (d.perCharacter!=null) cbPerChar.value=d.perCharacter;
    if (d.seed!=null) eSeed.value=d.seed;
    eDirRun.value = (d.dirRun!=null) ? Math.max(0,Math.min(6,Math.round(d.dirRun))) : 0;
    if (d.angle!=null) eAngle.value=d.angle;
    if (d.angleJl!=null) eAngleJl.value=d.angleJl;
    if (d.angleJh!=null) eAngleJh.value=d.angleJh;
    if (d.hatchAngle!=null) eHatch.value=d.hatchAngle;
    if (d.density!=null) eDens.value=d.density;
    if (d.densJl!=null) eDensJl.value=d.densJl;
    if (d.densJh!=null) eDensJh.value=d.densJh;
    if (d.densityGradient!=null) eDensGrad.value=Math.round(d.densityGradient*100);
    if (d.pathOverlap!=null) eOverlap.value=d.pathOverlap;
    if (d.polJl!=null) eOverlapJl.value=d.polJl;
    if (d.polJh!=null) eOverlapJh.value=d.polJh;
    if (d.curvature!=null) eCurv.value=d.curvature;
    if (d.curvJl!=null) eCurvJl.value=d.curvJl;
    if (d.curvJh!=null) eCurvJh.value=d.curvJh;
    if (d.waveType!=null) cbWave.selectedIndex=d.waveType;
    if (d.freq!=null) eFreq.value=d.freq;
    cbWaveRef.selectedIndex = (d.waveRef===1) ? 1 : 0;
    if (d.phaseJit!=null) ePhase.value=Math.round(d.phaseJit*100);
    if (d.strokeWidth!=null) eStroke.value=d.strokeWidth;
    if (d.penHSLA){ try{ cPenCol.value = Colour.createHSLAf(d.penHSLA); }catch(e){} }
}

btnSavePreset.setOnClickHandler(()=>{
    const name = app.prompt('Preset name:','Scribble – Save Preset','Scribble');
    if (!name || !name.trim()) return;
    if (savePresetToDisk(name.trim(), collectPresetData())){
        app.alert('Saved:\n'+presetPath(name.trim()),'Scribble');
    } else {
        app.alert('Error saving.','Scribble');
    }
});
btnLoadPreset.setOnClickHandler(()=>{
    const path = app.chooseFile();
    if (!path) return;
    const data = loadPresetFromPath(path);
    if (!data){ app.alert('Preset could not be loaded.','Scribble'); return; }
    applyPresetData(data);
});
btnDeletePreset.setOnClickHandler(()=>{
    const path = app.chooseFile();
    if (!path) return;
    if (deletePresetAtPath(path)) app.alert('Deleted:\n'+path,'Scribble');
    else app.alert('Error deleting.','Scribble');
});

// ── Randomize button ────────────────────────────────────────
btnRandom.setOnClickHandler(()=>{
    const seedNow = Date.now() >>> 0;
    rng = mulberry32(seedNow);
    cbMethod.selectedIndex = randomInt(0,3);
    eAngle.value = randomInt(0,179);
    eAngleJl.value = -randomInt(0,6);
    eAngleJh.value = randomInt(0,6);
    eHatch.value = randomInt(20,90);
    eDens.value = randomInt(6,45);
    eDensJl.value = -randomInt(0,6);
    eDensJh.value = randomInt(0,6);
    eDensGrad.value = randomInt(-100,100);
    eOverlap.value = Math.round((rng()*16-8)*10)/10;
    eOverlapJl.value = -randomInt(0,6);
    eOverlapJh.value = randomInt(0,6);
    eCurv.value = randomInt(0,16);
    eCurvJl.value = -randomInt(0,5);
    eCurvJh.value = randomInt(0,5);
    cbWave.selectedIndex = randomInt(0,2);
    eFreq.value = randomInt(1,4);
    cbWaveRef.selectedIndex = randomInt(0,1);
    ePhase.value = randomInt(0,50);
    eDirRun.value = randomInt(0,6);
    eStroke.value = Math.round((0.5+rng()*2.5)*10)/10;
    eSeed.value = randomInt(1,999999);
    runOnce(readParams());
});
btnNewSeed.setOnClickHandler(()=>{
    eSeed.value = Math.floor(Date.now()%1000000 + Math.random()*1000);
    runOnce(readParams());
});

btnVorschau.setOnClickHandler(()=>{ runOnce(readParams()); });

runOnce(readParams());

const result = dlg.runModal();
if (!result || result.value===DialogResult.Cancel.value){
    clearPreview();
    restoreHiddenOriginals();
    doc.executeCommand(DocumentCommand.createSetSelection(origSel));
    console.log('Cancelled.');
} else {
    // v19: recalculate if settings changed since the last run
    const pFinal = readParams();
    if (paramsKey(pFinal) !== lastRunKey) runOnce(pFinal);
    for (const n of hiddenOriginals){ try{ n.delete(); }catch(e){} }
    console.log('Applied.');
}

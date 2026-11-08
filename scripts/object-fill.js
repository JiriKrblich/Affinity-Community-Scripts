'use strict';
// ============================================================
// Object Fill v36
// Changes vs. v35 – performance (result and interface unchanged):
//  • All values (colour, size, rotation, opacity, position, outside test) are
//    computed in JavaScript up front; discarded points no longer create anything.
//  • Each copy is created with ONE combined matrix (duplicate + transform),
//    all copies in a single compound command.
//  • Fills, opacity and sorting into the group are one compound command each
//    (instead of 3–11 single commands per copy).
//  • Pixel access via the whole buffer (Uint8Array) instead of readPixel per pixel.
//  • Preview is discarded via the history position.
//  • A few history entries instead of thousands – undo in one step.
// v35: colour fixes for Affinity 3.3.3. v34: 6-tab GUI.
// v33: stale preview, exact path test, focal point via full parent chain.
// v32: gradient transfer, Blur Shadow interaction model, presets with prefix "OF_".
// ============================================================
const { Document }                   = require('/document');
const { Dialog, DialogResult }       = require('/dialog');
const { DocumentCommand,
        AddChildNodesCommandBuilder,
        CompoundCommandBuilder,
        NodeMoveType, NodeChildType } = require('/commands');
const { Selection }                  = require('/selections');
const { ContainerNodeDefinition }    = require('/nodes');
const { Transform, Point,
        WindingOrder }               = require('/geometry');
const { NodeRenderingEngine,
        NodeRenderingEngineOptions,
        RasterFormat }               = require('/rasterobject');
const { FillDescriptor, SolidFill }  = require('/fills');
const { Gradient, Colour }           = require('/colours');
const { app }                        = require('/application');
const { File, FileSystemApi }        = require('/fs');

function toColour(c){ return (c instanceof Colour)?c:new Colour(c); }
function mkRGBAf(o){ const f=Colour.createRGBAuf||Colour.createRGBAf; return f.call(Colour,o); }

const doc = Document.current;
if (!doc) { app.alert('No document open.','Object Fill'); throw new Error(); }
const initSel = doc.selection;
if (!initSel || initSel.length < 2) { app.alert('Select at least 2 objects.','Object Fill'); throw new Error(); }

const allNodes = [];
for (let i = 0; i < initSel.length; i++) allNodes.push(initSel.at(i).node);

// ── Helpers ─────────────────────────────────────────────────
function getBB(n) { try { return n.getSpreadBaseBox(false); } catch(e) { return null; } }
function diag(bb) { return bb ? Math.sqrt(bb.width*bb.width+bb.height*bb.height) : 0; }
function dist(ax,ay,bx,by) { const dx=ax-bx,dy=ay-by; return Math.sqrt(dx*dx+dy*dy); }
function randBetween(a,b) { return a+Math.random()*(b-a); }
function clamp(v,mn,mx) { return Math.max(mn,Math.min(mx,v)); }
function rotatePt(x,y,cx,cy,cosA,sinA) { const dx=x-cx,dy=y-cy; return {x:cx+dx*cosA-dy*sinA,y:cy+dx*sinA+dy*cosA}; }
function rgbToHsl(r,g,b) {
    const max=Math.max(r,g,b),min=Math.min(r,g,b),l=(max+min)/2;
    if(max===min)return{h:0,s:0,l};
    const d=max-min,s=l>0.5?d/(2-max-min):d/(max+min);
    let h;
    switch(max){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;default:h=(r-g)/d+4;}
    return{h:h/6,s,l};
}

function makePRNG(seed) {
    let s = seed >>> 0;
    return function() { s+=0x6D2B79F5; let t=s; t=Math.imul(t^t>>>15,1|t); t^=t+Math.imul(t^t>>>7,61|t); return ((t^t>>>14)>>>0)/4294967296; };
}

function composedSpreadTF(node) {
    const chain = [];
    let cur = node;
    while (cur) {
        const tag = cur[Symbol.toStringTag] || (cur.constructor && cur.constructor.name) || '';
        if (tag === 'SpreadNode' || tag === 'DocumentNode') break;
        chain.push(cur.transform);
        cur = cur.parent;
    }
    return {
        applyToPoint(pt) { let p=pt; for(const tf of chain) p=tf.applyToPoint(p); return p; },
        applyInverseToPoint(pt) { let p=pt; for(let i=chain.length-1;i>=0;i--) p=chain[i].inverted.applyToPoint(p); return p; }
    };
}

// ── Target object ───────────────────────────────────────────
let targetNode=null,targetDiag=-1;
for(const n of allNodes){ if(n.isGroupNode)continue; const d=diag(getBB(n)); if(d>targetDiag){targetDiag=d;targetNode=n;} }
if(!targetNode){ app.alert('No valid target object.','Object Fill'); throw new Error(); }
const fillNodes = allNodes.filter(n=>!n.isSameNode(targetNode));

let maxFillW=0,maxFillH=0,maxFillDiag=0;
for(const n of fillNodes){ const bb=getBB(n); if(bb){maxFillW=Math.max(maxFillW,bb.width);maxFillH=Math.max(maxFillH,bb.height);maxFillDiag=Math.max(maxFillDiag,diag(bb));} }
const fillMargin=Math.ceil(Math.max(maxFillW,maxFillH));

const targetTF = composedSpreadTF(targetNode);

function getTargetFocalPoint() {
    try{ const fp=targetNode.transformInterface.focalPoint; if(fp.isValid){ const p=targetTF.applyToPoint(fp.point); return{x:p.x,y:p.y,valid:true}; } }catch(e){}
    return{valid:false};
}
const focusPoint=getTargetFocalPoint();

function calcREnd(cx,cy,bb){ return Math.max(dist(cx,cy,bb.x,bb.y),dist(cx,cy,bb.x+bb.width,bb.y),dist(cx,cy,bb.x,bb.y+bb.height),dist(cx,cy,bb.x+bb.width,bb.y+bb.height)); }

function getTargetFillDescriptor(){ try{return targetNode.brushFillDescriptor;}catch(e){return null;} }
const TARGET_FD=getTargetFillDescriptor();
const TARGET_FILL_TYPE=TARGET_FD?TARGET_FD.fill.fillType.value:1;
const hasVariableFill=(TARGET_FILL_TYPE!==2&&TARGET_FILL_TYPE!==1);

const targetPPC = (function(){ try { const ci=targetNode.curvesInterface; return ci ? ci.polyPolyCurves : null; } catch(e) { return null; } })();
function isInsideFormExact(px,py) {
    if (!targetPPC) return null;
    try {
        const lp = targetTF.applyInverseToPoint({x:px,y:py});
        return targetPPC.containsPoint(new Point(lp.x,lp.y), false, WindingOrder.NonZero, true);
    } catch(e) { return null; }
}

// ── Grid generators ─────────────────────────────────────────
function gridTriangle(bb,cs,m){const h=cs*Math.sqrt(3)/2,x0=bb.x-m,y0=bb.y-m,x1=bb.x+bb.width+m,y1=bb.y+bb.height+m,pts=[];for(let r=0;y0+r*h<=y1;r++){const off=(r%2!==0)?cs/2:0;for(let c=0;x0+c*cs+off<=x1;c++)pts.push({x:x0+c*cs+off,y:y0+r*h,angle:null,normR:0});}return pts;}
function gridSquare(bb,cs,m){const x0=bb.x-m,y0=bb.y-m,x1=bb.x+bb.width+m,y1=bb.y+bb.height+m,pts=[];for(let r=0;y0+r*cs<=y1;r++)for(let c=0;x0+c*cs<=x1;c++)pts.push({x:x0+c*cs,y:y0+r*cs,angle:null,normR:0});return pts;}
function gridRectBB(bb,fbb,cs,m){const cw=fbb&&fbb.width>1?fbb.width:cs,ch=fbb&&fbb.height>1?fbb.height:cs,x0=bb.x-m,y0=bb.y-m,x1=bb.x+bb.width+m,y1=bb.y+bb.height+m,pts=[];for(let r=0;y0+r*ch<=y1;r++)for(let c=0;x0+c*cw<=x1;c++)pts.push({x:x0+c*cw,y:y0+r*ch,angle:null,normR:0});return pts;}
function gridPentagonal(bb,cs,m){const rH=cs*0.951,x0=bb.x-m,y0=bb.y-m,x1=bb.x+bb.width+m,y1=bb.y+bb.height+m,pts=[];for(let r=0;y0+r*rH<=y1;r++){const off=(r%2!==0)?cs*0.75:0;for(let c=0;x0+c*cs*1.5+off<=x1;c++)pts.push({x:x0+c*cs*1.5+off,y:y0+r*rH,angle:null,normR:0});}return pts;}
function gridHexagonal(bb,cs,m){const h=cs*Math.sqrt(3)/2,x0=bb.x-m,y0=bb.y-m,x1=bb.x+bb.width+m,y1=bb.y+bb.height+m,pts=[];for(let r=0;y0+r*h<=y1;r++){const off=(r%2!==0)?cs*0.75:0;for(let c=0;x0+c*cs*1.5+off<=x1;c++)pts.push({x:x0+c*cs*1.5+off,y:y0+r*h,angle:null,normR:0});}return pts;}

function gridCircles(cx,cy,rStart,rEnd,numRings,ptsOuter,propScale,offsetPct,offsetMode){
    const pts=[];
    for(let ring=0;ring<numRings;ring++){
        const t=numRings===1?1:ring/(numRings-1),r=rStart+(rEnd-rStart)*t;
        if(r<1)continue;
        const normR=rEnd>0?r/rEnd:0;
        const nPts=propScale?Math.max(3,Math.round(ptsOuter*(r/rEnd))):ptsOuter;
        const segAngle=2*Math.PI/nPts;
        let ringOffset=0;
        if(!propScale&&offsetPct!==0){const off=segAngle*offsetPct/100;ringOffset=offsetMode===0?ring*off:(ring%2===1?off:0);}
        for(let i=0;i<nPts;i++){const angle=segAngle*i+ringOffset;pts.push({x:cx+r*Math.cos(angle),y:cy+r*Math.sin(angle),angle:angle+Math.PI/2,normR});}
    }
    return pts;
}
function gridSpiral(cx,cy,rStart,rEnd,numTurns,arcSpacing,dir){
    if(arcSpacing<1)arcSpacing=1; if(dir!==1&&dir!==-1)dir=1;
    const pts=[],dr=(rEnd-rStart)/numTurns,totalAngle=numTurns*2*Math.PI,drPerRad=dr/(2*Math.PI);
    let theta=0,prevX=cx+rStart,prevY=cy,isFirst=true,arcAccum=0;
    while(theta<=totalAngle+0.01){
        const r=rStart+theta/(2*Math.PI)*dr,x=cx+r*Math.cos(theta),y=cy+r*Math.sin(theta)*dir;
        if(!isFirst){const dx=x-prevX,dy=y-prevY;arcAccum+=Math.sqrt(dx*dx+dy*dy);}
        if(isFirst||arcAccum>=arcSpacing){const normR=rEnd>0?r/rEnd:0;pts.push({x,y,angle:theta*dir+Math.PI/2+Math.atan(drPerRad/Math.max(r,1)),normR});arcAccum=0;}
        isFirst=false;prevX=x;prevY=y;theta+=0.01;
    }
    return pts;
}
function gridPhyllotaxis(cx,cy,rStart,rEnd,nTotal){
    const GOLDEN=Math.PI*(3-Math.sqrt(5));
    const pts=[];
    for(let i=0;i<nTotal;i++){
        const r=rStart+(rEnd-rStart)*Math.sqrt(i/nTotal);
        const theta=i*GOLDEN;
        const normR=rEnd>0?r/rEnd:0;
        pts.push({x:cx+r*Math.cos(theta),y:cy+r*Math.sin(theta),angle:theta+Math.PI/2,normR});
    }
    return pts;
}

function nextGroupIndex(){let max=0;for(const l of doc.layers.all){const m=(l.userDescription||'').match(/^ObjectFill_(\d+)$/);if(m)max=Math.max(max,parseInt(m[1]));}return max+1;}

// ── Renderer (v36: whole buffer as Uint8Array instead of readPixel per pixel) ──
function buildRenderer() {
    try{ const bb=getBB(targetNode); if(!bb||bb.width<1||bb.height<1)return null;
        let s=1; const maxPix=25e6;
        if(bb.width*bb.height>maxPix) s=Math.sqrt(maxPix/(bb.width*bb.height));
        const o=NodeRenderingEngineOptions.create(); o.scale=s;
        const pb=NodeRenderingEngine.create(targetNode,RasterFormat.RGBA8,o).createCompatibleBuffer(true);
        return{px:new Uint8Array(pb.buffer),W:pb.width,H:pb.height,bbSpread:bb};
    }catch(e){console.log('Renderer: '+e);return null;}
}
function probeRect(rend,ptX,ptY,probW,probH){
    const{W,H,bbSpread}=rend,scX=W/bbSpread.width,scY=H/bbSpread.height;
    const cx=(ptX-bbSpread.x)*scX,cy=(ptY-bbSpread.y)*scY,hw=probW*0.5*scX,hh=probH*0.5*scY;
    return{rx0:Math.floor(cx-hw),ry0:Math.floor(cy-hh),rx1:Math.ceil(cx+hw),ry1:Math.ceil(cy+hh),maxX:W-1,maxY:H-1};
}
function sampleBrightnessAndAlpha(rend,ptX,ptY,probW,probH){
    const{px,W}=rend,{rx0,ry0,rx1,ry1,maxX,maxY}=probeRect(rend,ptX,ptY,probW,probH);
    const stepX=Math.max(1,Math.ceil((rx1-rx0)/10)),stepY=Math.max(1,Math.ceil((ry1-ry0)/10));
    let lumSum=0,alphaSum=0,cnt=0;
    for(let py=ry0;py<=ry1;py+=stepY)for(let x=rx0;x<=rx1;x+=stepX){cnt++;if(x<0||py<0||x>maxX||py>maxY)continue;const k=(py*W+x)*4;alphaSum+=px[k+3]/255;lumSum+=(px[k]*0.299+px[k+1]*0.587+px[k+2]*0.114)/255;}
    return cnt===0?{lum:0.5,alpha:0}:{lum:lumSum/cnt,alpha:alphaSum/cnt};
}
function sampleHSL(rend,ptX,ptY,probW,probH){
    const{px,W}=rend,{rx0,ry0,rx1,ry1,maxX,maxY}=probeRect(rend,ptX,ptY,probW,probH);
    const stepX=Math.max(1,Math.ceil((rx1-rx0)/10)),stepY=Math.max(1,Math.ceil((ry1-ry0)/10));
    let sinSum=0,cosSum=0,sSum=0,lSum=0,cnt=0;
    for(let py=ry0;py<=ry1;py+=stepY)for(let x=rx0;x<=rx1;x+=stepX){if(x<0||py<0||x>maxX||py>maxY)continue;const k=(py*W+x)*4;if(px[k+3]===0)continue;const hsl=rgbToHsl(px[k]/255,px[k+1]/255,px[k+2]/255);const ang=hsl.h*2*Math.PI;sinSum+=Math.sin(ang);cosSum+=Math.cos(ang);sSum+=hsl.s;lSum+=hsl.l;cnt++;}
    if(cnt===0)return{h:0,s:0,l:0.5};let h=Math.atan2(sinSum/cnt,cosSum/cnt)/(2*Math.PI);if(h<0)h+=1;return{h,s:sSum/cnt,l:lSum/cnt};
}
function getAlphaAt(rend,sx,sy){
    const{px,W,H,bbSpread}=rend;
    const x=Math.round((sx-bbSpread.x)/bbSpread.width*W),y=Math.round((sy-bbSpread.y)/bbSpread.height*H);
    if(x<0||y<0||x>=W||y>=H)return 0;
    return px[(y*W+x)*4+3]/255;
}

// Transfer the target's gradient stops to an existing gradient fill → new FD or null
function targetGradientFD(dupFD){
    if(TARGET_FILL_TYPE!==3||!dupFD)return null;
    try{ if(dupFD.fill.fillType.value!==3)return null;
        const ts=TARGET_FD.fill.gradient.stops; if(!ts||ts.length===0)return null;
        const ns=ts.map(s=>({colour:toColour(s.colour),position:s.position,midpoint:s.midpoint!==undefined?s.midpoint:0.5,smoothness:s.smoothness!==undefined?s.smoothness:0}));
        const newGradFill=dupFD.fill.cloneWithNewGradient(Gradient.create(ns));
        return FillDescriptor.create(newGradFill,dupFD.isScaleWithObject,dupFD.transform,dupFD.blendMode,dupFD.isAnchoredToSpread);
    }catch(e){console.log('Gradient transfer: '+e);return null;}
}

// ── v36: compute the bounding box of a copy up front ──
// Affinity measures getSpreadBaseBox as the bounds of the transformed local base box.
// The same calculation in JavaScript gives exactly the box v35 queried after each step.
function spreadMatrix(node){
    let m=node.transform?node.transform.clone():Transform.createIdentity();
    let p=node.parent;
    while(p){
        const tag=p[Symbol.toStringTag]||(p.constructor&&p.constructor.name)||'';
        if(p.isSpreadNode||tag==='SpreadNode'||tag==='DocumentNode')break;
        if(p.transform)m=p.transform.multiply(m);
        p=p.parent;
    }
    return m;
}
const SHAPE_CACHE=[];
function sourceShape(idx){
    if(!SHAPE_CACHE[idx]){
        const n=fillNodes[idx], bb=getBB(n);
        let corners=null;
        try{ const b=n.baseBox, M=spreadMatrix(n);
            corners=[[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]].map(q=>M.applyToPoint({x:q[0],y:q[1]}));
        }catch(e){}
        if(!corners&&bb) corners=[{x:bb.x,y:bb.y},{x:bb.x+bb.width,y:bb.y},{x:bb.x,y:bb.y+bb.height},{x:bb.x+bb.width,y:bb.y+bb.height}];
        SHAPE_CACHE[idx]={bb,corners};
    }
    return SHAPE_CACHE[idx];
}
function transformedBox(idx,L){
    const P=sourceShape(idx).corners.map(p=>L.applyToPoint(p));
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const q of P){ if(q.x<x0)x0=q.x; if(q.x>x1)x1=q.x; if(q.y<y0)y0=q.y; if(q.y>y1)y1=q.y; }
    return{x:x0,y:y0,width:x1-x0,height:y1-y0};
}

// ── v36: create copies with one compound command ──
function createCopies(specs){
    if(!specs.length)return [];
    const cb=CompoundCommandBuilder.create();
    const perSrc=new Map();
    for(const s of specs){
        cb.addCommand(DocumentCommand.createTransform(Selection.create(doc,[fillNodes[s.src]]),s.F,{duplicateNodes:true}));
        perSrc.set(s.src,(perSrc.get(s.src)||0)+1);
    }
    doc.executeCommand(cb.createCommand());
    // duplicates sit directly above their source, newest lowest: [source, last, …, first]
    const bySrc=new Map();
    for(const [si,n] of perSrc){
        const src=fillNodes[si], sib=src.parent.children.toArray();
        const k=sib.findIndex(x=>x.isSameNode(src));
        const arr=[]; for(let i=0;i<n;i++) arr.push(sib[k+n-i]);
        bySrc.set(si,arr);
    }
    const used=new Map(); const out=[];
    for(const s of specs){ const u=used.get(s.src)||0; out.push(bySrc.get(s.src)[u]); used.set(s.src,u+1); }
    return out;
}
function runCompound(list){ if(!list.length)return; const cb=CompoundCommandBuilder.create(); for(const c of list)cb.addCommand(c); doc.executeCommand(cb.createCommand()); }
function createFillGroup(){
    const grpName='ObjectFill_'+nextGroupIndex();
    const grpB2=AddChildNodesCommandBuilder.create();
    grpB2.addContainerNode(ContainerNodeDefinition.create(grpName));
    const grpCmd=grpB2.createCommand(false);
    doc.executeCommand(grpCmd);
    return{grp:grpCmd.newNodes[0],name:grpName};
}
function moveIntoGroup(nodes,grp){
    runCompound(nodes.map(n=>DocumentCommand.createMoveNodes(Selection.create(doc,[n]),grp,NodeMoveType.Inside,NodeChildType.Main)));
}

// ── Point generation (unchanged from v35) ───────────────────
function buildPoints(params,targetBB,fillBB,isRadial,quick){
    let pts=[];
    if(isRadial){
        let cx=targetBB.x+targetBB.width/2,cy=targetBB.y+targetBB.height/2;
        if(params.radCenter===1&&focusPoint.valid){cx=focusPoint.x;cy=focusPoint.y;}
        const rEnd=calcREnd(cx,cy,targetBB);
        const rStart=Math.min(params.rStart,rEnd-1);
        if(params.gridType===6){
            pts=gridCircles(cx,cy,rStart,rEnd,params.numRings,params.ptsOuter,params.propScale,params.ringOffsetPct,params.ringOffsetMode);
        } else if(params.gridType===9){
            const area=Math.PI*rEnd*rEnd;
            const fillArea=(fillBB?fillBB.width*fillBB.height:100*100)||10000;
            const nTotal=quick?Math.max(10,Math.min(2000,Math.round(area/fillArea))):Math.max(10,Math.min(5000,Math.round(area/fillArea*params.copies)));
            pts=gridPhyllotaxis(cx,cy,rStart,rEnd,nTotal);
        } else {
            const dir=params.gridType===8?-1:1;
            const arcSpacing=params.arcSpacingPct/100*maxFillDiag;
            pts=gridSpiral(cx,cy,rStart,rEnd,params.numRings,Math.max(1,arcSpacing),dir);
        }
        if(Math.abs(params.gridRot)>0.0001){
            const ar=params.gridRot*Math.PI/180,cosA=Math.cos(ar),sinA=Math.sin(ar);
            pts=pts.map(p=>{const rp=rotatePt(p.x,p.y,cx,cy,cosA,sinA);return{x:rp.x,y:rp.y,angle:p.angle!==null?p.angle+ar:null,normR:p.normR};});
        }
    } else {
        const gridAngleRad=params.gridRot*Math.PI/180,cosA=Math.cos(gridAngleRad),sinA=Math.sin(gridAngleRad);
        const pivotX=targetBB.x+targetBB.width/2,pivotY=targetBB.y+targetBB.height/2;
        const rotMargin=(!quick&&Math.abs(params.gridRot)>0.0001)?Math.ceil(diag(targetBB)/2):0;
        const totalMargin=rotMargin+fillMargin;
        switch(params.gridType){
            case 0:pts=gridTriangle(targetBB,params.cellSize,totalMargin);break;
            case 2:pts=gridRectBB(targetBB,fillBB,params.cellSize,totalMargin);break;
            case 3:pts=gridPentagonal(targetBB,params.cellSize,totalMargin);break;
            case 4:pts=gridHexagonal(targetBB,params.cellSize,totalMargin);break;
            default:pts=gridSquare(targetBB,params.cellSize,totalMargin);
        }
        if(!quick&&Math.abs(params.gridRot)>0.0001)
            pts=pts.map(p=>{const r=rotatePt(p.x,p.y,pivotX,pivotY,cosA,sinA);return{x:r.x,y:r.y,angle:null,normR:0};});
        if(params.deleteOutside)
            pts=pts.filter(p=>p.x>=targetBB.x&&p.x<=targetBB.x+targetBB.width&&p.y>=targetBB.y&&p.y<=targetBB.y+targetBB.height);
    }
    return pts;
}

// ── Core (v36: everything precomputed, creation via compound commands) ──
function performFill(params){
    const t0=Date.now();
    const targetBB=getBB(targetNode); if(!targetBB)return null;
    const fillBB=getBB(fillNodes[0]);
    const isRadial=params.gridType>=6;

    if(params.quickPreview) return performQuickPreview(params,targetBB,fillBB,isRadial);

    const pts=buildPoints(params,targetBB,fillBB,isRadial,false);

    const needsRenderer=params.useBr||params.deleteOutside&&params.outsideTestMode===0||params.useColor||params.useOpBr;
    let rend=null;
    if(needsRenderer){rend=buildRenderer();if(!rend)console.log('Renderer n/a');}

    const prng = params.randomSelect ? makePRNG(params.seed===0?Date.now():params.seed) : null;
    let fillIdxArr=null;
    if(prng){
        fillIdxArr=pts.map((_,pi)=>{ const n=fillNodes.length; const arr=[...Array(n).keys()]; for(let i=n-1;i>0;i--){const j=Math.floor(prng()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];} return arr; });
    }

    const specs=[]; let fillIdx=0,deleted=0;
    for(let pi=0;pi<pts.length;pi++){
        const pt=pts[pi];
        for(let copy=0;copy<params.copies;copy++){
            let srcIdx;
            if(prng&&fillIdxArr){ srcIdx=fillIdxArr[pi][(fillIdx)%fillNodes.length]; }
            else{ srcIdx=fillIdx%fillNodes.length; }
            fillIdx++;
            const sbb=sourceShape(srcIdx).bb; if(!sbb||!sourceShape(srcIdx).corners)continue;

            let hsl=null;
            if(params.useColor&&rend) hsl=sampleHSL(rend,pt.x,pt.y,sbb.width*0.20,sbb.height*0.20);

            let L=Transform.createIdentity();
            if(isRadial&&params.alignToPath&&pt.angle!==null) L=Transform.createRotate(pt.angle).multiply(L);
            if(params.jRot>0) L=Transform.createRotate(randBetween(-params.jRot,params.jRot)*Math.PI/180).multiply(L);
            const hsSJ=params.jSXMin!==0||params.jSXMax!==0||params.jSYMin!==0||params.jSYMax!==0;
            if(hsSJ){const sxPct=randBetween(params.jSXMin,params.jSXMax),syPct=params.keepAspect?sxPct:randBetween(params.jSYMin,params.jSYMax);
                const sx=1+sxPct/100,sy=1+syPct/100; if(Math.abs(sx-1)>0.0001||Math.abs(sy-1)>0.0001) L=Transform.createScale(sx,sy).multiply(L);}
            if(isRadial&&(params.radScaleInner!==100||params.radScaleOuter!==100)){
                const scR=clamp((params.radScaleInner+(params.radScaleOuter-params.radScaleInner)*pt.normR)/100,0.001,50);
                if(Math.abs(scR-1)>0.001) L=Transform.createScale(scR,scR).multiply(L);
            }
            if(isRadial&&params.useDist){
                const scD=clamp((params.distCenter+(params.distEdge-params.distCenter)*pt.normR)/100,0.001,50);
                if(Math.abs(scD-1)>0.001) L=Transform.createScale(scD,scD).multiply(L);
            }
            const tb=transformedBox(srcIdx,L);
            const tcx=tb.x+tb.width/2,tcy=tb.y+tb.height/2;

            let sc=1;
            if(params.useBr&&rend){
                const{lum,alpha}=sampleBrightnessAndAlpha(rend,pt.x,pt.y,tb.width*0.20,tb.height*0.20);
                const scLum=clamp((params.bAt0+(params.bAt100-params.bAt0)*lum)/100,0.001,50);
                sc=scLum*Math.pow(alpha,params.alphaExp);
                if(sc<0.005){deleted++;continue;}
                if(Math.abs(sc-1)<=0.001) sc=1;
            }

            let ox=pt.x,oy=pt.y;
            if(params.jPX>0)ox+=randBetween(-targetBB.width*params.jPX/1000,targetBB.width*params.jPX/1000);
            if(params.jPY>0)oy+=randBetween(-targetBB.height*params.jPY/1000,targetBB.height*params.jPY/1000);

            let op=null;
            if(params.jOpMin!==100||params.jOpMax!==100) op=clamp(randBetween(params.jOpMin,params.jOpMax)/100,0,1);
            if(params.useOpBr&&rend){
                const{lum}=sampleBrightnessAndAlpha(rend,pt.x,pt.y,tb.width*sc*0.20,tb.height*sc*0.20);
                op=clamp((params.opBrDark+(params.opBrLight-params.opBrDark)*lum)/100,0,1);
            }

            if(params.deleteOutside){
                let outside=false;
                if(params.outsideTestMode===1){ const r=isInsideFormExact(ox,oy); if(r===null&&rend)outside=getAlphaAt(rend,ox,oy)<=0; else outside=r===false; }
                else if(rend) outside=getAlphaAt(rend,ox,oy)<=0;
                if(outside){deleted++;continue;}
            }

            const F=Transform.createTranslate(ox,oy).multiply(Transform.createScale(sc,sc)).multiply(Transform.createTranslate(-tcx,-tcy)).multiply(L);
            specs.push({src:srcIdx,F,hsl,op,area:tb.width*tb.height*sc*sc});
        }
    }

    const nodes=createCopies(specs);

    const fillCmds=[];
    for(let i=0;i<nodes.length;i++){
        const n=nodes[i],s=specs[i]; if(!n)continue;
        let fd=null;
        if(s.hsl){ try{ fd=FillDescriptor.createSolid(SolidFill.create(Colour.createHSLAf({h:s.hsl.h,s:s.hsl.s,l:s.hsl.l,alpha:1.0}))); }catch(e){} }
        else if(params.useGrad){ try{ fd=targetGradientFD(n.brushFillDescriptor); }catch(e){} }
        if(fd) fillCmds.push(DocumentCommand.createSetBrushFill(Selection.create(doc,[n]),fd));
    }
    runCompound(fillCmds);

    const opCmds=[];
    for(let i=0;i<nodes.length;i++){ if(nodes[i]&&specs[i].op!==null) opCmds.push(DocumentCommand.createSetOpacity(Selection.create(doc,[nodes[i]]),specs[i].op)); }
    runCompound(opCmds);

    let order=nodes.map((n,i)=>({n,area:specs[i].area})).filter(o=>o.n);
    if(params.sortBySize&&order.length>1) order.sort((a,b)=>params.sortDir===0?a.area-b.area:b.area-a.area);
    const{grp:fillGroup,name:grpName}=createFillGroup();
    if(!fillGroup)return null;
    moveIntoGroup(order.map(o=>o.n),fillGroup);

    console.log('Object Fill v36: '+order.length+' placed, '+deleted+' discarded → "'+grpName+'" ('+(Date.now()-t0)+' ms)');
    try{
        doc.executeCommand(DocumentCommand.createMoveNodes(fillGroup.selfSelection,targetNode,NodeMoveType.Inside,NodeChildType.Main));
    }catch(e){console.log('Embedding: '+e);}
    return fillGroup;
}

function performQuickPreview(params,targetBB,fillBB,isRadial){
    const pts=buildPoints(params,targetBB,fillBB,isRadial,true);
    const dotSize=Math.max(4,Math.min(20,maxFillDiag*0.1));
    const sbb=sourceShape(0).bb; if(!sbb)return null;
    const cx0=sbb.x+sbb.width/2,cy0=sbb.y+sbb.height/2;
    const scX=sbb.width>0.001?dotSize/sbb.width:1,scY=sbb.height>0.001?dotSize/sbb.height:1;
    const specs=pts.map(pt=>({src:0,F:Transform.createTranslate(pt.x,pt.y).multiply(Transform.createScale(scX,scY)).multiply(Transform.createTranslate(-cx0,-cy0))}));
    const nodes=createCopies(specs);
    let red=null; try{ red=FillDescriptor.createSolid(SolidFill.create(mkRGBAf({r:1,g:0.2,b:0.2,alpha:0.7}))); }catch(e){}
    if(red) runCompound(nodes.filter(n=>n).map(n=>DocumentCommand.createSetBrushFill(Selection.create(doc,[n]),red)));
    const{grp:fillGroup,name:grpName}=createFillGroup();
    if(!fillGroup)return null;
    moveIntoGroup(nodes.filter(n=>n),fillGroup);
    console.log('Quick preview v36: '+nodes.length+' dots → "'+grpName+'"');
    try{doc.executeCommand(DocumentCommand.createMoveNodes(fillGroup.selfSelection,targetNode,NodeMoveType.Inside,NodeChildType.Main));}catch(e){}
    return fillGroup;
}

// ── Dialog (tabs) ───────────────────────────────────────────
function buildDialog(){
    const dlg=Dialog.create('Object Fill');
    dlg.initialWidth=900;
    dlg.setIsResizable(true);

    const cNav=dlg.addColumn(); cNav.widthProportion=0.8;
    const cA=dlg.addColumn();   cA.widthProportion=1;
    const cB=dlg.addColumn();   cB.widthProportion=1;

    const PAGES=[[],[],[],[],[],[]];
    function pageGroup(pageIdx,col,title){ const g=col.addGroup(title); PAGES[pageIdx].push(g); return g; }
    let pagedOK=true;
    function showPage(i){
        if(!pagedOK)return;
        try{
            for(let k=0;k<PAGES.length;k++) for(const g of PAGES[k]) g.isVisible=(k===i);
        }catch(e){
            pagedOK=false;
            try{ for(const pg of PAGES) for(const g of pg) g.isVisible=true; }catch(e2){}
            console.log('Tabs not available: '+e.message);
        }
    }

    const gNav=cNav.addGroup('Tabs');
    const rNav=gNav.addRadioGroup('',['1  Grid','2  Radial','3  Size & opacity','4  Jitter','5  Colour','6  Sorting & output'],0);
    gNav.addStaticText('',
        (targetNode.userDescription||targetNode.defaultDescription||'Object')+
        '\nFill obj.: '+fillNodes.length+'  ·  Margin: '+fillMargin+'px'+
        (focusPoint.valid?'  ·  FP✓':'')+(!hasVariableFill?'  ·  Solid':''));

    const gAct=cNav.addGroup('Preview');
    const btnPreview=gAct.addButton('Preview');
    const cbQuickPrev=gAct.addCheckBox('Quick preview (red dots)',false);
    const stStatus=gAct.addStaticText('','');

    const gPresetBtn=cNav.addGroup('Presets');
    const btnSave=gPresetBtn.addButton('Save');
    const btnLoad=gPresetBtn.addButton('Load');
    const btnDelete=gPresetBtn.addButton('Delete');

    const gG=pageGroup(0,cA,'Grid');
    const edCop=gG.addUnitValueEditor('Copies/point','none','none',null,1,50); edCop.value=1;
    const cbGT=gG.addComboBox('Grid type',[
        'Equilat. triangle','Square','Rectangle (BB-prop.)','Pentagonal','Hexagonal',
        '── Radial ──','Circles (concentric)','Spiral ↻ (right)','Spiral ↺ (left)',
        'Phyllotaxis (golden angle)']);
    cbGT.selectedIndex=1;
    const edCS=gG.addUnitValueEditor('Grid size (px)','none','none',null,1,10000); edCS.value=100;
    const edGRot=gG.addUnitValueEditor('Grid rotation (°)','none','none',null,-180,180); edGRot.value=0;

    const gSel=pageGroup(0,cB,'Object selection');
    const cbRandom=gSel.addCheckBox('Random selection',false);
    const edSeed=gSel.addUnitValueEditor('Seed (0=time)','none','none',null,0,99999); edSeed.value=0;

    const gR=pageGroup(1,cA,'Radial parameters');
    gR.addStaticText('','Only for radial grid types.');
    const cbRadCenter=gR.addComboBox('Centre',['BB centre',focusPoint.valid?'Focal point':'Focal point (not set)']);
    cbRadCenter.selectedIndex=0;
    const targetBBinfo=getBB(targetNode);
    function calcREndInfo(useFC){
        if(!targetBBinfo)return 0;
        let cx=targetBBinfo.x+targetBBinfo.width/2,cy=targetBBinfo.y+targetBBinfo.height/2;
        if(useFC&&focusPoint.valid){cx=focusPoint.x;cy=focusPoint.y;}
        return Math.round(calcREnd(cx,cy,targetBBinfo));
    }
    const stREnd=gR.addStaticText('','Outer radius: '+calcREndInfo(false)+' px');
    cbRadCenter.setOnValueChangedHandler(()=>stREnd.setText('Outer radius: '+calcREndInfo(cbRadCenter.selectedIndex===1)+' px'));
    const edRStart=gR.addUnitValueEditor('Start radius (px)','none','none',null,0,10000); edRStart.value=20;
    const edRings=gR.addUnitValueEditor('Circles/turns/N','none','none',null,1,1000); edRings.value=5;
    const cbAlign=gR.addCheckBox('Align to circle/spiral',false);
    const edPtsOuter=gR.addUnitValueEditor('Points on outer circle','none','none',null,3,360); edPtsOuter.value=24;
    const cbPropScale=gR.addCheckBox('Proportional to radius',true);

    const gR2=pageGroup(1,cB,'Ring offset & spiral');
    const edRingOffset=gR2.addUnitValueEditor('Ring offset (% segment)','none','none',null,0,200); edRingOffset.value=0;
    const cbOffsetMode=gR2.addComboBox('Offset mode',['Continuous','Alternating']); cbOffsetMode.selectedIndex=0;
    gR2.addStaticText('','Offset only when Proportional is OFF.');
    const edArcSpacing=gR2.addUnitValueEditor('Arc spacing (% fill obj. diag.)','none','none',null,10,500); edArcSpacing.value=100;

    const gB=pageGroup(2,cA,'Size by brightness');
    gB.addStaticText('','Size=scLum×alpha^n (gradient/bitmap only)');
    const cbBr=gB.addCheckBox('Enable',false);
    const edB0=gB.addUnitValueEditor('Size at black (%)','none','none',null,0,500); edB0.value=100;
    const edB100=gB.addUnitValueEditor('Size at white (%)','none','none',null,0,500); edB100.value=30;
    const edAlphaExp=gB.addUnitValueEditor('Edge sharpness (exponent n)','none','none',null,0.1,10); edAlphaExp.value=1;

    const gC3=pageGroup(2,cA,'Opacity by brightness');
    gC3.addStaticText('','Light→transparent, dark→opaque');
    const cbOpBr=gC3.addCheckBox('Enable',false);
    const edOpBrDark=gC3.addUnitValueEditor('Opacity at black (%)','none','none',null,0,100); edOpBrDark.value=100;
    const edOpBrLight=gC3.addUnitValueEditor('Opacity at white (%)','none','none',null,0,100); edOpBrLight.value=30;

    const gRS=pageGroup(2,cB,'Radius scaling (radial)');
    gRS.addStaticText('','Scaling inner→outer (radial only)');
    const edRSInner=gRS.addUnitValueEditor('Size inner (%)','none','none',null,0,500); edRSInner.value=100;
    const edRSOuter=gRS.addUnitValueEditor('Size outer (%)','none','none',null,0,500); edRSOuter.value=100;

    const gDS=pageGroup(2,cB,'Size by distance (radial)');
    gDS.addStaticText('','Analytic from radius (radial only)');
    const cbDist=gDS.addCheckBox('Enable',false);
    const edDSCenter=gDS.addUnitValueEditor('Size at centre (%)','none','none',null,0,500); edDSCenter.value=100;
    const edDSEdge=gDS.addUnitValueEditor('Size at edge (%)','none','none',null,0,500); edDSEdge.value=30;

    const gJ=pageGroup(3,cA,'Jitter — rotation');
    const edRot=gJ.addUnitValueEditor('Max. angle (±°)','none','none',null,0,360); edRot.value=0;

    const gJS=pageGroup(3,cA,'Jitter — size');
    const edSXMin=gJS.addUnitValueEditor('Min. X (%)','none','none',null,-100,500); edSXMin.value=0;
    const edSXMax=gJS.addUnitValueEditor('Max. X (%)','none','none',null,-100,500); edSXMax.value=0;
    const edSYMin=gJS.addUnitValueEditor('Min. Y (%)','none','none',null,-100,500); edSYMin.value=0;
    const edSYMax=gJS.addUnitValueEditor('Max. Y (%)','none','none',null,-100,500); edSYMax.value=0;
    const cbAspect=gJS.addCheckBox('Keep aspect ratio',true);

    const gJO=pageGroup(3,cB,'Jitter — opacity');
    const edOpMin=gJO.addUnitValueEditor('Min. opacity (%)','none','none',null,0,100); edOpMin.value=100;
    const edOpMax=gJO.addUnitValueEditor('Max. opacity (%)','none','none',null,0,100); edOpMax.value=100;

    const gJP=pageGroup(3,cB,'Jitter — position');
    const edPX=gJP.addUnitValueEditor('Pos. X (‰ target)','none','none',null,0,2000); edPX.value=0;
    const edPY=gJP.addUnitValueEditor('Pos. Y (‰ target)','none','none',null,0,2000); edPY.value=0;

    const gFC=pageGroup(4,cA,'Transfer fill colour');
    gFC.addStaticText('','HSL sample from target (bitmaps too)');
    const cbColor=gFC.addCheckBox('Transfer fill colour',false);

    const gFG=pageGroup(4,cB,'Gradient');
    gFG.addStaticText('','Transfer the target\'s gradient stops');
    const cbGrad=gFG.addCheckBox('Use gradient',false);

    const gSort=pageGroup(5,cA,'Sorting');
    gSort.addStaticText('','Sort layer order by size');
    const cbSort=gSort.addCheckBox('Sort by size',false);
    const cbSortDir=gSort.addComboBox('Order',['Small bottom, large top','Large bottom, small top']);
    cbSortDir.selectedIndex=0;

    const gOut=pageGroup(5,cB,'Delete outside');
    const cbTestMode=gOut.addComboBox('Test method',['Alpha channel (default)','Exact path test']);
    cbTestMode.selectedIndex=0;
    gOut.addStaticText('','Alpha: bitmaps too. Path: vectors only.');
    const cbDel=gOut.addCheckBox('Delete outside',true);

    try{ rNav.selectedIndex=0; }catch(e){}
    showPage(0);
    try{ rNav.setOnValueChangedHandler(()=>{ showPage(rNav.selectedIndex); }); }catch(e){}

    function readParams(){
        return{
            copies:Math.max(1,Math.round(edCop.value||1)),
            gridType:cbGT.selectedIndex,
            cellSize:Math.max(1,edCS.value||100),
            gridRot:edGRot.value||0,
            radCenter:cbRadCenter.selectedIndex,
            rStart:Math.max(0,edRStart.value||20),
            numRings:Math.max(1,Math.round(edRings.value||5)),
            alignToPath:cbAlign.value,
            ptsOuter:Math.max(3,Math.round(edPtsOuter.value||24)),
            propScale:cbPropScale.value,
            ringOffsetPct:edRingOffset.value||0,
            ringOffsetMode:cbOffsetMode.selectedIndex,
            arcSpacingPct:Math.max(10,edArcSpacing.value||100),
            jRot:edRot.value||0,
            jSXMin:edSXMin.value||0,jSXMax:edSXMax.value||0,
            jSYMin:edSYMin.value||0,jSYMax:edSYMax.value||0,
            keepAspect:cbAspect.value,
            jOpMin:edOpMin.value!==undefined?edOpMin.value:100,
            jOpMax:edOpMax.value!==undefined?edOpMax.value:100,
            jPX:edPX.value||0,jPY:edPY.value||0,
            randomSelect:cbRandom.value,
            seed:Math.round(edSeed.value||0),
            useBr:cbBr.value,
            bAt0:edB0.value!==undefined?edB0.value:100,
            bAt100:edB100.value!==undefined?edB100.value:30,
            alphaExp:Math.max(0.1,edAlphaExp.value||1),
            useOpBr:cbOpBr.value,
            opBrDark:edOpBrDark.value!==undefined?edOpBrDark.value:100,
            opBrLight:edOpBrLight.value!==undefined?edOpBrLight.value:30,
            useColor:cbColor.value,
            radScaleInner:edRSInner.value!==undefined?edRSInner.value:100,
            radScaleOuter:edRSOuter.value!==undefined?edRSOuter.value:100,
            useDist:cbDist.value,
            distCenter:edDSCenter.value!==undefined?edDSCenter.value:100,
            distEdge:edDSEdge.value!==undefined?edDSEdge.value:30,
            useGrad:cbGrad.value,
            sortBySize:cbSort.value,
            sortDir:cbSortDir.selectedIndex,
            outsideTestMode:cbTestMode.selectedIndex,
            deleteOutside:cbDel.value,
            quickPreview:cbQuickPrev.value,
        };
    }
    function collectParams(){
        return{copies:edCop.value,gridType:cbGT.selectedIndex,cellSize:edCS.value,gridRot:edGRot.value,radCenter:cbRadCenter.selectedIndex,rStart:edRStart.value,numRings:edRings.value,alignToPath:cbAlign.value,ptsOuter:edPtsOuter.value,propScale:cbPropScale.value,ringOffsetPct:edRingOffset.value,ringOffsetMode:cbOffsetMode.selectedIndex,arcSpacingPct:edArcSpacing.value,jRot:edRot.value,jSXMin:edSXMin.value,jSXMax:edSXMax.value,jSYMin:edSYMin.value,jSYMax:edSYMax.value,keepAspect:cbAspect.value,jOpMin:edOpMin.value,jOpMax:edOpMax.value,jPX:edPX.value,jPY:edPY.value,randomSelect:cbRandom.value,seed:edSeed.value,useBr:cbBr.value,bAt0:edB0.value,bAt100:edB100.value,alphaExp:edAlphaExp.value,useOpBr:cbOpBr.value,opBrDark:edOpBrDark.value,opBrLight:edOpBrLight.value,useColor:cbColor.value,radScaleInner:edRSInner.value,radScaleOuter:edRSOuter.value,useDist:cbDist.value,distCenter:edDSCenter.value,distEdge:edDSEdge.value,useGrad:cbGrad.value,sortBySize:cbSort.value,sortDir:cbSortDir.selectedIndex,outsideTestMode:cbTestMode.selectedIndex,deleteOutside:cbDel.value,quickPreview:cbQuickPrev.value};
    }
    function applyParams(p){
        if(p.copies!=null)edCop.value=p.copies;if(p.gridType!=null)cbGT.selectedIndex=p.gridType;if(p.cellSize!=null)edCS.value=p.cellSize;if(p.gridRot!=null)edGRot.value=p.gridRot;if(p.radCenter!=null)cbRadCenter.selectedIndex=p.radCenter;if(p.rStart!=null)edRStart.value=p.rStart;if(p.numRings!=null)edRings.value=p.numRings;if(p.alignToPath!=null)cbAlign.value=p.alignToPath;if(p.ptsOuter!=null)edPtsOuter.value=p.ptsOuter;if(p.propScale!=null)cbPropScale.value=p.propScale;if(p.ringOffsetPct!=null)edRingOffset.value=p.ringOffsetPct;if(p.ringOffsetMode!=null)cbOffsetMode.selectedIndex=p.ringOffsetMode;if(p.arcSpacingPct!=null)edArcSpacing.value=p.arcSpacingPct;if(p.jRot!=null)edRot.value=p.jRot;if(p.jSXMin!=null)edSXMin.value=p.jSXMin;if(p.jSXMax!=null)edSXMax.value=p.jSXMax;if(p.jSYMin!=null)edSYMin.value=p.jSYMin;if(p.jSYMax!=null)edSYMax.value=p.jSYMax;if(p.keepAspect!=null)cbAspect.value=p.keepAspect;if(p.jOpMin!=null)edOpMin.value=p.jOpMin;if(p.jOpMax!=null)edOpMax.value=p.jOpMax;if(p.jPX!=null)edPX.value=p.jPX;if(p.jPY!=null)edPY.value=p.jPY;if(p.randomSelect!=null)cbRandom.value=p.randomSelect;if(p.seed!=null)edSeed.value=p.seed;if(p.useBr!=null)cbBr.value=p.useBr;if(p.bAt0!=null)edB0.value=p.bAt0;if(p.bAt100!=null)edB100.value=p.bAt100;if(p.alphaExp!=null)edAlphaExp.value=p.alphaExp;if(p.useOpBr!=null)cbOpBr.value=p.useOpBr;if(p.opBrDark!=null)edOpBrDark.value=p.opBrDark;if(p.opBrLight!=null)edOpBrLight.value=p.opBrLight;if(p.useColor!=null)cbColor.value=p.useColor;if(p.radScaleInner!=null)edRSInner.value=p.radScaleInner;if(p.radScaleOuter!=null)edRSOuter.value=p.radScaleOuter;if(p.useDist!=null)cbDist.value=p.useDist;if(p.distCenter!=null)edDSCenter.value=p.distCenter;if(p.distEdge!=null)edDSEdge.value=p.distEdge;if(p.useGrad!=null)cbGrad.value=p.useGrad;if(p.sortBySize!=null)cbSort.value=p.sortBySize;if(p.sortDir!=null)cbSortDir.selectedIndex=p.sortDir;if(p.outsideTestMode!=null)cbTestMode.selectedIndex=p.outsideTestMode;if(p.deleteOutside!=null)cbDel.value=p.deleteOutside;if(p.quickPreview!=null)cbQuickPrev.value=p.quickPreview;
        try{stREnd.setText('Outer radius: '+calcREndInfo(cbRadCenter.selectedIndex===1)+' px');}catch(e){}
    }
    const PRESET_PREFIX='OF_';
    function getPresetDir(){
        const dir=app.userDesktopPath+'/AffinityScriptPresets';
        try{ if(!FileSystemApi.exists(dir)) FileSystemApi.createDirectories(dir); }
        catch(e){ try{ FileSystemApi.createDirectories(dir); }catch(e2){} }
        return dir;
    }
    function savePreset(){
        try{
            const dir=getPresetDir();
            const nameIn=app.prompt('Enter preset name (prefix '+PRESET_PREFIX+' is added):','Save preset','');
            if(!nameIn||!nameIn.trim())return;
            let base=nameIn.trim();
            if(base.toUpperCase().startsWith(PRESET_PREFIX.toUpperCase()))base=base.substring(PRESET_PREFIX.length);
            const path=dir+'/'+PRESET_PREFIX+base+'.json';
            const f=File.create(path,'wb');f.writeStringAsUtf8(JSON.stringify(collectParams(),null,2));f.close();
            app.alert('Preset saved:\n'+path,'Object Fill');
        }catch(e){app.alert('Error saving:\n'+e.message,'Object Fill');}
    }
    function loadPreset(){
        try{
            getPresetDir();
            const path=app.chooseFile();if(!path)return false;
            let buf;try{buf=File.readAll(path);}catch(e){app.alert('File not readable.','Object Fill');return false;}
            applyParams(JSON.parse(buf.toString('utf8')));return true;
        }catch(e){app.alert('Error loading:\n'+e.message,'Object Fill');return false;}
    }
    function deletePreset(){
        try{
            getPresetDir();
            const path=app.chooseFile();if(!path)return;
            if(!/\.json$/i.test(path)){app.alert('Only .json preset files can be deleted.','Object Fill');return;}
            FileSystemApi.remove(path);
            app.alert('Preset deleted:\n'+path,'Object Fill');
        }catch(e){app.alert('Error deleting:\n'+e.message,'Object Fill');}
    }

    // v36: preview is discarded via the history position
    const basePos=doc.history.position;
    let previewGroup=null,previewKey=null,previewWasQuick=false;
    function cleanupPreview(){
        if(previewGroup){ rollbackTo(basePos); }
        previewGroup=null; previewKey=null; previewWasQuick=false;
    }
    function keyOf(p){ const q=Object.assign({},p); delete q.quickPreview; return JSON.stringify(q); }
    btnPreview.setOnClickHandler(()=>{
        cleanupPreview();
        const p=readParams();
        const t=Date.now();
        try{ previewGroup=performFill(p); }catch(e){ rollbackTo(basePos); previewGroup=null; try{stStatus.setText('Error: '+e.message);}catch(e2){} return; }
        if(previewGroup){ previewKey=keyOf(p); previewWasQuick=!!p.quickPreview; }
        try{ stStatus.setText((previewGroup?previewGroup.children.length:0)+' objects · '+(Date.now()-t)+' ms'); }catch(e){}
    });
    btnSave.setOnClickHandler(()=>{ savePreset(); });
    btnLoad.setOnClickHandler(()=>{ loadPreset(); });
    btnDelete.setOnClickHandler(()=>{ deletePreset(); });

    return{
        dlg,readParams,keyOf,cleanupPreview,
        isReusablePreview:(p)=>!!previewGroup&&!previewWasQuick&&previewKey===keyOf(p),
        getPreviewGroup:()=>previewGroup
    };
}

function rollbackTo(pos){
    try{ if(doc.history.position!==pos) doc.history.position=pos; }
    catch(e){ while(doc.history.position>pos) doc.history.undo(); }
}

// ── Run dialog ──────────────────────────────────────────────
const dlgObj=buildDialog();
const result=dlgObj.dlg.runModal();
if(result&&result.value===DialogResult.Ok.value){
    const p=dlgObj.readParams();
    p.quickPreview=false;
    if(!dlgObj.isReusablePreview(p)){
        dlgObj.cleanupPreview();
        performFill(p);
    }
}else{
    dlgObj.cleanupPreview();
}

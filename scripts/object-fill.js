'use strict';
// ============================================================
// Object Fill v33 (EN)
// Changes compared to v32b:
//  FIX1  Stale preview: OK always kept an existing preview - even when settings
//        were changed afterwards, and even if it was a "quick preview" (red dots).
//        The preview now stays only if it is a full fill with the same settings;
//        otherwise it is deleted and recalculated. Apply never creates a quick
//        preview.
//  FIX2  "Exact path test" never worked: polyPolyCurves.clone().transform()
//        expects a real Transform but received a custom object ("expected
//        Transform", confirmed live). The error was swallowed, the alpha test
//        always ran instead. The test point is now converted into the target's
//        local space via the inverse parent chain and tested there (as in
//        "Clip Objects").
//  FIX3  The target's focal point only used targetNode.transform - for a target
//        inside a transformed group the centre was wrong. Now the full parent chain.
// v32: gradient transfer (FillDescriptor.create), Blur-Shadow dialog concept,
//      presets in AffinityScriptPresets with prefix "OF_" (identical to the German
//      version, presets exchangeable).
// ============================================================
const { Document }                   = require('/document');
const { Dialog, DialogResult }       = require('/dialog');
const { DocumentCommand,
        AddChildNodesCommandBuilder,
        NodeMoveType, NodeChildType } = require('/commands');
const { Selection }                  = require('/selections');
const { ContainerNodeDefinition }    = require('/nodes');
const { Transform, Point,
        WindingOrder }               = require('/geometry');
const { NodeRenderingEngine,
        RasterFormat }               = require('/rasterobject');
const { PixelReaderRGBA8 }           = require('/pixelaccessor');
const { FillDescriptor, SolidFill }  = require('/fills');
const { Gradient, Colour }           = require('/colours');
const { app }                        = require('/application');
const { File, FileSystemApi }        = require('/fs');

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

// v33: parent chain with forward and inverse direction
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

// ── Determine target object ──────────────────────────────────
let targetNode=null,targetDiag=-1;
for(const n of allNodes){ if(n.isGroupNode)continue; const d=diag(getBB(n)); if(d>targetDiag){targetDiag=d;targetNode=n;} }
if(!targetNode){ app.alert('No valid target object.','Object Fill'); throw new Error(); }
const fillNodes = allNodes.filter(n=>!n.isSameNode(targetNode));

let maxFillW=0,maxFillH=0,maxFillDiag=0;
for(const n of fillNodes){ const bb=getBB(n); if(bb){maxFillW=Math.max(maxFillW,bb.width);maxFillH=Math.max(maxFillH,bb.height);maxFillDiag=Math.max(maxFillDiag,diag(bb));} }
const fillMargin=Math.ceil(Math.max(maxFillW,maxFillH));

const targetTF = composedSpreadTF(targetNode);

// v33: focal point via the full parent chain
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

// ── Exact path test (v33: test point in local space) ─────────
const targetPPC = (function(){ try { const ci=targetNode.curvesInterface; return ci ? ci.polyPolyCurves : null; } catch(e) { return null; } })();
function isInsideFormExact(px,py) {
    if (!targetPPC) return null;
    try {
        const lp = targetTF.applyInverseToPoint({x:px,y:py});
        return targetPPC.containsPoint(new Point(lp.x,lp.y), false, WindingOrder.NonZero, true);
    } catch(e) { return null; }
}

// ── Renderer ─────────────────────────────────────────────────
function buildRenderer() {
    try{ const bb=getBB(targetNode); if(!bb||bb.width<1||bb.height<1)return null;
        const engine=NodeRenderingEngine.createDefault(targetNode,RasterFormat.RGBA8);
        const bm=engine.createCompatibleBitmap(true),reader=PixelReaderRGBA8.create(bm);
        return{reader,bm,bbSpread:bb};
    }catch(e){console.log('Renderer: '+e);return null;}
}
function probeRect(rend,ptX,ptY,probW,probH){
    const{bm,bbSpread}=rend,scX=bm.width/bbSpread.width,scY=bm.height/bbSpread.height;
    const cx=(ptX-bbSpread.x)*scX,cy=(ptY-bbSpread.y)*scY,hw=probW*0.5*scX,hh=probH*0.5*scY;
    return{rx0:Math.floor(cx-hw),ry0:Math.floor(cy-hh),rx1:Math.ceil(cx+hw),ry1:Math.ceil(cy+hh),maxX:bm.width-1,maxY:bm.height-1};
}
function sampleBrightnessAndAlpha(rend,ptX,ptY,probW,probH){
    const{reader}=rend,{rx0,ry0,rx1,ry1,maxX,maxY}=probeRect(rend,ptX,ptY,probW,probH);
    const stepX=Math.max(1,Math.ceil((rx1-rx0)/10)),stepY=Math.max(1,Math.ceil((ry1-ry0)/10));
    let lumSum=0,alphaSum=0,cnt=0;
    for(let py=ry0;py<=ry1;py+=stepY)for(let px=rx0;px<=rx1;px+=stepX){cnt++;if(px<0||py<0||px>maxX||py>maxY)continue;const p=reader.readPixel(px,py);alphaSum+=p.alpha/255;lumSum+=(p.r*0.299+p.g*0.587+p.b*0.114)/255;}
    return cnt===0?{lum:0.5,alpha:0}:{lum:lumSum/cnt,alpha:alphaSum/cnt};
}
function sampleHSL(rend,ptX,ptY,probW,probH){
    const{reader}=rend,{rx0,ry0,rx1,ry1,maxX,maxY}=probeRect(rend,ptX,ptY,probW,probH);
    const stepX=Math.max(1,Math.ceil((rx1-rx0)/10)),stepY=Math.max(1,Math.ceil((ry1-ry0)/10));
    let sinSum=0,cosSum=0,sSum=0,lSum=0,cnt=0;
    for(let py=ry0;py<=ry1;py+=stepY)for(let px=rx0;px<=rx1;px+=stepX){if(px<0||py<0||px>maxX||py>maxY)continue;const p=reader.readPixel(px,py);if(p.alpha===0)continue;const hsl=rgbToHsl(p.r/255,p.g/255,p.b/255);const ang=hsl.h*2*Math.PI;sinSum+=Math.sin(ang);cosSum+=Math.cos(ang);sSum+=hsl.s;lSum+=hsl.l;cnt++;}
    if(cnt===0)return{h:0,s:0,l:0.5};let h=Math.atan2(sinSum/cnt,cosSum/cnt)/(2*Math.PI);if(h<0)h+=1;return{h,s:sSum/cnt,l:lSum/cnt};
}
function applySampledColour(dupNode,hsl){ try{const col=Colour.createHSLAf({h:hsl.h,s:hsl.s,l:hsl.l,alpha:1.0});dupNode.brushFillDescriptor=FillDescriptor.createSolid(SolidFill.create(col));}catch(e){} }
function getAlphaAt(rend,sx,sy){
    const{reader,bm,bbSpread}=rend;
    const px=Math.round((sx-bbSpread.x)/bbSpread.width*bm.width),py=Math.round((sy-bbSpread.y)/bbSpread.height*bm.height);
    if(px<0||py<0||px>=bm.width||py>=bm.height)return 0;
    try{return reader.readPixel(px,py).alpha/255;}catch(e){return 0;}
}
function isInsideFormAlpha(rend,dup){ const bb=getBB(dup); if(!bb)return false; return getAlphaAt(rend,bb.x+bb.width/2,bb.y+bb.height/2)>0; }

function applyTargetGradientToNode(dupNode){
    if(TARGET_FILL_TYPE!==3)return;
    try{ const dupFD=dupNode.brushFillDescriptor; if(!dupFD||dupFD.fill.fillType.value!==3)return;
        const ts=TARGET_FD.fill.gradient.stops; if(!ts||ts.length===0)return;
        const ns=ts.map(s=>({colour:new Colour(s.colour),position:s.position,midpoint:s.midpoint!==undefined?s.midpoint:0.5,smoothness:s.smoothness!==undefined?s.smoothness:0}));
        const newGradFill=dupFD.fill.cloneWithNewGradient(Gradient.create(ns));
        const newFD=FillDescriptor.create(newGradFill,dupFD.isScaleWithObject,dupFD.transform,dupFD.blendMode,dupFD.isAnchoredToSpread);
        dupNode.brushFillDescriptor=newFD;
    }catch(e){console.log('Gradient transfer: '+e);}
}

// ── Grid generators ──────────────────────────────────────────
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

function nextGroupIndex(){let max=0;for(const l of doc.layers.all){const m=(l.userDescription||'').match(/^ShapeFill_(\d+)$/);if(m)max=Math.max(max,parseInt(m[1]));}return max+1;}
function deleteGroupFully(grp){if(!grp)return;try{const ch=[];for(const c of grp.children)ch.push(c);for(const c of ch){try{c.delete();}catch(e){}}grp.delete();}catch(e){}}

// ── Dialog ───────────────────────────────────────────────────
function buildDialog(){
    const dlg=Dialog.create('Object Fill');
    dlg.initialWidth=1300;
    dlg.setIsResizable(true);

    const c1=dlg.addColumn(); c1.widthProportion=1.2;
    const gI=c1.addGroup('Target object');
    gI.addStaticText('',
        (targetNode.userDescription||targetNode.defaultDescription||'Object')+
        '  Fill obj: '+fillNodes.length+'  Buffer: '+fillMargin+'px'+
        (focusPoint.valid?'  FP✓':'')+(!hasVariableFill?'  Solid':''));

    const gG=c1.addGroup('Grid');
    const edCop=gG.addUnitValueEditor('Copies/point','none','none',null,1,50); edCop.value=1;
    const cbGT=gG.addComboBox('Grid type',[
        'Equilateral triangle','Square','Rectangle (BB-prop.)','Pentagonal','Hexagonal',
        '── Radial ──','Circles (concentric)','Spiral ↻ (right)','Spiral ↺ (left)',
        'Phyllotaxis (golden angle)']);
    cbGT.selectedIndex=1;
    const edCS=gG.addUnitValueEditor('Grid size (px)','none','none',null,1,10000); edCS.value=100;
    const edGRot=gG.addUnitValueEditor('Grid rotation (°)','none','none',null,-180,180); edGRot.value=0;

    const gR=c1.addGroup('Radial parameters');
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
    const edRingOffset=gR.addUnitValueEditor('Ring offset (% segment)','none','none',null,0,200); edRingOffset.value=0;
    const cbOffsetMode=gR.addComboBox('Offset mode',['Continuous','Alternating']); cbOffsetMode.selectedIndex=0;
    gR.addStaticText('','Offset only when Proportional is OFF.');
    const edArcSpacing=gR.addUnitValueEditor('Arc spacing (% fill obj. diag.)','none','none',null,10,500); edArcSpacing.value=100;

    const c2=dlg.addColumn(); c2.widthProportion=1.0;

    const gJ=c2.addGroup('Jitter — rotation');
    const edRot=gJ.addUnitValueEditor('Max. angle (±°)','none','none',null,0,360); edRot.value=0;

    const gJS=c2.addGroup('Jitter — size');
    const edSXMin=gJS.addUnitValueEditor('Min. X (%)','none','none',null,-100,500); edSXMin.value=0;
    const edSXMax=gJS.addUnitValueEditor('Max. X (%)','none','none',null,-100,500); edSXMax.value=0;
    const edSYMin=gJS.addUnitValueEditor('Min. Y (%)','none','none',null,-100,500); edSYMin.value=0;
    const edSYMax=gJS.addUnitValueEditor('Max. Y (%)','none','none',null,-100,500); edSYMax.value=0;
    const cbAspect=gJS.addCheckBox('Keep aspect ratio',true);

    const gJO=c2.addGroup('Jitter — opacity');
    const edOpMin=gJO.addUnitValueEditor('Min. opacity (%)','none','none',null,0,100); edOpMin.value=100;
    const edOpMax=gJO.addUnitValueEditor('Max. opacity (%)','none','none',null,0,100); edOpMax.value=100;

    const gJP=c2.addGroup('Jitter — position');
    const edPX=gJP.addUnitValueEditor('Pos. X (‰ target)','none','none',null,0,2000); edPX.value=0;
    const edPY=gJP.addUnitValueEditor('Pos. Y (‰ target)','none','none',null,0,2000); edPY.value=0;

    const gSel=c2.addGroup('Object selection');
    const cbRandom=gSel.addCheckBox('Random selection',false);
    const edSeed=gSel.addUnitValueEditor('Seed (0=time)','none','none',null,0,99999); edSeed.value=0;

    const c3=dlg.addColumn(); c3.widthProportion=1.2;

    const gB=c3.addGroup('Size by brightness');
    gB.addStaticText('','Size=scLum×alpha^n (gradient/bitmap only)');
    const cbBr=gB.addCheckBox('Enable',false);
    const edB0=gB.addUnitValueEditor('Size at black (%)','none','none',null,0,500); edB0.value=100;
    const edB100=gB.addUnitValueEditor('Size at white (%)','none','none',null,0,500); edB100.value=30;
    const edAlphaExp=gB.addUnitValueEditor('Edge sharpness (exponent n)','none','none',null,0.1,10); edAlphaExp.value=1;

    const gC3=c3.addGroup('Opacity by brightness');
    gC3.addStaticText('','Light→transparent, dark→opaque');
    const cbOpBr=gC3.addCheckBox('Enable',false);
    const edOpBrDark=gC3.addUnitValueEditor('Opacity at black (%)','none','none',null,0,100); edOpBrDark.value=100;
    const edOpBrLight=gC3.addUnitValueEditor('Opacity at white (%)','none','none',null,0,100); edOpBrLight.value=30;

    const gFC=c3.addGroup('Transfer colour fill');
    gFC.addStaticText('','HSL sample from target (bitmaps too)');
    const cbColor=gFC.addCheckBox('Transfer colour fill',false);

    const gRS=c3.addGroup('Radius scaling (radial)');
    gRS.addStaticText('','Scaling inside→outside (radial only)');
    const edRSInner=gRS.addUnitValueEditor('Size inside (%)','none','none',null,0,500); edRSInner.value=100;
    const edRSOuter=gRS.addUnitValueEditor('Size outside (%)','none','none',null,0,500); edRSOuter.value=100;

    const gDS=c3.addGroup('Size by distance (radial)');
    gDS.addStaticText('','Analytic from radius (radial only)');
    const cbDist=gDS.addCheckBox('Enable',false);
    const edDSCenter=gDS.addUnitValueEditor('Size at centre (%)','none','none',null,0,500); edDSCenter.value=100;
    const edDSEdge=gDS.addUnitValueEditor('Size at edge (%)','none','none',null,0,500); edDSEdge.value=30;

    const c4=dlg.addColumn(); c4.widthProportion=1.35;

    const gFG=c4.addGroup('Gradient');
    gFG.addStaticText('','Transfer the target\'s gradient stops');
    const cbGrad=gFG.addCheckBox('Use gradient',false);

    const gSort=c4.addGroup('Sorting');
    gSort.addStaticText('','Sort layer order by size');
    const cbSort=gSort.addCheckBox('Sort by size',false);
    const cbSortDir=gSort.addComboBox('Order',['Small at bottom, large on top','Large at bottom, small on top']);
    cbSortDir.selectedIndex=0;

    const gOut=c4.addGroup('Delete outside');
    const cbTestMode=gOut.addComboBox('Test method',['Alpha channel (default)','Exact path test']);
    cbTestMode.selectedIndex=0;
    gOut.addStaticText('','Alpha: bitmaps too. Path: vectors only.');
    const cbDel=gOut.addCheckBox('Delete outside',true);

    const gPrev=c4.addGroup('Preview mode');
    gPrev.addStaticText('','Grid points only, as red duplicates');
    const cbQuickPrev=gPrev.addCheckBox('Quick preview',false);

    const gAct=c4.addGroup('Action');
    const btnPreview=gAct.addButton('Preview');

    const gPresetBtn=c4.addGroup('Preset');
    const btnSave=gPresetBtn.addButton('Save');
    const btnLoad=gPresetBtn.addButton('Load');
    const btnDelete=gPresetBtn.addButton('Delete');

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
        }catch(e){app.alert('Error while saving:\n'+e.message,'Object Fill');}
    }
    function loadPreset(){
        try{
            getPresetDir();
            const path=app.chooseFile();if(!path)return false;
            let buf;try{buf=File.readAll(path);}catch(e){app.alert('File not readable.','Object Fill');return false;}
            applyParams(JSON.parse(buf.toString('utf8')));return true;
        }catch(e){app.alert('Error while loading:\n'+e.message,'Object Fill');return false;}
    }
    function deletePreset(){
        try{
            getPresetDir();
            const path=app.chooseFile();if(!path)return;
            if(!/\.json$/i.test(path)){app.alert('Only .json preset files can be deleted.','Object Fill');return;}
            FileSystemApi.remove(path);
            app.alert('Preset deleted:\n'+path,'Object Fill');
        }catch(e){app.alert('Error while deleting:\n'+e.message,'Object Fill');}
    }

    // v33: preview state incl. settings and kind (quick preview yes/no)
    let previewGroup=null,previewKey=null,previewWasQuick=false;
    function cleanupPreview(){ if(previewGroup){ deleteGroupFully(previewGroup); } previewGroup=null; previewKey=null; previewWasQuick=false; }
    function keyOf(p){ const q=Object.assign({},p); delete q.quickPreview; return JSON.stringify(q); }
    btnPreview.setOnClickHandler(()=>{
        cleanupPreview();
        const p=readParams();
        previewGroup=performFill(p);
        if(previewGroup){ previewKey=keyOf(p); previewWasQuick=!!p.quickPreview; }
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

// ── Core ─────────────────────────────────────────────────────
function performFill(params){
    const targetBB=getBB(targetNode); if(!targetBB)return null;
    const fillBB=getBB(fillNodes[0]);
    const isRadial=params.gridType>=6;
    let pts=[];

    if(params.quickPreview){
        return performQuickPreview(params,targetBB,fillBB,isRadial);
    }

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
            const nTotal=Math.max(10,Math.min(5000,Math.round(area/fillArea*params.copies)));
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
        const rotMargin=Math.abs(params.gridRot)>0.0001?Math.ceil(diag(targetBB)/2):0;
        const totalMargin=rotMargin+fillMargin;
        switch(params.gridType){
            case 0:pts=gridTriangle(targetBB,params.cellSize,totalMargin);break;
            case 2:pts=gridRectBB(targetBB,fillBB,params.cellSize,totalMargin);break;
            case 3:pts=gridPentagonal(targetBB,params.cellSize,totalMargin);break;
            case 4:pts=gridHexagonal(targetBB,params.cellSize,totalMargin);break;
            default:pts=gridSquare(targetBB,params.cellSize,totalMargin);
        }
        if(Math.abs(params.gridRot)>0.0001)
            pts=pts.map(p=>{const r=rotatePt(p.x,p.y,pivotX,pivotY,cosA,sinA);return{x:r.x,y:r.y,angle:null,normR:0};});
        if(params.deleteOutside)
            pts=pts.filter(p=>p.x>=targetBB.x&&p.x<=targetBB.x+targetBB.width&&p.y>=targetBB.y&&p.y<=targetBB.y+targetBB.height);
    }

    const needsRenderer=params.useBr||params.deleteOutside&&params.outsideTestMode===0||params.useColor||params.useOpBr;
    let rend=null;
    if(needsRenderer){rend=buildRenderer();if(!rend)console.log('Renderer n/a');}

    const prng = params.randomSelect ? makePRNG(params.seed===0?Date.now():params.seed) : null;
    let fillIdxArr=null;
    if(prng){
        fillIdxArr=pts.map((_,pi)=>{ const n=fillNodes.length; const arr=[...Array(n).keys()]; for(let i=n-1;i>0;i--){const j=Math.floor(prng()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];} return arr; });
    }

    const grpName='ShapeFill_'+nextGroupIndex();
    const grpDef=ContainerNodeDefinition.create(grpName);
    const grpB2=AddChildNodesCommandBuilder.create();
    grpB2.addContainerNode(grpDef);
    const grpCmd=grpB2.createCommand(false);
    doc.executeCommand(grpCmd);
    const fillGroup=grpCmd.newNodes[0];
    if(!fillGroup){if(rend)rend.reader.dispose();return null;}

    let fillIdx=0,placed=0,deleted=0;
    const placedNodes=[];

    for(let pi=0;pi<pts.length;pi++){
        const pt=pts[pi];
        for(let copy=0;copy<params.copies;copy++){
            try{
                let srcIdx;
                if(prng&&fillIdxArr){ srcIdx=fillIdxArr[pi][(fillIdx)%fillNodes.length]; }
                else{ srcIdx=fillIdx%fillNodes.length; }
                fillIdx++;
                const src=fillNodes[srcIdx];

                const dupCmd=DocumentCommand.createTransform(Selection.create(doc,[src]),null,{duplicateNodes:true});
                doc.executeCommand(dupCmd);
                const dup=dupCmd.newNodes[0];if(!dup)continue;
                const dupSel=Selection.create(doc,[dup]);
                let bb=getBB(dup);if(!bb){try{dup.delete();}catch(e){}continue;}
                let dupDeleted=false;

                if(params.useGrad&&!dupDeleted)applyTargetGradientToNode(dup);
                if(params.useColor&&rend&&!dupDeleted){bb=getBB(dup)||bb;if(bb)applySampledColour(dup,sampleHSL(rend,pt.x,pt.y,bb.width*0.20,bb.height*0.20));}

                if(isRadial&&params.alignToPath&&pt.angle!==null&&!dupDeleted){
                    bb=getBB(dup)||bb;if(bb){const cx=bb.x+bb.width/2,cy=bb.y+bb.height/2;
                        doc.executeCommand(DocumentCommand.createTransform(dupSel,Transform.createTranslate(cx,cy).multiply(Transform.createRotate(pt.angle)).multiply(Transform.createTranslate(-cx,-cy))));bb=getBB(dup)||bb;}
                }

                if(params.jRot>0&&!dupDeleted){bb=getBB(dup)||bb;if(bb){const ang=randBetween(-params.jRot,params.jRot)*Math.PI/180,cx=bb.x+bb.width/2,cy=bb.y+bb.height/2;
                    doc.executeCommand(DocumentCommand.createTransform(dupSel,Transform.createTranslate(cx,cy).multiply(Transform.createRotate(ang)).multiply(Transform.createTranslate(-cx,-cy))));bb=getBB(dup)||bb;}}

                if(!dupDeleted){const hsSJ=params.jSXMin!==0||params.jSXMax!==0||params.jSYMin!==0||params.jSYMax!==0;
                    if(hsSJ){const sxPct=randBetween(params.jSXMin,params.jSXMax),syPct=params.keepAspect?sxPct:randBetween(params.jSYMin,params.jSYMax);
                        const sx=1+sxPct/100,sy=1+syPct/100;if(Math.abs(sx-1)>0.0001||Math.abs(sy-1)>0.0001){
                            bb=getBB(dup)||bb;if(bb){const cx=bb.x+bb.width/2,cy=bb.y+bb.height/2;
                                doc.executeCommand(DocumentCommand.createTransform(dupSel,Transform.createTranslate(cx,cy).multiply(Transform.createScale(sx,sy)).multiply(Transform.createTranslate(-cx,-cy))));bb=getBB(dup)||bb;}}}}

                if(isRadial&&(params.radScaleInner!==100||params.radScaleOuter!==100)&&!dupDeleted){
                    const scR=clamp((params.radScaleInner+(params.radScaleOuter-params.radScaleInner)*pt.normR)/100,0.001,50);
                    if(Math.abs(scR-1)>0.001){bb=getBB(dup)||bb;if(bb){const cx=bb.x+bb.width/2,cy=bb.y+bb.height/2;
                        doc.executeCommand(DocumentCommand.createTransform(dupSel,Transform.createTranslate(cx,cy).multiply(Transform.createScale(scR,scR)).multiply(Transform.createTranslate(-cx,-cy))));bb=getBB(dup)||bb;}}
                }

                if(isRadial&&params.useDist&&!dupDeleted){
                    const scD=clamp((params.distCenter+(params.distEdge-params.distCenter)*pt.normR)/100,0.001,50);
                    if(Math.abs(scD-1)>0.001){bb=getBB(dup)||bb;if(bb){const cx=bb.x+bb.width/2,cy=bb.y+bb.height/2;
                        doc.executeCommand(DocumentCommand.createTransform(dupSel,Transform.createTranslate(cx,cy).multiply(Transform.createScale(scD,scD)).multiply(Transform.createTranslate(-cx,-cy))));bb=getBB(dup)||bb;}}
                }

                if(params.useBr&&rend&&!dupDeleted){
                    bb=getBB(dup)||bb;if(bb){
                        const{lum,alpha}=sampleBrightnessAndAlpha(rend,pt.x,pt.y,bb.width*0.20,bb.height*0.20);
                        const scLum=clamp((params.bAt0+(params.bAt100-params.bAt0)*lum)/100,0.001,50);
                        const sc=scLum*Math.pow(alpha,params.alphaExp);
                        if(sc<0.005){try{dup.delete();}catch(e){}dupDeleted=true;deleted++;}
                        else if(Math.abs(sc-1)>0.001){const cx=bb.x+bb.width/2,cy=bb.y+bb.height/2;
                            doc.executeCommand(DocumentCommand.createTransform(dupSel,Transform.createTranslate(cx,cy).multiply(Transform.createScale(sc,sc)).multiply(Transform.createTranslate(-cx,-cy))));bb=getBB(dup)||bb;}
                    }
                }
                if(dupDeleted)continue;

                bb=getBB(dup)||bb;if(!bb)continue;
                let tx=pt.x-(bb.x+bb.width/2),ty=pt.y-(bb.y+bb.height/2);
                if(params.jPX>0)tx+=randBetween(-targetBB.width*params.jPX/1000,targetBB.width*params.jPX/1000);
                if(params.jPY>0)ty+=randBetween(-targetBB.height*params.jPY/1000,targetBB.height*params.jPY/1000);
                if(Math.abs(tx)>0.001||Math.abs(ty)>0.001)
                    doc.executeCommand(DocumentCommand.createTransform(dupSel,Transform.createTranslate(tx,ty)));

                if((params.jOpMin!==100||params.jOpMax!==100)&&!dupDeleted){
                    const op=clamp(randBetween(params.jOpMin,params.jOpMax)/100,0,1);
                    try{doc.executeCommand(DocumentCommand.createSetOpacity(dupSel,op));}catch(e){}
                }

                if(params.useOpBr&&rend&&!dupDeleted){
                    bb=getBB(dup)||bb;if(bb){
                        const{lum}=sampleBrightnessAndAlpha(rend,pt.x,pt.y,bb.width*0.20,bb.height*0.20);
                        const op=clamp((params.opBrDark+(params.opBrLight-params.opBrDark)*lum)/100,0,1);
                        try{doc.executeCommand(DocumentCommand.createSetOpacity(dupSel,op));}catch(e){}
                    }
                }

                if(params.deleteOutside&&!dupDeleted){
                    let outside=false;
                    if(params.outsideTestMode===1){
                        bb=getBB(dup)||bb;if(bb){const cx=bb.x+bb.width/2,cy=bb.y+bb.height/2;const r=isInsideFormExact(cx,cy);if(r===null&&rend)outside=!isInsideFormAlpha(rend,dup);else outside=r===false;}
                    } else {
                        if(rend)outside=!isInsideFormAlpha(rend,dup);
                    }
                    if(outside){try{dup.delete();}catch(e){}deleted++;continue;}
                }

                doc.executeCommand(DocumentCommand.createMoveNodes(dupSel,fillGroup,NodeMoveType.Inside,NodeChildType.Main));
                placedNodes.push(dup);
                placed++;
            }catch(err){console.log('Duplicate error: '+err);}
        }
    }

    if(params.sortBySize&&placedNodes.length>1){
        try{
            const sized=placedNodes.map(n=>{const bb=getBB(n);return{n,area:bb?(bb.width*bb.height):0};});
            sized.sort((a,b)=>params.sortDir===0?a.area-b.area:b.area-a.area);
            for(let i=1;i<sized.length;i++){
                doc.executeCommand(DocumentCommand.createMoveNodes(sized[i].n.selfSelection,sized[i-1].n,NodeMoveType.After,NodeChildType.Main));
            }
        }catch(e){console.log('Sorting: '+e);}
    }

    if(rend){try{rend.reader.dispose();}catch(e){}}
    console.log('Object Fill v33: '+placed+' placed, '+deleted+' deleted → "'+grpName+'"');

    try{
        doc.executeCommand(DocumentCommand.createMoveNodes(fillGroup.selfSelection,targetNode,NodeMoveType.Inside,NodeChildType.Main));
    }catch(e){console.log('Embedding: '+e);}
    return fillGroup;
}

function performQuickPreview(params,targetBB,fillBB,isRadial){
    let pts=[];
    const dotSize=Math.max(4,Math.min(20,maxFillDiag*0.1));

    if(isRadial){
        let cx=targetBB.x+targetBB.width/2,cy=targetBB.y+targetBB.height/2;
        if(params.radCenter===1&&focusPoint.valid){cx=focusPoint.x;cy=focusPoint.y;}
        const rEnd=calcREnd(cx,cy,targetBB);
        const rStart=Math.min(params.rStart,rEnd-1);
        if(params.gridType===6) pts=gridCircles(cx,cy,rStart,rEnd,params.numRings,params.ptsOuter,params.propScale,params.ringOffsetPct,params.ringOffsetMode);
        else if(params.gridType===9){const area=Math.PI*rEnd*rEnd,fillArea=(fillBB?fillBB.width*fillBB.height:10000)||10000;pts=gridPhyllotaxis(cx,cy,rStart,rEnd,Math.max(10,Math.min(2000,Math.round(area/fillArea))));}
        else{const dir=params.gridType===8?-1:1;pts=gridSpiral(cx,cy,rStart,rEnd,params.numRings,Math.max(1,params.arcSpacingPct/100*maxFillDiag),dir);}
        if(Math.abs(params.gridRot)>0.0001){const ar=params.gridRot*Math.PI/180,cosA=Math.cos(ar),sinA=Math.sin(ar);pts=pts.map(p=>{const rp=rotatePt(p.x,p.y,cx,cy,cosA,sinA);return{...p,x:rp.x,y:rp.y};});}
    } else {
        const totalMargin=fillMargin;
        switch(params.gridType){case 0:pts=gridTriangle(targetBB,params.cellSize,totalMargin);break;case 2:pts=gridRectBB(targetBB,fillBB,params.cellSize,totalMargin);break;case 3:pts=gridPentagonal(targetBB,params.cellSize,totalMargin);break;case 4:pts=gridHexagonal(targetBB,params.cellSize,totalMargin);break;default:pts=gridSquare(targetBB,params.cellSize,totalMargin);}
        if(params.deleteOutside)pts=pts.filter(p=>p.x>=targetBB.x&&p.x<=targetBB.x+targetBB.width&&p.y>=targetBB.y&&p.y<=targetBB.y+targetBB.height);
    }

    const grpName='ShapeFill_'+nextGroupIndex();
    const grpDef=ContainerNodeDefinition.create(grpName);
    const grpB2=AddChildNodesCommandBuilder.create();
    grpB2.addContainerNode(grpDef);
    const grpCmd=grpB2.createCommand(false);
    doc.executeCommand(grpCmd);
    const fillGroup=grpCmd.newNodes[0];
    if(!fillGroup)return null;

    const src=fillNodes[0];
    let placed=0;

    for(const pt of pts){
        try{
            const dupCmd=DocumentCommand.createTransform(Selection.create(doc,[src]),null,{duplicateNodes:true});
            doc.executeCommand(dupCmd);
            const dup=dupCmd.newNodes[0];if(!dup)continue;
            const dupSel=Selection.create(doc,[dup]);
            let bb=getBB(dup);if(!bb){try{dup.delete();}catch(e){}continue;}

            const cx0=bb.x+bb.width/2,cy0=bb.y+bb.height/2;
            const scX=bb.width>0.001?dotSize/bb.width:1,scY=bb.height>0.001?dotSize/bb.height:1;
            if(Math.abs(scX-1)>0.0001||Math.abs(scY-1)>0.0001)
                doc.executeCommand(DocumentCommand.createTransform(dupSel,Transform.createTranslate(cx0,cy0).multiply(Transform.createScale(scX,scY)).multiply(Transform.createTranslate(-cx0,-cy0))));
            bb=getBB(dup)||bb;

            const tx=pt.x-(bb.x+bb.width/2),ty=pt.y-(bb.y+bb.height/2);
            if(Math.abs(tx)>0.001||Math.abs(ty)>0.001)
                doc.executeCommand(DocumentCommand.createTransform(dupSel,Transform.createTranslate(tx,ty)));

            try{
                const col=Colour.createRGBAf({r:1,g:0.2,b:0.2,alpha:0.7});
                dup.brushFillDescriptor=FillDescriptor.createSolid(SolidFill.create(col));
            }catch(e){}

            doc.executeCommand(DocumentCommand.createMoveNodes(dupSel,fillGroup,NodeMoveType.Inside,NodeChildType.Main));
            placed++;
        }catch(err){console.log('Preview point error: '+err);}
    }

    console.log('Quick preview v33: '+placed+' points → "'+grpName+'"');
    try{doc.executeCommand(DocumentCommand.createMoveNodes(fillGroup.selfSelection,targetNode,NodeMoveType.Inside,NodeChildType.Main));}catch(e){}
    return fillGroup;
}

// ── Run dialog ───────────────────────────────────────────────
const dlgObj=buildDialog();
const result=dlgObj.dlg.runModal();
if(result&&result.value===DialogResult.Ok.value){
    // v33: keep the preview only if it is a full fill with the same settings;
    // otherwise delete and recalculate (never as a quick preview).
    const p=dlgObj.readParams();
    p.quickPreview=false;
    if(!dlgObj.isReusablePreview(p)){
        dlgObj.cleanupPreview();
        performFill(p);
    }
}else{
    dlgObj.cleanupPreview();
}

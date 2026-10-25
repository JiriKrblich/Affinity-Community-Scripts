'use strict';
// ============================================================
//  Form on Path v45-EN
//  English GUI — identical logic to Form an Pfad v45
//  v45: Tab-based GUI (6 tabs) like objekte-transformieren-v8.
//       Left navigation column always visible (tabs, preview,
//       preset); right two content columns per tab:
//         1 Anchor Points   2 Angle & Sequence
//         3 Distance & Scaling   4 Colour
//         5 Cosine            6 Output & Preset
//  v44: dupSrc() single source duplicate; preview key;
//       app.alert params; File.create().
//  v43: composedSpreadTF for objects in transformed groups.
//  Output: PathObjects_N, AnchorPoints_N, Templates_N
// ============================================================
const { Document }        = require('/document');
const { DocumentCommand, AddChildNodesCommandBuilder, NodeMoveType, NodeChildType } = require('/commands');
const { Selection }       = require('/selections');
const { Transform }       = require('/geometry');
const { Colour }          = require('/colours');
const { FillDescriptor, FillType } = require('/fills');
const { Dialog, DialogResult }     = require('/dialog');
const { ShapeNodeDefinition, ContainerNodeDefinition } = require('/nodes');
const { ShapeEllipse } = require('/shapes');
const { app } = require('/application');
const { File, FileSystemApi } = require('/fs');
const { StoryDelta } = require('/storydelta');

const doc = Document.current;
if (!doc) throw new Error('No document');
const sel = doc.selection;
const selNodes = [];
for (let i = 0; i < sel.length; i++) selNodes.push(sel.at(i).node);

// ── Path detection ────────────────────────────────────────
const pathNodes  = [];
const shapeNodes = [];
for (const n of selNodes) {
    const isMutableCurve = n.curvesInterface && n.curvesInterface.isMutable;
    if (isMutableCurve) {
        const name = n.userDescription || n.defaultDescription || '';
        if (name.startsWith('_')) pathNodes.push(n);
        else shapeNodes.push(n);
    } else {
        shapeNodes.push(n);
    }
}
if (pathNodes.length === 0) {
    for (let i = 0; i < shapeNodes.length; i++) {
        const n = shapeNodes[i];
        if (n.curvesInterface && n.curvesInterface.isMutable) {
            pathNodes.push(n); shapeNodes.splice(i,1); break;
        }
    }
}
if (pathNodes.length === 0){ app.alert('No curve found.\nPlease select a mutable Bézier curve together with shapes.','Form on Path'); throw new Error(); }
if (shapeNodes.length === 0){ app.alert('No shapes found.','Form on Path'); throw new Error(); }

const origSel = doc.selection;

// ── Preset ────────────────────────────────────────────────
const PRESETS_DIR   = app.userDesktopPath + '/AffinityScriptPresets';
const PRESET_PREFIX = 'FamPfad_';
function ensurePresetsDir(){try{FileSystemApi.createDirectories(PRESETS_DIR);return true;}catch(e){return false;}}
function sanitizeName(name){return String(name||'').trim().replace(/[^a-zA-Z0-9 _\-äöüÄÖÜß]/g,'_').slice(0,80);}
function presetPath(name){return PRESETS_DIR+'/'+PRESET_PREFIX+sanitizeName(name)+'.json';}
function savePresetToDisk(name,data){try{ensurePresetsDir();const f=File.create(presetPath(name),'wb');f.writeStringAsUtf8(JSON.stringify(data,null,2));f.close();return true;}catch(e){return false;}}
function loadPresetFromPath(path){try{const buf=File.readAll(path);return JSON.parse(buf.toString('utf8'));}catch(e){return null;}}
function deletePresetAtPath(path){try{FileSystemApi.remove(path);return true;}catch(e){return false;}}

// ── composedSpreadTF ──────────────────────────────────────
function composedSpreadTF(node){
    const chain=[];
    let cur=node;
    while(cur){
        const tag=cur[Symbol.toStringTag]||'';
        if(tag==='SpreadNode'||tag==='DocumentNode')break;
        chain.push(cur.transform);
        cur=cur.parent;
    }
    return{
        applyToPoint(pt){let p=pt;for(let i=0;i<chain.length;i++)p=chain[i].applyToPoint(p);return p;},
        applyToVector(v){let r=v;for(let i=0;i<chain.length;i++){const tf=chain[i];r={x:tf.xAxis.x*r.x+tf.yAxis.x*r.y,y:tf.xAxis.y*r.x+tf.yAxis.y*r.y};}return r;}
    };
}

// ── Geometry ──────────────────────────────────────────────
function bzPtW(bz,t,tf){const mt=1-t;const lx=mt*mt*mt*bz.start.x+3*mt*mt*t*bz.c1.x+3*mt*t*t*bz.c2.x+t*t*t*bz.end.x;const ly=mt*mt*mt*bz.start.y+3*mt*mt*t*bz.c1.y+3*mt*t*t*bz.c2.y+t*t*t*bz.end.y;return tf.applyToPoint({x:lx,y:ly});}
function bzTanW(bz,t,tf){const mt=1-t;let tlx=3*(mt*mt*(bz.c1.x-bz.start.x)+2*mt*t*(bz.c2.x-bz.c1.x)+t*t*(bz.end.x-bz.c2.x));let tly=3*(mt*mt*(bz.c1.y-bz.start.y)+2*mt*t*(bz.c2.y-bz.c1.y)+t*t*(bz.end.y-bz.c2.y));if(Math.sqrt(tlx*tlx+tly*tly)<0.001){tlx=bz.end.x-bz.start.x;tly=bz.end.y-bz.start.y;}if(Math.sqrt(tlx*tlx+tly*tly)<0.001){tlx=1;tly=0;}const tw=tf.applyToVector({x:tlx,y:tly});const wl=Math.sqrt(tw.x*tw.x+tw.y*tw.y)||1;return{x:tw.x/wl,y:tw.y/wl};}
function buildArcTable(node){const tf=composedSpreadTF(node);const pc=node.curvesInterface.polyCurve;const bzArr=[];for(let ci=0;ci<pc.curveCount;ci++)for(const bz of pc.at(ci).beziers)bzArr.push(bz);if(!bzArr.length)return null;const table=[{arc:0,pt:bzPtW(bzArr[0],0,tf),tan:bzTanW(bzArr[0],0,tf),angle:0}];let totalLen=0;for(let bi=0;bi<bzArr.length;bi++)for(let s=1;s<=100;s++){const t=s/100,pt=bzPtW(bzArr[bi],t,tf),prev=table[table.length-1];const dx=pt.x-prev.pt.x,dy=pt.y-prev.pt.y;totalLen+=Math.sqrt(dx*dx+dy*dy);const tan=bzTanW(bzArr[bi],t,tf);table.push({arc:totalLen,pt,tan,angle:Math.atan2(tan.y,tan.x)});}return{table,totalLen};}
function sampleArc(d,s){const{table,totalLen}=d;s=Math.max(0,Math.min(totalLen,s));let lo=0,hi=table.length-1;while(hi-lo>1){const mid=(lo+hi)>>1;if(table[mid].arc<=s)lo=mid;else hi=mid;}const a=table[lo],b=table[hi],sp=b.arc-a.arc;if(sp<0.0001)return{x:a.pt.x,y:a.pt.y,angle:a.angle};const f=(s-a.arc)/sp;return{x:a.pt.x+f*(b.pt.x-a.pt.x),y:a.pt.y+f*(b.pt.y-a.pt.y),angle:a.angle+f*(b.angle-a.angle)};}
function angleDiff(a,b){let d=b-a;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;return Math.abs(d);}
function buildCurvatureSampler(arcData){const{table}=arcData,n=table.length;const kappa=new Array(n).fill(0);for(let i=1;i<n-1;i++){const da=angleDiff(table[i-1].angle,table[i+1].angle);const ds=table[i+1].arc-table[i-1].arc;kappa[i]=ds>0.001?Math.min(da/ds,0.5):0;}kappa[0]=kappa[1];kappa[n-1]=kappa[n-2];return kappa;}
function makeWeightedCDF(arcData,kappa,strength){const{table}=arcData,n=table.length;let total=0;const w=new Array(n);for(let i=0;i<n;i++){w[i]=1+strength*kappa[i];total+=w[i];}const cdf=new Array(n);let cum=0;for(let i=0;i<n;i++){cum+=w[i]/total;cdf[i]=cum;}return cdf;}
function cdfToArc(cdf,arcData,tNorm){const{table}=arcData;tNorm=Math.max(0,Math.min(1,tNorm));let lo=0,hi=cdf.length-1;while(hi-lo>1){const mid=(lo+hi)>>1;if(cdf[mid]<=tNorm)lo=mid;else hi=mid;}const a=lo>0?cdf[lo-1]:0,b=cdf[lo];const f=b>a?(tNorm-a)/(b-a):0;const idx=Math.min(lo+f,table.length-1);const idxLo=Math.floor(idx),idxHi=Math.min(Math.ceil(idx),table.length-1);const ff=idx-idxLo;return table[idxLo].arc+ff*(table[idxHi].arc-table[idxLo].arc);}
function jitter(lo,hi){return(lo===0&&hi===0)?0:lo+Math.random()*(hi-lo);}
function buildKnotenList(node,skipLast){const tf=composedSpreadTF(node);const pc=node.curvesInterface.polyCurve;const knoten=[];for(let ci=0;ci<pc.curveCount;ci++){const curve=pc.at(ci),bzArr=[...curve.beziers];if(!bzArr.length)continue;for(let bi=0;bi<bzArr.length;bi++){const bz=bzArr[bi],pt=tf.applyToPoint(bz.start),tan=bzTanW(bz,0,tf);knoten.push({x:pt.x,y:pt.y,angle:Math.atan2(tan.y,tan.x)});}if(!curve.isClosed){const lb=bzArr[bzArr.length-1],pt=tf.applyToPoint(lb.end),tan=bzTanW(lb,1,tf);knoten.push({x:pt.x,y:pt.y,angle:Math.atan2(tan.y,tan.x)});}}if(skipLast&&knoten.length>1)knoten.pop();return knoten;}

// ── Text node detection ───────────────────────────────────
function isTextNode(node){const tag=node[Symbol.toStringTag]||'';return tag==='ArtTextNode'||tag==='FrameTextNode';}
function getFDFromNode(node,usePen){if(isTextNode(node)){const story=node.storyInterface?.story;if(!story||story.length===0)return null;const a=story.getGlyphAtts(0);return(usePen?a.penFill:a.brushFill)||null;}return usePen?node.penFillDescriptor:node.brushFillDescriptor;}
function setFDOnNode(node,fd,usePen){if(isTextNode(node)){const delta=usePen?StoryDelta.createPenFill(fd):StoryDelta.createBrushFill(fd);doc.executeCommand(DocumentCommand.createSetSelection(node.selfSelection));doc.formatText(delta,doc.selection,false);}else if(usePen){doc.executeCommand(DocumentCommand.createSetPenFill(node.selfSelection,fd));}else{doc.executeCommand(DocumentCommand.createSetBrushFill(node.selfSelection,fd));}}

// ── Colour ────────────────────────────────────────────────
function colToRgba(col){try{const c=col instanceof Colour?col:new Colour(col);const r=c.rgba8;return{r:r.r/255,g:r.g/255,b:r.b/255,a:r.alpha/255};}catch(e){return{r:0,g:0,b:0,a:1};}}
function colToHsla(col){try{const c=col instanceof Colour?col:new Colour(col);const h=c.hslaf;return{h:h.h,s:h.s,l:h.l,a:h.alpha};}catch(e){const r=colToRgba(col);return{h:0,s:0,l:r.r*0.299+r.g*0.587+r.b*0.114,a:r.a};}}
function lerpHue(h1,h2,t){let d=h2-h1;if(d>0.5)d-=1;if(d<-0.5)d+=1;return((h1+d*t)%1+1)%1;}
function lerpColRGB(ca,cb,t){const a=colToRgba(ca),b=colToRgba(cb);return Colour.createRGBAf({r:a.r+t*(b.r-a.r),g:a.g+t*(b.g-a.g),b:a.b+t*(b.b-a.b),alpha:a.a+t*(b.a-a.a)});}
function lerpColHSL(ca,cb,t){const a=colToHsla(ca),b=colToHsla(cb);return Colour.createHSLAf({h:lerpHue(a.h,b.h,t),s:a.s+t*(b.s-a.s),l:a.l+t*(b.l-a.l),alpha:a.a+t*(b.a-a.a)});}
function lerpFD(fdA,fdB,t,useRGB){if(!fdA||!fdB)return fdA||fdB;const getft=f=>f.fill?f.fill.fillType.value:f.fillType?.value;const ftA=getft(fdA),ftB=getft(fdB);const lerpCol=useRGB?lerpColRGB:lerpColHSL;const solidVal=FillType.Solid.value,gradVal=FillType.Gradient.value;if(ftA===solidVal&&ftB===solidVal){const cA=fdA.fill?fdA.fill.colour:fdA.colour,cB=fdB.fill?fdB.fill.colour:fdB.colour;return FillDescriptor.createSolid(lerpCol(cA,cB,t));}if(ftA===gradVal&&ftB===gradVal){const gA=fdA.fill?fdA.fill.gradient:fdA.gradient,gB=fdB.fill?fdB.fill.gradient:fdB.gradient;const n=Math.min(gA.stopCount,gB.stopCount);const stops=[];for(let i=0;i<n;i++){const sA=gA.getStop(i),sB=gB.getStop(i);stops.push({colour:lerpCol(sA.colour,sB.colour,t),position:sA.position+t*(sB.position-sA.position),midpoint:sA.midpoint+t*(sB.midpoint-sA.midpoint)});}if(fdA.fill)return FillDescriptor.create(fdA.fill.constructor.create(gA.constructor.create(stops),fdA.fill.gradientFillType),fdA.isScaleWithObject,fdA.transform,fdA.blendMode,fdA.isAnchoredToSpread);return FillDescriptor.create(fdA.constructor.create(gA.constructor.create(stops),fdA.gradientFillType),fdA.isScaleWithObject,fdA.transform,fdA.blendMode,fdA.isAnchoredToSpread);}return t<0.5?fdA:fdB;}
function applyColourBlendRecursive(dupNode,srcA,srcB,tPos,useRGB){if(dupNode.isGroupNode&&srcA.isGroupNode&&srcB.isGroupNode){const cD=[],cA=[],cB=[];for(const ch of dupNode.children)cD.push(ch);for(const ch of srcA.children)cA.push(ch);for(const ch of srcB.children)cB.push(ch);const n=Math.min(cD.length,cA.length,cB.length);for(let i=0;i<n;i++)applyColourBlendRecursive(cD[i],cA[i],cB[i],tPos,useRGB);}else{try{const fdA=getFDFromNode(srcA,false),fdB=getFDFromNode(srcB,false);if(fdA&&fdB){const fdN=lerpFD(fdA,fdB,tPos,useRGB);if(fdN)setFDOnNode(dupNode,fdN,false);}}catch(e){}try{const pA=getFDFromNode(srcA,true),pB=getFDFromNode(srcB,true);if(pA&&pB){const pN=lerpFD(pA,pB,tPos,useRGB);if(pN)setFDOnNode(dupNode,pN,true);}}catch(e){}}}
function rgba8ToHslaf(r,g,b,a){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b);let h=0,s=0;const l=(mx+mn)/2;if(mx!==mn){const d=mx-mn;s=l>0.5?d/(2-mx-mn):d/(mx+mn);switch(mx){case r:h=((g-b)/d+(g<b?6:0))/6;break;case g:h=((b-r)/d+2)/6;break;case b:h=((r-g)/d+4)/6;break;}}return{h,s,l,alpha:(a!=null?a:255)/255};}
function shiftColour(col,dH,dL,dS){let hsl;try{hsl=col instanceof Colour?col.hslaf:new Colour(col).hslaf;}catch(e){const r=colToRgba(col);hsl=rgba8ToHslaf(r.r*255,r.g*255,r.b*255,r.a*255);}return Colour.createHSLAf({h:((hsl.h+dH/360)%1+1)%1,s:Math.max(0,Math.min(1,hsl.s+dS/100)),l:Math.max(0,Math.min(1,hsl.l+dL/100)),alpha:hsl.alpha});}
function shiftFD(fd,dH,dL,dS){if(!fd)return fd;const getft=f=>f.fill?f.fill.fillType.value:f.fillType?.value;const ft=getft(fd);if(ft===FillType.None.value)return fd;if(ft===FillType.Solid.value){const col=fd.fill?fd.fill.colour:fd.colour;return FillDescriptor.createSolid(shiftColour(col,dH,dL,dS));}if(ft===FillType.Gradient.value){const g=fd.fill?fd.fill.gradient:fd.gradient;const stops=[];for(let i=0;i<g.stopCount;i++){const st=g.getStop(i);stops.push({colour:shiftColour(st.colour,dH,dL,dS),position:st.position,midpoint:st.midpoint});}if(fd.fill)return FillDescriptor.create(fd.fill.constructor.create(g.constructor.create(stops),fd.fill.gradientFillType),fd.isScaleWithObject,fd.transform,fd.blendMode,fd.isAnchoredToSpread);return FillDescriptor.create(fd.constructor.create(g.constructor.create(stops),fd.gradientFillType),fd.isScaleWithObject,fd.transform,fd.blendMode,fd.isAnchoredToSpread);}return fd;}
function applyHSLrecursive(node,dH,dL,dS){if(node.isGroupNode){for(const ch of node.children)applyHSLrecursive(ch,dH,dL,dS);}else{try{const fd=getFDFromNode(node,false);if(fd){const s=shiftFD(fd,dH,dL,dS);if(s)setFDOnNode(node,s,false);}}catch(e){}try{const pfd=getFDFromNode(node,true);if(pfd){const s=shiftFD(pfd,dH,dL,dS);if(s)setFDOnNode(node,s,true);}}catch(e){}}}

function objListIndex(objIdx,n,palindrom){if(n<=1)return 0;if(!palindrom)return objIdx%n;const period=2*n,pos=objIdx%period;return pos<n?pos:(2*n-1-pos);}
function getFPSpread(node){try{const fp=node.transformInterface.focalPoint;if(fp.isValid){const s=composedSpreadTF(node).applyToPoint(fp.point);return{x:s.x,y:s.y,valid:true};}}catch(e){}return{x:0,y:0,valid:false};}
function makeCB(group,label,defaultVal){const cb=group.addCheckBox(label,defaultVal);cb.setIsFullWidth(true);return cb;}
function cosScaleFactors(tanAngle,cosX,cosY,cosMult,cosOff,cosMin,cosMax,negMode,cosJl,cosJh){if(!cosX&&!cosY)return{sx:1,sy:1};const D2R=Math.PI/180;const mult=Math.max(0.001,cosMult);const c=Math.cos(tanAngle*mult+cosOff*D2R);const absC=Math.abs(c);const baseScale=cosMin/100+absC*(cosMax/100-cosMin/100);const jitVal=jitter(cosJl/100,cosJh/100);const scaleAbs=Math.max(0.001,baseScale+jitVal);const mirror=(c<0)&&(negMode===1);const sc=mirror?-scaleAbs:scaleAbs;return{sx:cosX?sc:1,sy:cosY?sc:1};}

let runIndex=1;
for(const l of doc.layers.all){const ud=l.userDescription||'';if(ud.startsWith('PathObjects_')){const n=parseInt(ud.split('_')[1]);if(!isNaN(n)&&n>=runIndex)runIndex=n+1;}}

const pathInfo = pathNodes.length>1 ? ' ('+pathNodes.length+' paths)' : '';

// ══════════════════════════════════════════════════════════
//  Tab-based Dialog
// ══════════════════════════════════════════════════════════
const dlg = Dialog.create('Form on Path'+pathInfo);
dlg.initialWidth = 820;
dlg.setIsResizable(true);

const cNav = dlg.addColumn(); cNav.widthProportion = 0.75;
const cA   = dlg.addColumn(); cA.widthProportion   = 1;
const cB   = dlg.addColumn(); cB.widthProportion   = 1;

// ── Tab system ────────────────────────────────────────────
const PAGES = [[], [], [], [], [], []];
function pageGroup(pageIdx, col, title){
    const g = col.addGroup(title);
    PAGES[pageIdx].push(g);
    return g;
}
let pagedOK = true;
function showPage(i){
    if(!pagedOK) return;
    try{
        for(let k=0;k<PAGES.length;k++)
            for(const g of PAGES[k]) g.isVisible = (k===i);
    } catch(e){
        pagedOK = false;
        try{ for(const pg of PAGES) for(const g of pg) g.isVisible = true; }catch(e2){}
    }
}

// ── Left navigation column (always visible) ───────────────
const gNav = cNav.addGroup('Tabs');
const rNav = gNav.addRadioGroup('', [
    '1  Anchor Points',
    '2  Angle & Sequence',
    '3  Distance & Scaling',
    '4  Colour',
    '5  Cosine',
    '6  Output & Preset',
], 0);

const gPv = cNav.addGroup('');
const btnPreview = gPv.addButton('▶  Preview');

const gPresetNav = cNav.addGroup('Preset');
const btnSavePreset   = gPresetNav.addButton('💾 Save…');
const btnLoadPreset   = gPresetNav.addButton('📂 Load…');
const btnDeletePreset = gPresetNav.addButton('🗑 Delete…');

const gInfoNav = cNav.addGroup('');
gInfoNav.addStaticText('', pathNodes.length+' path(s), '+shapeNodes.length+' shape(s)');

// ══════════════════════════════════════════════════════════
//  Tab 1 — Anchor Points
// ══════════════════════════════════════════════════════════
const gAP = pageGroup(0, cA, 'Anchor Points');
const eAnz = gAP.addUnitValueEditor('Count','',''); eAnz.value=shapeNodes.length;
const eOP  = gAP.addUnitValueEditor('Obj/Anchor','',''); eOP.value=1;
const eOP1 = gAP.addUnitValueEditor('Obj. AP 1 (0=same)','',''); eOP1.value=0;

const gAPOpt = pageGroup(0, cA, 'Options');
const cbKnoten  = makeCB(gAPOpt, 'On curve nodes', false);
const cbSkip    = makeCB(gAPOpt, 'Skip last AP', false);
const cbRnd     = makeCB(gAPOpt, 'Random order', false);
const cbReverse = makeCB(gAPOpt, 'Reverse distribution', false);

const gDist = pageGroup(0, cB, 'Distribution');
const eOS = gDist.addUnitValueEditor('Offset Start %','',''); eOS.value=0;
const eOE = gDist.addUnitValueEditor('Offset End %','','');   eOE.value=0;
const eEx = gDist.addUnitValueEditor('Exponent','','');        eEx.value=1;

const gDK = pageGroup(0, cB, 'Density by Curvature');
const cbKrümm = makeCB(gDK, 'Enable', false);
const eKrümmStärke = gDK.addUnitValueEditor('Strength','',''); eKrümmStärke.value=3;

const gMK = pageGroup(0, cB, 'Multiple Paths');
gMK.addStaticText('', '_Name = path, else shape');
const cbMKModus = gMK.addComboBox('Distribution', ['Divide evenly','Each path full'], 0);
const cbMKReset = makeCB(gMK, 'Reset per path', true);

// ══════════════════════════════════════════════════════════
//  Tab 2 — Angle & Sequence
// ══════════════════════════════════════════════════════════
const gAng = pageGroup(1, cA, 'Angle to Tangent (°)');
const eAS  = gAng.addUnitValueEditor('Static','','');          eAS.value=90;
const eAD  = gAng.addUnitValueEditor('Dyn. cumulative','',''); eAD.value=0;
const eAJl = gAng.addUnitValueEditor('Jitter low','','');      eAJl.value=0;
const eAJh = gAng.addUnitValueEditor('Jitter high','','');     eAJh.value=0;
const cbASeq = gAng.addComboBox('Angle sequence', ['Sequential','Mirrored Rotatable','Mirrored'], 0);

const gAlign = pageGroup(1, cA, 'Orientation');
const cbAlignToPath = makeCB(gAlign, 'Align to curve', true);
const cbFP = makeCB(gAlign, 'FP distance as base', false);

const gObjFolge = pageGroup(1, cB, 'Object Sequence');
const cbObjFolge = gObjFolge.addComboBox('Type', ['Sequential  1-2-3-1-2-3','Palindrome  1-2-3-3-2-1'], 0);

const gKreis = pageGroup(1, cB, 'Circle Arrangement per AP');
gKreis.addStaticText('', 'When Obj/Anchor > 1:');
const cbKreis = makeCB(gKreis, 'Arrange in circle', false);
const eKreisOffset = gKreis.addUnitValueEditor('Angle offset (°)','',''); eKreisOffset.value=0;

// ══════════════════════════════════════════════════════════
//  Tab 3 — Distance & Scaling
// ══════════════════════════════════════════════════════════
const gAbs = pageGroup(2, cA, 'Distance');
const eAbS  = gAbs.addUnitValueEditor('Static','','');      eAbS.value=0;
const eAbD  = gAbs.addUnitValueEditor('Dyn. cum. (%)','','');eAbD.value=0;
const eAbJl = gAbs.addUnitValueEditor('Jitter low','','');  eAbJl.value=0;
const eAbJh = gAbs.addUnitValueEditor('Jitter high','',''); eAbJh.value=0;
const cbAbstandProzent = makeCB(gAbs, 'Relative (% curve length)', false);

const gSc = pageGroup(2, cA, 'Scaling (%)');
const eScD  = gSc.addUnitValueEditor('Dyn. cumulative','',''); eScD.value=0;
const eScJl = gSc.addUnitValueEditor('Jitter low','','');      eScJl.value=0;
const eScJh = gSc.addUnitValueEditor('Jitter high','','');     eScJh.value=0;

const gScPos = pageGroup(2, cB, 'Position Scaling');
gScPos.addStaticText('', 'Start → End of curve:');
const eScStart = gScPos.addUnitValueEditor('Start (%)','',''); eScStart.value=100;
const eScEnd   = gScPos.addUnitValueEditor('End (%)','','');   eScEnd.value=100;

const gRot = pageGroup(2, cB, 'Own Rotation (°)');
const eRS  = gRot.addUnitValueEditor('Static','','');          eRS.value=0;
const eRD  = gRot.addUnitValueEditor('Dyn. cumulative','',''); eRD.value=0;
const eRJl = gRot.addUnitValueEditor('Jitter low','','');      eRJl.value=0;
const eRJh = gRot.addUnitValueEditor('Jitter high','','');     eRJh.value=0;

// ══════════════════════════════════════════════════════════
//  Tab 4 — Colour
// ══════════════════════════════════════════════════════════
const gFarbModus = pageGroup(3, cA, 'Colour Blend');
const cbFarbModus = gFarbModus.addComboBox('Mode', ['None','HSL-Delta (cumulative)','RGB  Start → End','HSL  Start → End'], 1);
gFarbModus.addStaticText('', 'Start→End: Shape 1=start, Shape 2=end');
gFarbModus.addStaticText('', 'tPos 0→1 · Text: fill+stroke supported');

const gH = pageGroup(3, cA, 'Hue H (°)  [HSL-Delta]');
const eHD  = gH.addUnitValueEditor('Dyn. cumulative','',''); eHD.value=0;
const eHJl = gH.addUnitValueEditor('Jitter low','','');      eHJl.value=0;
const eHJh = gH.addUnitValueEditor('Jitter high','','');     eHJh.value=0;

const gL = pageGroup(3, cB, 'Lightness L (%)');
const eLD  = gL.addUnitValueEditor('Dyn. cumulative','',''); eLD.value=0;
const eLJl = gL.addUnitValueEditor('Jitter low','','');      eLJl.value=0;
const eLJh = gL.addUnitValueEditor('Jitter high','','');     eLJh.value=0;

const gS = pageGroup(3, cB, 'Saturation S (%)');
const eSD  = gS.addUnitValueEditor('Dyn. cumulative','',''); eSD.value=0;
const eSJl = gS.addUnitValueEditor('Jitter low','','');      eSJl.value=0;
const eSJh = gS.addUnitValueEditor('Jitter high','','');     eSJh.value=0;

const gOp = pageGroup(3, cB, 'Opacity (%)');
const eOD  = gOp.addUnitValueEditor('Dyn. cumulative','',''); eOD.value=0;
const eOJl = gOp.addUnitValueEditor('Jitter low','','');      eOJl.value=0;
const eOJh = gOp.addUnitValueEditor('Jitter high','','');     eOJh.value=0;

// ══════════════════════════════════════════════════════════
//  Tab 5 — Cosine Scaling
// ══════════════════════════════════════════════════════════
const gCosAchsen = pageGroup(4, cA, 'Axes');
const cbCosX = makeCB(gCosAchsen, 'Width (X)', false);
const cbCosY = makeCB(gCosAchsen, 'Height (Y)', false);

const gCosP = pageGroup(4, cA, 'Parameters');
const eCosMult = gCosP.addUnitValueEditor('Multiplier','','');       eCosMult.value=1;
const eCosOff  = gCosP.addUnitValueEditor('Angle offset (°)','',''); eCosOff.value=0;
const eCosMin  = gCosP.addUnitValueEditor('Minimum (%)','','');       eCosMin.value=50;
const eCosMax  = gCosP.addUnitValueEditor('Maximum (%)','','');       eCosMax.value=100;

const gCosNeg = pageGroup(4, cB, 'Neg. Cosine');
const cbCosNegMode = gCosNeg.addComboBox('Mode', ['Absolute (no mirror)','Mirror'], 0);

const gCosJ = pageGroup(4, cB, 'Jitter (%)');
const eCosJl = gCosJ.addUnitValueEditor('Jitter low','','');  eCosJl.value=0;
const eCosJh = gCosJ.addUnitValueEditor('Jitter high','',''); eCosJh.value=0;

// ══════════════════════════════════════════════════════════
//  Tab 6 — Output & Preset
// ══════════════════════════════════════════════════════════
const gAusgabe = pageGroup(5, cA, 'Output');
const cbAPLöschen = makeCB(gAusgabe, 'Delete AP group on Apply', false);
const cbBasisGrp  = makeCB(gAusgabe, 'Move base objects to group', false);

const gPresetTab = pageGroup(5, cA, 'Preset (also in navigation column)');
gPresetTab.addStaticText('', '💾 📂 🗑  buttons on the left');

const gInfo6 = pageGroup(5, cB, 'Info');
gInfo6.addStaticText('', 'OK = Apply');
gInfo6.addStaticText('', 'Cancel = Discard');
gInfo6.addStaticText('', '▶ Preview = left in nav.');

// ── Show first tab ────────────────────────────────────────
showPage(0);
try{ rNav.setOnValueChangedHandler(()=>{ showPage(rNav.selectedIndex); }); }catch(e){}

// ── Preset collect/apply ──────────────────────────────────
function collectParams(){return{anzahl:eAnz.value,objPerPt:eOP.value,objAP1:eOP1.value,knoten:cbKnoten.value,skipLast:cbSkip.value,rnd:cbRnd.value,reverse:cbReverse.value,offsetStart:eOS.value,offsetEnde:eOE.value,exponent:eEx.value,krümm:cbKrümm.value,krümmStärke:eKrümmStärke.value,mkModus:cbMKModus.selectedIndex,mkReset:cbMKReset.value,apLöschen:cbAPLöschen.value,basisGrp:cbBasisGrp.value,winkelStat:eAS.value,winkelDyn:eAD.value,winkelJl:eAJl.value,winkelJh:eAJh.value,winkelSeq:cbASeq.selectedIndex,objFolge:cbObjFolge.selectedIndex,kreis:cbKreis.value,kreisOffset:eKreisOffset.value,abstandStat:eAbS.value,abstandDyn:eAbD.value,abstandJl:eAbJl.value,abstandJh:eAbJh.value,abstandProzent:cbAbstandProzent.value,fpAbstand:cbFP.value,skalDyn:eScD.value,skalJl:eScJl.value,skalJh:eScJh.value,scStart:eScStart.value,scEnd:eScEnd.value,rotStat:eRS.value,rotDyn:eRD.value,rotJl:eRJl.value,rotJh:eRJh.value,alignPath:cbAlignToPath.value,farbModus:cbFarbModus.selectedIndex,hDyn:eHD.value,hJl:eHJl.value,hJh:eHJh.value,lDyn:eLD.value,lJl:eLJl.value,lJh:eLJh.value,sDyn:eSD.value,sJl:eSJl.value,sJh:eSJh.value,opDyn:eOD.value,opJl:eOJl.value,opJh:eOJh.value,cosX:cbCosX.value,cosY:cbCosY.value,cosMult:eCosMult.value,cosOff:eCosOff.value,cosMin:eCosMin.value,cosMax:eCosMax.value,cosNegMode:cbCosNegMode.selectedIndex,cosJl:eCosJl.value,cosJh:eCosJh.value};}
function applyParams(p){if(p.anzahl!=null)eAnz.value=p.anzahl;if(p.objPerPt!=null)eOP.value=p.objPerPt;if(p.objAP1!=null)eOP1.value=p.objAP1;if(p.knoten!=null)cbKnoten.value=p.knoten;if(p.skipLast!=null)cbSkip.value=p.skipLast;if(p.rnd!=null)cbRnd.value=p.rnd;if(p.reverse!=null)cbReverse.value=p.reverse;if(p.offsetStart!=null)eOS.value=p.offsetStart;if(p.offsetEnde!=null)eOE.value=p.offsetEnde;if(p.exponent!=null)eEx.value=p.exponent;if(p.krümm!=null)cbKrümm.value=p.krümm;if(p.krümmStärke!=null)eKrümmStärke.value=p.krümmStärke;if(p.mkModus!=null)cbMKModus.selectedIndex=p.mkModus;if(p.mkReset!=null)cbMKReset.value=p.mkReset;if(p.apLöschen!=null)cbAPLöschen.value=p.apLöschen;if(p.basisGrp!=null)cbBasisGrp.value=p.basisGrp;if(p.winkelStat!=null)eAS.value=p.winkelStat;if(p.winkelDyn!=null)eAD.value=p.winkelDyn;if(p.winkelJl!=null)eAJl.value=p.winkelJl;if(p.winkelJh!=null)eAJh.value=p.winkelJh;if(p.winkelSeq!=null)cbASeq.selectedIndex=p.winkelSeq;if(p.objFolge!=null)cbObjFolge.selectedIndex=p.objFolge;if(p.kreis!=null)cbKreis.value=p.kreis;if(p.kreisOffset!=null)eKreisOffset.value=p.kreisOffset;if(p.abstandStat!=null)eAbS.value=p.abstandStat;if(p.abstandDyn!=null)eAbD.value=p.abstandDyn;if(p.abstandJl!=null)eAbJl.value=p.abstandJl;if(p.abstandJh!=null)eAbJh.value=p.abstandJh;if(p.abstandProzent!=null)cbAbstandProzent.value=p.abstandProzent;if(p.fpAbstand!=null)cbFP.value=p.fpAbstand;if(p.skalDyn!=null)eScD.value=p.skalDyn;if(p.skalJl!=null)eScJl.value=p.skalJl;if(p.skalJh!=null)eScJh.value=p.skalJh;if(p.scStart!=null)eScStart.value=p.scStart;if(p.scEnd!=null)eScEnd.value=p.scEnd;if(p.rotStat!=null)eRS.value=p.rotStat;if(p.rotDyn!=null)eRD.value=p.rotDyn;if(p.rotJl!=null)eRJl.value=p.rotJl;if(p.rotJh!=null)eRJh.value=p.rotJh;if(p.alignPath!=null)cbAlignToPath.value=p.alignPath;if(p.farbModus!=null)cbFarbModus.selectedIndex=p.farbModus;if(p.hDyn!=null)eHD.value=p.hDyn;if(p.hJl!=null)eHJl.value=p.hJl;if(p.hJh!=null)eHJh.value=p.hJh;if(p.lDyn!=null)eLD.value=p.lDyn;if(p.lJl!=null)eLJl.value=p.lJl;if(p.lJh!=null)eLJh.value=p.lJh;if(p.sDyn!=null)eSD.value=p.sDyn;if(p.sJl!=null)eSJl.value=p.sJl;if(p.sJh!=null)eSJh.value=p.sJh;if(p.opDyn!=null)eOD.value=p.opDyn;if(p.opJl!=null)eOJl.value=p.opJl;if(p.opJh!=null)eOJh.value=p.opJh;if(p.cosX!=null)cbCosX.value=p.cosX;if(p.cosY!=null)cbCosY.value=p.cosY;if(p.cosMult!=null)eCosMult.value=p.cosMult;if(p.cosOff!=null)eCosOff.value=p.cosOff;if(p.cosMin!=null)eCosMin.value=p.cosMin;if(p.cosMax!=null)eCosMax.value=p.cosMax;if(p.cosNegMode!=null)cbCosNegMode.selectedIndex=p.cosNegMode;if(p.cosJl!=null)eCosJl.value=p.cosJl;if(p.cosJh!=null)eCosJh.value=p.cosJh;}

btnSavePreset.setOnClickHandler(()=>{const name=app.prompt('Preset name:','Save preset','PathObjects_'+runIndex);if(!name||!name.trim())return;if(savePresetToDisk(name.trim(),collectParams())){app.alert('Saved:\n'+presetPath(name.trim()),'Form on Path');}else{app.alert('Error saving preset.','Form on Path');}});
btnLoadPreset.setOnClickHandler(()=>{const path=app.chooseFile();if(!path)return;const data=loadPresetFromPath(path);if(!data){app.alert('Could not load preset.','Form on Path');return;}applyParams(data);});
btnDeletePreset.setOnClickHandler(()=>{const path=app.chooseFile();if(!path)return;if(deletePresetAtPath(path)){app.alert('Deleted:\n'+path,'Form on Path');}else{app.alert('Error deleting preset.','Form on Path');}});

// ── Helpers ───────────────────────────────────────────────
function makeGroup(name){const b=AddChildNodesCommandBuilder.create();b.addContainerNode(ContainerNodeDefinition.createDefault());doc.executeCommand(b.createCommand());doc.executeCommand(DocumentCommand.createSetDescription(doc.selection,name));return doc.selection.at(0).node;}
function makeMaker(pt,idx){const r=5;const b=AddChildNodesCommandBuilder.create();b.addShapeNode(ShapeNodeDefinition.create(ShapeEllipse.create(),{x:pt.x-r,y:pt.y-r,width:r*2,height:r*2}));doc.executeCommand(b.createCommand());doc.executeCommand(DocumentCommand.createSetBrushFill(doc.selection,FillDescriptor.createSolid(Colour.createHSLAf({h:0,s:1,l:0.5,alpha:1}))));doc.executeCommand(DocumentCommand.createSetPenFill(doc.selection,FillDescriptor.createNone()));doc.executeCommand(DocumentCommand.createSetDescription(doc.selection,'AP_'+idx));}
function dupSrc(src){
    const cmd=DocumentCommand.createTransform(Selection.create(doc,[src]),null,{duplicateNodes:true});
    doc.executeCommand(cmd);
    let dup=null;
    try{dup=cmd.newNodes[0]||null;}catch(e){dup=null;}
    if(!dup)return null;
    doc.executeCommand(DocumentCommand.createSetSelection(Selection.create(doc,[dup])));
    return dup;
}
function moveBasisToGroup(){if(!shapeNodes.length)return;const grpBasis=makeGroup('Templates_'+runIndex);for(const n of shapeNodes){try{doc.executeCommand(DocumentCommand.createMoveNodes(n.selfSelection,grpBasis,NodeMoveType.Inside,NodeChildType.Main));}catch(e){}}}

function buildSampList(pNode,N,skipLast,doKrümm,krümmStärke,exponent,offStartPct,offEndPct,useKnoten){if(useKnoten)return buildKnotenList(pNode,skipLast);const arcData=buildArcTable(pNode);if(!arcData)return[];const{totalLen}=arcData;const offStartPx=Math.max(0,offStartPct/100*totalLen);const offEndPx=Math.max(0,offEndPct/100*totalLen);const usable=Math.max(1,totalLen-offStartPx-offEndPx);let kappa=null,cdf=null;if(doKrümm){kappa=buildCurvatureSampler(arcData);cdf=makeWeightedCDF(arcData,kappa,krümmStärke);}const list=[];for(let i=0;i<N;i++){const tNorm=skipLast?i/N:(N>1?i/(N-1):0);let arcS;if(doKrümm&&cdf){const tW=cdfToArc(cdf,arcData,tNorm)/totalLen;arcS=offStartPx+Math.pow(tW,exponent)*usable;}else{arcS=offStartPx+Math.pow(tNorm,exponent)*usable;}list.push(sampleArc(arcData,arcS));}return list;}

// ── Placement logic ───────────────────────────────────────
let previewGrpObj=null,previewGrpAP=null,previewKey=null;

function placeObjects(){
    if(previewGrpObj){try{previewGrpObj.delete();}catch(e){}}
    if(previewGrpAP){try{previewGrpAP.delete();}catch(e){}}
    previewGrpObj=null;previewGrpAP=null;previewKey=null;
    const D2R=Math.PI/180;
    const useKnoten=cbKnoten.value,skipLast=cbSkip.value,doReverse=cbReverse.value;
    const doKreis=cbKreis.value,kreisOffset=(eKreisOffset.value||0)*D2R;
    const abstandProzent=cbAbstandProzent.value;
    const doKrümm=cbKrümm.value,krümmStärke=Math.max(0,eKrümmStärke.value||3);
    const scStart=(eScStart.value!=null?eScStart.value:100)/100;
    const scEnd  =(eScEnd.value  !=null?eScEnd.value  :100)/100;
    const farbModus=cbFarbModus.selectedIndex;
    const doBlend=farbModus===2||farbModus===3,useRGB=farbModus===2;
    const srcA=shapeNodes[0],srcB=shapeNodes.length>1?shapeNodes[1]:shapeNodes[0];
    const mkModus=cbMKModus.selectedIndex;
    const doReset=cbMKReset.value&&mkModus===1&&pathNodes.length>1;
    const exponent=Math.max(0.01,eEx.value||1);
    const offStartPct=eOS.value||0,offEndPct=eOE.value||0;
    const totalN=Math.max(1,Math.round(eAnz.value||shapeNodes.length));
    const nPfade=pathNodes.length;
    let sampList=[];
    if(nPfade===1||mkModus===1){for(let pi=0;pi<nPfade;pi++){const list=buildSampList(pathNodes[pi],totalN,skipLast,doKrümm,krümmStärke,exponent,offStartPct,offEndPct,useKnoten);for(const s of list)s.pathIdx=pi;sampList=sampList.concat(list);}}
    else{const baseN=Math.floor(totalN/nPfade);for(let pi=0;pi<nPfade;pi++){const nForThis=pi<nPfade-1?baseN:totalN-(nPfade-1)*baseN;const list=buildSampList(pathNodes[pi],nForThis,skipLast,doKrümm,krümmStärke,exponent,offStartPct,offEndPct,useKnoten);for(const s of list)s.pathIdx=pi;sampList=sampList.concat(list);}}
    if(doReverse)sampList.reverse();
    const N=sampList.length;if(N===0){console.log('No anchor points');return;}
    const objPerPt=Math.max(1,Math.round(eOP.value||1));
    const rawOP1=Math.round(eOP1.value||0),objPerPt1=rawOP1>0?rawOP1:objPerPt;
    const angleSeq=cbASeq.selectedIndex,palindrom=cbObjFolge.selectedIndex===1;
    const useFP=cbFP.value,alignPath=cbAlignToPath.value;
    const cosX=cbCosX.value,cosY=cbCosY.value;
    const cosMult=eCosMult.value||1,cosOff=eCosOff.value||0;
    const cosMin=eCosMin.value!=null?eCosMin.value:50,cosMax=eCosMax.value!=null?eCosMax.value:100;
    const negMode=cbCosNegMode.selectedIndex;
    const cosJl=eCosJl.value||0,cosJh=eCosJh.value||0,cosActive=cosX||cosY;
    let totalLen=1;
    if(abstandProzent&&!useKnoten){const ad=buildArcTable(pathNodes[0]);if(ad)totalLen=ad.totalLen;}
    const rawBaseOff=eAbS.value||0;
    const baseOff=abstandProzent?rawBaseOff/100*totalLen:rawBaseOff;
    const abJlPx=abstandProzent?(eAbJl.value||0)/100*totalLen:(eAbJl.value||0);
    const abJhPx=abstandProzent?(eAbJh.value||0)/100*totalLen:(eAbJh.value||0);
    let objList;
    if(doBlend){objList=[srcA];}
    else{objList=[...shapeNodes];if(cbRnd.value){for(let i=objList.length-1;i>0;i--){const j=0|Math.random()*(i+1);[objList[i],objList[j]]=[objList[j],objList[i]];}}}
    const nObjs=objList.length;
    const grpObj=makeGroup('PathObjects_'+runIndex);
    const grpAP =makeGroup('AnchorPoints_'+runIndex);
    previewGrpObj=grpObj;previewGrpAP=grpAP;
    let cumAngle=0,cumRot=0,cumH=0,cumL=0,cumS=0,cumOp=0,objIdx=0;
    let lastPathIdx=-1,localApCount=0,localApI=0;
    for(let i=0;i<N;i++){
        const samp=sampList[i];
        const curPathIdx=samp.pathIdx!=null?samp.pathIdx:0;
        if(doReset&&curPathIdx!==lastPathIdx&&lastPathIdx!==-1){cumAngle=0;cumRot=0;cumH=0;cumL=0;cumS=0;cumOp=0;objIdx=0;localApI=0;}
        if(curPathIdx!==lastPathIdx){localApCount=sampList.filter(s=>(s.pathIdx??0)===curPathIdx).length;if(lastPathIdx!==-1)localApI=0;lastPathIdx=curPathIdx;}
        const tPos=doReset?(localApCount>1?localApI/(localApCount-1):0):(N>1?i/(N-1):0);
        makeMaker(samp,i);
        doc.executeCommand(DocumentCommand.createMoveNodes(doc.selection,grpAP,NodeMoveType.Inside,NodeChildType.Main));
        const countAtThisAP=(i===0&&!doReset)||(localApI===0&&doReset)?objPerPt1:objPerPt;
        for(let j=0;j<countAtThisAP;j++){
            const listIdx=doBlend?0:objListIndex(objIdx,nObjs,palindrom);
            const src=objList[listIdx];
            const srcBB=src.getSpreadBaseBox(false);
            if(!srcBB){objIdx++;continue;}
            const bbCx=srcBB.x+srcBB.width/2,bbCy=srcBB.y+srcBB.height/2;
            const staticDeg=(eAS.value||0),dynDeg=cumAngle*(180/Math.PI),jitDeg=jitter(eAJl.value||0,eAJh.value||0);
            const phase=objIdx%2;
            let finalOffsetDeg;
            if(angleSeq===0)finalOffsetDeg=staticDeg+dynDeg+jitDeg;
            else if(angleSeq===1)finalOffsetDeg=(phase===0?staticDeg:-staticDeg)+dynDeg+jitDeg;
            else{const sum=staticDeg+dynDeg+jitDeg;finalOffsetDeg=(phase===0)?Math.abs(sum):-Math.abs(sum);}
            let extraAngle=0;
            if(doKreis&&countAtThisAP>1)extraAngle=(j*360/countAtThisAP)*D2R+kreisOffset;
            const dirAngle=samp.angle+(finalOffsetDeg*D2R)+extraAngle;
            const{sx:cosSX,sy:cosSY}=cosActive?cosScaleFactors(samp.angle,cosX,cosY,cosMult,cosOff,cosMin,cosMax,negMode,cosJl,cosJh):{sx:1,sy:1};
            const scPos=scStart+(scEnd-scStart)*tPos;
            let xf,pivotX,pivotY;
            if(useFP){
                const fpS=getFPSpread(src);
                const fpOrigX=fpS.valid?fpS.x:bbCx,fpOrigY=fpS.valid?fpS.y:bbCy;
                const dx=samp.x-fpOrigX,dy=samp.y-fpOrigY;
                const fpToMidAngle=Math.atan2(bbCy-fpOrigY,bbCx-fpOrigX);
                const rotAlign=dirAngle-fpToMidAngle;
                const ownRotBase=((eRS.value||0)+cumRot*(180/Math.PI)+jitter(eRJl.value||0,eRJh.value||0))*D2R;
                const totalRot=rotAlign+ownRotBase;
                const fSc=Math.max(0.001,scPos*(1+(eScD.value||0)/100*localApI)+jitter((eScJl.value||0)/100,(eScJh.value||0)/100));
                const APx=samp.x,APy=samp.y;pivotX=APx;pivotY=APy;
                xf=Transform.createTranslate(dx,dy);
                if(Math.abs(totalRot)>0.00001){xf=Transform.createTranslate(APx,APy).multiply(Transform.createRotate(totalRot)).multiply(Transform.createTranslate(-APx,-APy)).multiply(xf);}
                if(Math.abs(fSc-1)>0.00001){xf=Transform.createTranslate(APx,APy).multiply(Transform.createScale(fSc,fSc)).multiply(Transform.createTranslate(-APx,-APy)).multiply(xf);}
            } else {
                const apIdxForDyn=doReset?localApI:i;
                const dynOff=baseOff*(eAbD.value||0)/100*apIdxForDyn;
                const jitOff=jitter(abJlPx,abJhPx);
                const fOff=baseOff+dynOff+jitOff;
                const targetX=samp.x+Math.cos(dirAngle)*fOff,targetY=samp.y+Math.sin(dirAngle)*fOff;
                const dx=targetX-bbCx,dy=targetY-bbCy,newCx=bbCx+dx,newCy=bbCy+dy;
                pivotX=newCx;pivotY=newCy;
                const ownRotBase=((eRS.value||0)+cumRot*(180/Math.PI)+jitter(eRJl.value||0,eRJh.value||0))*D2R;
                const ownRot=alignPath?ownRotBase+samp.angle:ownRotBase;
                const fSc=Math.max(0.001,scPos*(1+(eScD.value||0)/100*apIdxForDyn)+jitter((eScJl.value||0)/100,(eScJh.value||0)/100));
                xf=Transform.createTranslate(dx,dy);
                if(Math.abs(ownRot)>0.00001){xf=Transform.createTranslate(newCx,newCy).multiply(Transform.createRotate(ownRot)).multiply(Transform.createTranslate(-newCx,-newCy)).multiply(xf);}
                if(Math.abs(fSc-1)>0.00001){xf=Transform.createTranslate(newCx,newCy).multiply(Transform.createScale(fSc,fSc)).multiply(Transform.createTranslate(-newCx,-newCy)).multiply(xf);}
            }
            if(cosActive&&(Math.abs(cosSX-1)>0.0001||Math.abs(cosSY-1)>0.0001)){
                const tanA=samp.angle;
                const cosXf=Transform.createTranslate(pivotX,pivotY).multiply(Transform.createRotate(tanA)).multiply(Transform.createScale(cosSX,cosSY)).multiply(Transform.createRotate(-tanA)).multiply(Transform.createTranslate(-pivotX,-pivotY));
                xf=cosXf.multiply(xf);
            }
            const shapeDup=dupSrc(src);
            if(!shapeDup){objIdx++;continue;}
            doc.executeCommand(DocumentCommand.createTransform(doc.selection,xf));
            const fOp=cumOp+jitter(eOJl.value||0,eOJh.value||0);
            if(Math.abs(fOp)>0.0001){try{const cur=typeof shapeDup.globalOpacity!=='undefined'?shapeDup.globalOpacity:1;doc.executeCommand(DocumentCommand.createSetOpacity(doc.selection,Math.max(0,Math.min(1,cur+fOp/100))));}catch(e){}}
            doc.executeCommand(DocumentCommand.createMoveNodes(doc.selection,grpObj,NodeMoveType.Inside,NodeChildType.Main));
            if(farbModus===0){/* none */}
            else if(farbModus===1){const fH=cumH+jitter(eHJl.value||0,eHJh.value||0);const fL=cumL+jitter(eLJl.value||0,eLJh.value||0);const fS=cumS+jitter(eSJl.value||0,eSJh.value||0);if(fH!==0||fL!==0||fS!==0)applyHSLrecursive(shapeDup,fH,fL,fS);}
            else{applyColourBlendRecursive(shapeDup,srcA,srcB,tPos,useRGB);}
            doc.executeCommand(DocumentCommand.createSetSelection(origSel));
            objIdx++;
        }
        cumAngle+=(eAD.value||0)*D2R;cumRot+=(eRD.value||0)*D2R;
        cumH+=(eHD.value||0);cumL+=(eLD.value||0);cumS+=(eSD.value||0);cumOp+=(eOD.value||0);
        localApI++;
    }
    doc.executeCommand(DocumentCommand.createSetSelection(origSel));
    previewKey=JSON.stringify(collectParams());
    let cObj=0;for(const ch of grpObj.children)cObj++;
    let cAP=0;for(const ch of grpAP.children)cAP++;
    console.log('Preview: '+cObj+' obj, '+cAP+' APs');
}

btnPreview.setOnClickHandler(()=>{placeObjects();});
placeObjects();

const result=dlg.runModal();
if(!result||result.value===DialogResult.Cancel.value){
    if(previewGrpObj){try{previewGrpObj.delete();}catch(e){}}
    if(previewGrpAP){try{previewGrpAP.delete();}catch(e){}}
    console.log('Cancelled.');
} else {
    if(!previewGrpObj||previewKey!==JSON.stringify(collectParams()))placeObjects();
    if(cbAPLöschen.value&&previewGrpAP){try{previewGrpAP.delete();}catch(e){}previewGrpAP=null;}
    if(cbBasisGrp.value)moveBasisToGroup();
    runIndex++;previewGrpObj=null;previewGrpAP=null;
    console.log('Applied.');
}

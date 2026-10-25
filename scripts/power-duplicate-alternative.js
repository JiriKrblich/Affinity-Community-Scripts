'use strict';
// Power Duplicate Alternative EN v4
// v4 – GUI converted to tabs (pages), following the pattern of "Transform Objects v8":
//   always visible on the left: tab selector, preview, presets; two columns per page on the right.
//   Pages: 1 General (incl. grid, pivot display) · 2 Global transform · 3 Local transform ·
//   4 Scaling · 5 Colour & opacity.
//   When switching, the groups of the active page are shown and all others hidden
//   (group.isVisible). All values are kept on hidden pages as well.
//   Functions, parameters and preset format are unchanged from v3.
// v3 – two fixes:
//  1) BUGFIX crash on "Randomize order": shuffleChildrenOrder and moveToTop compared nodes with
//     "===" (wrappers are never identical -> moving a node before itself -> COMMAND_FAILED).
//     Now isSameNode().
//  2) BUGFIX stale preview: on OK the result is recomputed if the settings changed since the
//     last preview.
// v2b: text fill/stroke (GlyphAtts/StoryDelta).
// FUNDAMENTALLY DIFFERENT COMPUTATION MODEL from "Power Duplicate": no chaining, every copy is
// duplicated directly from the original object and computed absolutely from Stat./Dyn.; jitter
// does not accumulate. Order per copy: global first (rotation around the pivot + radial + X/Y as
// one step), then local (rotation/radial/scaling around the copy's own centre).
const { Document }                   = require('/document');
const { Dialog, DialogResult }       = require('/dialog');
const { DocumentCommand,
        AddChildNodesCommandBuilder,
        NodeMoveType, NodeChildType } = require('/commands');
const { Selection }                  = require('/selections');
const { ContainerNodeDefinition,
        ShapeNodeDefinition }        = require('/nodes');
const { ShapeEllipse }               = require('/shapes');
const { Transform }                  = require('/geometry');
const { Colour }                     = require('/colours');
const { FillDescriptor }             = require('/fills');
const { File, FileSystemApi }        = require('/fs');
const { StoryDelta }                 = require('/storydelta');
const { app }                        = require('/application');

const doc = Document.current;
if (!doc) { app.alert('No document open.','Power Duplicate Alternative EN'); throw new Error('Kein Dokument'); }
const initSel = doc.selection;
if (!initSel || initSel.length === 0) { app.alert('No object selected.','Power Duplicate Alternative EN'); throw new Error('Keine Auswahl'); }

const selectedNodes = [];
let pdNode = null;
for (let i = 0; i < initSel.length; i++) {
    const n = initSel.at(i).node;
    const name = (n.userDescription || n.defaultDescription || '').toLowerCase();
    if (name === '_pd') pdNode = n;
    else selectedNodes.push(n);
}
if (selectedNodes.length === 0) { app.alert('No duplicatable objects.\n(Only _PD found)','Power Duplicate Alternative EN'); throw new Error('Keine Elternobjekte'); }

function clamp(v,mn,mx){return Math.max(mn,Math.min(mx,v));}
let currentRandom=Math.random;
function randRange(mn,mx){return mn+currentRandom()*(mx-mn);}
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};}
const MIN_SCALE = 0.1;
const MAX_SHEAR_SIN = Math.sin(85 * Math.PI / 180);

function easingFn(t,mode){
    t=Math.max(0,Math.min(1,t));
    if(mode===1) return t*t;
    if(mode===2) return 1-(1-t)*(1-t);
    if(mode===3) return (1-Math.cos(t*Math.PI))/2;
    return t;
}

function cumulativeStatDyn(s,d,N){
    if(N<=0) return 0;
    const r=1+d/100;
    if(Math.abs(r-1)<1e-9) return s*N;
    return s*(Math.pow(r,N)-1)/(r-1);
}
function absoluteStepValue(p,stepNum,count){
    let base;
    if(p.zielActive){
        const t=stepNum/count;
        base=p.s+(p.zielTarget-p.s)*easingFn(t,p.zielEasing);
    } else {
        base=cumulativeStatDyn(p.s,p.d,stepNum);
    }
    const jitter=(p.rMin!==0||p.rMax!==0)?randRange(p.rMin,p.rMax):0;
    return base+jitter;
}
function absoluteColorValue(p,stepNum,count){
    let base;
    if(p.zielActive){ const t=stepNum/count; base=p.s+(p.zielTarget-p.s)*easingFn(t,p.zielEasing); }
    else base=p.s*stepNum;
    const jitter=(p.rMin!==0||p.rMax!==0)?randRange(p.rMin,p.rMax):0;
    return base+jitter;
}

function getTFArr(node) { const d=node.transform.data; return [d[0],d[1],d[2],d[3],d[4],d[5]]; }
function fpToSpread(node) { try { const fp=node.transformInterface.focalPoint; if(fp.isValid) return node.transform.applyToPoint(fp.point); } catch(e){} return null; }
function getRC(node) { const fp=fpToSpread(node); if(fp) return fp; const bb=getNodeBB(node); if(bb) return{x:bb.x+bb.width/2,y:bb.y+bb.height/2}; return{x:0,y:0}; }
function getNodeBB(n){try{return n.getSpreadBaseBox(false);}catch(e){return null;}}
function getCombinedBB(nodes){ let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity; for(const n of nodes){const b=getNodeBB(n);if(!b)continue;x0=Math.min(x0,b.x);y0=Math.min(y0,b.y);x1=Math.max(x1,b.x+b.width);y1=Math.max(y1,b.y+b.height);} if(!isFinite(x0))return null; return{x:x0,y:y0,width:x1-x0,height:y1-y0,cx:(x0+x1)/2,cy:(y0+y1)/2,diag:Math.sqrt((x1-x0)**2+(y1-y0)**2)}; }

function scaleTarget(origSize,s_pct,d_ppm,stepNum) { let totalInc=0,inc=origSize*(s_pct/100); for(let i=0;i<stepNum;i++){if(i>0)inc*=(1+d_ppm/1000);totalInc+=inc;} const result=origSize+totalInc; if(Math.abs(result)<MIN_SCALE) return result>=0?MIN_SCALE:-MIN_SCALE; return result; }

function absoluteScaleFactor(origSize,s_pct,d_ppm,jitterPct,stepNum,count,allowNeg,ziel){
    if(Math.abs(origSize)<=MIN_SCALE) return {factor:1,newSize:origSize};
    let targetNew;
    if(ziel&&ziel.zielActive){
        const startVal=origSize*(1+s_pct/100);
        const t=stepNum/count;
        targetNew=startVal+(ziel.zielTarget-startVal)*easingFn(t,ziel.zielEasing);
    } else {
        targetNew=scaleTarget(origSize,s_pct,d_ppm,stepNum);
    }
    const jitter=origSize*jitterPct/100;
    let newSize=targetNew+jitter;
    if(Math.abs(newSize)<MIN_SCALE) newSize=newSize>=0?MIN_SCALE:-MIN_SCALE;
    if(!allowNeg) newSize=Math.max(MIN_SCALE,newSize);
    const origAbs=Math.max(Math.abs(origSize),MIN_SCALE);
    return {factor:newSize/origAbs,newSize};
}

function clampShearFactor(fScX,fScY,dRotRad,m) {
    const cosR=Math.cos(dRotRad),sinR=Math.sin(dRotRad);
    const rm11=cosR*m[0]-sinR*m[3],rm12=cosR*m[1]-sinR*m[4];
    const rm21=sinR*m[0]+cosR*m[3],rm22=sinR*m[1]+cosR*m[4];
    const nm11=fScX*rm11,nm12=fScX*rm12,nm21=fScY*rm21,nm22=fScY*rm22;
    const sx_n=Math.sqrt(nm11*nm11+nm21*nm21),sy_n=Math.sqrt(nm12*nm12+nm22*nm22);
    if(sx_n<MIN_SCALE||sy_n<MIN_SCALE) return fScX;
    if(Math.abs((nm11*nm12+nm21*nm22)/(sx_n*sy_n))<=MAX_SHEAR_SIN) return fScX;
    const sign=fScX>=0?1:-1; let lo=0,hi=Math.abs(fScX);
    for(let i=0;i<30;i++){const mid=(lo+hi)/2,t=sign*mid;const tnm11=t*rm11,tnm12=t*rm12,tnm21=fScY*rm21,tnm22=fScY*rm22;const tsx=Math.sqrt(tnm11*tnm11+tnm21*tnm21),tsy=Math.sqrt(tnm12*tnm12+tnm22*tnm22);if(tsx<MIN_SCALE||tsy<MIN_SCALE){lo=mid;continue;}if(Math.abs((tnm11*tnm12+tnm21*tnm22)/(tsx*tsy))<=MAX_SHEAR_SIN) lo=mid; else hi=mid;}
    return sign*(lo+hi)/2;
}

function isTextNode(node){
    const tag=node[Symbol.toStringTag]||'';
    return tag==='ArtTextNode'||tag==='FrameTextNode';
}
function getFDFromNode(node,usePen){
    if(isTextNode(node)){
        try{
            const story=node.storyInterface?.story;
            if(!story||story.length===0)return null;
            const a=story.getGlyphAtts(0);
            return (usePen?a.penFill:a.brushFill)||null;
        }catch(e){return null;}
    }
    try{
        if(usePen) return node.hasPenFill?node.penFillDescriptor:null;
        return node.hasBrushFill?node.brushFillDescriptor:null;
    }catch(e){return null;}
}
function setFDOnNode(node,fd,usePen){
    if(isTextNode(node)){
        try{
            const delta=usePen?StoryDelta.createPenFill(fd):StoryDelta.createBrushFill(fd);
            doc.executeCommand(DocumentCommand.createSetSelection(node.selfSelection));
            doc.formatText(delta,doc.selection,false);
        }catch(e){}
    } else {
        try{
            const sel=Selection.create(doc,[node]);
            if(usePen) doc.executeCommand(DocumentCommand.createSetPenFill(sel,fd));
            else doc.executeCommand(DocumentCommand.createSetBrushFill(sel,fd));
        }catch(e){}
    }
}

function applyHSLtoFD(fd,dH,dS,dL){
    if(!fd||!fd.fill||!fd.fill.fillType)return null;
    const ft=fd.fill.fillType.value;
    if(ft===2){const hsl=fd.fill.colour.hslaf;return FillDescriptor.createSolid(Colour.createHSLAf({h:((hsl.h+dH/360)%1+1)%1,s:clamp(hsl.s+dS/100,0,1),l:clamp(hsl.l+dL/100,0,1),alpha:hsl.alpha}));}
    if(ft===3){const g=fd.fill.gradient,ns=[];for(let j=0;j<g.stopCount;j++){const stop=g.getStop(j),hsl=new Colour(stop.colour).hslaf;ns.push({colour:Colour.createHSLAf({h:((hsl.h+dH/360)%1+1)%1,s:clamp(hsl.s+dS/100,0,1),l:clamp(hsl.l+dL/100,0,1),alpha:hsl.alpha}),position:stop.position,midpoint:stop.midpoint});}return FillDescriptor.create(fd.fill.constructor.create(g.constructor.create(ns),fd.fill.gradientFillType),fd.isScaleWithObject,fd.transform,fd.blendMode,fd.isAnchoredToSpread);}
    return null;
}

function applyHSLtoNode(dupNode,origNode,dH,dS,dL,chF,chS){
    if(chF){ const fd=getFDFromNode(origNode,false); if(fd){ const nf=applyHSLtoFD(fd,dH,dS,dL); if(nf) setFDOnNode(dupNode,nf,false); } }
    if(chS){ const fd=getFDFromNode(origNode,true); if(fd){ const nf=applyHSLtoFD(fd,dH,dS,dL); if(nf) setFDOnNode(dupNode,nf,true); } }
}

function applyHSLChange(dupNode,dH,dS,dL,chF,chS,origNode){
    if(!chF&&!chS) return;
    if(dupNode.isGroupNode&&!isTextNode(dupNode)){
        const dc=[],oc=[];
        for(const ch of dupNode.children) dc.push(ch);
        for(const ch of origNode.children) oc.push(ch);
        const len=Math.min(dc.length,oc.length);
        for(let i=0;i<len;i++) applyHSLChange(dc[i],dH,dS,dL,chF,chS,oc[i]);
    } else {
        applyHSLtoNode(dupNode,origNode,dH,dS,dL,chF,chS);
    }
}

function reverseChildrenOrder(group){ const arr=[];for(const ch of group.children)arr.push(ch);if(arr.length<=1)return;for(let i=1;i<arr.length;i++){let ff=null;for(const ch of group.children){ff=ch;break;}if(!ff)break;doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,[arr[i]]),ff,NodeMoveType.Before,NodeChildType.Main));} }
function shuffleChildrenOrder(group){
    const arr=[]; for(const ch of group.children) arr.push(ch);
    if(arr.length<=1) return;
    for(let i=arr.length-1;i>0;i--){ const j=Math.floor(currentRandom()*(i+1)); const tmp=arr[i]; arr[i]=arr[j]; arr[j]=tmp; }
    for(let i=arr.length-1;i>=0;i--){
        let first=null; for(const ch of group.children){first=ch;break;}
        // v3: isSameNode instead of === (wrappers are never identical; moving a node before itself throws)
        if(!first||first.isSameNode(arr[i])) continue;
        doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,[arr[i]]),first,NodeMoveType.Before,NodeChildType.Main));
    }
}
// v3: isSameNode instead of ===
function moveToTop(node,pg){ let first=null;for(const ch of pg.children){first=ch;break;}if(!first||first.isSameNode(node))return;doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,[node]),first,NodeMoveType.Before,NodeChildType.Main)); }

const PRESET_DIR = app.userDesktopPath + '/AffinityScriptPresets';
const PRESET_PREFIX = 'PDA_';
function ensurePresetDir(){ try{ FileSystemApi.createDirectories(PRESET_DIR); }catch(e){} }
function savePreset(params){
    try{
        ensurePresetDir();
        const name=app.prompt('Preset name (without prefix/extension):','Save preset','My_Preset');
        if(!name||!name.trim()) return;
        const fname=PRESET_PREFIX+name.trim()+'.json';
        const f=File.create(PRESET_DIR+'/'+fname,'wb');
        f.writeStringAsUtf8(JSON.stringify(params,null,2));
        f.close();
        app.alert('Saved:\n'+fname,'Power Duplicate Alternative EN');
    }catch(e){app.alert('Error: '+e,'Power Duplicate Alternative EN');}
}
function loadPreset(){
    try{
        const path=app.chooseFile();
        if(!path) return null;
        let buf;
        try{buf=File.readAll(path);}catch(e){app.alert('File not readable.','Power Duplicate Alternative EN');return null;}
        return JSON.parse(buf.toString('utf8'));
    }catch(e){app.alert('Error: '+e,'Power Duplicate Alternative EN');return null;}
}
function deletePreset(){
    try{
        const path=app.chooseFile();
        if(!path) return;
        FileSystemApi.remove(path);
        app.alert('Deleted.','Power Duplicate Alternative EN');
    }catch(e){app.alert('Error: '+e,'Power Duplicate Alternative EN');}
}

const autoBB=getCombinedBB(selectedNodes);
const autoGCx=autoBB?autoBB.cx:0,autoGCy=autoBB?autoBB.cy:0;
const pdBB=pdNode?getNodeBB(pdNode):null;
const pdCx=pdBB?pdBB.x+pdBB.width/2:null,pdCy=pdBB?pdBB.y+pdBB.height/2:null;
const pdFound=pdNode!==null;

function hasFocalPoint(nodes){ for(const n of nodes){try{if(n.transformInterface.focalPoint.isValid)return true;if(n.isGroupNode)for(const ch of n.children)if(ch.transformInterface?.focalPoint?.isValid)return true;}catch(e){}}return false; }
const anyFocalPoint=hasFocalPoint(selectedNodes);

const ZDEF={zielActive:false,zielTarget:0,zielEasing:0};
const DEF={count:5,reverse:false,shuffleOrder:false,splitGroups:false,allowNegativeScale:false,scaleBeforeRotation:false,lockAspect:false,changeFill:true,changeStroke:false,fixedSeed:false,seed:12345,gridCols:0,gridRows:0,brickPct:0,
    gx:{s:0,d:0,rMin:0,rMax:0,...ZDEF},gy:{s:0,d:0,rMin:0,rMax:0,...ZDEF},
    gRot:{s:0,d:0,rMin:0,rMax:0,...ZDEF},gRad:{s:0,d:0,rMin:0,rMax:0,...ZDEF},
    lRot:{s:0,d:0,rMin:0,rMax:0,...ZDEF},lRad:{s:0,d:0,rMin:0,rMax:0},
    scX:{s:0,d:0,rMin:0,rMax:0,...ZDEF},scY:{s:0,d:0,rMin:0,rMax:0,...ZDEF},
    hue:{s:0,rMin:0,rMax:0,...ZDEF},sat:{s:0,rMin:0,rMax:0,...ZDEF},lum:{s:0,rMin:0,rMax:0,...ZDEF},opac:{s:0,rMin:0,rMax:0,...ZDEF}};

// --- Tab management (pattern from "Transform Objects v8")
const PAGES=[[],[],[],[],[]];          // groups belonging to each page
let currentPage=-1;                    // page newly created groups are assigned to (-1 = none)
function mkGroup(col,title){ const g=col.addGroup(title); if(currentPage>=0&&PAGES[currentPage]) PAGES[currentPage].push(g); return g; }
let pagedOK=true;
function showPage(i){
    if(!pagedOK) return;
    try{ for(let k=0;k<PAGES.length;k++) for(const g of PAGES[k]) g.isVisible=(k===i); }
    catch(e){ pagedOK=false; try{ for(const pgs of PAGES) for(const g of pgs) g.isVisible=true; }catch(e2){} console.log('Tabs not available: '+e.message); }
}

function addZielUI(g,pObj){
    const chkZ=chk(g,'Target value (end)',pObj.zielActive??false);
    const eZ=g.addUnitValueEditor('Target','none','none',null,null,null); eZ.value=pObj.zielTarget??0;
    const cbE=g.addComboBox('Easing',['Linear','Ease-In','Ease-Out','Sine'],pObj.zielEasing??0);
    try{cbE.selectedIndex=pObj.zielEasing??0;}catch(e){}
    function syncEnabled(){ try{ eZ.isEnabled=chkZ.value; cbE.isEnabled=chkZ.value; }catch(e){} }
    try{chkZ.setOnValueChangedHandler(()=>syncEnabled());}catch(e){}
    syncEnabled();
    return {chkZ,eZ,cbE};
}
function readZiel(z){ if(!z) return {}; return {zielActive:z.chkZ.value,zielTarget:z.eZ.value,zielEasing:z.cbE.selectedIndex}; }
function applyZiel(z,v){ if(!z)return; z.chkZ.value=!!(v&&v.zielActive); z.eZ.value=(v&&v.zielTarget)||0; try{z.cbE.selectedIndex=(v&&v.zielEasing)||0;}catch(e){} }

function pg(col,label,pObj,minVal,maxVal,supportsZiel){ const g=mkGroup(col,label);const eS=g.addUnitValueEditor('Stat.','none','none',null,null,null);const eD=g.addUnitValueEditor('Dyn.%','none','none',null,-500,500);const eN=g.addUnitValueEditor('Jit.Min','none','none',null,minVal,maxVal);const eX=g.addUnitValueEditor('Jit.Max','none','none',null,minVal,maxVal);eS.value=pObj.s??0;eD.value=pObj.d??0;eN.value=pObj.rMin??0;eX.value=pObj.rMax??0;const ziel=supportsZiel?addZielUI(g,pObj):null;return{eS,eD,eN,eX,ziel}; }
function rpg(e){const base={s:e.eS.value,d:e.eD.value,rMin:e.eN.value,rMax:e.eX.value};return{...base,...readZiel(e.ziel)};}
function apg(e,v){if(!v)return;e.eS.value=v.s??0;e.eD.value=v.d??0;e.eN.value=v.rMin??0;e.eX.value=v.rMax??0;applyZiel(e.ziel,v);}
function pgRad(col,label,pObj,supportsZiel){ const g=mkGroup(col,label);const eS=g.addUnitValueEditor('Stat.px','none','none',null,null,null);const eD=g.addUnitValueEditor('Dyn.%/step','none','none',null,-500,500);const eN=g.addUnitValueEditor('Jit.Min','none','none',null,-9999,9999);const eX=g.addUnitValueEditor('Jit.Max','none','none',null,-9999,9999);eS.value=pObj.s??0;eD.value=pObj.d??0;eN.value=pObj.rMin??0;eX.value=pObj.rMax??0;const ziel=supportsZiel?addZielUI(g,pObj):null;return{eS,eD,eN,eX,ziel}; }
function scg(col,label,pObj,supportsZiel){ const g=mkGroup(col,label);const eS=g.addUnitValueEditor('Stat.%','none','none',null,-500,500);const eD=g.addUnitValueEditor('Dyn.‰','none','none',null,-9999,9999);const eN=g.addUnitValueEditor('Jit.Min','none','none',null,-500,500);const eX=g.addUnitValueEditor('Jit.Max','none','none',null,-500,500);eS.value=pObj.s??0;eD.value=pObj.d??0;eN.value=pObj.rMin??0;eX.value=pObj.rMax??0;const ziel=supportsZiel?addZielUI(g,pObj):null;return{eS,eD,eN,eX,ziel}; }
function rscg(e){const base={s:e.eS.value,d:e.eD.value,rMin:e.eN.value,rMax:e.eX.value};return{...base,...readZiel(e.ziel)};}
function ascg(e,v){if(!v)return;e.eS.value=v.s??0;e.eD.value=v.d??0;e.eN.value=v.rMin??0;e.eX.value=v.rMax??0;applyZiel(e.ziel,v);}
function farbg(col,label,pObj,unit,mn,mx){ const g=mkGroup(col,label);const eS=g.addUnitValueEditor('Stat./cum.','none','none',null,mn*2,mx*2);const eN=g.addUnitValueEditor('Rand.Min','none','none',null,mn,mx);const eX=g.addUnitValueEditor('Rand.Max','none','none',null,mn,mx);eS.value=pObj.s??0;eN.value=pObj.rMin??0;eX.value=pObj.rMax??0;const ziel=addZielUI(g,pObj);return{eS,eN,eX,ziel}; }
function rfg(e){const base={s:e.eS.value,rMin:e.eN.value,rMax:e.eX.value};return{...base,...readZiel(e.ziel)};}
function afg(e,v){if(!v)return;e.eS.value=v.s??0;e.eN.value=v.rMin??0;e.eX.value=v.rMax??0;applyZiel(e.ziel,v);}
function chk(grp,label,val){const cb=grp.addCheckBox(label,val);cb.setIsFullWidth(true);return cb;}

function buildDialog(p){
    const dlg=Dialog.create('Power Duplicate Alternative EN');
    dlg.initialWidth=1000;dlg.setIsResizable(true);

    // Left: narrow, always-visible column; right: two content columns per page
    const cNav=dlg.addColumn();cNav.widthProportion=0.8;cNav.paddingFactor=0.3;
    const cA=dlg.addColumn();cA.widthProportion=1;cA.paddingFactor=0.3;
    const cB=dlg.addColumn();cB.widthProportion=1;cB.paddingFactor=0.3;

    const gNav=cNav.addGroup('Tabs');
    const rNav=gNav.addRadioGroup('',['1  General','2  Global transform','3  Local transform','4  Scaling','5  Colour & opacity'],0);
    const gAct=cNav.addGroup('Action');
    const btnPreview=gAct.addButton('Preview');
    const gPreset=cNav.addGroup('Preset');
    const btnSave=gPreset.addButton('Save');
    const btnLoad=gPreset.addButton('Load');
    const btnDel=gPreset.addButton('Delete');

    // Page 1: General
    currentPage=0;
    const gB=mkGroup(cA,'General');
    const edCnt=gB.addUnitValueEditor('Count','none','none',null,1,1000);edCnt.value=p.count;
    const chkRev=chk(gB,'Reverse order',p.reverse);
    const chkShuf=chk(gB,'Randomize order',p.shuffleOrder??false);
    const chkSpl=chk(gB,'Split groups',p.splitGroups);
    const chkSeed=chk(gB,'Fixed seed',p.fixedSeed??false);
    const edSeed=gB.addUnitValueEditor('Seed','none','none',null,0,999999999);edSeed.value=p.seed??12345;
    const txtCount=gB.addStaticText('','');
    function updateCount(){ try{ let n=0; for(const node of selectedNodes){ if(chkSpl.value&&node.isGroupNode){ for(const ch of node.children) n++; } else n++; } const total=n*(Math.max(1,Math.round(edCnt.value||1))+1); txtCount.text='≈ '+total+' objects total'; }catch(e){} }
    try{edCnt.setOnValueChangedHandler(()=>updateCount());chkSpl.setOnValueChangedHandler(()=>updateCount());}catch(e){}
    updateCount();
    const gGrid=mkGroup(cB,'Grid');
    const edCols=gGrid.addUnitValueEditor('Grid: Columns (0=off)','none','none',null,0,999);edCols.value=p.gridCols??0;
    const edRows=gGrid.addUnitValueEditor('Grid: Rows (0=auto)','none','none',null,0,999);edRows.value=p.gridRows??0;
    const edBrick=gGrid.addUnitValueEditor('Grid: Brick offset % (every 2nd row)','none','none',null,-100,100);edBrick.value=p.brickPct??0;
    const gPiv=mkGroup(cB,'Global pivot point');
    if(pdFound){gPiv.addStaticText('','✓ _PD: ('+pdCx.toFixed(0)+','+pdCy.toFixed(0)+')');}
    else{gPiv.addStaticText('','No _PD → BB center ('+autoGCx.toFixed(0)+','+autoGCy.toFixed(0)+')');}

    // Page 2: Global transform
    currentPage=1;
    const eGX=pg(cA,'Global X (px)',p.gx,-9999,9999,true);
    const eGY=pg(cA,'Global Y (px)',p.gy,-9999,9999,true);
    const eGRot=pg(cB,'Glob.Rot.(°)',p.gRot,-360,360,true);
    const eGRad=pgRad(cB,'Global Radial',p.gRad,true);

    // Page 3: Local transform
    currentPage=2;
    const eLRot=pg(cA,'Loc.Rot.(°) [fp]',p.lRot,-360,360,true);
    const eLRad=pgRad(cB,'Local Radial',p.lRad,false);

    // Page 4: Scaling
    currentPage=3;
    const eScX=scg(cA,'Scale Width X',p.scX,true);
    const eScY=scg(cB,'Scale Height Y',  p.scY,true);
    const gScOpt=mkGroup(cB,'Scaling Options');
    const chkNeg=chk(gScOpt,'Neg. values (mirroring)',  p.allowNegativeScale??false);
    const chkScR=chk(gScOpt,'No trapezoid (local scale)', p.scaleBeforeRotation??false);
    const chkAsp=chk(gScOpt,'Lock aspect ratio X→Y',    p.lockAspect??false);
    if(anyFocalPoint) gScOpt.addStaticText('','⚠ Neg. values + focal point incompatible');

    // Page 5: Colour & opacity
    currentPage=4;
    const gOpt=mkGroup(cA,'Apply HSL to');
    const chkFill  =chk(gOpt,'Fill',p.changeFill  ??true);
    const chkStroke=chk(gOpt,'Stroke',  p.changeStroke??false);
    const eHue=farbg(cA,'H Hue°', p.hue,'°',-360,360);
    const eSat=farbg(cA,'S Saturation',p.sat,'%',-100,100);
    const eLum =farbg(cB,'L Lightness',p.lum,'%',-100,100);
    const eOpac=farbg(cB,'Opacity',   p.opac,'%',-100,100);
    currentPage=-1;

    try{rNav.selectedIndex=0;}catch(e){}
    showPage(0);
    try{rNav.setOnValueChangedHandler(()=>showPage(rNav.selectedIndex));}catch(e){}

    function readParams(){ return{count:Math.max(1,Math.round(edCnt.value||3)),reverse:chkRev.value,shuffleOrder:chkShuf.value,splitGroups:chkSpl.value,gridCols:Math.max(0,Math.round(edCols.value||0)),gridRows:Math.max(0,Math.round(edRows.value||0)),brickPct:edBrick.value||0,fixedSeed:chkSeed.value,seed:Math.round(edSeed.value||0),allowNegativeScale:chkNeg.value,scaleBeforeRotation:chkScR.value,lockAspect:chkAsp.value,changeFill:chkFill.value,changeStroke:chkStroke.value,gx:rpg(eGX),gy:rpg(eGY),gRot:rpg(eGRot),gRad:rpg(eGRad),lRot:rpg(eLRot),lRad:rpg(eLRad),scX:rscg(eScX),scY:rscg(eScY),hue:rfg(eHue),sat:rfg(eSat),lum:rfg(eLum),opac:rfg(eOpac)}; }
    function applyParams(v){ if(!v)return;edCnt.value=v.count||3;chkRev.value=!!v.reverse;chkShuf.value=!!v.shuffleOrder;chkSpl.value=!!v.splitGroups;edCols.value=v.gridCols||0;edRows.value=v.gridRows||0;edBrick.value=v.brickPct||0;chkSeed.value=!!v.fixedSeed;edSeed.value=v.seed||12345;chkNeg.value=!!v.allowNegativeScale;chkScR.value=!!v.scaleBeforeRotation;chkAsp.value=!!v.lockAspect;chkFill.value=v.changeFill??true;chkStroke.value=v.changeStroke??false;apg(eGX,v.gx);apg(eGY,v.gy);apg(eGRot,v.gRot);apg(eGRad,v.gRad);apg(eLRot,v.lRot);apg(eLRad,v.lRad);ascg(eScX,v.scX);ascg(eScY,v.scY);afg(eHue,v.hue);afg(eSat,v.sat);afg(eLum,v.lum);afg(eOpac,v.opac);updateCount(); }
    return{dlg,btnSave,btnLoad,btnDel,btnPreview,readParams,applyParams};
}

function performDuplicate(params,isPreview,autoCombinedBB){
    currentRandom = params.fixedSeed ? mulberry32((params.seed>>>0)||1) : Math.random;
    const count=Math.max(1,Math.round(params.count)),reverse=params.reverse,allowNeg=params.allowNegativeScale??false,scaleFirst=params.scaleBeforeRotation??false,lockAspect=params.lockAspect??false;
    const gridCols0=Math.max(0,Math.round(params.gridCols||0));
    const gridRows0=Math.max(0,Math.round(params.gridRows||0));
    let gridCols=gridCols0;
    if(gridCols<=0&&gridRows0>0) gridCols=Math.max(1,Math.ceil(count/gridRows0));
    let globalCx,globalCy;
    if(pdFound){globalCx=pdCx;globalCy=pdCy;}else{globalCx=autoCombinedBB?autoCombinedBB.cx:0;globalCy=autoCombinedBB?autoCombinedBB.cy:0;}
    const bbDiag=autoCombinedBB?autoCombinedBB.diag:100;
    const parentInfos=[];
    for(const n of selectedNodes){if(params.splitGroups&&n.isGroupNode){for(const ch of n.children)parentInfos.push({parent:ch});}else parentInfos.push({parent:n});}
    if(parentInfos.length===0) return null;
    let pdIdx=1; for(const l of doc.layers.all){if((l.userDescription||'').match(/^Power-Duplicate-Alt_\d+$/))pdIdx++;}
    const outerDef=ContainerNodeDefinition.create('Power-Duplicate-Alt_'+pdIdx);
    const ob=AddChildNodesCommandBuilder.create();ob.addContainerNode(outerDef);
    const outerCmd=ob.createCommand(false);doc.executeCommand(outerCmd);
    const outerGroup=outerCmd.newNodes[0]; if(!outerGroup) return null;
    let markerNode=null;const subGroups=[];

    for(let pi=0;pi<parentInfos.length;pi++){
        const{parent}=parentInfos[pi];
        const baseName=(parent.userDescription||parent.defaultDescription||('Obj_'+pi)).replace(/\s+/g,'_');
        const pgDef=ContainerNodeDefinition.create(baseName+'_Group');
        const pgb=AddChildNodesCommandBuilder.create();pgb.addContainerNode(pgDef);pgb.setInsertionTarget(outerGroup);pgb.setInsertionMode(1);
        const pgCmd=pgb.createCommand(false);doc.executeCommand(pgCmd);
        const pgGrp=pgCmd.newNodes[0];if(!pgGrp)continue;subGroups.push(pgGrp);
        const cpCmd=DocumentCommand.createTransform(Selection.create(doc,[parent]),null,{duplicateNodes:true});
        doc.executeCommand(cpCmd);const pCopy=cpCmd.newNodes[0];
        if(pCopy){try{doc.executeCommand(DocumentCommand.createSetDescription(Selection.create(doc,[pCopy]),baseName+'_0'));}catch(e){}doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,[pCopy]),pgGrp,NodeMoveType.Inside,NodeChildType.Main));}
        const pBB=getNodeBB(parent);
        const origW=pBB?pBB.width:100,origH=pBB?pBB.height:100;
        const pCx=pBB?pBB.x+origW/2:globalCx,pCy=pBB?pBB.y+origH/2:globalCy;
        const parentRC=getRC(parent);
        const fpToBBDist=Math.sqrt((pCx-parentRC.x)**2+(pCy-parentRC.y)**2);
        const lRadBaseDir=fpToBBDist>0.001?Math.atan2(pCy-parentRC.y,pCx-parentRC.x):0;
        const distToGlobal=Math.sqrt((pCx-globalCx)**2+(pCy-globalCy)**2);
        const gRadBaseDir=distToGlobal>0?Math.atan2(pCy-globalCy,pCx-globalCx):0;
        const origOpac=(parent.globalOpacity!==undefined)?parent.globalOpacity:1.0;

        for(let stepNum=1;stepNum<=count;stepNum++){
            let gX_N,gY_N,gRot_N,gRad_N;
            if(gridCols>0){
                const idx=stepNum-1;
                const col=idx%gridCols, row=Math.floor(idx/gridCols);
                const jitGX=(params.gx.rMin!==0||params.gx.rMax!==0)?randRange(params.gx.rMin,params.gx.rMax):0;
                const jitGY=(params.gy.rMin!==0||params.gy.rMax!==0)?randRange(params.gy.rMin,params.gy.rMax):0;
                const brickShift=(row%2===1)?(params.gx.s*((params.brickPct||0)/100)):0;
                gX_N=col*params.gx.s+brickShift+jitGX; gY_N=row*params.gy.s+jitGY;
                gRot_N=0; gRad_N=0;
            } else {
                gX_N=absoluteStepValue(params.gx,stepNum,count);
                gY_N=absoluteStepValue(params.gy,stepNum,count);
                gRot_N=absoluteStepValue(params.gRot,stepNum,count);
                gRad_N=absoluteStepValue(params.gRad,stepNum,count);
            }
            const radG=gRot_N*Math.PI/180;
            const gDir=gRadBaseDir+radG;

            const jitterPctX=(params.scX.rMin!==0||params.scX.rMax!==0)?randRange(params.scX.rMin,params.scX.rMax):0;
            const zielX={zielActive:params.scX.zielActive,zielTarget:params.scX.zielTarget,zielEasing:params.scX.zielEasing};
            const resX=absoluteScaleFactor(origW,params.scX.s,params.scX.d,jitterPctX,stepNum,count,allowNeg,zielX);
            let resY;
            if(lockAspect){
                resY={factor:resX.factor,newSize:origH*resX.factor};
            } else {
                const jitterPctY=(params.scY.rMin!==0||params.scY.rMax!==0)?randRange(params.scY.rMin,params.scY.rMax):0;
                const zielY={zielActive:params.scY.zielActive,zielTarget:params.scY.zielTarget,zielEasing:params.scY.zielEasing};
                resY=absoluteScaleFactor(origH,params.scY.s,params.scY.d,jitterPctY,stepNum,count,allowNeg,zielY);
            }
            const fScX=resX.factor,fScY=resY.factor;

            const lRot_N=absoluteStepValue(params.lRot,stepNum,count);
            const dLRotR=lRot_N*Math.PI/180;
            const lRad_N=params.lRad.s+fpToBBDist*(params.lRad.d/100)*stepNum+((params.lRad.rMin!==0||params.lRad.rMax!==0)?randRange(params.lRad.rMin,params.lRad.rMax):0);

            const sH=absoluteColorValue(params.hue,stepNum,count);
            const sS=absoluteColorValue(params.sat,stepNum,count);
            const sL=absoluteColorValue(params.lum,stepNum,count);
            const sO=absoluteColorValue(params.opac,stepNum,count);

            const dupCmd=DocumentCommand.createTransform(Selection.create(doc,[parent]),null,{duplicateNodes:true});
            doc.executeCommand(dupCmd);const dup=dupCmd.newNodes[0];if(!dup)continue;
            const dupSel=Selection.create(doc,[dup]);
            try{doc.executeCommand(DocumentCommand.createSetDescription(dupSel,baseName+'_'+stepNum));}catch(e){}

            if(Math.abs(radG)>0.0001||Math.abs(gRad_N)>0.0001||Math.abs(gX_N)>0.001||Math.abs(gY_N)>0.001){
                const flatDx=Math.cos(gDir)*gRad_N+gX_N, flatDy=Math.sin(gDir)*gRad_N+gY_N;
                const tf=Transform.createTranslate(flatDx,flatDy)
                    .multiply(Transform.createTranslate(globalCx,globalCy))
                    .multiply(Transform.createRotate(radG))
                    .multiply(Transform.createTranslate(-globalCx,-globalCy));
                doc.executeCommand(DocumentCommand.createTransform(dupSel,tf));
            }

            const needsRot=Math.abs(dLRotR)>0.0001;
            const needsScale=Math.abs(fScX-1)>0.001||Math.abs(fScY-1)>0.001;
            if(scaleFirst){
                if(needsScale){const rcS=getRC(dup);const tf=Transform.createTranslate(rcS.x,rcS.y).multiply(Transform.createScale(fScX,fScY)).multiply(Transform.createTranslate(-rcS.x,-rcS.y));doc.executeCommand(DocumentCommand.createTransform(dupSel,tf));}
                if(needsRot){const rcR=getRC(dup);const tf=Transform.createTranslate(rcR.x,rcR.y).multiply(Transform.createRotate(dLRotR)).multiply(Transform.createTranslate(-rcR.x,-rcR.y));doc.executeCommand(DocumentCommand.createTransform(dupSel,tf));}
            } else {
                if(needsRot){const rcR=getRC(dup);const tf=Transform.createTranslate(rcR.x,rcR.y).multiply(Transform.createRotate(dLRotR)).multiply(Transform.createTranslate(-rcR.x,-rcR.y));doc.executeCommand(DocumentCommand.createTransform(dupSel,tf));}
                if(needsScale){const rcS=getRC(dup);let fScX_use=fScX;if(allowNeg&&needsRot){const m=getTFArr(dup);fScX_use=clampShearFactor(fScX,fScY,dLRotR,m);}const tf=Transform.createTranslate(rcS.x,rcS.y).multiply(Transform.createScale(fScX_use,fScY)).multiply(Transform.createTranslate(-rcS.x,-rcS.y));doc.executeCommand(DocumentCommand.createTransform(dupSel,tf));}
            }
            if(Math.abs(lRad_N)>0.0001){
                const lDir=lRadBaseDir+dLRotR;
                const lrx=Math.cos(lDir)*lRad_N, lry=Math.sin(lDir)*lRad_N;
                doc.executeCommand(DocumentCommand.createTransform(dupSel,Transform.createTranslate(lrx,lry)));
            }

            if((sH!==0||sS!==0||sL!==0)&&(params.changeFill||params.changeStroke)) applyHSLChange(dup,sH,sS,sL,params.changeFill,params.changeStroke,parent);
            if(sO!==0){try{doc.executeCommand(DocumentCommand.createSetOpacity(dupSel,clamp(origOpac+sO/100,0,1)));}catch(e){}}
            doc.executeCommand(DocumentCommand.createMoveNodes(dupSel,pgGrp,NodeMoveType.Inside,NodeChildType.Main));
        }
        if(params.shuffleOrder) shuffleChildrenOrder(pgGrp);
        else if(reverse) reverseChildrenOrder(pgGrp);
    }
    if(params.shuffleOrder&&subGroups.length>1) shuffleChildrenOrder(outerGroup);
    else if(reverse&&subGroups.length>1) reverseChildrenOrder(outerGroup);
    if(isPreview){
        try{const r=bbDiag*0.05/2;const mDef=ShapeNodeDefinition.create(ShapeEllipse.create(),{x:globalCx-r,y:globalCy-r,width:r*2,height:r*2},FillDescriptor.createSolid(Colour.createHSLAf({h:0,s:1,l:0.5,alpha:1})),null,null,null);mDef.userDescription='__PD_Marker__';const mb=AddChildNodesCommandBuilder.create();mb.addShapeNode(mDef);mb.setInsertionTarget(outerGroup);mb.setInsertionMode(1);const mc=mb.createCommand(false);doc.executeCommand(mc);markerNode=mc.newNodes[0];if(markerNode)moveToTop(markerNode,outerGroup);}catch(e){console.log('Marker error:'+e);}
    }
    return{outerGroup,markerNode};
}

const combinedBB=getCombinedBB(selectedNodes);
const{dlg,btnSave,btnLoad,btnDel,btnPreview,readParams,applyParams}=buildDialog(DEF);
let previewGroup=null,previewMarker=null;
let previewKey=null;   // v3: settings of the last shown preview
function cleanupPreview(){if(previewGroup){try{previewGroup.delete();}catch(e){}previewGroup=null;previewMarker=null;}previewKey=null;}
function deleteMarkerOnly(){if(previewMarker){try{previewMarker.delete();}catch(e){}previewMarker=null;}}
function doPreview(){
    cleanupPreview();
    const p=readParams();
    const r=performDuplicate(p,true,combinedBB);
    if(r){previewGroup=r.outerGroup;previewMarker=r.markerNode;previewKey=JSON.stringify(p);}
}
try{
    btnPreview.setOnClickHandler(()=>doPreview());
    btnSave.setOnClickHandler(()=>savePreset(readParams()));
    btnLoad.setOnClickHandler(()=>{const v=loadPreset();if(v){applyParams(v);}});
    btnDel.setOnClickHandler(()=>deletePreset());
}catch(e){}
doPreview();
const result=dlg.runModal();
if(result&&result.value===DialogResult.Ok.value){
    const p=readParams();
    // v3: only keep the preview if the settings haven't changed since
    if(previewGroup&&previewKey===JSON.stringify(p)){
        deleteMarkerOnly();
    } else {
        cleanupPreview();
        performDuplicate(p,false,combinedBB);
    }
    previewGroup=null;
} else {
    cleanupPreview();
}

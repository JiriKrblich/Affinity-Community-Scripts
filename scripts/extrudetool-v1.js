"use strict";
const { Document } = require("/document");
const { DocumentCommand, AddChildNodesCommandBuilder, CompoundCommandBuilder, NodeChildType, NodeMoveType } = require("/commands");
const { PolyCurve, CurveBuilder } = require("/geometry");
const { ContainerNodeDefinition, PolyCurveNodeDefinition } = require("/nodes");
const { Dialog, DialogResult } = require("/dialog");
const { Selection } = require("/selections");
const { FillDescriptor } = require("/fills");
const { LineStyleDescriptor } = require("/linestyle");
const { RGBA8 } = require("/colours");
const { BlendMode } = require("affinity:common");

const doc = Document.current;
if (!doc) { alert("No document open."); } else {

const mkSel = n => Selection.create(doc, n);
const undoN = n => { for (let i = 0; i < n; i++) doc.undo(); };
const lerp    = (a,b,t) => a+(b-a)*t;
const lerpPt  = (a,b,t) => ({x:lerp(a.x,b.x,t),y:lerp(a.y,b.y,t)});
const lerpSeg = (a,b,t) => ({start:lerpPt(a.start,b.start,t),c1:lerpPt(a.c1,b.c1,t),c2:lerpPt(a.c2,b.c2,t),end:lerpPt(a.end,b.end,t)});

function splitAt(seg,t){
  const p0=seg.start,p1=seg.c1,p2=seg.c2,p3=seg.end;
  const a=lerpPt(p0,p1,t),b=lerpPt(p1,p2,t),c=lerpPt(p2,p3,t);
  const d=lerpPt(a,b,t),e=lerpPt(b,c,t),f=lerpPt(d,e,t);
  return{left:{start:p0,c1:a,c2:d,end:f},right:{start:f,c1:e,c2:c,end:p3}};
}
function subdivide(segs,n){
  if(n<=1)return segs;
  const out=[];
  for(const seg of segs){let rem=seg;for(let i=0;i<n-1;i++){const{left,right}=splitAt(rem,1/(n-i));out.push(left);rem=right;}out.push(rem);}
  return out;
}
function extractSegs(node){
  try{
    const ci=node.curvesInterface;if(!ci)return null;
    const raw=ci.polyCurve;if(!raw||raw.curveCount===0)return null;
    const pc=raw.clone();pc.transform(node.baseToSpreadTransform);
    const curve=pc.at(0);const segs=[];
    for(const b of curve.beziers)segs.push({start:{x:b.start.x,y:b.start.y},c1:{x:b.c1.x,y:b.c1.y},c2:{x:b.c2.x,y:b.c2.y},end:{x:b.end.x,y:b.end.y}});
    return segs.length>0?{segs,closed:curve.isClosed,n:segs.length}:null;
  }catch(e){return null;}
}
function bestAlign(segsA,segsB){
  const n=segsA.length;if(n!==segsB.length||n===0)return segsB;
  let bestRot=0,bestDist=Infinity;
  for(let r=0;r<n;r++){let dist=0;for(let i=0;i<n;i++){const a=segsA[i].start,b=segsB[(i+r)%n].start;dist+=(a.x-b.x)**2+(a.y-b.y)**2;}if(dist<bestDist){bestDist=dist;bestRot=r;}}
  return bestRot===0?segsB:[...segsB.slice(bestRot),...segsB.slice(0,bestRot)];
}
function approxPerimeter(segs){
  let len=0;for(const s of segs){const chord=Math.hypot(s.end.x-s.start.x,s.end.y-s.start.y);const poly=Math.hypot(s.c1.x-s.start.x,s.c1.y-s.start.y)+Math.hypot(s.c2.x-s.c1.x,s.c2.y-s.c1.y)+Math.hypot(s.end.x-s.c2.x,s.end.y-s.c2.y);len+=(chord+poly)/2;}return len;
}
function segsCenter(segs){let cx=0,cy=0;for(const s of segs){cx+=s.start.x;cy+=s.start.y;}return{x:cx/segs.length,y:cy/segs.length};}

function capPC(segs,closed){const cb=CurveBuilder.create();cb.beginXY(segs[0].start.x,segs[0].start.y);for(const s of segs)cb.addBezierXY(s.c1.x,s.c1.y,s.c2.x,s.c2.y,s.end.x,s.end.y);if(closed)cb.close();const pc=new PolyCurve();pc.addCurve(cb.createCurve());return pc;}
function facePC(sA,sB){const cb=CurveBuilder.create();cb.beginXY(sA.start.x,sA.start.y);cb.addBezierXY(sA.c1.x,sA.c1.y,sA.c2.x,sA.c2.y,sA.end.x,sA.end.y);cb.lineToXY(sB.end.x,sB.end.y);cb.addBezierXY(sB.c2.x,sB.c2.y,sB.c1.x,sB.c1.y,sB.start.x,sB.start.y);cb.close();const pc=new PolyCurve();pc.addCurve(cb.createCurve());return pc;}
function mkNode(poly,fill,strokeFill,lsd){return PolyCurveNodeDefinition.create(poly,fill,lsd,strokeFill,FillDescriptor.createNone());}

// Signed area of face quad (shoelace, Y-down screen coords).
// Positive=CW=front-facing, Negative=CCW=back-facing.
function faceSignedArea(sA,sB){
  const pts=[sA.start,sA.end,sB.end,sB.start];let area=0;
  for(let k=0;k<4;k++){const p=pts[k],q=pts[(k+1)%4];area+=p.x*q.y-q.x*p.y;}
  return area/2;
}
// Signed area of closed path. Positive=CW, Negative=CCW in Y-down screen coords.
function pathSignedArea(segs){
  let area=0;for(const s of segs)area+=s.start.x*s.end.y-s.end.x*s.start.y;return area/2;
}

// --- Selection ---
const rawSel=doc.selection.nodes.toArray().filter(Boolean);
if(rawSel.length<2){alert("Select at least 2 shapes.");}else{

let shapes=rawSel.map(n=>{const d=extractSegs(n);return d?{node:n,d}:null;}).filter(Boolean);
if(shapes.length<2){alert("Could not read curves. Select vector shapes.");}else{

const N=shapes[0].d.n,bad=shapes.find(s=>s.d.n!==N);
if(bad){alert(`Shapes must have the same anchor count.\nFound: ${N} vs ${bad.d.n}\nConvert to curves first.`);}else{

// Sort: larger perimeter (60%) + HIGHER layer z-rank (40%).
// Top layer = most previousSiblings = higher zRank → (zRank/maxZ) gives high score.
{
  const sd=shapes.map(sh=>{
    const perim=approxPerimeter(sh.d.segs);
    let zRank=0;try{let p=sh.node.previousSibling,c=0;while(p){c++;p=p.previousSibling;}zRank=c;}catch(e){}
    return{sh,perim,zRank};
  });
  const maxP=Math.max(...sd.map(d=>d.perim))||1,maxZ=Math.max(...sd.map(d=>d.zRank))||1;
  sd.sort((a,b)=>{const sa=(a.perim/maxP)*0.6+(a.zRank/maxZ)*0.4,sb=(b.perim/maxP)*0.6+(b.zRank/maxZ)*0.4;return sb-sa;});
  shapes=sd.map(d=>d.sh);
}

// getActive: effective shape order based on swap, with deep-copied segs (no mutation of originals).
function getActive(swap){
  const base=swap?[...shapes].reverse():shapes;
  const active=base.map(sh=>({node:sh.node,d:{segs:[...sh.d.segs],closed:sh.d.closed,n:sh.d.n}}));
  if(active[0].d.closed)
    for(let i=1;i<active.length;i++) active[i].d.segs=bestAlign(active[i-1].d.segs,active[i].d.segs);
  return active;
}

// build(): generate side faces only — NO caps. Source shapes serve as visual caps.
// Returns allFaces[]{pc, depth, sa}.
function build(active,p){
  const allFaces=[];
  const sub=active.map(sh=>({segs:subdivide(sh.d.segs,p.subdivs)}));
  const subN=sub[0].segs.length;
  const cFront=segsCenter(active[0].d.segs),cBack=segsCenter(active[active.length-1].d.segs);
  const exDx=cBack.x-cFront.x,exDy=cBack.y-cFront.y,exLen=Math.hypot(exDx,exDy)||1;
  const exNx=exDx/exLen,exNy=exDy/exLen;
  for(let s=0;s<sub.length-1;s++){
    const A=sub[s].segs,B=sub[s+1].segs;
    for(let k=0;k<p.steps;k++){
      const t0=k/p.steps,t1=(k+1)/p.steps;
      const slA=A.map((a,i)=>lerpSeg(a,B[i],t0)),slB=A.map((a,i)=>lerpSeg(a,B[i],t1));
      for(let i=0;i<subN;i++){
        const cx=(slA[i].start.x+slA[i].end.x+slB[i].start.x+slB[i].end.x)/4;
        const cy=(slA[i].start.y+slA[i].end.y+slB[i].start.y+slB[i].end.y)/4;
        allFaces.push({pc:facePC(slA[i],slB[i]),depth:cx*exNx+cy*exNy,sa:faceSignedArea(slA[i],slB[i])});
      }
    }
  }
  return{allFaces};
}

// splitFaces: corrects for shape winding (CW vs CCW) so classification is always right.
// CW front shape (pathSA>0): front-facing faces have NEGATIVE sa → multiply by -1 to normalize.
function splitFaces(allFaces,active){
  const psa=pathSignedArea(active[0].d.segs);
  const fs=psa>0?-1:1; // frontSign
  return{frontFaces:allFaces.filter(f=>f.sa*fs>=0),backFaces:allFaces.filter(f=>f.sa*fs<0)};
}

// makeDefs: ascending depth sort (shallowest first=bottom, deepest last=TOP when added to canvas).
// Deepest face = most visible = should render on top.
function makeDefs(faces,fill,stroke,lsd){
  const mn=pc=>mkNode(pc,fill,stroke,lsd);
  return [...faces].sort((a,b)=>a.depth-b.depth).map(f=>mn(f.pc));
}

// readStyle: extract fill/stroke/lsd from source node, with opacity applied.
function readStyle(node,opacity){
  const f=opacity/100;
  let fill=FillDescriptor.createNone();
  try{const bfd=node.brushFillDescriptor;if(bfd&&bfd.type!=='none'&&bfd.fill?.colour){const c=bfd.fill.colour.rgba8;fill=FillDescriptor.createSolid(RGBA8(c.r,c.g,c.b,Math.min(255,Math.round(c.alpha*f))),BlendMode.Normal);}}catch(e){}
  let stroke=FillDescriptor.createNone();
  try{const pfd=node.penFillDescriptor;if(pfd&&pfd.type!=='none')stroke=pfd;}catch(e){}
  let lsd=null;try{lsd=node.lineStyleDescriptor;}catch(e){} if(!lsd)lsd=LineStyleDescriptor.createDefault(4.166);
  return{fill,stroke,lsd};
}

// --- PREVIEW ---
// Combine add-nodes + hide-shapes into ONE compound = 1 undo step.
// Canvas z-order: back defs first (bottom), front defs last (top=deepest face).
function doPreview(p){
  const active=getActive(p.swap);
  const{allFaces}=build(active,p);
  const{frontFaces,backFaces}=splitFaces(allFaces,active);
  const{fill,stroke,lsd}=readStyle(active[0].node,p.opacity);
  const fDefs=makeDefs(frontFaces,fill,stroke,lsd);
  const bDefs=makeDefs(backFaces, fill,stroke,lsd);
  // allDefs: back first (bottom), front last (top), deepest front face = very last = TOP
  const allDefs=[...bDefs,...fDefs];

  // Combine add + hide in ONE compound → 1 undo step
  const preview=CompoundCommandBuilder.create();
  if(allDefs.length>0){
    const addAb=AddChildNodesCommandBuilder.create();
    allDefs.forEach(d=>addAb.addNode(d));
    preview.addCommand(addAb.createCommand());
  }
  const hideCmds=CompoundCommandBuilder.create();
  shapes.forEach(sh=>hideCmds.addCommand(DocumentCommand.createSetVisibility(mkSel(sh.node),false)));
  preview.addCommand(hideCmds.createCommand());
  doc.executeCommand(preview.createCommand());
  return 1; // always 1 undo step
}

// --- APPLY ---
// Final structure (top→bottom): main shape | Front container | Back container | secondary shape.
// Source shapes stay in place; NO caps generated (source shapes are the visual caps).
//
// Undo steps:
//   Step 1: create containers + all curve nodes in ONE batch  (1 undo step)
//   Step 2: ONE compound = swap? + move curves into containers + position containers + rename + show  (1 undo step)
//   Total: 2 undo steps → user needs only 2 × Ctrl+Z to fully undo.
function doApply(p){
  const active=getActive(p.swap);
  const mainNode=active[0].node;
  const secNode =active[active.length-1].node;

  const{allFaces}=build(active,p);
  const{frontFaces,backFaces}=splitFaces(allFaces,active);
  const{fill,stroke,lsd}=readStyle(mainNode,p.opacity);

  // Ascending sort: shallowest[0]→bottom, deepest[F-1]→added last→TOP after moves
  const fDefs=makeDefs(frontFaces,fill,stroke,lsd); // fDefs[0]=shallowest, fDefs[F-1]=deepest
  const bDefs=makeDefs(backFaces, fill,stroke,lsd); // bDefs[0]=shallowest, bDefs[B-1]=deepest
  const F=fDefs.length,B=bDefs.length;
  if(F===0&&B===0){alert("No geometry generated.");return;}

  const parentNode=secNode.parent;

  // === STEP 1: Create containers + all curve nodes in ONE batch (1 undo step) ===
  // Addition order: Back cont (1st), Front cont (2nd), fDefs[0..F-1], bDefs[0..B-1]
  //
  // newNodes (0=last added=TOP):
  //   [0..B-1]   = bDefs in reverse: newNodes[0]=bDefs[B-1](deepest), newNodes[B-1]=bDefs[0](shallowest)
  //   [B..B+F-1] = fDefs in reverse: newNodes[B]=fDefs[F-1](deepest),  newNodes[B+F-1]=fDefs[0](shallowest)
  //   [B+F]      = Front container (2nd added)
  //   [B+F+1]    = Back container  (1st added)
  const allAb=AddChildNodesCommandBuilder.create();
  if(parentNode&&!parentNode.isSpreadNode) allAb.setInsertionTarget(parentNode);
  allAb.addContainerNode(ContainerNodeDefinition.create("Back"));   // 1st → newNodes[B+F+1]
  allAb.addContainerNode(ContainerNodeDefinition.create("Front"));  // 2nd → newNodes[B+F]
  fDefs.forEach(d=>allAb.addNode(d));  // fDefs[0..F-1] → newNodes[B+F-1..B]
  bDefs.forEach(d=>allAb.addNode(d));  // bDefs[0..B-1] → newNodes[B-1..0]
  const allCmd=allAb.createCommand(false,NodeChildType.Main);
  doc.executeCommand(allCmd);

  const frontCont=allCmd.newNodes[B+F];    // Front container
  const backCont =allCmd.newNodes[B+F+1];  // Back container

  // === STEP 2: Everything else in ONE compound (1 undo step) ===
  const compound=CompoundCommandBuilder.create();

  // Optional: swap source shapes z-positions (new main above new secondary)
  if(p.swap){
    compound.addCommand(DocumentCommand.createMoveNodes(mkSel(mainNode),secNode,NodeMoveType.After,NodeChildType.Main));
  }

  // Move front curves into frontCont (loop high→low so deepest/newNodes[B] moves LAST = TOP)
  // After moves in frontCont: newNodes[B]=fDefs[F-1](deepest)=TOP, newNodes[B+F-1]=fDefs[0]=BOTTOM
  for(let i=B+F-1;i>=B;i--){
    compound.addCommand(DocumentCommand.createMoveNodes(mkSel(allCmd.newNodes[i]),frontCont,NodeMoveType.Inside,NodeChildType.Main));
  }

  // Move back curves into backCont (loop high→low so deepest/newNodes[0] moves LAST = TOP)
  // After moves in backCont: newNodes[0]=bDefs[B-1](deepest)=TOP, newNodes[B-1]=bDefs[0]=BOTTOM
  for(let i=B-1;i>=0;i--){
    compound.addCommand(DocumentCommand.createMoveNodes(mkSel(allCmd.newNodes[i]),backCont,NodeMoveType.Inside,NodeChildType.Main));
  }

  // Position containers between source shapes.
  // NodeMoveType.After = just ABOVE the reference node in z-order.
  // Move Front just above secondary → ..., Front, secondary
  compound.addCommand(DocumentCommand.createMoveNodes(mkSel(frontCont),secNode,NodeMoveType.After,NodeChildType.Main));
  // Move Back just above secondary → ..., Front, Back, secondary ✓
  compound.addCommand(DocumentCommand.createMoveNodes(mkSel(backCont), secNode,NodeMoveType.After,NodeChildType.Main));

  // Rename by z-order (TOP=curve1 in each container).
  // frontCont: newNodes[B]=TOP(deepest fDef)=curve1, newNodes[B+F-1]=BOTTOM=curveF
  for(let i=0;i<F;i++) compound.addCommand(DocumentCommand.createSetDescription(mkSel(allCmd.newNodes[B+i]),`curve${i+1}`));
  // backCont: newNodes[0]=TOP(deepest bDef)=curve(F+1), newNodes[B-1]=BOTTOM=curve(F+B)
  for(let i=0;i<B;i++) compound.addCommand(DocumentCommand.createSetDescription(mkSel(allCmd.newNodes[i]),`curve${F+1+i}`));

  // Show source shapes (they were hidden in doPreview).
  shapes.forEach(sh=>compound.addCommand(DocumentCommand.createSetVisibility(mkSel(sh.node),true)));

  doc.executeCommand(compound.createCommand());
}

// --- Dialog ---
const dlg=Dialog.create("Extrude Tool");
const col=dlg.addColumn();

const gBlend=col.addGroup("Blend");
const eSteps  =gBlend.addUnitValueEditor("Steps",      "","", 1,1,20); eSteps.precision=0;
const eSubdivs=gBlend.addUnitValueEditor("Smoothness", "","", 5,1,16); eSubdivs.precision=0;

const gStyle=col.addGroup("Style");
const eOp=gStyle.addUnitValueEditor("Opacity (%)","","%",100,0,100); eOp.precision=0;

const gOpts=col.addGroup("Options");
const sSwap=gOpts.addSwitch("Swap Main/Secondary",false);

const gEnd=col.addGroup(""); gEnd.enableSeparator=true;
const btns=gEnd.addButtonSet("",["Preview","Apply"],0);

const getP=()=>({
  steps:   Math.max(1,Math.round(eSteps.value)),
  subdivs: Math.max(1,Math.round(eSubdivs.value)),
  opacity: eOp.value,
  swap:    sSwap.value
});

let previewSteps=doPreview(getP()),running=true;
while(running){
  btns.selectedIndex=0;
  const res=dlg.show(),p=getP();
  if(res.value===DialogResult.Ok.value){
    undoN(previewSteps);
    if(btns.selectedIndex===1){doApply(p);running=false;}
    else previewSteps=doPreview(p);
  }else{undoN(previewSteps);running=false;}
}

}}}}

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

// Approximate arc length of a single bezier segment.
function approxSegLen(s){
  return(Math.hypot(s.end.x-s.start.x,s.end.y-s.start.y)+
         Math.hypot(s.c1.x-s.start.x,s.c1.y-s.start.y)+
         Math.hypot(s.c2.x-s.c1.x,s.c2.y-s.c1.y)+
         Math.hypot(s.end.x-s.c2.x,s.end.y-s.c2.y))/2;
}

// Upsample segs to targetN by splitting the longest segment at its midpoint repeatedly.
// Preserves curve shape exactly — only inserts anchor points, never removes.
function resampleToCount(segs,targetN){
  const result=segs.map(s=>({...s}));
  while(result.length<targetN){
    let maxLen=-1,maxIdx=0;
    for(let i=0;i<result.length;i++){const l=approxSegLen(result[i]);if(l>maxLen){maxLen=l;maxIdx=i;}}
    const{left,right}=splitAt(result[maxIdx],0.5);
    result.splice(maxIdx,1,left,right);
  }
  return result;
}

function facePC(sA,sB){const cb=CurveBuilder.create();cb.beginXY(sA.start.x,sA.start.y);cb.addBezierXY(sA.c1.x,sA.c1.y,sA.c2.x,sA.c2.y,sA.end.x,sA.end.y);cb.lineToXY(sB.end.x,sB.end.y);cb.addBezierXY(sB.c2.x,sB.c2.y,sB.c1.x,sB.c1.y,sB.start.x,sB.start.y);cb.close();const pc=new PolyCurve();pc.addCurve(cb.createCurve());return pc;}
function mkNode(poly,fill,strokeFill,lsd){return PolyCurveNodeDefinition.create(poly,fill,lsd,strokeFill,FillDescriptor.createNone());}

// Signed area of face quad. Positive=CW=front-facing in Y-down coords.
function faceSignedArea(sA,sB){
  const pts=[sA.start,sA.end,sB.end,sB.start];let area=0;
  for(let k=0;k<4;k++){const p=pts[k],q=pts[(k+1)%4];area+=p.x*q.y-q.x*p.y;}
  return area/2;
}
// Signed area of closed path. Positive=CW in Y-down coords.
function pathSignedArea(segs){
  let area=0;for(const s of segs)area+=s.start.x*s.end.y-s.end.x*s.start.y;return area/2;
}

// --- Selection ---
const rawSel=doc.selection.nodes.toArray().filter(Boolean);
if(rawSel.length<2){alert("Select at least 2 shapes.");}else{

let shapes=rawSel.map(n=>{const d=extractSegs(n);return d?{node:n,d}:null;}).filter(Boolean);
if(shapes.length<2){alert("Could not read curves. Select vector shapes.");}else{

// Normalize all shapes to the same anchor count (maxN).
// Shapes with fewer points are upsampled by splitting their longest segments.
{
  const maxN=Math.max(...shapes.map(s=>s.d.n));
  shapes=shapes.map(sh=>{
    if(sh.d.n<maxN){
      const resampled=resampleToCount(sh.d.segs,maxN);
      return{node:sh.node,d:{segs:resampled,closed:sh.d.closed,n:maxN}};
    }
    return sh;
  });
}

// Sort: larger perimeter (60%) + higher layer z-rank (40%).
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

function getActive(swap){
  const base=swap?[...shapes].reverse():shapes;
  const active=base.map(sh=>({node:sh.node,d:{segs:[...sh.d.segs],closed:sh.d.closed,n:sh.d.n}}));
  if(active[0].d.closed)
    for(let i=1;i<active.length;i++) active[i].d.segs=bestAlign(active[i-1].d.segs,active[i].d.segs);
  return active;
}

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

function splitFaces(allFaces,active){
  const psa=pathSignedArea(active[0].d.segs);
  const fs=psa>0?-1:1;
  return{frontFaces:allFaces.filter(f=>f.sa*fs>=0),backFaces:allFaces.filter(f=>f.sa*fs<0)};
}

// makeDefs: ascending depth sort → [0]=shallowest (bottom), [N-1]=deepest (top).
function makeDefs(faces,fill,stroke,lsd){
  const mn=pc=>mkNode(pc,fill,stroke,lsd);
  return [...faces].sort((a,b)=>a.depth-b.depth).map(f=>mn(f.pc));
}

function readStyle(node,opacity){
  const f=opacity/100;
  let fill=FillDescriptor.createNone();
  try{const bfd=node.brushFillDescriptor;if(bfd&&bfd.type!=='none'&&bfd.fill?.colour){const c=bfd.fill.colour.rgba8;fill=FillDescriptor.createSolid(RGBA8(c.r,c.g,c.b,Math.min(255,Math.round(c.alpha*f))),BlendMode.Normal);}}catch(e){}
  let stroke=FillDescriptor.createNone();
  try{const pfd=node.penFillDescriptor;if(pfd&&pfd.type!=='none')stroke=pfd;}catch(e){}
  let lsd=null;try{lsd=node.lineStyleDescriptor;}catch(e){} if(!lsd)lsd=LineStyleDescriptor.createDefault(4.166);
  return{fill,stroke,lsd};
}

// --- PREVIEW v2 ---
// Source shapes stay VISIBLE — no hiding/showing.
//
// Strategy: add all face nodes to same parent as secNode, then move them ALL
// to be just above secNode (leaving mainNode untouched above them).
//
// Insertion order into the compound: deepest face FIRST (i=0), shallowest LAST (i=N-1).
// Each move is "After secNode" = just above secNode.
// Sequentially: each new insert goes just above secNode, pushing the previous up.
// Final z-order: secNode | shallowest | ... | deepest | mainNode (untouched, still on top)
//
// Returns 2 undo steps (or 0 if no geometry).
function doPreview(p){
  const active=getActive(p.swap);
  const{allFaces}=build(active,p);
  const{frontFaces,backFaces}=splitFaces(allFaces,active);
  const{fill,stroke,lsd}=readStyle(active[0].node,p.opacity);
  const fDefs=makeDefs(frontFaces,fill,stroke,lsd); // [0]=shallowest, [F-1]=deepest
  const bDefs=makeDefs(backFaces, fill,stroke,lsd); // [0]=shallowest, [B-1]=deepest
  // allDefs: back ascending then front ascending (back bottom, front top)
  const allDefs=[...bDefs,...fDefs];
  if(allDefs.length===0)return 0;

  const secNode=active[active.length-1].node;
  const parentNode=secNode.parent;

  // Step 1: Add all face nodes to same parent as secNode (lands above everything).
  // Addition order: allDefs[0] first, allDefs[N-1] last.
  // newNodes: [0]=last-added=allDefs[N-1]=deepest_front (TOP of added)
  //           [N-1]=first-added=allDefs[0]=shallowest_back (BOTTOM of added)
  const addAb=AddChildNodesCommandBuilder.create();
  if(parentNode&&!parentNode.isSpreadNode)addAb.setInsertionTarget(parentNode);
  allDefs.forEach(d=>addAb.addNode(d));
  const addCmd=addAb.createCommand();
  doc.executeCommand(addCmd);

  // Step 2: Move all faces to be just above secNode.
  // Loop i=0..N-1: newNodes[0]=deepest_front moved first, newNodes[N-1]=shallowest_back moved last.
  // Each "After secNode" inserts just above secNode, shifting previous faces up.
  // Result: secNode | shallowest_back | ... | deepest_back | shallowest_front | ... | deepest_front | mainNode
  const N=allDefs.length;
  const compound=CompoundCommandBuilder.create();
  for(let i=0;i<N;i++){
    compound.addCommand(
      DocumentCommand.createMoveNodes(mkSel(addCmd.newNodes[i]),secNode,NodeMoveType.After,NodeChildType.Main)
    );
  }
  doc.executeCommand(compound.createCommand());

  return 2;
}

// --- APPLY ---
// Final structure (top→bottom): mainNode | Front container | Back container | secNode.
// Source shapes always visible.
//
// Step 1: create containers + all curve nodes in ONE batch  (1 undo step)
// Step 2: ONE compound = move curves into containers + position containers + rename  (1 undo step)
// Total: 2 undo steps.
function doApply(p){
  const active=getActive(p.swap);
  const mainNode=active[0].node;
  const secNode =active[active.length-1].node;

  const{allFaces}=build(active,p);
  const{frontFaces,backFaces}=splitFaces(allFaces,active);
  const{fill,stroke,lsd}=readStyle(mainNode,p.opacity);

  const fDefs=makeDefs(frontFaces,fill,stroke,lsd);
  const bDefs=makeDefs(backFaces, fill,stroke,lsd);
  const F=fDefs.length,B=bDefs.length;
  if(F===0&&B===0){alert("No geometry generated.");return;}

  const parentNode=secNode.parent;

  // === STEP 1: Create containers + all curve nodes in ONE batch ===
  // Addition order: Back cont (1st), Front cont (2nd), fDefs[0..F-1], bDefs[0..B-1]
  // newNodes (0=last added=TOP):
  //   [0..B-1]   = bDefs reversed: [0]=bDefs[B-1](deepest),  [B-1]=bDefs[0](shallowest)
  //   [B..B+F-1] = fDefs reversed: [B]=fDefs[F-1](deepest),   [B+F-1]=fDefs[0](shallowest)
  //   [B+F]      = Front container
  //   [B+F+1]    = Back container
  const allAb=AddChildNodesCommandBuilder.create();
  if(parentNode&&!parentNode.isSpreadNode)allAb.setInsertionTarget(parentNode);
  allAb.addContainerNode(ContainerNodeDefinition.create("Back"));
  allAb.addContainerNode(ContainerNodeDefinition.create("Front"));
  fDefs.forEach(d=>allAb.addNode(d));
  bDefs.forEach(d=>allAb.addNode(d));
  const allCmd=allAb.createCommand(false,NodeChildType.Main);
  doc.executeCommand(allCmd);

  const frontCont=allCmd.newNodes[B+F];
  const backCont =allCmd.newNodes[B+F+1];

  // === STEP 2: ONE compound ===
  const compound=CompoundCommandBuilder.create();

  if(p.swap){
    compound.addCommand(DocumentCommand.createMoveNodes(mkSel(mainNode),secNode,NodeMoveType.After,NodeChildType.Main));
  }

  // Move front curves into frontCont (high→low so deepest ends up TOP inside container)
  for(let i=B+F-1;i>=B;i--){
    compound.addCommand(DocumentCommand.createMoveNodes(mkSel(allCmd.newNodes[i]),frontCont,NodeMoveType.Inside,NodeChildType.Main));
  }

  // Move back curves into backCont (high→low so deepest ends up TOP inside container)
  for(let i=B-1;i>=0;i--){
    compound.addCommand(DocumentCommand.createMoveNodes(mkSel(allCmd.newNodes[i]),backCont,NodeMoveType.Inside,NodeChildType.Main));
  }

  // Position containers: secNode | backCont | frontCont | mainNode
  // "After secNode" = just above secNode. Move frontCont first, then backCont (backCont ends up just above secNode).
  compound.addCommand(DocumentCommand.createMoveNodes(mkSel(frontCont),secNode,NodeMoveType.After,NodeChildType.Main));
  compound.addCommand(DocumentCommand.createMoveNodes(mkSel(backCont), secNode,NodeMoveType.After,NodeChildType.Main));

  // Rename curves by z-order within each container (deepest = curve1 = rendered on TOP).
  for(let i=0;i<F;i++) compound.addCommand(DocumentCommand.createSetDescription(mkSel(allCmd.newNodes[B+i]),`curve${i+1}`));
  for(let i=0;i<B;i++) compound.addCommand(DocumentCommand.createSetDescription(mkSel(allCmd.newNodes[i]),`curve${F+1+i}`));

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

}}}
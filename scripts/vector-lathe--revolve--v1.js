
// Vector Lathe (Revolve) v11
// Changes vs v10:
// — Shading INVERTED: nz = (z-zMn)/zRng  (was 1-...)
//   → high-z faces (convex/far sides) = lighter = highlight
//   → low-z faces  (front center)     = darker  = shadow
// — Segmentation checkbox REMOVED — containers always created (extrudetool-v2 style)
// — Structure: Cap(back) | Visible | Cap(front) — automatic, in both preview and apply
// — All faces use shadedFill (not color-coded) with inverted shading
// — Caps use same inverted shadedFill as faces
// Select a path first, then run.

const { Document }                    = require('/document');
const { DocumentCommand,
        AddChildNodesCommandBuilder }  = require('/commands');
const { PolyCurve, CurveBuilder }     = require('/geometry');
const { Dialog, DialogResult }        = require('/dialog');
const { PolyCurveNodeDefinition,
        ContainerNodeDefinition }     = require('/nodes');
const { UnitType }                    = require('/units');
const { Colour }                      = require('/colours');
const { FillDescriptor, FillType }    = require('/fills');

const doc=Document.current,sel=doc?[...doc.selection.nodes]:[];
const src=sel[0];
if(!doc||!src||!src.polyCurve){console.log('ERROR: Select a vector path first');}
else{

// placement offset (artboard-safe)
var sbb=src.getSpreadBaseBox(false),lbb=src.baseBox;
var ox=sbb.x-lbb.x,oy=sbb.y-lbb.y;
var rawPC=src.polyCurve;

// bezier profile sampling
function buildProfile(sps){
  var out=[];
  for(var ci=0;ci<rawPC.curveCount;ci++){
    var crv=rawPC.at(ci),bezs=[...crv.beziers];
    if(!bezs.length){for(var ni=0;ni<crv.nodes.length;ni++){var n=crv.nodes[ni];out.push({x:n.position.x+ox,y:n.position.y+oy});}continue;}
    for(var bi=0;bi<bezs.length;bi++){var b=bezs[bi];
      for(var si=0;si<sps;si++){var t=si/sps,u=1-t;
        out.push({x:u*u*u*b.start.x+3*u*u*t*b.c1.x+3*u*t*t*b.c2.x+t*t*t*b.end.x+ox,
                  y:u*u*u*b.start.y+3*u*u*t*b.c1.y+3*u*t*t*b.c2.y+t*t*t*b.end.y+oy});}
    }
    var lb=bezs[bezs.length-1];out.push({x:lb.end.x+ox,y:lb.end.y+oy});
  }
  return out;
}

// source style
var srcBrush=src.brushFillDescriptor,srcPen=src.penFillDescriptor;
var srcLine=src.lineStyleDescriptor,noF=FillDescriptor.createNone();
var bH=0.60,bS=0.70,bL=0.50,bA=1.0;
try{if(src.hasBrushFill&&srcBrush.fillType.value===FillType.Solid.value){
  var hsl=srcBrush.fill.colour.hslaf;bH=hsl.h;bS=Math.max(0.30,hsl.s);
  bL=Math.max(0.15,Math.min(0.85,hsl.l));bA=hsl.alpha;}}catch(e){}

// INVERTED shading: nz = (z-zMn)/zRng
// High-z (positive, convex outer surface) → nz→1 → lighter = highlight
// Low-z  (negative, center front)         → nz→0 → darker  = shadow
function shadedFill(nz){
  var l=Math.max(0.05,Math.min(0.95,bL-0.30+nz*0.60));
  return FillDescriptor.createSolid(Colour.createHSLAf({h:bH,s:bS,l:l,alpha:bA}));
}

// 3D revolve + Euler X→Y→Z
function rev3D(p,theta,axX,cenY,twR,Xr,Yr,Zr,mnY,yR){
  var r=p.x-axX,vp=(p.y-mnY)/yR,ft=theta+vp*twR;
  var lx=r*Math.cos(ft),ly=p.y-cenY,lz=r*Math.sin(ft);
  var y1=ly*Math.cos(Xr)-lz*Math.sin(Xr),z1=ly*Math.sin(Xr)+lz*Math.cos(Xr);
  var x2=lx*Math.cos(Yr)+z1*Math.sin(Yr),z2=-lx*Math.sin(Yr)+z1*Math.cos(Yr);
  var x3=x2*Math.cos(Zr)-y1*Math.sin(Zr),y3=x2*Math.sin(Zr)+y1*Math.cos(Zr);
  return{x:axX+x3,y:cenY+y3,z:z2};
}
// Shoelace quad: >0 backfacing, ≤0 frontfacing
function quadArea(A,B,C,D){return 0.5*((A.x*(B.y-D.y))+(B.x*(C.y-A.y))+(C.x*(D.y-B.y))+(D.x*(A.y-C.y)));}
// average Z of a ring
function avgZRing(ring){var z=0;for(var i=0;i<ring.length;i++)z+=ring[i].z;return z/ring.length;}

// node factories
function mkFace(A,B,C,D,fill){
  var cb=new CurveBuilder();cb.beginXY(A.x,A.y);cb.lineToXY(B.x,B.y);cb.lineToXY(C.x,C.y);cb.lineToXY(D.x,D.y);cb.close();
  var pc=new PolyCurve();pc.addCurve(cb.createCurve());
  var df=PolyCurveNodeDefinition.createDefault();df.setCurves(pc);
  df.setBrushFillDescriptor(0,fill);df.setLineDescriptors(0,noF,srcLine);return df;
}
function mkCap(ring,fill){
  var cb=new CurveBuilder();cb.beginXY(ring[0].x,ring[0].y);
  for(var i=1;i<ring.length;i++)cb.lineToXY(ring[i].x,ring[i].y);cb.close();
  var pc=new PolyCurve();pc.addCurve(cb.createCurve());
  var df=PolyCurveNodeDefinition.createDefault();df.setCurves(pc);
  df.setBrushFillDescriptor(0,fill);df.setLineDescriptors(0,noF,srcLine);return df;
}
function mkWire(pts,closed){
  var cb=new CurveBuilder();cb.beginXY(pts[0].x,pts[0].y);
  for(var i=1;i<pts.length;i++)cb.lineToXY(pts[i].x,pts[i].y);if(closed)cb.close();
  var pc=new PolyCurve();pc.addCurve(cb.createCurve());
  var df=PolyCurveNodeDefinition.createDefault();df.setCurves(pc);
  df.setBrushFillDescriptor(0,srcBrush);df.setLineDescriptors(0,srcPen,srcLine);return df;
}
function addNodes(tgt,defs){
  if(!defs.length)return 0;
  var b=AddChildNodesCommandBuilder.create();b.autoName=true;b.setInsertionTarget(tgt);
  for(var i=0;i<defs.length;i++)b.addPolyCurveNode(defs[i]);
  doc.executeCommand(b.createCommand(true));return 1;
}

var spread=doc.currentSpread;

// ── MAIN ──────────────────────────────────────────────────────────
function applyLathe(deg,steps,sps,axOff,Xd,Yd,Zd,tw,solidMode,capsOn,wires,hoops){
  var prof=buildProfile(sps),nP=prof.length;
  if(nP<2)return 0;

  var mnX=Infinity,mxX=-Infinity,mnY=Infinity,mxY=-Infinity;
  for(var i=0;i<nP;i++){var p=prof[i];if(p.x<mnX)mnX=p.x;if(p.x>mxX)mxX=p.x;if(p.y<mnY)mnY=p.y;if(p.y>mxY)mxY=p.y;}
  var yR=(mxY-mnY)||1,axX=mnX+axOff,cenY=(mnY+mxY)/2;
  var Xr=Xd*Math.PI/180,Yr=Yd*Math.PI/180,Zr=Zd*Math.PI/180,twR=tw*Math.PI/180;

  var grid=[];
  for(var s=0;s<=steps;s++){
    var theta=(s/steps)*deg*Math.PI/180,row=[];
    for(var qi=0;qi<nP;qi++)row.push(rev3D(prof[qi],theta,axX,cenY,twR,Xr,Yr,Zr,mnY,yR));
    grid.push(row);
  }

  // WIREFRAME
  if(!solidMode){
    var b=AddChildNodesCommandBuilder.create();b.autoName=true;b.setInsertionTarget(spread);
    if(wires)for(var sw=0;sw<=steps;sw++)b.addPolyCurveNode(mkWire(grid[sw],false));
    if(hoops){var cl=deg>=360;for(var qw=0;qw<nP;qw++){var rg=[];for(var sw2=0;sw2<=steps;sw2++)rg.push(grid[sw2][qw]);b.addPolyCurveNode(mkWire(rg,cl));}}
    doc.executeCommand(b.createCommand(true));return 1;
  }

  // frontfacing quads only (Shoelace ≤ 0)
  var visFaces=[];
  for(var sf=0;sf<steps;sf++){for(var qf=0;qf<nP-1;qf++){
    var A=grid[sf][qf],B=grid[sf+1][qf],C=grid[sf+1][qf+1],D=grid[sf][qf+1];
    if(quadArea(A,B,C,D)<=0)
      visFaces.push({A:A,B:B,C:C,D:D,z:(A.z+B.z+C.z+D.z)*0.25});
  }}

  // caps — always both rings, z-ordered
  var capClose=null,capFar=null;
  if(capsOn&&deg>=360){
    var rT=[],rB=[];
    for(var sc=0;sc<steps;sc++){rT.push(grid[sc][0]);rB.push(grid[sc][nP-1]);}
    var zT=avgZRing(rT),zB=avgZRing(rB);
    if(zT<=zB){capClose={ring:rT,z:zT};capFar={ring:rB,z:zB};}
    else       {capClose={ring:rB,z:zB};capFar={ring:rT,z:zT};}
  }

  // merge all for global z-range (for shading)
  var all=[];
  for(var fi=0;fi<visFaces.length;fi++)all.push({face:visFaces[fi],z:visFaces[fi].z,isCap:false});
  if(capFar)   all.push({cap:capFar.ring,   z:capFar.z,   isCap:true,isFar:true});
  if(capClose) all.push({cap:capClose.ring, z:capClose.z, isCap:true,isFar:false});

  var zMn=Infinity,zMx=-Infinity;
  for(var ai=0;ai<all.length;ai++){if(all[ai].z<zMn)zMn=all[ai].z;if(all[ai].z>zMx)zMx=all[ai].z;}
  var zRng=(zMx-zMn)||1;

  // INVERTED: nz = (z-zMn)/zRng → high z = lighter
  function nzFor(z){return(z-zMn)/zRng;}

  // sort painter: largest z first → added first → bottom layer (behind)
  all.sort(function(a,b){return b.z-a.z;});

  // ── CONTAINERS (always, extrudetool-v2 style) ─────────────────────
  // Layer order bottom→top: Cap(back) | Visible | Cap(front)
  var hasFar=!!capFar,hasClose=!!capClose;
  var bc=AddChildNodesCommandBuilder.create();bc.autoName=true;bc.setInsertionTarget(spread);
  if(hasFar)   bc.addContainerNode(ContainerNodeDefinition.createDefault()); // Cap(back)  → bottom
  bc.addContainerNode(ContainerNodeDefinition.createDefault());               // Visible    → middle
  if(hasClose) bc.addContainerNode(ContainerNodeDefinition.createDefault()); // Cap(front) → top
  var cmd=bc.createCommand(true);doc.executeCommand(cmd);var cc=1;

  var idx=0,capCloseCont=null,visCont,capFarCont=null;
  if(hasClose){capCloseCont=cmd.newNodes[idx];capCloseCont.name='Cap (front)';idx++;}
  visCont=cmd.newNodes[idx];visCont.name='Visible';idx++;
  if(hasFar){capFarCont=cmd.newNodes[idx];capFarCont.name='Cap (back)';}

  // build node defs per container (painter order: largest z = first = bottom of container)
  var visDefs=[],capFarDefs=[],capCloseDefs=[];
  for(var ai2=0;ai2<all.length;ai2++){
    var e=all[ai2],fill=shadedFill(nzFor(e.z));
    if(!e.isCap)    visDefs.push(mkFace(e.face.A,e.face.B,e.face.C,e.face.D,fill));
    else if(e.isFar) capFarDefs.push(mkCap(e.cap,fill));
    else             capCloseDefs.push(mkCap(e.cap,fill));
  }

  cc+=addNodes(visCont,visDefs);
  if(hasFar&&capFarCont)     cc+=addNodes(capFarCont,capFarDefs);
  if(hasClose&&capCloseCont) cc+=addNodes(capCloseCont,capCloseDefs);
  return cc;
}

// ── DIALOG ────────────────────────────────────────────────────────
var dlg=Dialog.create('Vector Lathe');var col=dlg.addColumn();
var mGrp=col.addGroup('Render Mode');var mBtns=mGrp.addButtonSet('',['Wireframe','Solid Fill'],1);
var rGrp=col.addGroup('Revolve');
var angC=rGrp.addUnitValueEditor('Angle',         UnitType.Degree,UnitType.Degree,360,1,  360);
var stpC=rGrp.addUnitValueEditor('Steps',         UnitType.Point, UnitType.Point,  16,3,   64);
var detC=rGrp.addUnitValueEditor('Profile Detail',UnitType.Point, UnitType.Point,   4,1,   16);
var axC =rGrp.addUnitValueEditor('Axis Offset',   UnitType.Point, UnitType.Point,   0,-500,500);
var rotG=col.addGroup('3D Rotation');
var Xc=rotG.addUnitValueEditor('X (pitch)',UnitType.Degree,UnitType.Degree,0,-360,360);
var Yc=rotG.addUnitValueEditor('Y (yaw)',  UnitType.Degree,UnitType.Degree,0,-360,360);
var Zc=rotG.addUnitValueEditor('Z (roll)', UnitType.Degree,UnitType.Degree,0,-360,360);
var twC=rotG.addUnitValueEditor('Twist',   UnitType.Degree,UnitType.Degree,0,-360,360);
var oGrp=col.addGroup('Options');
var capCk=oGrp.addCheckBox('End Caps',true);
var wfGrp=col.addGroup('Wireframe');
var wirCk=wfGrp.addCheckBox('Profile wires',true);
var hopCk=wfGrp.addCheckBox('Ring hoops',  true);
wirCk.setIsEnabledByWithSelectedIndex(mBtns,0);
hopCk.setIsEnabledByWithSelectedIndex(mBtns,0);
capCk.setIsEnabledByWithSelectedIndex(mBtns,1);
var bGrp=col.addGroup('');bGrp.enableSeparator=true;
var aBtns=bGrp.addButtonSet('',['Preview','Apply'],0);

var pc0=applyLathe(360,16,4,0,0,0,0,0,true,true,true,true);
var pAct=pc0>0,run=true;

while(run){
  aBtns.selectedIndex=0;var r=dlg.show();
  var deg=angC.value,st=Math.max(3,Math.round(stpC.value));
  var sps=Math.max(1,Math.round(detC.value)),ax=axC.value;
  var Xd=Xc.value,Yd=Yc.value,Zd=Zc.value,tw=twC.value;
  var sol=mBtns.selectedIndex===1,cap=capCk.value&&sol;
  var wir=wirCk.value,hop=hopCk.value,md=aBtns.selectedIndex;

  if(r.value===DialogResult.Ok.value){
    if(pAct)for(var u=0;u<pc0;u++)doc.executeCommand(DocumentCommand.createUndo());
    pc0=applyLathe(deg,st,sps,ax,Xd,Yd,Zd,tw,sol,cap,wir,hop);
    pAct=pc0>0;if(md===1)run=false;
  }else{
    if(pAct)for(var u2=0;u2<pc0;u2++)doc.executeCommand(DocumentCommand.createUndo());
    pAct=false;run=false;
  }
}
console.log('Done');
}

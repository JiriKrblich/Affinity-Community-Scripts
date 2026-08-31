
'use strict';
// Warp into Shape Group v64-EN
// English GUI variant of "Form in Verzerrungsgruppe v64". All logic and
// math are identical - only dialog texts, group/node names translated.
// Includes: (1) new "Hide base shape" option in Path Mode, (2) removed
// the redundant Preview/Apply/Cancel buttons in favour of the native
// dialog OK/Cancel footer (live preview still runs automatically on
// every change), (3) fix for a nested-modal-dialog bug that silently
// swallowed the "object not converted to curves" warning - status/error
// messages are now shown inline as text instead of a nested dialog.

const { Document }                    = require('/document');
const { DocumentCommand,
        AddChildNodesCommandBuilder } = require('/commands');
const { Selection }                   = require('/selections');
const { Dialog, DialogResult }        = require('/dialog');
const { ContainerNodeDefinition,
        PolyCurveNodeDefinition,
        NodeChildType }               = require('/nodes');
const { FillDescriptor }              = require('/fills');
const { CurveBuilder, PolyCurve, Transform } = require('/geometry');
const { LineStyleDescriptor }         = require('/linestyle');
const { Colour }                      = require('/colours');
const { File, createDirectories }     = require('/fs');
const { app }                         = require('/application');

const MOVE_INSIDE = 2;
const MOVE_AFTER  = 0;

// ── Transform ─────────────────────────────────────────────────────────────────
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
        applyToPoint(pt){
            let p=pt;
            for(let i=0;i<chain.length;i++)p=chain[i].applyToPoint(p);
            return p;
        }
    };
}
function bestTransform(node){
    return composedSpreadTF(node);
}
function readNodeCurvesSpread(node){
    const ci=node.curvesInterface;if(!ci||!ci.isMutable)return null;
    const tf=bestTransform(node);
    const pc=ci.polyCurve,curves=[];
    for(let c=0;c<pc.curveCount;c++){
        const cu=pc.at(c);
        curves.push({bzs:cu.beziers.toArray().map(bz=>({
            start:tf.applyToPoint(bz.start),c1:tf.applyToPoint(bz.c1),
            c2:tf.applyToPoint(bz.c2),end:tf.applyToPoint(bz.end)
        })),isClosed:cu.isClosed});
    }
    return curves.length?curves:null;
}

// ── Klassifizierung ───────────────────────────────────────────────────────────

function classifyLeaf(node){
    const ci=node.curvesInterface;
    if(ci&&ci.isMutable&&node.isPolyCurveNode)return'curve';
    if(ci&&!ci.isMutable)return'shape';
    return'dup';
}
function findFirstShape(node){
    const tag=node[Symbol.toStringTag]||'';
    if(node.isGroupNode||tag==='GroupNode'){
        const kids=[];for(const ch of node.children)kids.push(ch);
        for(const ch of kids){const bad=findFirstShape(ch);if(bad)return bad;}
        return null;
    }
    if(classifyLeaf(node)==='shape')
        return node.userDescription||node.defaultDescription||tag||'Unbekannt';
    return null;
}
function collectAllItems(node){
    const results=[];
    const tag=node[Symbol.toStringTag]||'';
    if(node.isGroupNode||tag==='GroupNode'){
        const kids=[];for(const ch of node.children)kids.push(ch);
        for(const ch of kids)results.push(...collectAllItems(ch));
        return results;
    }
    const cls=classifyLeaf(node);
    if(cls==='curve'){
        const curves=readNodeCurvesSpread(node);
        if(curves){
            let fd=null,pfd=null,ls=null;
            try{fd=node.brushFillDescriptor;}catch(e){}
            try{pfd=node.penFillDescriptor;}catch(e){}
            try{ls=node.lineStyleDescriptor;}catch(e){}
            const childDups=[];
            const kidsBuf=[];try{for(const ch of node.children)kidsBuf.push(ch);}catch(e){}
            for(const ch of kidsBuf){
                if(classifyLeaf(ch)==='dup') childDups.push(ch);
                else results.push(...collectAllItems(ch));
            }
            results.push({type:'curve',curves,fd,pfd,ls,childDups,srcNode:node});
        }
    } else if(cls==='dup'){
        results.push({type:'dup',node,childDups:[]});
    }
    return results;
}

function autoDetectRoles(nodeA, nodeB){
    function isClosedCurve(n){
        const ci=n.curvesInterface;
        if(!ci||!ci.isMutable||!n.isPolyCurveNode)return false;
        const pc=ci.polyCurve;
        if(pc.curveCount===0)return false;
        for(let c=0;c<pc.curveCount;c++){if(!pc.at(c).isClosed)return false;}
        return true;
    }
    const aC=isClosedCurve(nodeA),bC=isClosedCurve(nodeB);
    if(aC&&!bC)return{formNode:nodeA,objNode:nodeB};
    if(bC&&!aC)return{formNode:nodeB,objNode:nodeA};
    return null;
}

// ── Kontur-Berechnung (Flächen-Warp) ──────────────────────────────────────────

function bzPt(bz,t){const mt=1-t;return{
    x:mt*mt*mt*bz.start.x+3*mt*mt*t*bz.c1.x+3*mt*t*t*bz.c2.x+t*t*t*bz.end.x,
    y:mt*mt*mt*bz.start.y+3*mt*mt*t*bz.c1.y+3*mt*t*t*bz.c2.y+t*t*t*bz.end.y};}

function getNodeCurvesSpreadForContour(node){
    const ci=node.curvesInterface;if(!ci||!ci.isMutable)return null;
    const tf=bestTransform(node);
    const pc=ci.polyCurve,allC=[];
    for(let c=0;c<pc.curveCount;c++){
        const cu=pc.at(c);
        allC.push({bzs:cu.beziers.toArray().map(bz=>({
            start:tf.applyToPoint(bz.start),c1:tf.applyToPoint(bz.c1),
            c2:tf.applyToPoint(bz.c2),end:tf.applyToPoint(bz.end)
        })),isClosed:cu.isClosed,subCurveIdx:c});
    }
    return allC.length?allC:null;
}

function buildContourForAngle(formNode, angleDeg, N){
    const curves=getNodeCurvesSpreadForContour(formNode);if(!curves)return null;
    const nbb=formNode.getSpreadBaseBox(false);
    const allBzs=curves.flatMap(c=>c.bzs);
    const rad=angleDeg*Math.PI/180,cos=Math.cos(rad),sin=Math.sin(rad);
    function toRot(x,y){return{u:x*cos+y*sin,v:-x*sin+y*cos};}
    function fromRot(u,v){return{x:u*cos-v*sin,y:u*sin+v*cos};}
    let uMin=Infinity,uMax=-Infinity;
    for(const bz of allBzs)for(let ti=0;ti<=100;ti++){const p=bzPt(bz,ti/100),r=toRot(p.x,p.y);if(r.u<uMin)uMin=r.u;if(r.u>uMax)uMax=r.u;}
    const rotBzs=allBzs.map(bz=>({start:toRot(bz.start.x,bz.start.y),c1:toRot(bz.c1.x,bz.c1.y),c2:toRot(bz.c2.x,bz.c2.y),end:toRot(bz.end.x,bz.end.y)}));
    const cols=[];
    for(let i=0;i<=N;i++){
        const u_rot=uMin+(i/N)*(uMax-uMin),vHits=[];
        for(const bz of rotBzs){
            let pU=bz.start.u;
            for(let ti=1;ti<=200;ti++){
                const t=ti/200,mt=1-t;
                const cU=mt*mt*mt*bz.start.u+3*mt*mt*t*bz.c1.u+3*mt*t*t*bz.c2.u+t*t*t*bz.end.u;
                if((pU-u_rot)*(cU-u_rot)<=0&&Math.abs(cU-pU)>0.001){
                    const f=(u_rot-pU)/(cU-pU),iT=(ti-1)/200+f/200,mt2=1-iT;
                    vHits.push(mt2*mt2*mt2*bz.start.v+3*mt2*mt2*iT*bz.c1.v+3*mt2*iT*iT*bz.c2.v+iT*iT*iT*bz.end.v);
                }
                pU=cU;
            }
        }
        vHits.sort((a,b)=>a-b);
        const d=[];for(const h of vHits)if(!d.length||Math.abs(h-d[d.length-1])>0.5)d.push(h);
        cols.push(d.length>=2?{u_rot,vTop:d[0],vBot:d[d.length-1]}:d.length===1?{u_rot,vTop:d[0],vBot:d[0]}:null);
    }
    for(let i=0;i<=N;i++){
        if(!cols[i]){
            let prev=null,next=null;
            for(let j=i-1;j>=0;j--){if(cols[j]){prev=cols[j];break;}}
            for(let j=i+1;j<=N;j++){if(cols[j]){next=cols[j];break;}}
            const u_rot=uMin+(i/N)*(uMax-uMin);
            cols[i]=prev&&next?{u_rot,vTop:(prev.vTop+next.vTop)/2,vBot:(prev.vBot+next.vBot)/2}
                :prev?{...prev,u_rot}:next?{...next,u_rot}:{u_rot,vTop:0,vBot:1};
        }
    }
    return{cols,N,uMin,uMax,fromRot,nbb};
}

// ── Pfad-Modus: Bogenlängen-Kontur mit Tangente + Normale ────────────────────

function buildPathContour(formNode, angleDeg, N){
    const curves=getNodeCurvesSpreadForContour(formNode);if(!curves)return null;
    const nbb=formNode.getSpreadBaseBox(false);
    const allBzs=curves.flatMap(c=>c.bzs);
    const samples=[];let totalLen=0;
    for(const bz of allBzs){
        let px=bz.start.x,py=bz.start.y;
        for(let ti=1;ti<=100;ti++){
            const p=bzPt(bz,ti/100);
            const dl=Math.sqrt((p.x-px)**2+(p.y-py)**2);
            totalLen+=dl;
            samples.push({x:p.x,y:p.y,s:totalLen});
            px=p.x;py=p.y;
        }
    }
    if(totalLen<1)return null;
    const cols=[];
    for(let i=0;i<=N;i++){
        const s=i/N*totalLen;
        let idx=samples.findIndex(p=>p.s>=s);
        if(idx<0)idx=samples.length-1;
        const p=samples[idx];
        const prev=idx>0?samples[idx-1]:samples[0];
        const tx=p.x-prev.x,ty=p.y-prev.y;
        const tlen=Math.sqrt(tx*tx+ty*ty)||1;
        const tux=tx/tlen,tuy=ty/tlen;
        const nx=-tuy,ny=tux;
        cols.push({u_rot:i/N,cx:p.x,cy:p.y,nx,ny,tux,tuy});
    }
    function pathFromRotNormal(u,v,objH){
        const us=Math.max(0,Math.min(1,u))*N;
        const i0=Math.min(N-1,Math.floor(us)),i1=Math.min(N,i0+1),frac=us-i0;
        const c0=cols[i0],c1=cols[i1];
        const cx=c0.cx*(1-frac)+c1.cx*frac,cy=c0.cy*(1-frac)+c1.cy*frac;
        const nx=c0.nx*(1-frac)+c1.nx*frac,ny=c0.ny*(1-frac)+c1.ny*frac;
        return{x:cx+nx*v*objH,y:cy+ny*v*objH};
    }
    function pathFromRotUpright(u,v,objH){
        const us=Math.max(0,Math.min(1,u))*N;
        const i0=Math.min(N-1,Math.floor(us)),i1=Math.min(N,i0+1),frac=us-i0;
        const c0=cols[i0],c1=cols[i1];
        const cx=c0.cx*(1-frac)+c1.cx*frac,cy=c0.cy*(1-frac)+c1.cy*frac;
        const tux=c0.tux*(1-frac)+c1.tux*frac;
        return{x:cx,y:cy+v*objH*tux};
    }
    function pathFromRotUprightPlain(u,v,objH){
        const us=Math.max(0,Math.min(1,u))*N;
        const i0=Math.min(N-1,Math.floor(us)),i1=Math.min(N,i0+1),frac=us-i0;
        const c0=cols[i0],c1=cols[i1];
        const cx=c0.cx*(1-frac)+c1.cx*frac,cy=c0.cy*(1-frac)+c1.cy*frac;
        return{x:cx,y:cy+v*objH};
    }
    function fromRot(u,v){return{x:u,y:v};}
    return{cols,N,totalLen,fromRot,pathFromRot:pathFromRotNormal,pathFromRotUpright,pathFromRotUprightPlain,nbb,isPath:true};
}

// ── UV-Mapping + Methoden (Flaechen-Warp) ─────────────────────────────────────

function mapUV(u,v,con){
    const us=Math.max(0,Math.min(1,u))*con.N;
    const i0=Math.min(con.N-1,Math.floor(us)),i1=i0+1,frac=us-i0;
    const c0=con.cols[i0],c1=con.cols[i1];
    const u_rot=c0.u_rot*(1-frac)+c1.u_rot*frac;
    const vTop=c0.vTop*(1-frac)+c1.vTop*frac,vBot=c0.vBot*(1-frac)+c1.vBot*frac;
    return con.fromRot(u_rot,vTop+Math.max(0,Math.min(1,v))*(vBot-vTop));
}
function applyMethod(u0,v0,method,strength){
    let u=u0,v=v0;
    if(method===1){v=(1-Math.cos(v0*Math.PI*(strength*0.5+0.5)))/2;v=Math.max(0,Math.min(1,v));}
    else if(method===2){const tp=Math.pow(Math.max(0,v0),1/Math.max(0.3,strength));u=0.5+(u0-0.5)*tp;}
    else if(method===3){const brl=Math.sin(u0*Math.PI)*Math.sin(v0*Math.PI)*(strength-1)*0.4;u=u0+brl*(u0-0.5);}
    else if(method===5){u=u0+Math.sin(v0*Math.PI)*strength*0.4;}
    else if(method===6){const dx=u0-0.5,dy=v0-0.5,dist=Math.sqrt(dx*dx+dy*dy);const angle=strength*(1-Math.min(1,dist/(Math.SQRT2/2)));const c=Math.cos(angle),s=Math.sin(angle);u=Math.max(0,Math.min(1,0.5+dx*c-dy*s));v=Math.max(0,Math.min(1,0.5+dx*s+dy*c));}
    return{u:Math.max(0,Math.min(1,u)),v:Math.max(0,Math.min(1,v))};
}

function computeOffsetSbb(sbb,startPct,endPct){
    const so=Math.max(0,Math.min(45,startPct))/100;
    const eo=Math.max(0,Math.min(45,endPct))/100;
    const denom=1-so-eo;
    if(denom<=0.05)return sbb;
    const virtualWidth=sbb.width/denom;
    const virtualX=sbb.x-so*virtualWidth;
    return{x:virtualX,y:sbb.y,width:virtualWidth,height:sbb.height};
}

function warpPt(x,y,sbb,con,method,strength,lockX,lockY,pathAlign){
    const u0=(x-sbb.x)/sbb.width,v0=(y-sbb.y)/sbb.height;
    const{u:um,v:vm}=applyMethod(u0,v0,method,strength);
    const uf=lockX?u0:um,vf=lockY?v0:vm;
    if(con.isPath){
        if(pathAlign===2) return con.pathFromRotUprightPlain(uf,vf-0.5,sbb.height);
        if(pathAlign===1) return con.pathFromRotUpright(uf,vf-0.5,sbb.height);
        return con.pathFromRot(uf,vf-0.5,sbb.height);
    }
    return mapUV(uf,vf,con);
}

// ── Adaptives Subdivision ──────────────────────────────────────────────────────

function needsSubdivide(bz,epsilon){
    const mx=(bz.start.x+bz.end.x)/2,my=(bz.start.y+bz.end.y)/2;
    const cx=0.125*bz.start.x+0.375*bz.c1.x+0.375*bz.c2.x+0.125*bz.end.x;
    const cy=0.125*bz.start.y+0.375*bz.c1.y+0.375*bz.c2.y+0.125*bz.end.y;
    return Math.sqrt((cx-mx)**2+(cy-my)**2)>epsilon;
}
function subdivideBez(bz,t){
    const mt=1-t;
    const p01={x:mt*bz.start.x+t*bz.c1.x,y:mt*bz.start.y+t*bz.c1.y};
    const p12={x:mt*bz.c1.x+t*bz.c2.x,y:mt*bz.c1.y+t*bz.c2.y};
    const p23={x:mt*bz.c2.x+t*bz.end.x,y:mt*bz.c2.y+t*bz.end.y};
    const p012={x:mt*p01.x+t*p12.x,y:mt*p01.y+t*p12.y};
    const p123={x:mt*p12.x+t*p23.x,y:mt*p12.y+t*p23.y};
    const mid={x:mt*p012.x+t*p123.x,y:mt*p012.y+t*p123.y};
    return[{start:bz.start,c1:p01,c2:p012,end:mid},{start:mid,c1:p123,c2:p23,end:bz.end}];
}
function subdivideCurvesAdaptive(curves,epsilon,maxDepth){
    maxDepth=maxDepth||8;
    function rec(bz,depth){
        if(depth>=maxDepth)return[bz];
        if(!needsSubdivide(bz,epsilon))return[bz];
        const[l,r]=subdivideBez(bz,0.5);
        return[...rec(l,depth+1),...rec(r,depth+1)];
    }
    return curves.map(c=>({bzs:c.bzs.flatMap(bz=>rec(bz,0)),isClosed:c.isClosed}));
}
function warpCurves(curves,sbb,con,method,strength,lockX,lockY,pathAlign){
    return curves.map(c=>({bzs:c.bzs.map(bz=>({
        start:warpPt(bz.start.x,bz.start.y,sbb,con,method,strength,lockX,lockY,pathAlign),
        c1:   warpPt(bz.c1.x,   bz.c1.y,   sbb,con,method,strength,lockX,lockY,pathAlign),
        c2:   warpPt(bz.c2.x,   bz.c2.y,   sbb,con,method,strength,lockX,lockY,pathAlign),
        end:  warpPt(bz.end.x,  bz.end.y,  sbb,con,method,strength,lockX,lockY,pathAlign)
    })),isClosed:c.isClosed}));
}

// ── Douglas-Peucker Vereinfachung nach Warp ───────────────────────────────────

function perpDist(pt,a,b){
    const dx=b.x-a.x,dy=b.y-a.y,len=Math.sqrt(dx*dx+dy*dy);
    if(len<1e-10)return Math.sqrt((pt.x-a.x)**2+(pt.y-a.y)**2);
    return Math.abs(dy*pt.x-dx*pt.y+b.x*a.y-b.y*a.x)/len;
}
function douglasPeucker(pts,eps){
    if(pts.length<=2)return pts;
    let maxD=0,maxI=0;
    for(let i=1;i<pts.length-1;i++){const d=perpDist(pts[i],pts[0],pts[pts.length-1]);if(d>maxD){maxD=d;maxI=i;}}
    if(maxD>eps){const l=douglasPeucker(pts.slice(0,maxI+1),eps),r=douglasPeucker(pts.slice(maxI),eps);return[...l.slice(0,-1),...r];}
    return[pts[0],pts[pts.length-1]];
}
function simplifyCurves(curves,epsilon){
    if(epsilon<=0)return curves;
    return curves.map(c=>{
        const pts=[];
        for(const bz of c.bzs){if(!pts.length)pts.push(bz.start);for(let ti=1;ti<=20;ti++)pts.push(bzPt(bz,ti/20));}
        if(pts.length<3)return c;
        const simp=douglasPeucker(pts,epsilon);
        if(simp.length<2)return c;
        const newBzs=[];
        for(let i=0;i<simp.length-1;i++){
            const s=simp[i],e=simp[i+1];
            newBzs.push({start:s,c1:{x:s.x+(e.x-s.x)/3,y:s.y+(e.y-s.y)/3},c2:{x:s.x+(e.x-s.x)*2/3,y:s.y+(e.y-s.y)*2/3},end:e});
        }
        if(c.isClosed&&newBzs.length>0){
            const s=simp[simp.length-1],e=simp[0];
            newBzs.push({start:s,c1:{x:s.x+(e.x-s.x)/3,y:s.y+(e.y-s.y)/3},c2:{x:s.x+(e.x-s.x)*2/3,y:s.y+(e.y-s.y)*2/3},end:e});
        }
        return{bzs:newBzs,isClosed:c.isClosed};
    });
}

// ── Fuellungs-Transform mitverzerren (Gradient/Bitmap/Schraffur) ─────────────

function computeCurvesBB(curves){
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const c of curves)for(const bz of c.bzs)for(let ti=0;ti<=20;ti++){
        const p=bzPt(bz,ti/20);
        if(p.x<x0)x0=p.x;if(p.x>x1)x1=p.x;
        if(p.y<y0)y0=p.y;if(p.y>y1)y1=p.y;
    }
    if(x0===Infinity)return null;
    return{x:x0,y:y0,width:Math.max(1e-6,x1-x0),height:Math.max(1e-6,y1-y0)};
}

function remapFillTransform(fd,srcBB,dstBB){
    if(!fd||!srcBB||!dstBB)return fd;
    let fill;try{fill=fd.fill;}catch(e){return fd;}
    if(!fill)return fd;
    let ftVal;try{ftVal=fill.fillType.value;}catch(e){return fd;}
    if(ftVal!==3&&ftVal!==4&&ftVal!==6)return fd;
    if(fd.isAnchoredToSpread)return fd;
    let tr;try{tr=fd.transform;}catch(e){return fd;}
    if(!tr)return fd;
    try{
        const ox=(tr.origin.x-srcBB.x)/srcBB.width, oy=(tr.origin.y-srcBB.y)/srcBB.height;
        const v1x=tr.xAxis.x/srcBB.width, v1y=tr.xAxis.y/srcBB.height;
        const v2x=tr.yAxis.x/srcBB.width, v2y=tr.yAxis.y/srcBB.height;
        const newTr=Transform.createIdentity();
        const d=newTr.data;
        d[0]=v1x*dstBB.width; d[3]=v1y*dstBB.height;
        d[1]=v2x*dstBB.width; d[4]=v2y*dstBB.height;
        d[2]=dstBB.x+ox*dstBB.width; d[5]=dstBB.y+oy*dstBB.height;
        return FillDescriptor.create(fill,fd.isScaleWithObject,newTr,fd.blendMode,fd.isAnchoredToSpread);
    }catch(e){return fd;}
}

function getSrcLocalBB(node){
    try{
        const ci=node.curvesInterface;
        if(ci&&ci.isMutable)return ci.polyCurve.getExactBoundingBox();
    }catch(e){}
    try{return node.getSpreadBaseBox(false);}catch(e){}
    return null;
}

// ── Node-Erzeugung ─────────────────────────────────────────────────────────────

function buildPolyCurveNode(doc,curves,fd,pfd,ls){
    const pc=PolyCurve.create(),nof=FillDescriptor.createNone();
    for(const c of curves){if(!c.bzs?.length)continue;const cb=new CurveBuilder();cb.begin(c.bzs[0].start);for(const bz of c.bzs)cb.addBezier(bz.c1,bz.c2,bz.end);if(c.isClosed)cb.close();pc.addCurve(cb.createCurve());}
    if(pc.curveCount===0)return null;
    const def=PolyCurveNodeDefinition.create(pc,fd||nof,ls||LineStyleDescriptor.createDefault(),pfd||nof,nof);
    const gb=AddChildNodesCommandBuilder.create(doc);gb.addPolyCurveNode(def);doc.executeCommand(gb.createCommand());
    return doc.selection.at(0).node;
}

function buildGridNode(doc,con,cols,rows,method,strength,lockX,lockY,pathAlign){
    const nof=FillDescriptor.createNone(),gFD=FillDescriptor.createSolid(Colour.createRGBA8(77,77,77,255));
    const ls=LineStyleDescriptor.createDefault(),pc=PolyCurve.create();
    const S=60;
    function gPt(u0,v0){
        const{u,v}=applyMethod(u0,v0,method,strength);
        const uf=lockX?u0:u,vf=lockY?v0:v;
        if(con.isPath){
            if(pathAlign===2) return con.pathFromRotUprightPlain(uf,vf-0.5,con.nbb.height);
            if(pathAlign===1) return con.pathFromRotUpright(uf,vf-0.5,con.nbb.height);
            return con.pathFromRot(uf,vf-0.5,con.nbb.height);
        }
        return mapUV(uf,vf,con);
    }
    for(let ci=0;ci<=cols;ci++){const u=ci/cols,cb=new CurveBuilder();cb.begin(gPt(u,0));for(let ri=1;ri<=S;ri++)cb.lineTo(gPt(u,ri/S));pc.addCurve(cb.createCurve());}
    for(let ri=0;ri<=rows;ri++){const v=ri/rows,cb=new CurveBuilder();cb.begin(gPt(0,v));for(let ci2=1;ci2<=S;ci2++)cb.lineTo(gPt(ci2/S,v));pc.addCurve(cb.createCurve());}
    const def=PolyCurveNodeDefinition.create(pc,nof,ls,gFD,nof);
    const gb=AddChildNodesCommandBuilder.create(doc);gb.addPolyCurveNode(def);doc.executeCommand(gb.createCommand());
    const gn=doc.selection.at(0).node;try{gn.userDescription='Warp Grid';}catch(e){}return gn;
}

function moveNodeInto(doc,node,tgt){doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,[node]),tgt,MOVE_INSIDE,NodeChildType.Main));}
function moveNodeAfter(doc,node,tgt){doc.executeCommand(DocumentCommand.createMoveNodes(Selection.create(doc,[node]),tgt,MOVE_AFTER,NodeChildType.Main));}
function dupNode(doc,node){try{doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc,[node]),null,{duplicateNodes:true}));return doc.selection.at(0)?.node||null;}catch(e){return null;}}

// ── Hauptskript ────────────────────────────────────────────────────────────────

const doc=Document.current;
if(!doc)throw new Error('Kein Dokument geoeffnet.');
const sel=doc.selection;

if(sel.length!==2){
    const d=Dialog.create('Warp into Shape Group');
    const col=d.addColumn(),g=col.addGroup('Note');
    g.addStaticText('','Please select exactly 2 objects:');
    g.addStaticText('','  1) Base shape (warp contour)');
    g.addStaticText('','  2) Object to warp');
    g.addStaticText('','Selected: '+sel.length+' object(s)');
    g.addStaticText('','');
    g.addStaticText('','Note: Start script with the Move tool active.');
    g.addStaticText('','All vector objects must be converted to curves first.');
    g.addStaticText('','(Adjustment layers are included. Masks are ignored.)');
    col.addGroup('').addButtonSet('', [' OK '], 0);
    d.runModal();
}else{
    const nodeA=sel.at(0).node,nodeB=sel.at(1).node;
    let idxA=0,idxB=0,idx=0;
    for(const l of doc.layers.all){if(l===nodeA)idxA=idx;if(l===nodeB)idxB=idx;idx++;}
    const[topNode,botNode]=idxA<idxB?[nodeA,nodeB]:[nodeB,nodeA];

    const autoRole=autoDetectRoles(nodeA,nodeB);
    let defaultFormIdx=0;
    if(autoRole&&autoRole.formNode===botNode) defaultFormIdx=1;

    const dTop=(topNode.userDescription||topNode.defaultDescription||'top').substring(0,26);
    const dBot=(botNode.userDescription||botNode.defaultDescription||'bottom').substring(0,26);

    // ── Dialog: 2-column layout, resizable, compact, LIVE preview ───────────
    const dlg=Dialog.create('Warp into Shape Group v64-EN');
    dlg.initialWidth=700;
    dlg.setIsResizable(true);
    const colL=dlg.addColumn(); colL.widthProportion=0.52;
    const colR=dlg.addColumn(); colR.widthProportion=0.48;

    const gP=colL.addGroup('Preset');
    let loadedPresetName='(no preset loaded)';
    const stPreset=gP.addStaticText('','Loaded: '+loadedPresetName);
    const btnLoad=gP.addButton(' Load... ');
    const btnSave=gP.addButton(' Save... ');
    const btnDelete=gP.addButton(' Delete ');
    for(const b of [btnLoad,btnSave,btnDelete]){try{b.setIsFullWidth(true);}catch(e){}}

    const gR=colL.addGroup('Role Assignment'+(autoRole?' (auto)':''));
    const cboForm=gR.addComboBox('Base shape:',['(top)    '+dTop,'(bottom) '+dBot],defaultFormIdx);

    const gM=colL.addGroup('Warp (Area Mode)');
    const cboMeth=gM.addComboBox('Method:',[
        'Trapezoid','Compressed','Cone/Fan','Barrel/Cushion',
        'Banner/Flag','Swing Warp','Twirl',
    ],0);
    const edStr=gM.addUnitValueEditor('Strength:','none',null,1.0,-3.0,3.0);edStr.value=1.0;
    const chkLockX=gM.addCheckBox('Lock X-axis',false);
    const chkLockY=gM.addCheckBox('Lock Y-axis',false);

    const gMod=colL.addGroup('Path Mode');
    const chkPath=gMod.addCheckBox('Arrange along contour',false);
    const cboPathAlign=gMod.addComboBox('Alignment:',[
        'Perpendicular to path',
        'Upright (cosine compression)',
        'Upright, no compression'
    ],0);
    const chkHidePath=gMod.addCheckBox('Hide base shape',false);
    gMod.addStaticText('','No clipping in path mode.');

    const gA=colR.addGroup('Scan Direction');
    const edAngle=gA.addUnitValueEditor('Angle (deg):','none',null,0,-180,180);edAngle.value=0;

    const gRes=colR.addGroup('Resolution');
    const edScanRes=gRes.addUnitValueEditor('Res.:','none',null,400,100,2000);edScanRes.value=400;
    const edEpsilon=gRes.addUnitValueEditor('Eps. (px):','none',null,2.0,0.5,20.0);edEpsilon.value=2.0;
    const edSimplify=gRes.addUnitValueEditor('Simplify (px):','none',null,0.0,0.0,10.0);edSimplify.value=0.0;

    const gG=colR.addGroup('Grid');
    const edCols=gG.addUnitValueEditor('Columns:','none',null,12,4,40);edCols.value=12;
    const edRows=gG.addUnitValueEditor('Rows:','none',null,24,4,80);edRows.value=24;
    const edOffStart=gG.addUnitValueEditor('Start Offset (%):','none',null,0,0,45);edOffStart.value=0;
    const edOffEnd=gG.addUnitValueEditor('End Offset (%):','none',null,0,0,45);edOffEnd.value=0;

    for(const ed of [edStr,edAngle,edScanRes,edEpsilon,edSimplify,edCols,edRows,edOffStart,edOffEnd]){
        try{ed.setIsFullWidth(true);}catch(e){}
    }

    const gStatus=colR.addGroup('Status');
    const stStatus=gStatus.addStaticText('','Ready. Changes are shown live.');

    // ── Hilfsfunktionen ───────────────────────────────────────────────────────

    function getParams(){
        return{
            formIdx:    cboForm.selectedIndex,
            method:     cboMeth.selectedIndex,
            strength:   Math.max(-3.0,Math.min(3.0,Number(edStr.value)||1.0)),
            angleDeg:   Math.max(-180,Math.min(180,Number(edAngle.value)||0)),
            cols:       Math.max(4,Math.min(40,Math.round(Number(edCols.value)||12))),
            rows:       Math.max(4,Math.min(80,Math.round(Number(edRows.value)||24))),
            offStart:   Math.max(0,Math.min(45,Number(edOffStart.value)||0)),
            offEnd:     Math.max(0,Math.min(45,Number(edOffEnd.value)||0)),
            scanRes:    Math.max(100,Math.min(2000,Math.round(Number(edScanRes.value)||400))),
            epsilon:    Math.max(0.5,Math.min(20,Number(edEpsilon.value)||2.0)),
            simplify:   Math.max(0,Math.min(10,Number(edSimplify.value)||0)),
            lockX:      chkLockX.value===true,
            lockY:      chkLockY.value===true,
            pathMode:   chkPath.value===true,
            pathAlign:  cboPathAlign.selectedIndex,
            hidePathBase: chkHidePath.value===true,
        };
    }

    function applyPreset(p){
        if(p.method!==undefined)    try{cboMeth.selectedIndex=p.method;}catch(e){}
        if(p.strength!==undefined)  edStr.value=p.strength;
        if(p.angleDeg!==undefined)  edAngle.value=p.angleDeg;
        if(p.cols!==undefined)      edCols.value=p.cols;
        if(p.rows!==undefined)      edRows.value=p.rows;
        if(p.offStart!==undefined)  edOffStart.value=p.offStart;
        if(p.offEnd!==undefined)    edOffEnd.value=p.offEnd;
        if(p.scanRes!==undefined)   edScanRes.value=p.scanRes;
        if(p.epsilon!==undefined)   edEpsilon.value=p.epsilon;
        if(p.simplify!==undefined)  edSimplify.value=p.simplify;
        if(p.lockX!==undefined)     try{chkLockX.value=p.lockX;}catch(e){}
        if(p.lockY!==undefined)     try{chkLockY.value=p.lockY;}catch(e){}
        if(p.pathMode!==undefined)  try{chkPath.value=p.pathMode;}catch(e){}
        if(p.pathAlign!==undefined) try{cboPathAlign.selectedIndex=p.pathAlign;}catch(e){}
        if(p.hidePathBase!==undefined) try{chkHidePath.value=p.hidePathBase;}catch(e){}
    }

    let conCache=null,cacheSig='';
    function getCon(formNode,params){
        const sig=JSON.stringify([formNode.userDescription||'_',params.angleDeg,params.scanRes,params.pathMode]);
        if(conCache&&cacheSig===sig)return conCache;
        cacheSig=sig;
        conCache=params.pathMode
            ?buildPathContour(formNode,params.angleDeg,params.scanRes)
            :buildContourForAngle(formNode,params.angleDeg,params.scanRes);
        return conCache;
    }

    function buildResultNodes(items,sbb,con,p){
        const em=p.method===4?0:p.method;
        const curveItems=items.filter(it=>it.type==='curve');
        const dupItems=items.filter(it=>it.type==='dup');

        const offSbb=computeOffsetSbb(sbb,p.offStart,p.offEnd);
        const prepared=curveItems.map(item=>{
            const sub=subdivideCurvesAdaptive(item.curves,p.epsilon,8);
            let warped=warpCurves(sub,offSbb,con,em,p.strength,p.lockX,p.lockY,p.pathMode?p.pathAlign:0);
            if(p.simplify>0)warped=simplifyCurves(warped,p.simplify);
            let remFd=item.fd, remPfd=item.pfd;
            const srcBB=item.srcNode?getSrcLocalBB(item.srcNode):null;
            const dstBB=computeCurvesBB(warped);
            if(srcBB&&dstBB){
                remFd=remapFillTransform(item.fd,srcBB,dstBB);
                remPfd=remapFillTransform(item.pfd,srcBB,dstBB);
            }
            return{item:{...item,fd:remFd,pfd:remPfd},warped};
        }).filter(pr=>pr.warped.some(c=>c.bzs.length));

        const resultNodes=[];
        if(prepared.length){
            const nof=FillDescriptor.createNone();
            const gb=AddChildNodesCommandBuilder.create(doc);
            const validPrepared=[];
            for(const pr of prepared){
                const pc=PolyCurve.create();
                for(const c of pr.warped){
                    if(!c.bzs?.length)continue;
                    const cb=new CurveBuilder();
                    cb.begin(c.bzs[0].start);
                    for(const bz of c.bzs)cb.addBezier(bz.c1,bz.c2,bz.end);
                    if(c.isClosed)cb.close();
                    pc.addCurve(cb.createCurve());
                }
                if(pc.curveCount===0)continue;
                const def=PolyCurveNodeDefinition.create(pc,pr.item.fd||nof,pr.item.ls||LineStyleDescriptor.createDefault(),pr.item.pfd||nof,nof);
                gb.addPolyCurveNode(def);
                validPrepared.push(pr);
            }
            if(validPrepared.length){
                doc.executeCommand(gb.createCommand());
                const sel2=doc.selection;
                const newNodes=[];
                for(let i=0;i<sel2.length;i++)newNodes.push(sel2.at(i).node);
                if(newNodes.length===validPrepared.length){
                    for(let i=0;i<validPrepared.length;i++){
                        const wNode=newNodes[i],item=validPrepared[i].item;
                        for(const co of item.childDups){const cd=dupNode(doc,co);if(cd)moveNodeInto(doc,cd,wNode);}
                        resultNodes.push(wNode);
                    }
                }else{
                    for(const pr of validPrepared){
                        const wNode=buildPolyCurveNode(doc,pr.warped,pr.item.fd,pr.item.pfd,pr.item.ls);
                        if(wNode){for(const co of pr.item.childDups){const cd=dupNode(doc,co);if(cd)moveNodeInto(doc,cd,wNode);}resultNodes.push(wNode);}
                    }
                }
            }
        }
        for(const item of dupItems){
            const dup=dupNode(doc,item.node);
            if(dup)resultNodes.push(dup);
        }
        return resultNodes;
    }

    function doFullBuild(p){
        const formNode=p.formIdx===0?topNode:botNode;
        const objNode =p.formIdx===0?botNode:topNode;
        const em=p.method===4?0:p.method;
        const con=getCon(formNode,p);
        if(!con)return{success:false,message:'Contour calculation failed (base shape invalid or empty).'};
        const sbb=objNode.getSpreadBaseBox(false);
        const tag=objNode[Symbol.toStringTag]||'';

        if(tag==='ImageNode'||tag==='RasterNode'||tag==='PixelNode'){
            const grpDef=ContainerNodeDefinition.create('Warp Group');
            const gb2=AddChildNodesCommandBuilder.create(doc);gb2.setInsertionTargetSelection(Selection.create(doc,[formNode]));gb2.addContainerNode(grpDef);doc.executeCommand(gb2.createCommand());
            let mainGrp=null;const ns=doc.selection;for(let i=0;i<ns.length;i++){const n=ns.at(i).node;if(n.isGroupNode||n.isContainerNode){mainGrp=n;break;}}
            if(mainGrp){moveNodeInto(doc,formNode,mainGrp);moveNodeInto(doc,objNode,formNode);}
            if(p.pathMode&&p.hidePathBase){
                try{doc.executeCommand(DocumentCommand.createSetVisibility(Selection.create(doc,[formNode]),false));}catch(e){}
            }
            return{success:true};
        }

        const badName=findFirstShape(objNode);
        if(badName)return{success:false,message:'"'+badName+'" is not yet a curve. Please convert it first via Curves -> Convert to Curves.'};
        const items=collectAllItems(objNode);
        if(!items.length)return{success:false,message:'No curve objects found in the object to warp.'};
        const resultNodes=buildResultNodes(items,sbb,con,p);
        if(!resultNodes.length)return{success:false,message:'Warp produced no result objects.'};

        const gNode=buildGridNode(doc,con,p.cols,p.rows,em,p.strength,p.lockX,p.lockY,p.pathMode?p.pathAlign:0);
        const subDef=ContainerNodeDefinition.create('Warp Content');
        const gbS=AddChildNodesCommandBuilder.create(doc);gbS.addContainerNode(subDef);doc.executeCommand(gbS.createCommand());
        const subGrp=doc.selection.at(0).node;
        moveNodeInto(doc,gNode,subGrp);
        for(const n of resultNodes)moveNodeInto(doc,n,subGrp);

        const grpDef=ContainerNodeDefinition.create('Warp Group');
        const gb2=AddChildNodesCommandBuilder.create(doc);gb2.setInsertionTargetSelection(Selection.create(doc,[formNode]));gb2.addContainerNode(grpDef);doc.executeCommand(gb2.createCommand());
        let mainGrp=null;const ns=doc.selection;for(let i=0;i<ns.length;i++){const n=ns.at(i).node;if(n.isGroupNode||n.isContainerNode){mainGrp=n;break;}}

        if(p.pathMode){
            if(mainGrp){
                moveNodeInto(doc,formNode,mainGrp);
                moveNodeInto(doc,subGrp,mainGrp);
                if(p.hidePathBase){
                    try{doc.executeCommand(DocumentCommand.createSetVisibility(Selection.create(doc,[formNode]),false));}catch(e){}
                }
            }
        }else{
            moveNodeInto(doc,subGrp,formNode);
            if(mainGrp)moveNodeInto(doc,formNode,mainGrp);
        }
        return{success:true};
    }

    // ── Live-Vorschau ─────────────────────────────────────────────────────────
    const posBeforePreview=doc.history.position;
    function updatePreview(){
        try{doc.history.position=posBeforePreview;}catch(e){}
        try{
            const res=doFullBuild(getParams());
            if(res&&res.success){
                try{stStatus.setText('Preview up to date.');}catch(e){}
            }else{
                try{stStatus.setText((res&&res.message)?res.message:'Build failed.');}catch(e){}
            }
        }catch(e){
            try{stStatus.setText('Error: '+(e&&e.message?e.message:String(e)));}catch(e2){}
        }
    }

    let lastLoadedPath=null;
    function baseName(path){
        const parts=path.replace(/\\/g,'/').split('/');
        let n=parts[parts.length-1]||path;
        return n.replace(/\.json$/i,'');
    }
    btnLoad.setOnClickHandler(()=>{
        const path=app.chooseFile();
        if(!path)return;
        try{
            const buf=File.readAll(path);
            const p=JSON.parse(buf.toString());
            applyPreset(p);
            lastLoadedPath=path;
            loadedPresetName=baseName(path);
            stPreset.setText('Loaded: '+loadedPresetName);
        }catch(e){
            stPreset.setText('Error loading: '+baseName(path));
        }
        updatePreview();
    });
    btnSave.setOnClickHandler(()=>{
        const name=app.prompt('Enter preset name:','Save preset','My Preset');
        if(name&&name.trim()){
            const cleanName=name.trim();
            const presetDir=app.userDesktopPath+'/AffinityScriptPresets';
            try{createDirectories(presetDir);}catch(e){}
            const path=presetDir+'/WarpPreset - '+cleanName+'.json';
            try{
                const f=new File(path,'wb');
                f.writeStringAsUtf8(JSON.stringify(getParams(),null,2));
                f.close();
                lastLoadedPath=path;
                loadedPresetName=cleanName;
                stPreset.setText('Saved: '+loadedPresetName);
            }catch(e){
                stPreset.setText('Error saving: '+cleanName);
            }
        }
    });
    btnDelete.setOnClickHandler(()=>{
        if(!lastLoadedPath){
            stPreset.setText('No preset loaded to delete.');
            return;
        }
        try{
            const fsMod=require('/fs');
            fsMod.remove(lastLoadedPath);
            stPreset.setText('Deleted: '+loadedPresetName);
            lastLoadedPath=null;
            loadedPresetName='(no preset loaded)';
        }catch(e){
            stPreset.setText('Error deleting: '+loadedPresetName);
        }
    });
    dlg.setOnControlValueChangedHandler(()=>{updatePreview();});

    updatePreview();

    const result=dlg.runModal();
    const cancelled = !result || result.value!==DialogResult.Ok.value;
    if(cancelled){
        try{doc.history.position=posBeforePreview;}catch(e){}
    }
}

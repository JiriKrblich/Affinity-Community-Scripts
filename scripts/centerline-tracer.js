'use strict';
/**
 * Binary Raster Centerline Tracer for Affinity  v4.0.1
 *
 * v4.0.1: ループ検出の誤検出・誤色を修正。
 *   [修正1] isClosed をRDP簡略化後のパスで呼ぶように変更。
 *     簡略化前のスケルトンパスで判定していたため、小さな円形ドット
 *     （猫の鼻・目など）がループとして誤検出され、SVG上では直線に
 *     見えるパスが赤く表示されていた。
 *   [修正2] ノード追加を1本ずつ実行し、参照を取得してからスタイルを
 *     一括適用（N+1 Undoエントリ）。
 *     addCmd.newNodes の返却順が挿入順と一致しない場合に
 *     pathMeta とのインデックスがずれ、ループが青・非ループが赤に
 *     なる問題を根本解決。
 *
 * v4.0: ダイアログでパラメータを調整可能に。
 *   主要パラメータをUIから変更できます：
 *   - 最小パス長 (MIN_PATH_PX): 短い孤立パス（端キャップアーティファクト等）を除去
 *   - ヒゲ除去長 (SPUR_LENGTH): 枝分かれした短い末端を除去
 *   - 簡略化精度 (SIMPLIFY): ノード数と形状精度のバランス
 *   - 出力線幅 (STROKE_WIDTH)
 * v3.9.1: getSpreadBaseBox() でスプレッド座標を取得し、
 *   ピクセル座標 → スプレッド座標への変換を適用（座標ズレ修正）。
 *   v3.9: 分岐集合点を幾何学的交点で再計算（adjustJunctionPositions追加）
 *         各ブランチを安定ゾーンでサンプリング→最小二乗交点→新集合点
 *   v3.8: 分岐点付近の直線化（straightenAtJunctions追加）
 *   v3.7: 分岐クラスタリング試み（Zhang-Suen1px幅のため効果なし）
 *   v3.6: RGBA8をnewなし呼び出しに修正
 *   v3.5: createDefault()+DocumentCommandによるスタイル適用
 */

// ── デフォルト値（ダイアログの初期値） ───────────────────────
const INVERT_DEFAULT      = false;
const SIMPLIFY_DEFAULT    = 1.5;
const MIN_PATH_PX_DEFAULT = 20;
const SPUR_LENGTH_DEFAULT = 8;
const STROKE_WIDTH_DEFAULT= 1.0;

// ── 固定パラメータ ──────────────────────────────────────────
const MIN_LENGTH      = 4;
const SPUR_ANGLE      = 70.0;
const SPUR_ANGLE_LEN  = 30;
const MERGE_ANGLE     = 35.0;
const DETECT_LOOPS    = true;
const JUNCTION_OFFSET = 12;
const JUNCTION_SAMPLE = 6;
const JUNCTION_LOOK   = 18;
const OPEN_COLOR      = [0,   102, 204, 255];
const CLOSED_COLOR    = [204,   0,   0, 255];

const { app }        = require('/application');
const { NodeRenderingEngine, RasterFormat } = require('/rasterobject');
const { CurveBuilder, PolyCurve }           = require('/geometry');
const { FillDescriptor }                    = require('/fills');
const { RGBA8 }                             = require('/colours');
const { LineStyleDescriptor }               = require('/linestyle');
const Nodes                                 = require('/nodes');
const { AddChildNodesCommandBuilder, CompoundCommandBuilder, DocumentCommand } = require('/commands');
const { Dialog, DialogResult }              = require('/dialog');
const { UnitType }                          = require('/units');

// ─── 画像取得 ────────────────────────────────────────────────
function getImagePixels() {
    const doc = app.documents.current;
    const sel = doc.selection;
    if (!sel || sel.length === 0) throw new Error('ラスタ画像を1つ選択してから実行してください。');
    const item = sel.at(0);
    const node = item ? item.node : null;
    if (!node) throw new Error('選択ノードが取得できませんでした。');
    const engine = NodeRenderingEngine.createDefault(node, RasterFormat.RGBA8);
    const pixels = new Uint8Array(engine.createCompatibleBuffer(true).buffer);
    const bbox = node.getSpreadBaseBox(false);
    return { pixels, w: engine.width, h: engine.height, bbox };
}

// ─── 二値化 ──────────────────────────────────────────────────
function toBinary(pixels, w, h, invert) {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
        const p = i * 4;
        const gray = pixels[p+3] < 128 ? 255 : (pixels[p]+pixels[p+1]+pixels[p+2]) / 3;
        bin[i] = invert ? (gray >= 128 ? 1 : 0) : (gray < 128 ? 1 : 0);
    }
    return bin;
}

// ─── Zhang-Suen 細線化 ───────────────────────────────────────
function thinZhangSuen(binary, w, h) {
    const img = new Uint8Array(binary);
    const get = (y,x) => (y<0||y>=h||x<0||x>=w) ? 0 : img[y*w+x];
    let changed = true;
    while (changed) {
        changed = false;
        for (let step = 1; step <= 2; step++) {
            const del = [];
            for (let y=1; y<h-1; y++) for (let x=1; x<w-1; x++) {
                if (!img[y*w+x]) continue;
                const [P2,P3,P4,P5,P6,P7,P8,P9] = [get(y-1,x),get(y-1,x+1),get(y,x+1),get(y+1,x+1),get(y+1,x),get(y+1,x-1),get(y,x-1),get(y-1,x-1)];
                const B = P2+P3+P4+P5+P6+P7+P8+P9;
                if (B<2||B>6) continue;
                const s=[P2,P3,P4,P5,P6,P7,P8,P9,P2]; let A=0;
                for(let k=0;k<8;k++) if(s[k]===0&&s[k+1]===1) A++;
                if(A!==1) continue;
                if(step===1){if(P2*P4*P6)continue;if(P4*P6*P8)continue;}
                else        {if(P2*P4*P8)continue;if(P2*P6*P8)continue;}
                del.push(y*w+x);
            }
            if(del.length){for(const i of del)img[i]=0;changed=true;}
        }
    }
    return img;
}

// ─── スケルトン追跡 ──────────────────────────────────────────
function traceSkeleton(skel, w, h) {
    const cn = new Int32Array(w*h);
    const get = (y,x) => (y<0||y>=h||x<0||x>=w) ? 0 : skel[y*w+x];
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
        if(!skel[y*w+x]) continue;
        const s=[get(y-1,x),get(y-1,x+1),get(y,x+1),get(y+1,x+1),get(y+1,x),get(y+1,x-1),get(y,x-1),get(y-1,x-1),get(y-1,x)];
        let c=0; for(let k=0;k<8;k++) if(s[k]===0&&s[k+1]===1) c++;
        cn[y*w+x]=c;
    }
    const isNode=new Uint8Array(w*h), isEdge=new Uint8Array(w*h);
    for(let i=0;i<w*h;i++){if(!skel[i])continue;cn[i]===1||cn[i]>=3?isNode[i]=1:isEdge[i]=1;}
    const vis=new Uint8Array(w*h), paths=[], seen=new Set();
    const DIRS=[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
    const nbrs=(y,x)=>{const o=[];for(const[dy,dx]of DIRS){const ny=y+dy,nx=x+dx;if(ny>=0&&ny<h&&nx>=0&&nx<w&&skel[ny*w+nx])o.push([ny,nx]);}return o;};
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
        if(!isNode[y*w+x]) continue;
        for(const[sy,sx]of nbrs(y,x)) {
            if(isNode[sy*w+sx]){const k=Math.min(y*w+x,sy*w+sx)+','+Math.max(y*w+x,sy*w+sx);if(seen.has(k))continue;seen.add(k);paths.push([[x,y],[sx,sy]]);continue;}
            if(vis[sy*w+sx]) continue;
            const path=[[x,y],[sx,sy]]; vis[sy*w+sx]=1; let cy=sy,cx=sx,py=y,px=x;
            while(true){let np=null;for(const[ay,ax]of nbrs(cy,cx)){if(ay===py&&ax===px)continue;if(isNode[ay*w+ax]){np=[ay,ax];break;}if(!vis[ay*w+ax]){np=[ay,ax];break;}}if(!np)break;path.push([np[1],np[0]]);if(isNode[np[0]*w+np[1]])break;vis[np[0]*w+np[1]]=1;py=cy;px=cx;cy=np[0];cx=np[1];}
            paths.push(path);
        }
    }
    for(let sy=0;sy<h;sy++) for(let sx=0;sx<w;sx++) {
        if(!isEdge[sy*w+sx]||vis[sy*w+sx]) continue;
        const path=[[sx,sy]]; vis[sy*w+sx]=1; let cy=sy,cx=sx,py=-1,px=-1;
        while(true){let np=null;for(const[ay,ax]of nbrs(cy,cx)){if(ay===py&&ax===px)continue;if(!vis[ay*w+ax]){np=[ay,ax];break;}}if(!np){path.push([sx,sy]);break;}path.push([np[1],np[0]]);vis[np[0]*w+np[1]]=1;py=cy;px=cx;cy=np[0];cx=np[1];}
        if(path.length>=3) paths.push(path);
    }
    return paths;
}

// ─── 分岐集合点を幾何学的交点で再配置 ───────────────────────
function adjustJunctionPositions(paths, offset, sampleLen) {
    if (!paths.length || offset <= 0 || sampleLen <= 0) return paths;
    const epMap = new Map();
    for (let i = 0; i < paths.length; i++) {
        const p = paths[i];
        const ak = p[0].join(','), bk = p[p.length-1].join(',');
        if (!epMap.has(ak)) epMap.set(ak, []);
        epMap.get(ak).push({ idx: i, isStart: true });
        if (ak !== bk) {
            if (!epMap.has(bk)) epMap.set(bk, []);
            epMap.get(bk).push({ idx: i, isStart: false });
        }
    }
    const newJunctions = new Map();
    for (const [key, refs] of epMap) {
        if (refs.length < 3) continue;
        const lines = [];
        for (const { idx, isStart } of refs) {
            const path = paths[idx];
            const n = path.length;
            const cap = Math.floor((n - 1) * 0.7);
            let i1, i2;
            if (isStart) {
                i1 = Math.min(offset, cap);
                i2 = Math.min(i1 + sampleLen, cap);
            } else {
                i1 = Math.max(n - 1 - offset, n - 1 - cap);
                i2 = Math.max(i1 - sampleLen, n - 1 - cap);
            }
            if (i1 === i2) continue;
            const dx = path[i1][0] - path[i2][0];
            const dy = path[i1][1] - path[i2][1];
            const len = Math.hypot(dx, dy);
            if (len < 0.5) continue;
            lines.push({ px: path[i1][0], py: path[i1][1], dx: dx/len, dy: dy/len });
        }
        if (lines.length < 2) continue;
        let A00=0, A01=0, A11=0, B0=0, B1=0;
        for (const { px, py, dx, dy } of lines) {
            const m00 = 1-dx*dx, m01 = -dx*dy, m11 = 1-dy*dy;
            A00 += m00; A01 += m01; A11 += m11;
            B0  += m00*px + m01*py;
            B1  += m01*px + m11*py;
        }
        const det = A00*A11 - A01*A01;
        if (Math.abs(det) < 1e-6) continue;
        const newX = (A11*B0 - A01*B1) / det;
        const newY = (A00*B1 - A01*B0) / det;
        const [ox, oy] = key.split(',').map(Number);
        if (Math.hypot(newX-ox, newY-oy) > offset * 1.5) continue;
        newJunctions.set(key, [newX, newY]);
    }
    if (!newJunctions.size) return paths;
    return paths.map(path => {
        const out = path.map(p => [p[0], p[1]]);
        const ak = path[0].join(','), bk = path[path.length-1].join(',');
        if (newJunctions.has(ak)) { const [x,y]=newJunctions.get(ak); out[0]=[x,y]; }
        if (newJunctions.has(bk)) { const [x,y]=newJunctions.get(bk); out[out.length-1]=[x,y]; }
        return out;
    });
}

// ─── 分岐点付近の直線化 ─────────────────────────────────────
function straightenAtJunctions(paths, lookPx) {
    if (!paths.length || lookPx <= 0) return paths;
    const epCount = new Map();
    for (const p of paths) {
        const a = p[0].join(','), b = p[p.length-1].join(',');
        epCount.set(a, (epCount.get(a)||0) + 1);
        if (a !== b) epCount.set(b, (epCount.get(b)||0) + 1);
    }
    const isJunc = k => (epCount.get(k)||0) >= 3;
    return paths.map(path => {
        if (path.length <= 2) return path;
        const aKey = path[0].join(','), bKey = path[path.length-1].join(',');
        const aIsJ = isJunc(aKey), bIsJ = isJunc(bKey);
        if (!aIsJ && !bIsJ) return path;
        const out = path.map(p => [p[0], p[1]]);
        const n = path.length;
        const maxK = Math.max(1, Math.floor((n-1) / 2));
        if (aIsJ) {
            const k = Math.min(lookPx, maxK);
            if (k >= 1) {
                const [ax,ay] = out[0], [bx,by] = path[k];
                for (let i=1; i<k; i++) { const t=i/k; out[i]=[ax+(bx-ax)*t, ay+(by-ay)*t]; }
            }
        }
        if (bIsJ) {
            const k = Math.min(lookPx, maxK);
            if (k >= 1) {
                const [ax,ay] = out[n-1], [bx,by] = path[n-1-k];
                for (let i=1; i<k; i++) { const t=i/k; out[n-1-i]=[ax+(bx-ax)*t, ay+(by-ay)*t]; }
            }
        }
        return out;
    });
}

// ─── ヒゲ除去（長さ） ────────────────────────────────────────
function removeSpurs(paths, maxLen) {
    if(maxLen<=0||!paths.length) return paths;
    while(true){
        const ep=new Map();
        for(const p of paths){const a=p[0].join(','),b=p[p.length-1].join(',');ep.set(a,(ep.get(a)||0)+1);if(a!==b)ep.set(b,(ep.get(b)||0)+1);}
        let rm=false; const np=[];
        for(const p of paths){if(p.length<=maxLen){const a=p[0].join(','),b=p[p.length-1].join(',');if(((ep.get(a)||0)>=2)!==((ep.get(b)||0)>=2)){rm=true;continue;}}np.push(p);}
        paths=np; if(!rm) break;
    }
    return paths;
}

// ─── ヒゲ除去（角度） ────────────────────────────────────────
function removeAngleSpurs(paths, thr, maxLen) {
    if(thr<=0||maxLen<=0||!paths.length) return paths;
    const cosT=Math.cos(thr*Math.PI/180), LOOK=4;
    const dir=(p,fs)=>{const n=p.length,k=Math.min(LOOK,n-1);const dx=fs?p[k][0]-p[0][0]:p[n-1-k][0]-p[n-1][0],dy=fs?p[k][1]-p[0][1]:p[n-1-k][1]-p[n-1][1];const m=Math.hypot(dx,dy);return m>1e-6?[dx/m,dy/m]:null;};
    while(true){
        const em=new Map();
        for(let i=0;i<paths.length;i++){const p=paths[i],a=p[0].join(','),b=p[p.length-1].join(',');if(!em.has(a))em.set(a,[]);em.get(a).push([i,true]);if(a!==b){if(!em.has(b))em.set(b,[]);em.get(b).push([i,false]);}}
        const keep=new Array(paths.length).fill(true); let rm=false;
        for(let i=0;i<paths.length;i++){const p=paths[i];if(p.length>maxLen)continue;const a=p[0].join(','),b=p[p.length-1].join(',');const aS=(em.get(a)||[]).length>=2,bS=(em.get(b)||[]).length>=2;if(!(aS!==bS))continue;const jk=aS?a:b,sd=dir(p,aS);if(!sd)continue;let nc=false;for(const[oi,of_]of(em.get(jk)||[])){if(oi===i)continue;const od=dir(paths[oi],of_);if(!od)continue;if(Math.abs(sd[0]*od[0]+sd[1]*od[1])>cosT){nc=true;break;}}if(!nc){keep[i]=false;rm=true;}}
        paths=paths.filter((_,i)=>keep[i]); if(!rm) break;
    }
    return paths;
}

// ─── 共線結合 ────────────────────────────────────────────────
function mergeCollinear(paths, angTol) {
    if(!paths.length) return paths;
    const cT=-Math.cos(angTol*Math.PI/180), S=4;
    const tan=(p,side)=>{const n=p.length,k=Math.min(S,n-1);if(k<=0)return[0,0];const vx=side===0?p[k][0]-p[0][0]:p[n-1-k][0]-p[n-1][0],vy=side===0?p[k][1]-p[0][1]:p[n-1-k][1]-p[n-1][1];const nr=Math.hypot(vx,vy);return nr>0?[vx/nr,vy/nr]:[0,0];};
    while(true){
        const em=new Map();
        for(let i=0;i<paths.length;i++){const p=paths[i];if(p.length<2)continue;const a=p[0].join(','),b=p[p.length-1].join(',');if(!em.has(a))em.set(a,[]);em.get(a).push([i,0]);if(a!==b){if(!em.has(b))em.set(b,[]);em.get(b).push([i,-1]);}}
        let best=null;
        for(const[,lst]of em){if(lst.length<2)continue;const ts=lst.map(([idx,e])=>tan(paths[idx],e));for(let a=0;a<lst.length;a++)for(let b=a+1;b<lst.length;b++){if(lst[a][0]===lst[b][0])continue;const d=ts[a][0]*ts[b][0]+ts[a][1]*ts[b][1];if(d<cT&&(!best||d<best[0]))best=[d,lst[a][0],lst[a][1],lst[b][0],lst[b][1]];}}
        if(!best) break;
        const[,i1,e1,i2]=best; let p1=[...paths[i1]],p2=[...paths[i2]];
        if(e1===0)p1=p1.reverse(); if(best[4]===-1)p2=p2.reverse();
        paths[i1]=[...p1,...p2.slice(1)]; paths.splice(i2,1);
    }
    return paths;
}

// ─── RDP 簡略化 ──────────────────────────────────────────────
function rdp(pts, eps) {
    if(pts.length<3) return[...pts];
    const n=pts.length, keep=new Uint8Array(n); keep[0]=keep[n-1]=1; const st=[[0,n-1]];
    while(st.length){const[i0,i1]=st.pop();if(i1-i0<2)continue;const p0=pts[i0],p1=pts[i1],sx=p1[0]-p0[0],sy=p1[1]-p0[1],sl=Math.hypot(sx,sy);let md=0,mi=i0+1;for(let i=i0+1;i<i1;i++){const vx=pts[i][0]-p0[0],vy=pts[i][1]-p0[1];const d=sl===0?Math.hypot(vx,vy):Math.abs(vx*sy-vy*sx)/sl;if(d>md){md=d;mi=i;}}if(md>eps){keep[mi]=1;st.push([i0,mi]);st.push([mi,i1]);}}
    return pts.filter((_,i)=>keep[i]);
}

const pathLen = pts => { let l=0; for(let i=1;i<pts.length;i++) l+=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]); return l; };

// [修正1] isClosed は簡略化後の simplified パスで呼ぶ。
// 簡略化前のピクセルパスで判定すると、小さな円形ドットが
// スケルトン上でリングとして正しく検出されても、RDP後に
// 2点に潰れて「直線なのに赤」という見た目の誤りが生じる。
function isClosed(path, tol=2.0) {
    if(path.length<3) return false;
    const p0=path[0],pn=path[path.length-1];
    if(Math.abs(p0[0]-pn[0])>tol||Math.abs(p0[1]-pn[1])>tol) return false;
    let area=0; const n=path.length;
    for(let i=0;i<n;i++){const j=(i+1)%n;area+=path[i][0]*path[j][1]-path[j][0]*path[i][1];}
    return Math.abs(area)/2>=9.0;
}

// ─── メイン ──────────────────────────────────────────────────
function main() {
    const doc = app.documents.current;

    // ── ダイアログ ──────────────────────────────────────────
    const dlg = Dialog.create('中心線トレーサー v4.0.1');
    const col = dlg.addColumn();

    const grpBasic = col.addGroup('基本');
    grpBasic.addStaticText('', '選択中のラスタ画像から中心線を抽出します。');
    const invertCtrl = grpBasic.addCheckBox('白前景 (INVERT)', INVERT_DEFAULT);

    const grpClean = col.addGroup('クリーンアップ');
    grpClean.addStaticText('', '最小パス長: 短い孤立パスを除去（端キャップの\nアーティファクト対策）。値を上げると除去が強くなります。');
    const minPathCtrl = grpClean.addUnitValueEditor(
        '最小パス長', UnitType.Pixel, UnitType.Pixel, MIN_PATH_PX_DEFAULT, 0, 1000);
    minPathCtrl.showPopupSlider = true;

    grpClean.addStaticText('', 'ヒゲ除去長: 枝分かれした短い末端を除去します。');
    const spurCtrl = grpClean.addUnitValueEditor(
        'ヒゲ除去長', UnitType.Pixel, UnitType.Pixel, SPUR_LENGTH_DEFAULT, 0, 200);
    spurCtrl.showPopupSlider = true;

    const grpOutput = col.addGroup('出力');
    const simplifyCtrl = grpOutput.addUnitValueEditor(
        '簡略化精度', UnitType.Pixel, UnitType.Pixel, SIMPLIFY_DEFAULT, 0, 20);
    simplifyCtrl.showPopupSlider = true;

    const strokeCtrl = grpOutput.addUnitValueEditor(
        '線幅', UnitType.Pixel, UnitType.Pixel, STROKE_WIDTH_DEFAULT, 0.1, 50);
    strokeCtrl.showPopupSlider = true;

    const dlgResult = dlg.runModal();
    if (!dlgResult || dlgResult.value !== DialogResult.Ok.value) return;

    const INVERT       = invertCtrl.value;
    const MIN_PATH_PX  = Math.max(0, minPathCtrl.value);
    const SPUR_LENGTH  = Math.max(0, Math.round(spurCtrl.value));
    const SIMPLIFY     = Math.max(0, simplifyCtrl.value);
    const STROKE_WIDTH = Math.max(0.1, strokeCtrl.value);

    try {
        const { pixels, w, h, bbox } = getImagePixels();
        const binary = toBinary(pixels, w, h, INVERT);
        const fgCount = binary.reduce((a,b)=>a+b, 0);
        if (fgCount === 0) throw new Error('前景画素が見つかりません。「白前景 (INVERT)」チェックを試してください。');

        const skel = thinZhangSuen(binary, w, h);
        let paths = traceSkeleton(skel, w, h);

        paths = adjustJunctionPositions(paths, JUNCTION_OFFSET, JUNCTION_SAMPLE);
        if (JUNCTION_LOOK > 0) paths = straightenAtJunctions(paths, JUNCTION_LOOK);

        if (SPUR_LENGTH > 0) paths = removeSpurs(paths, SPUR_LENGTH);
        if (SPUR_ANGLE  > 0) paths = removeAngleSpurs(paths, SPUR_ANGLE, SPUR_ANGLE_LEN);
        if (MERGE_ANGLE > 0) paths = mergeCollinear(paths, MERGE_ANGLE);

        // ── ピクセル → スプレッド座標変換 ───────────────────
        const scaleX = bbox.width  / w;
        const scaleY = bbox.height / h;
        const offX   = bbox.x;
        const offY   = bbox.y;
        const toDoc  = ([px, py]) => [offX + px * scaleX, offY + py * scaleY];

        // ── Phase 1: ノードを1本ずつ追加して参照を収集 ──────
        // [修正2] addCmd.newNodes の返却順が挿入順と保証されないため、
        // 1本ずつ追加して newNodes[0] で確実に対応ノードを取得する。
        // スタイル適用は Phase 2 で一括（Undo は N+1 エントリ）。
        const openFill   = FillDescriptor.createSolid(RGBA8(...OPEN_COLOR));
        const closedFill = FillDescriptor.createSolid(RGBA8(...CLOSED_COLOR));
        const lineStyle  = LineStyleDescriptor.createDefault(STROKE_WIDTH);

        const addedNodes = [];  // { node, closed } のリスト

        for (const pts of paths) {
            if (pts.length < MIN_LENGTH) continue;

            const simplified = SIMPLIFY > 0 ? rdp(pts, SIMPLIFY) : [...pts];
            if (simplified.length < 2) continue;
            if (pathLen(simplified) < MIN_PATH_PX) continue;

            // [修正1] isClosed を簡略化後のパスで判定
            const closed = DETECT_LOOPS && isClosed(simplified);

            const docPts = simplified.map(toDoc);

            const cb = CurveBuilder.create();
            cb.beginXY(docPts[0][0], docPts[0][1]);
            for (let i = 1; i < docPts.length; i++) cb.lineToXY(docPts[i][0], docPts[i][1]);
            if (closed) cb.close();
            const pc = PolyCurve.create();
            pc.addCurve(cb.createCurve());

            const def = Nodes.PolyCurveNodeDefinition.createDefault();
            def.setCurves(pc);

            const acnBuilder = AddChildNodesCommandBuilder.create();
            acnBuilder.addPolyCurveNode(def);
            const addCmd = acnBuilder.createCommand();
            doc.executeCommand(addCmd);

            addedNodes.push({ node: addCmd.newNodes[0], closed });
        }

        if (addedNodes.length === 0) {
            app.alert('中心線が検出されませんでした。\n画像を確認するか、INVERTや最小パス長を調整してください。', '中心線トレーサー');
            return;
        }

        // ── Phase 2: スタイルを一括適用（Undo 1エントリ） ──
        const styleBuilder = CompoundCommandBuilder.create();
        for (const { node, closed } of addedNodes) {
            const fill = closed ? closedFill : openFill;
            styleBuilder.addCommand(DocumentCommand.createSetPenFill(node.selfSelection, fill));
            styleBuilder.addCommand(DocumentCommand.createSetLineStyleDescriptor(node.selfSelection, lineStyle));
        }
        doc.executeCommand(styleBuilder.createCommand());

        const closedCount = addedNodes.filter(e => e.closed).length;
        app.alert(`完了: ${addedNodes.length} パス (開 ${addedNodes.length - closedCount}, 閉 ${closedCount})`, '中心線トレーサー');

    } catch (e) {
        app.alert('エラー: ' + e.message, '中心線トレーサー');
    }
}

main();

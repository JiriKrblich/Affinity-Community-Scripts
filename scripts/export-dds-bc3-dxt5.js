/**
 * name: Export DDS
 * description: Exports the current Affinity document as a DDS file using BC3/DXT5 compression with auto-generated mipmaps.
 * version: 1.0.0
 * author: jeffthor10
 */
 
'use strict';

const { app } = require('/application');
const { Document } = require('/document');
const { NodeRenderingEngine, RasterFormat } = require('/rasterobject');
const { PixelReaderRGBA8 } = require('/pixelaccessor');
const { File } = require('/fs');
const { Buffer } = require('/buffer');

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function downsample(pixels, w, h) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const out = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
        for (let x = 0; x < nw; x++) {
            const sx = x * 2, sy = y * 2;
            let r = 0, g = 0, b = 0, a = 0;
            for (let dy = 0; dy < 2; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    const px = Math.min(sx + dx, w - 1);
                    const py = Math.min(sy + dy, h - 1);
                    const i = (py * w + px) * 4;
                    r += pixels[i]; g += pixels[i+1]; b += pixels[i+2]; a += pixels[i+3];
                }
            }
            const o = (y * nw + x) * 4;
            out[o] = r / 4; out[o+1] = g / 4; out[o+2] = b / 4; out[o+3] = a / 4;
        }
    }
    return out;
}

function compressBC3Block(pixels, bx, by, width, height) {
    const texels = new Uint8Array(64);
    for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
            const sx = Math.min(bx + px, width - 1);
            const sy = Math.min(by + py, height - 1);
            const si = (sy * width + sx) * 4;
            const di = (py * 4 + px) * 4;
            texels[di] = pixels[si]; texels[di+1] = pixels[si+1];
            texels[di+2] = pixels[si+2]; texels[di+3] = pixels[si+3];
        }
    }

    let aMin = 255, aMax = 0;
    for (let i = 0; i < 16; i++) { const a = texels[i*4+3]; if (a < aMin) aMin = a; if (a > aMax) aMax = a; }
    const alphaBlock = new Uint8Array(8);
    alphaBlock[0] = aMax; alphaBlock[1] = aMin;
    const alphaTable = new Array(8);
    alphaTable[0] = aMax; alphaTable[1] = aMin;
    for (let i = 1; i <= 6; i++) alphaTable[i+1] = Math.round(aMax + (aMin - aMax) * i / 7);
    let bits = BigInt(0);
    for (let i = 15; i >= 0; i--) {
        const a = texels[i*4+3];
        let best = 0, bestDist = Math.abs(a - alphaTable[0]);
        for (let j = 1; j < 8; j++) { const d = Math.abs(a - alphaTable[j]); if (d < bestDist) { bestDist = d; best = j; } }
        bits = (bits << BigInt(3)) | BigInt(best);
    }
    for (let b = 0; b < 6; b++) alphaBlock[2 + b] = Number((bits >> BigInt(b * 8)) & BigInt(0xFF));

    let rMin=255,rMax=0,gMin=255,gMax=0,bMin=255,bMax=0;
    for (let i = 0; i < 16; i++) {
        rMin=Math.min(rMin,texels[i*4]); rMax=Math.max(rMax,texels[i*4]);
        gMin=Math.min(gMin,texels[i*4+1]); gMax=Math.max(gMax,texels[i*4+1]);
        bMin=Math.min(bMin,texels[i*4+2]); bMax=Math.max(bMax,texels[i*4+2]);
    }
    const encode565 = (r,g,b) => ((clamp(r,0,255)>>3)<<11)|((clamp(g,0,255)>>2)<<5)|(clamp(b,0,255)>>3);
    const c0 = encode565(rMax,gMax,bMax);
    const c1 = encode565(rMin,gMin,bMin);
    const dec565r = (c) => ((c>>11)&0x1F)<<3;
    const dec565g = (c) => ((c>>5)&0x3F)<<2;
    const dec565b = (c) => (c&0x1F)<<3;
    const palette = [
        [dec565r(c0),dec565g(c0),dec565b(c0)],
        [dec565r(c1),dec565g(c1),dec565b(c1)],
        [Math.round((2*dec565r(c0)+dec565r(c1))/3), Math.round((2*dec565g(c0)+dec565g(c1))/3), Math.round((2*dec565b(c0)+dec565b(c1))/3)],
        [Math.round((dec565r(c0)+2*dec565r(c1))/3), Math.round((dec565g(c0)+2*dec565g(c1))/3), Math.round((dec565b(c0)+2*dec565b(c1))/3)],
    ];
    let colIndices = 0;
    for (let i = 0; i < 16; i++) {
        const r=texels[i*4],g=texels[i*4+1],b=texels[i*4+2];
        let best=0,bestDist=1e9;
        for (let j=0;j<4;j++) { const dr=r-palette[j][0],dg=g-palette[j][1],db=b-palette[j][2]; const d=dr*dr+dg*dg+db*db; if(d<bestDist){bestDist=d;best=j;} }
        colIndices |= (best << (i*2));
    }
    const colBlock = new Uint8Array(8);
    colBlock[0]=c0&0xFF; colBlock[1]=(c0>>8)&0xFF;
    colBlock[2]=c1&0xFF; colBlock[3]=(c1>>8)&0xFF;
    colBlock[4]=colIndices&0xFF; colBlock[5]=(colIndices>>8)&0xFF;
    colBlock[6]=(colIndices>>16)&0xFF; colBlock[7]=(colIndices>>24)&0xFF;

    return { alphaBlock, colBlock };
}

function compressMipBC3(pixels, width, height) {
    const blocksX = Math.max(1, Math.ceil(width / 4));
    const blocksY = Math.max(1, Math.ceil(height / 4));
    const out = new Uint8Array(blocksX * blocksY * 16);
    let offset = 0;
    for (let by = 0; by < height; by += 4) {
        for (let bx = 0; bx < width; bx += 4) {
            const { alphaBlock, colBlock } = compressBC3Block(pixels, bx, by, width, height);
            out.set(alphaBlock, offset); offset += 8;
            out.set(colBlock, offset);   offset += 8;
        }
    }
    return out;
}

function buildDDSHeader(width, height, mipCount) {
    const header = new Uint8Array(128);
    const view = new DataView(header.buffer);
    header[0]=0x44;header[1]=0x44;header[2]=0x53;header[3]=0x20;
    view.setUint32(4, 124, true);
    view.setUint32(8, 0x00021007, true);
    view.setUint32(12, height, true);
    view.setUint32(16, width, true);
    view.setUint32(20, Math.ceil(width/4)*16, true);
    view.setUint32(24, 0, true);
    view.setUint32(28, mipCount, true);
    view.setUint32(76, 32, true);
    view.setUint32(80, 0x4, true);
    header[84]=0x44;header[85]=0x58;header[86]=0x54;header[87]=0x35;
    view.setUint32(108, 0x401008, true);
    return header;
}

try {
    const doc = Document.current;
    if (!doc) { app.alert('No document is open.', 'DDS Export'); }
    else {
        const rootNode = doc.rootNode;
        const engine = NodeRenderingEngine.createDefault(rootNode, RasterFormat.RGBA8);
        const bitmap = engine.createCompatibleBitmap(true);
        const width = bitmap.width;
        const height = bitmap.height;

        const reader = PixelReaderRGBA8.create(bitmap);
        const basePixels = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const px = reader.readPixel(x, y);
                const i = (y * width + x) * 4;
                basePixels[i]   = px.r;
                basePixels[i+1] = px.g;
                basePixels[i+2] = px.b;
                basePixels[i+3] = px.alpha;
            }
        }

        const mips = [];
        let mw = width, mh = height, mipPixels = basePixels;
        while (true) {
            mips.push({ pixels: mipPixels, w: mw, h: mh });
            if (mw === 1 && mh === 1) break;
            mipPixels = downsample(mipPixels, mw, mh);
            mw = Math.max(1, mw >> 1);
            mh = Math.max(1, mh >> 1);
        }

        const mipData = mips.map(m => compressMipBC3(m.pixels, m.w, m.h));
        const totalSize = 128 + mipData.reduce((s, d) => s + d.length, 0);

        const desktop = app.getUserDesktopPath;
        const docTitle = doc.title.replace(/\.[^.]+$/, '');
        const outPath = desktop + '/' + docTitle + '.dds';

        const afBuf = Buffer.create(totalSize);
        const arr = afBuf.array;
        arr.set(buildDDSHeader(width, height, mips.length), 0);
        let offset = 128;
        for (const data of mipData) { arr.set(data, offset); offset += data.length; }

        const file = new File(outPath, 'wb');
        file.write(afBuf, totalSize);
        file.close();

        app.alert('Export complete!\n\nFile: ' + outPath + '\nSize: ' + width + 'x' + height + '\nFormat: BC3/DXT5\nMip levels: ' + mips.length, 'DDS Export');
    }
} catch(e) {
    app.alert('Error: ' + e.message, 'DDS Export');
}

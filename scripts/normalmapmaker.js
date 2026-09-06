/**
 * name: Normal Map Maker
 * description: Generate a normal map from a selected raster image inside Affinity. You can make fine adjustments with a live preview and the normal map will save as new layer inside the document.
 * version: 1.0.0
 * author: jeffthor10
 */

/*! MIT License

Copyright (c) 2019 Christian Petry

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. */

'use strict';

const { app } = require('/application');
const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');
const { RasterNodeDefinition } = require('/nodes');
const { PixelBuffer, RasterFormat } = require('/rasterobject');
const { Transform } = require('/geometry');

function main() {
    const doc = Document.current;
    if (!doc) {
        app.alert("This script requires an open document.");
        return;
    }

    const sourceNode = doc.selection.firstNode;
    if (!sourceNode || !sourceNode.isRasterNode) {
        app.alert("Please select a raster (pixel) layer to use as the height map, then run this script again.");
        return;
    }

    if (sourceNode.rasterFormat.value !== RasterFormat.RGBA8.value) {
        app.alert("This script currently supports 8-bit RGBA layers only. Please convert the document to 8-bit and try again.");
        return;
    }

    const width = sourceNode.rasterWidth;
    const height = sourceNode.rasterHeight;

    const srcBuf = sourceNode.createCompatibleBuffer(true);
    const srcArr = new Uint8Array(srcBuf.buffer);
    const heightData = new Float32Array(width * height);
    const alphaData = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < width * height; ++i, p += 4) {
        const r = srcArr[p], g = srcArr[p + 1], b = srcArr[p + 2];
        heightData[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        alphaData[i] = srcArr[p + 3];
    }

    function wrapCoord(c, size) {
        c = c % size;
        return c < 0 ? c + size : c;
    }

    const WEIGHTS = [0.051, 0.0918, 0.12245, 0.1531, 0.1633, 0.1531, 0.12245, 0.0918, 0.051];
    function blurSharpPass(src, w, h, amount, horizontal) {
        const out = new Float32Array(w * h);
        const step = amount / 5;
        const offsets = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map(i => Math.round(i * step));
        for (let y = 0; y < h; ++y) {
            for (let x = 0; x < w; ++x) {
                let sum = 0;
                for (let k = 0; k < 9; ++k) {
                    let sx = x, sy = y;
                    if (horizontal) sx = x + offsets[k]; else sy = y + offsets[k];
                    sx = wrapCoord(sx, w);
                    sy = wrapCoord(sy, h);
                    sum += src[sy * w + sx] * WEIGHTS[k];
                }
                if (amount > 0) {
                    const orig = src[y * w + x];
                    sum = orig + orig - sum;
                }
                out[y * w + x] = sum;
            }
        }
        return out;
    }

    let blurCacheKey = null;
    let blurCacheData = null;
    function getBlurredHeight(amount) {
        if (amount === blurCacheKey) return blurCacheData;
        let result;
        if (amount === 0) {
            result = heightData;
        } else {
            const pass1 = blurSharpPass(heightData, width, height, amount, true);
            result = blurSharpPass(pass1, width, height, amount, false);
        }
        blurCacheKey = amount;
        blurCacheData = result;
        return result;
    }

    function computeNormalMapBitmap(params) {
        const { strength, level, blurSharp, filterType, invertR, invertG, invertH, zRange } = params;
        const h = getBlurredHeight(blurSharp);
        const dz = (1.0 / strength) * (1.0 + Math.pow(2.0, level));
        const iR = invertR ? -1 : 1;
        const iG = invertG ? -1 : 1;
        const iH = invertH ? -1 : 1;

        function at(x, y) {
            const sx = wrapCoord(x, width);
            const sy = wrapCoord(y, height);
            return h[sy * width + sx];
        }

        const outBuffer = PixelBuffer.create(width, height, RasterFormat.RGBA8);
        const outArr = new Uint8Array(outBuffer.buffer);

        let p = 0;
        for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) {
                const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
                const l = at(x - 1, y), r = at(x + 1, y);
                const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);

                let dx, dy;
                if (filterType === 0) {
                    dx = tl + l * 2 + bl - tr - r * 2 - br;
                    dy = tl + t * 2 + tr - bl - b * 2 - br;
                } else {
                    dx = tl * 3 + l * 10 + bl * 3 - (tr * 3 + r * 10 + br * 3);
                    dy = tl * 3 + t * 10 + tr * 3 - (bl * 3 + b * 10 + br * 3);
                }

                const nx = dx * iR * iH * 255;
                const ny = dy * iG * iH * 255;
                const nz = dz;
                const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

                const nxN = nx / len, nyN = ny / len, nzN = nz / len;

                outArr[p]     = Math.max(0, Math.min(255, Math.round(nxN * 127.5 + 127.5)));
                outArr[p + 1] = Math.max(0, Math.min(255, Math.round(nyN * 127.5 + 127.5)));
                outArr[p + 2] = zRange
                    ? Math.max(0, Math.min(255, Math.round(nzN * 255)))
                    : Math.max(0, Math.min(255, Math.round(nzN * 127.5 + 127.5)));
                outArr[p + 3] = alphaData[y * width + x];
                p += 4;
            }
        }
        return outBuffer.createCompatibleBitmap(true);
    }

    const dlg = Dialog.create("Generate Normal Map");
    const col = dlg.addColumn();

    const grp = col.addGroup("Normal Map Settings");
    dlg.strength = grp.addUnitValueEditor("Strength", UnitType.Number, UnitType.Number, 2.5, 0.01, 5)
        .setShowPopupSlider(true).setPrecision(2);
    dlg.level = grp.addUnitValueEditor("Level", UnitType.Number, UnitType.Number, 7, 4, 10)
        .setShowPopupSlider(true).setPrecision(1);
    dlg.blurSharp = grp.addUnitValueEditor("Blur / Sharpen", UnitType.Number, UnitType.Number, 0, -32, 32)
        .setShowPopupSlider(true).setPrecision(0);
    dlg.filterType = grp.addComboBox("Filter", ["Sobel", "Scharr"], 0);

    const grp2 = col.addGroup("Invert");
    dlg.invertR = grp2.addCheckBox("Invert R", false);
    dlg.invertG = grp2.addCheckBox("Invert G", false);
    dlg.invertH = grp2.addCheckBox("Invert Height", false);

    const grp3 = col.addGroup("Z Range");
    dlg.zRange = grp3.addCheckBox("-1 to +1", true);

    dlg.initialWidth = 340;

    const nodeDef = RasterNodeDefinition.create(RasterFormat.RGBA8);
    nodeDef.userDescription = "Normal Map";
    const srcBox = sourceNode.getSpreadBaseBox(false);
    nodeDef.transform = Transform.createTranslate(srcBox.x, srcBox.y)
        .multiply(Transform.createScale(srcBox.width / width, srcBox.height / height));

    function currentParams() {
        return {
            strength: dlg.strength.value,
            level: dlg.level.value,
            blurSharp: dlg.blurSharp.value,
            filterType: dlg.filterType.selectedIndex,
            invertR: dlg.invertR.value,
            invertG: dlg.invertG.value,
            invertH: dlg.invertH.value,
            zRange: dlg.zRange.value
        };
    }

    function update(preview) {
        nodeDef.bitmap = computeNormalMapBitmap(currentParams());
        doc.addNode(nodeDef, null, undefined, preview);
    }

    update(true);
    dlg.onControlValueChangedHandler = () => update(true);

    if (dlg.runModal() === DialogResult.Ok) {
        update(false);
    }
    doc.clearPreviews();
}

main();

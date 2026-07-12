/**
 * name: Document Cleanup
 * description: Removes all elements outside the document. More info: tools.axpra.ch/affinity/tools/aufraeumen
 * version: 1.0.6
 * author: Andreas Peier
 * category: Layout
 */
'use strict';

const { app } = require('/application');
const { File, FileSystemApi } = require('/fs');
const { Dialog, DialogResult } = require('/dialog');
const { Document } = require('/document');
const { Selection } = require('/selections');

const SETTINGS_PATH = app.userDesktopPath + '/document-cleanup-settings.json';

function ladeEinstellungen() {
    const defaults = { bereich: 0, ausgeblendeteLoeschen: true, gesperrteBehalten: false, randbereichBehalten: false, ragendeLoeschen: false, seiten: '' };
    try {
        if (!FileSystemApi.exists(SETTINGS_PATH)) return defaults;
        const data = JSON.parse(File.readAll(SETTINGS_PATH).toString('utf8'));
        return Object.assign(defaults, data);
    } catch (e) { return defaults; }
}

function speichereEinstellungen(s) {
    try {
        const f = new File(SETTINGS_PATH, 'wb');
        f.writeStringAsUtf8(JSON.stringify(s));
        f.close();
    } catch (e) {}
}

function parseSeiten(text) {
    const result = new Set();
    for (let teil of text.split(',')) {
        teil = teil.trim();
        if (!teil) continue;
        const parts = teil.split('-');
        if (parts.length === 2) {
            const von = parseInt(parts[0], 10), bis = parseInt(parts[1], 10);
            if (!isNaN(von) && !isNaN(bis))
                for (let i = Math.min(von, bis); i <= Math.max(von, bis); i++) result.add(i);
        } else {
            const n = parseInt(teil, 10);
            if (!isNaN(n)) result.add(n);
        }
    }
    return result;
}

function ueberlappenSich(a, b) {
    if (!a || !b) return false;
    return !((a.x + a.width) <= b.x || a.x >= (b.x + b.width) || (a.y + a.height) <= b.y || a.y >= (b.y + b.height));
}

function vollstaendigInnerhalb(box, rahmen) {
    return box.x >= rahmen.x && box.y >= rahmen.y &&
        (box.x + box.width) <= (rahmen.x + rahmen.width) &&
        (box.y + box.height) <= (rahmen.y + rahmen.height);
}

function main() {
    const doc = Document.current;
    if (!doc) { app.alert('No document open.', 'Document Cleanup'); return; }

    const s = ladeEinstellungen();

    const dlg = Dialog.create('Delete elements outside the document');
    dlg.initialWidth = 420;
    const col = dlg.addColumn();

    const grpBereich = col.addGroup('Scope');
    const bereichGruppe = grpBereich.addRadioGroup('Scope', ['Entire document', 'Active page', 'Page(s)'], s.bereich);
    bereichGruppe.setIsFullWidth(true);
    const seitenFeld = grpBereich.addTextBox('Page(s), e.g. 1-3 or 2,4', s.seiten);
    seitenFeld.setIsFullWidth(true);
    seitenFeld.isEnabled = (s.bereich === 2);

    const grpOpt = col.addGroup('Options');
    const cbAusgeblendet = grpOpt.addCheckBox('Delete hidden elements', s.ausgeblendeteLoeschen);
    cbAusgeblendet.setIsFullWidth(true);
    const cbGesperrt = grpOpt.addCheckBox('Keep locked elements', s.gesperrteBehalten);
    cbGesperrt.setIsFullWidth(true);
    const cbRandbereich = grpOpt.addCheckBox('Keep elements in the bleed area', s.randbereichBehalten);
    cbRandbereich.setIsFullWidth(true);
    const cbRagend = grpOpt.addCheckBox('Also delete elements extending beyond the edge', s.ragendeLoeschen);
    cbRagend.setIsFullWidth(true);

    dlg.setOnControlValueChangedHandler(function() {
        seitenFeld.isEnabled = (bereichGruppe.selectedIndex === 2);
    });

    if (dlg.runModal() !== DialogResult.Ok) return;

    const bereich = bereichGruppe.selectedIndex;
    const ausgeblendeteLoeschen = cbAusgeblendet.value;
    const gesperrteBehalten = cbGesperrt.value;
    const randbereichBehalten = cbRandbereich.value;
    const ragendeLoeschen = cbRagend.value;
    const seitenText = seitenFeld.text;

    speichereEinstellungen({ bereich, ausgeblendeteLoeschen, gesperrteBehalten, randbereichBehalten, ragendeLoeschen, seiten: seitenText });

    let zielSpreads = [];
    if (bereich === 0) {
        zielSpreads = doc.spreads.toArray();
    } else if (bereich === 1) {
        zielSpreads = [doc.currentSpread];
    } else {
        const gewuenschteSeiten = parseSeiten(seitenText);
        if (gewuenschteSeiten.size === 0) { app.alert('Please enter valid page numbers.', 'Document Cleanup'); return; }
        zielSpreads = doc.spreads.toArray().filter(spread => {
            for (let p = spread.firstPageIndex + 1; p <= spread.lastPageIndex + 1; p++)
                if (gewuenschteSeiten.has(p)) return true;
            return false;
        });
    }

    if (zielSpreads.length === 0) { app.alert('No matching pages found.', 'Document Cleanup'); return; }

    let zuLoeschen = Selection.createEmpty(doc);
    let gelG = 0, gelA = 0, gelS = 0, gelR = 0, gelRag = 0;
    let behG = 0, behA = 0, behS = 0, behR = 0, behRag = 0;

    for (const spread of zielSpreads) {
        const trimBox = spread.getSpreadExtents({ includeSpread: true, includeBleed: false, includeChildren: false });
        const bleedBox = spread.getSpreadExtents({ includeSpread: true, includeBleed: true, includeChildren: false });

        for (const node of spread.layers) {
            const nodeBox = node.spreadBaseBox;
            const ueberlapptSeite = ueberlappenSich(nodeBox, trimBox);
            let istRandbereich = false, istRagend = false;

            if (ueberlapptSeite) {
                if (vollstaendigInnerhalb(nodeBox, trimBox)) continue;
                istRagend = true;
                if (!ragendeLoeschen) continue;
            } else {
                istRandbereich = ueberlappenSich(nodeBox, bleedBox);
            }

            const istA = !node.isVisible;
            const istS = node.isLocked;
            const behalten = (istRandbereich && randbereichBehalten) || (istA && !ausgeblendeteLoeschen) || (istS && gesperrteBehalten);

            if (behalten) {
                behG++; if (istA) behA++; if (istS) behS++; if (istRandbereich) behR++; if (istRagend) behRag++;
            } else {
                gelG++; if (istA) gelA++; if (istS) gelS++; if (istRandbereich) gelR++; if (istRagend) gelRag++;
                zuLoeschen.addNode(node);
            }
        }
    }

    if (gelG === 0) { app.alert('No elements outside the document found.', 'Document Cleanup'); return; }

    doc.deleteSelection(zuLoeschen);

    let msg = 'Deleted\n' + gelG + ' element(s)\n' + gelA + ' hidden element(s)\n' + gelS + ' locked element(s)\n' + gelR + ' element(s) in the bleed area';
    if (ragendeLoeschen) msg += '\n' + gelRag + ' element(s) extending beyond the edge';
    if (behG > 0) {
        msg += '\n\nKept\n' + behA + ' hidden element(s)\n' + behS + ' locked element(s)\n' + behR + ' element(s) in the bleed area';
        if (ragendeLoeschen) msg += '\n' + behRag + ' element(s) extending beyond the edge';
    }
    msg += '\n\nNote: Undo with Ctrl+Z (Cmd+Z).';

    app.alert(msg, 'Document Cleanup');
}

main();

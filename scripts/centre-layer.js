/**
 * name: Centre Layer
 * description: Centres each selected layer horizontally and vertically on the current page/spread.
 * version: 1.0.0
 *
 * Changelog
 * 1.0.0 - Initial version. Centres every selected layer on the current spread (page area, no bleed).
 */

const { app }             = require('/application');
const { Document }        = require('/document');
const { DocumentCommand } = require('/commands');
const { Transform }       = require('/geometry');

const doc = Document.current;
if (!doc) { app.alert('No document open.', 'Centre Layer'); return; }

// ── Page area of the current spread ─────────────────────────────
function getPageRect() {
    let spread = null;
    try { spread = doc.currentSpread; } catch (e) {}
    if (!spread) { try { spread = doc.getCurrentSpread(); } catch (e) {} }
    if (!spread) return null;
    // includeSpread = true, includeBleed = false, includeChildren = false
    return spread.getSpreadExtents(true, false, false);
}

const page = getPageRect();
if (!page) { app.alert('Could not read the page bounds.', 'Centre Layer'); return; }

const pageCx = page.x + page.width  * 0.5;
const pageCy = page.y + page.height * 0.5;

// ── Selected nodes ──────────────────────────────────────────────
const nodes = [];
for (const item of doc.selection.items) nodes.push(item.node);

if (nodes.length === 0) { app.alert('Select a layer first.', 'Centre Layer'); return; }

// ── Centre each node ────────────────────────────────────────────
for (const node of nodes) {
    const bb = node.getSpreadBaseBox(false);
    if (!bb) continue;

    const dx = pageCx - (bb.x + bb.width  * 0.5);
    const dy = pageCy - (bb.y + bb.height * 0.5);
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) continue;

    doc.executeCommand(DocumentCommand.createTransform(
        node.selfSelection,
        new Transform(1, 0, dx, 0, 1, dy),
        { mergeable: false }));
}

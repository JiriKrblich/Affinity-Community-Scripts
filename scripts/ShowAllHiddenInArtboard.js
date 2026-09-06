/**
 * name: Show All Hidden in Artboard
 * description: Arată instant toate elementele, straturile, grupurile și măștile ascunse din artboard-ul selectat fără căsuță de dialog.
 * version: 1.0.0
 * author: Affinity Scripts
 */

'use strict';

const { Document } = require('/document');
const { DocumentCommand } = require('/commands');
const { Selection } = require('/selections');

/**
 * Verifică dacă un nod este un Artboard.
 * @param {Node} node 
 * @returns {boolean}
 */
function isArtboard(node) {
  if (!node) return false;
  try {
    if (node.artboardInterface && node.artboardInterface.isArtboardEnabled) return true;
  } catch (e) {}
  try {
    if (node.artboardEnabled) return true;
  } catch (e) {}
  return false;
}

/**
 * Verifică dacă o listă conține deja nodul respectiv (comparare nativă noduri).
 * @param {Array<Node>} list 
 * @param {Node} target 
 * @returns {boolean}
 */
function containsNode(list, target) {
  return list.some(n => {
    try {
      return n.isSameNode(target);
    } catch (e) {
      return n === target;
    }
  });
}

/**
 * Returnează un nume descriptiv pentru nod/artboard.
 * @param {Node} node 
 * @returns {string}
 */
function getNodeDisplayName(node) {
  if (!node) return "Artboard";
  return node.userDescription || node.description || node.defaultDescription || "Artboard";
}

/**
 * Identifică artboard-urile țintă pe baza selecției curente a utilizatorului.
 * Suportă selecție directă de artboard, selecție de obiecte din interiorul artboard-ului,
 * sau fallback automat pe artboard-urile de pe spread-ul activ dacă nu e selectat nimic.
 * @param {Document} doc 
 * @returns {Array<Node>}
 */
function collectTargetRoots(doc) {
  const targets = [];
  const sel = doc.selection;

  if (sel && sel.length > 0) {
    for (let i = 0; i < sel.length; i++) {
      const item = sel.at(i);
      const node = item ? item.node : null;
      if (!node) continue;

      let ab = null;
      if (isArtboard(node)) {
        ab = node;
      } else {
        let curr = node.parent;
        while (curr) {
          if (isArtboard(curr)) {
            ab = curr;
            break;
          }
          if (curr.isSpreadNode || curr.isDocumentNode) break;
          curr = curr.parent;
        }
      }

      if (ab) {
        if (!containsNode(targets, ab)) targets.push(ab);
      } else {
        // Obiect selectat în afara unui artboard (pe pagină simplă sau pasteboard)
        if (!containsNode(targets, node)) targets.push(node);
      }
    }
  }

  // Fallback: Dacă utilizatorul nu a selectat nimic, căutăm artboard-urile de pe spread-ul curent
  if (targets.length === 0) {
    const sp = doc.spreads.first;
    if (sp) {
      if (sp.children) {
        for (const child of sp.children) {
          if (isArtboard(child)) {
            if (!containsNode(targets, child)) targets.push(child);
          }
        }
      }
      if (targets.length === 0) {
        targets.push(sp);
      }
    }
  }

  return targets;
}

/**
 * Colectează recursiv toate nodurile ascunse dintr-un container/artboard
 * (inclusiv copii direcți, grupuri, containere, măști, enclosures și sub-straturi).
 * @param {Node} rootNode 
 * @returns {Array<Node>}
 */
function collectHiddenDescendants(rootNode) {
  const hidden = [];

  // Verificăm dacă rădăcina însăși este ascunsă (dacă nu e spread/doc)
  if (!rootNode.isSpreadNode && !rootNode.isDocumentNode) {
    try {
      if (!rootNode.isVisibleInDomain) {
        hidden.push(rootNode);
      }
    } catch (e) {}
  }

  function walk(node) {
    if (!node) return;

    // 1. Copii principali (obiecte, grupuri, curbe, forme, text, containere)
    try {
      if (node.children) {
        for (const child of node.children) {
          try {
            if (!child.isVisibleInDomain) {
              hidden.push(child);
            }
          } catch (e) {}
          walk(child);
        }
      }
    } catch (e) {}

    // 2. Enclosures (măști, clipping-uri, straturi de ajustare, efecte live)
    try {
      if (node.enclosures) {
        for (const enc of node.enclosures) {
          try {
            if (!enc.isVisibleInDomain) {
              hidden.push(enc);
            }
          } catch (e) {}
          walk(enc);
        }
      }
    } catch (e) {}
  }

  walk(rootNode);
  return hidden;
}

function main() {
  const doc = Document.current;
  if (!doc) {
    console.log("[Show All Hidden] Niciun document deschis în Affinity.");
    return;
  }

  const targetRoots = collectTargetRoots(doc);
  if (targetRoots.length === 0) {
    console.log("[Show All Hidden] Nu s-a găsit niciun artboard sau obiect țintă.");
    return;
  }

  const allHiddenNodes = [];
  const targetNames = [];

  for (const root of targetRoots) {
    targetNames.push(getNodeDisplayName(root));
    const hiddenInRoot = collectHiddenDescendants(root);
    for (const h of hiddenInRoot) {
      if (!containsNode(allHiddenNodes, h)) {
        allHiddenNodes.push(h);
      }
    }
  }

  const namesStr = targetNames.length <= 3 
    ? `"${targetNames.join('", "')}"` 
    : `${targetNames.length} artboards (${targetNames.slice(0, 3).join(', ')}...)`;

  if (allHiddenNodes.length === 0) {
    console.log(`[Show All Hidden] Toate elementele din ${namesStr} sunt deja vizibile (0 elemente ascunse).`);
    return;
  }

  // Execută comanda de vizibilitate într-un singur pas atomic de Undo
  const hiddenSelection = Selection.create(doc, allHiddenNodes, false);
  const visibilityCmd = DocumentCommand.createSetVisibility(hiddenSelection, true);
  doc.executeCommand(visibilityCmd, false);

  console.log(`[Show All Hidden] Succes: S-au afișat ${allHiddenNodes.length} elemente ascunse în ${namesStr}.`);
}

main();

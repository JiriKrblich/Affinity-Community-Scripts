// ============================================================================
// Sommaire des images Stock (Pexels / Pixabay)
// ----------------------------------------------------------------------------
// Parcourt le document ouvert, relève l'URL de chaque image issue de l'onglet
// Stock (celle du bouton « Ouvrir l'URL de Stock »), puis écrit le tout dans
// une nouvelle zone de texte, avec les styles de texte par défaut d'Affinity
// (Heading 1, Heading 2, Body).
// ============================================================================

// --- Modules du SDK Affinity -------------------------------------------------
const { Document } = require('/document.js');                 // accès au document courant
const { StoryBuilder } = require('/storybuilder.js');         // construction du texte
const { FrameTextNodeDefinition } = require('/nodes.js');     // définition d'une zone de texte
const {
  StoryDelta, ParagraphAttStringType, ParagraphAttDoubleType, GlyphAttDoubleType,
} = require('/storydelta.js');                                // modifications de texte
const { FontWeight } = require('/fonts.js');                  // graisses de police

// --- Réglages ---------------------------------------------------------------
const TITRE_SOMMAIRE = "Summary of Stock Images";
const MARGE = 40;                          // marge de la zone de texte (px du document)

// Styles par défaut d'Affinity : nom du style + attributs visuels équivalents.
// Le SDK ne permet pas de lire le panneau « Styles de texte » : on assigne donc
// le NOM du style et on applique en plus les attributs correspondants
// (taille en points, graisse, espace avant).
const STYLES = {
  titre:     { nom: "Heading 1", taillePt: 20, graisse: FontWeight.Bold,   espaceAvantPt: 0  },
  sousTitre: { nom: "Heading 2", taillePt: 16, graisse: FontWeight.Bold,   espaceAvantPt: 12 },
  corps:     { nom: "Body",      taillePt: 12, graisse: FontWeight.Normal, espaceAvantPt: 4  },
};

// --- Fonctions utilitaires --------------------------------------------------

// Identifie la source d'une URL de Stock ("Pexels", "Pixabay") ou null sinon.
function sourceDe(url) {
  const u = (url || "").toLowerCase();
  if (u.includes("pexels.com")) return "Pexels";
  if (u.includes("pixabay.com")) return "Pixabay";
  return null;
}

// Ajoute un paragraphe au texte avec le style demandé.
// pxParPt convertit les points en pixels du document (dpi / 72).
function ajouterParagraphe(sb, texte, style, pxParPt, estPremier) {
  if (!estPremier) sb.addParagraphBreak();              // saut de paragraphe entre les lignes

  // Attributs de PARAGRAPHE : nom du style + espace avant
  sb.applyParagraphDelta(StoryDelta.createComposite([
    StoryDelta.createParagraphString(ParagraphAttStringType.StyleName, style.nom),
    StoryDelta.createParagraphDouble(ParagraphAttDoubleType.SpaceBefore, style.espaceAvantPt * pxParPt),
  ]));

  // Attributs de CARACTÈRES : taille et graisse
  sb.applyGlyphDelta(StoryDelta.createComposite([
    StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, style.taillePt * pxParPt),
    StoryDelta.createWeight(style.graisse),
  ]));

  sb.addText(texte);
}

// --- Programme principal ----------------------------------------------------
const doc = Document.current;
if (!doc) {
  alert("This script requires an open document.");
} else {

  // 1) Collecte : une Map par source, clé = URL, valeur = nombre d'utilisations.
  //    Les doublons (même image utilisée plusieurs fois) sont regroupés.
  const trouvees = { Pexels: new Map(), Pixabay: new Map() };

  for (const spread of doc.spreads) {                   // toutes les pages / planches
    for (const node of spread.children.all) {           // tous les objets, groupes inclus
      if (!node.isImageNode) continue;                  // on ne garde que les images

      const url = node.stockURL;                        // URL de l'onglet Stock
      const source = sourceDe(url);
      if (!source) continue;                            // ignore les images hors Pexels/Pixabay

      trouvees[source].set(url, (trouvees[source].get(url) ?? 0) + 1);
    }
  }

  const total = trouvees.Pexels.size + trouvees.Pixabay.size;
  if (total === 0) {
    alert("No Pexels or Pixabay images (Stock tab) found in this document.");
  } else {

    // 2) Construction du texte : liste de { texte, style }.
    const lignes = [{ texte: TITRE_SOMMAIRE, style: STYLES.titre }];

    for (const source of ["Pexels", "Pixabay"]) {
      const images = trouvees[source];
      if (images.size === 0) continue;                  // saute une source sans image

      lignes.push({ texte: `${source} (${images.size})`, style: STYLES.sousTitre });

      let numero = 1;
      for (const [url, nombre] of images) {
        // Format : « 1. URL » (+ « (x2) » si l'image est utilisée 2 fois)
        const repetition = nombre > 1 ? `  (x${nombre})` : "";
        lignes.push({ texte: `${numero++}. ${url}${repetition}`, style: STYLES.corps });
      }
    }

    // 3) Création de la zone de texte avec le texte stylé.
    const pxParPt = doc.dpi / 72;                       // points -> pixels du document
    const sb = StoryBuilder.create();
    sb.setToFrameTextDefaultStyle(doc.dpi, doc.format); // base : style de zone de texte par défaut

    lignes.forEach((l, i) => ajouterParagraphe(sb, l.texte, l.style, pxParPt, i === 0));

    // 4) Dimensions : largeur = page - marges ; hauteur estimée selon les lignes.
    const page = doc.currentSpread.getSpreadBaseBox();  // rectangle de la page courante
    const largeur = Math.max(100, page.width - 2 * MARGE);
    const hauteurTexte = lignes.reduce(
      (h, l) => h + (l.style.taillePt * 1.3 + l.style.espaceAvantPt) * pxParPt, 0);
    const hauteur = Math.min(Math.max(page.height - 2 * MARGE, 50), hauteurTexte + 10 * pxParPt);

    const cadre = { x: page.x + MARGE, y: page.y + MARGE, width: largeur, height: hauteur };

    // 5) Ajout au document (sur le calque courant).
    doc.addNode(FrameTextNodeDefinition.createFromStoryBuilder(cadre, sb));
    console.log(`Text box created: ${total} Stock image(s) listed.`);
  }
}

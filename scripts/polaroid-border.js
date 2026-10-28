/*
 * Copyright (c) 2026 Jacques Lacerte
 * Tous droits réservés. / All rights reserved.
 *
 * Version : 1.0.0
 *
 * Script : Contour Polaroid / Polaroid border
 * Description : Ajoute un contour style Polaroid autour du document, avec choix du côté
 * le plus large. / Adds a Polaroid-style border around the document, with a choice of
 * the widest side.
 *
 * FR : Ce script est fourni « tel quel », sans garantie d'aucune sorte, expresse
 * ou implicite. Toute reproduction ou distribution, en tout ou en partie, est
 * interdite sans l'autorisation écrite du titulaire des droits.
 *
 * EN: This script is provided "as is", without warranty of any kind, express or
 * implied. Any reproduction or distribution, in whole or in part, is prohibited
 * without the prior written permission of the copyright holder.
 */

'use strict';

// ===========================================================================
// Importations des modules du SDK Affinity (chaque constante ci-dessous est
// une classe ou une fonction du SDK utilisée par le script).
// ===========================================================================

// Document :          Le document Affinity (Document.current = document actif).
// FileExportOptions : Options d'exportation (sert ici à détecter la langue d'Affinity).
const { Document, FileExportOptions } = require('/document.js');

// AddChildNodesCommandBuilder : Construit une commande qui ajoute des éléments au document.
// DocumentCommand :             Fabrique de commandes sur le document (ex. déplacer des éléments).
// BlendMode :                   Les modes de fusion (ex. Normal).
const { AddChildNodesCommandBuilder, DocumentCommand, BlendMode } = require('/commands.js');

// CurveBuilder : Construit une courbe point par point.
// PolyCurve :    Un ensemble de courbes formant un seul tracé.
// Transform :    Une transformation (déplacement, rotation...).
const { CurveBuilder, PolyCurve, Transform } = require('/geometry.js');

// PolyCurveNodeDefinition : Définition d'un élément « courbe » à ajouter au document.
const { PolyCurveNodeDefinition } = require('/nodes.js');

// Selection : Une sélection d'éléments sur laquelle appliquer des commandes.
const { Selection } = require('/selections.js');

// Dialog :        Une boîte de dialogue.
// DialogResult :  Le résultat d'une boîte de dialogue (OK / Annuler).
// SpatialAnchor : Ancrages de position (ex. coin haut gauche) pour redimensionner la page.
const { Dialog, DialogResult, SpatialAnchor } = require('/dialog.js');

// UnitType : Les types d'unités (ex. pixel) des champs numériques de la boîte de dialogue.
const { UnitType } = require('/units.js');

// LineStyleDescriptor : Description d'un style de trait pour une définition d'élément.
const { LineStyleDescriptor } = require('/linestyle.js');

// FillDescriptor : Description d'un remplissage (aucun, uni...).
const { FillDescriptor } = require('/fills.js');

// RGB8 : Crée une couleur à partir de ses composantes rouge, vert, bleu (0 à 255).
const { RGB8 } = require('/colours.js');

// ===========================================================================
// Constantes du script.
// ===========================================================================

// THIN_RATIO : Épaisseur proposée par défaut pour les trois bords fins, en proportion
//              de la plus petite dimension du document (0.06 = 6 %).
const THIN_RATIO = 0.06;
// WIDE_FACTOR : Épaisseur proposée par défaut pour le bord le plus large, en multiple
//               de l'épaisseur des bords fins (4 = quatre fois plus large).
const WIDE_FACTOR = 4;
// SIDE_BOTTOM, SIDE_TOP, SIDE_LEFT, SIDE_RIGHT : Les index des choix du côté le plus
//               large dans la boîte de dialogue (même ordre que les boutons radio).
const SIDE_BOTTOM = 0, SIDE_TOP = 1, SIDE_LEFT = 2, SIDE_RIGHT = 3;

// ---------------------------------
// Les messages anglais et français.
// ---------------------------------
// messages : Tous les textes affichés par le script, par langue ("fr" et "en").
//            Les valeurs sont du texte, ou des fonctions qui construisent un texte.
const messages = {
    fr: {
        noDoc:       "Ce script nécessite un document ouvert.",
        title:       "Contour style Polaroid",
        sideGroup:   "Côté le plus large",
        side:        "Côté",
        bottom:      "Bas",
        top:         "Haut",
        left:        "Gauche",
        right:       "Droite",
        sizeGroup:   "Épaisseur des bords (px)",
        thin:        "Bords fins",
        wide:        "Bord le plus large",
        colourGroup: "Couleur",
        colour:      "Couleur du contour",
        cancelled:   "Annulé par l'utilisateur",
        nothing:     "Aucune épaisseur demandée : rien n'a été créé",
        done:        (w, h) => "Contour Polaroid ajouté : le document fait maintenant " + w + " x " + h + " px."
    },
    en: {
        noDoc:       "This script requires an open document.",
        title:       "Polaroid-style border",
        sideGroup:   "Widest side",
        side:        "Side",
        bottom:      "Bottom",
        top:         "Top",
        left:        "Left",
        right:       "Right",
        sizeGroup:   "Border thickness (px)",
        thin:        "Thin borders",
        wide:        "Widest border",
        colourGroup: "Colour",
        colour:      "Border colour",
        cancelled:   "Cancelled by the user",
        nothing:     "No thickness requested: nothing was created",
        done:        (w, h) => "Polaroid border added: the document is now " + w + " x " + h + " px."
    }
};

// ---------------------------------------------------------------
// Déterminer la langue d'Affinity.
//
// Paramètres d'entrée :
//   (aucun)
//
// Retour :
//   string - "fr" si les préréglages d'exportation d'Affinity sont en
//            français, sinon "en" (anglais par défaut).
// ---------------------------------------------------------------
function detectLanguage() {
    let lang = 'en'     // lang : La langue détectée ("en" par défaut, "fr" si trouvée).
    if (FileExportOptions.allPresetNames.includes("SVG (pour exportation)")) {
        lang = "fr";
    }
    return lang;
}

// msgs : Les messages de la langue détectée (un des objets de 'messages').
const msgs = messages[detectLanguage()];

// ---------------------------------------------------------------
// Afficher un message dans la console et dans une alerte.
//
// Paramètres d'entrée :
//   msg:  string - Le texte à afficher.
//
// Retour :
//   (aucun)
// ---------------------------------------------------------------
function notify(msg) {
    console.log(msg);
    alert(msg);
}

// ---------------------------------------------------------------
// Savoir si l'utilisateur a validé une boîte de dialogue avec « OK ».
//
// Paramètres d'entrée :
//   result:  DialogResult | objet avec une propriété 'value' - Le résultat
//            retourné par dlg.runModal().
//
// Retour :
//   boolean - true si le résultat correspond à DialogResult.Ok,
//             false sinon (Annuler, fermeture de la boîte).
// ---------------------------------------------------------------
function isOk(result) {
    return (result?.value ?? result) == DialogResult.Ok.value;
}

// ---------------------------------------------------------------
// Demander à l'utilisateur le côté le plus large, les épaisseurs et la couleur.
//
// Paramètres d'entrée :
//   w:  number - La largeur actuelle du document (en pixels). Sert à calculer
//                les épaisseurs proposées par défaut.
//   h:  number - La hauteur actuelle du document (en pixels). Sert à calculer
//                les épaisseurs proposées par défaut.
//
// Retour :
//   null  - Si l'utilisateur annule la boîte de dialogue.
//   sinon un objet avec :
//     side:    number - Le côté le plus large : SIDE_BOTTOM (0), SIDE_TOP (1),
//                       SIDE_LEFT (2) ou SIDE_RIGHT (3).
//     thin:    number - L'épaisseur des trois bords fins (en pixels, entier >= 0).
//     wide:    number - L'épaisseur du bord le plus large (en pixels, entier >= 0).
//     colour:  Colour - La couleur du contour (blanc si aucune couleur choisie).
// ---------------------------------------------------------------
function askOptions(w, h) {
    const defThin = 100;// Math.round(Math.min(w, h) * THIN_RATIO);   // defThin : L'épaisseur proposée par défaut pour les bords fins.
    const defWide = 400; //Math.round(defThin * WIDE_FACTOR);         // defWide : L'épaisseur proposée par défaut pour le bord le plus large.

    const dlg = Dialog.create(msgs.title);          // dlg : La boîte de dialogue.
    const col = dlg.addColumn();                    // col : L'unique colonne de la boîte de dialogue.

    const gSide = col.addGroup(msgs.sideGroup);     // gSide : Le groupe « Côté le plus large ».
    // sideRadio : Les boutons radio Bas / Haut / Gauche / Droite (Bas choisi par défaut, index 0).
    const sideRadio = gSide.addRadioGroup(msgs.side, [msgs.bottom, msgs.top, msgs.left, msgs.right], SIDE_BOTTOM);

    const gSize = col.addGroup(msgs.sizeGroup);     // gSize : Le groupe des épaisseurs.
    // thinEd : Le champ « Bords fins » (en pixels, 0 ou plus, entier).
    const thinEd = gSize.addUnitValueEditor(msgs.thin, UnitType.Pixel, UnitType.Pixel, defThin, 0).setNoMaxValue().setPrecision(0);
    // wideEd : Le champ « Bord le plus large » (en pixels, 0 ou plus, entier).
    const wideEd = gSize.addUnitValueEditor(msgs.wide, UnitType.Pixel, UnitType.Pixel, defWide, 0).setNoMaxValue().setPrecision(0);

    const gColour = col.addGroup(msgs.colourGroup); // gColour : Le groupe « Couleur ».
    // colourPicker : Le sélecteur de la couleur du contour (blanc par défaut).
    const colourPicker = gColour.addColourPicker(msgs.colour, RGB8(255, 255, 255));

    if (!isOk(dlg.runModal()))
        return null;
    return {
        side:   sideRadio.selectedIndex,
        thin:   Math.max(0, Math.round(thinEd.value)),
        wide:   Math.max(0, Math.round(wideEd.value)),
        colour: colourPicker.value || RGB8(255, 255, 255)
    };
}

// ---------------------------------------------------------------
// Calculer l'épaisseur du contour sur chacun des quatre côtés.
//
// Paramètres d'entrée :
//   side:  number - Le côté le plus large : SIDE_BOTTOM, SIDE_TOP, SIDE_LEFT ou SIDE_RIGHT.
//   thin:  number - L'épaisseur des trois bords fins (en pixels).
//   wide:  number - L'épaisseur du bord le plus large (en pixels).
//
// Retour :
//   { top, right, bottom, left } - L'épaisseur du contour (en pixels) pour
//                                  chaque côté : 'wide' pour le côté choisi,
//                                  'thin' pour les trois autres.
// ---------------------------------------------------------------
function buildMargins(side, thin, wide) {
    return {
        top:    side === SIDE_TOP    ? wide : thin,
        right:  side === SIDE_RIGHT  ? wide : thin,
        bottom: side === SIDE_BOTTOM ? wide : thin,
        left:   side === SIDE_LEFT   ? wide : thin
    };
}

// ---------------------------------------------------------------
// Construire la courbe fermée d'un rectangle.
//
// Paramètres d'entrée :
//   x0:  number - Coordonnée X du bord gauche.
//   y0:  number - Coordonnée Y du bord haut.
//   x1:  number - Coordonnée X du bord droit.
//   y1:  number - Coordonnée Y du bord bas.
//
// Retour :
//   Curve - La courbe fermée du rectangle.
// ---------------------------------------------------------------
function rectangleCurve(x0, y0, x1, y1) {
    const cb = CurveBuilder.create();   // cb : Le constructeur de courbe.
    cb.beginXY(x0, y0);
    cb.lineToXY(x1, y0);
    cb.lineToXY(x1, y1);
    cb.lineToXY(x0, y1);
    cb.close();
    return cb.createCurve();
}

// ---------------------------------------------------------------
// Ajouter le contour Polaroid autour du document : le contenu est déplacé,
// la page est agrandie, puis une forme de la couleur choisie est ajoutée
// par-dessus, uniquement dans les marges.
//
// Paramètres d'entrée :
//   doc:      Document - Le document à entourer.
//   margins:  { top, right, bottom, left } - L'épaisseur du contour (en pixels)
//                       pour chaque côté (voir buildMargins).
//   colour:   Colour   - La couleur du contour.
//
// Retour :
//   { width, height } - Les nouvelles dimensions du document (en pixels).
// ---------------------------------------------------------------
function applyPolaroid(doc, margins, colour) {
    // w, h :   La largeur et la hauteur actuelles du document (en pixels).
    const w = doc.widthPixels, h = doc.heightPixels;
    // nw, nh : La largeur et la hauteur du document avec le contour (en pixels).
    const nw = w + margins.left + margins.right;
    const nh = h + margins.top + margins.bottom;

    // layers : Tous les calques du document (à déplacer pour laisser la marge en haut et à gauche).
    const layers = doc.layers.toArray();
    if (layers.length > 0 && (margins.left > 0 || margins.top > 0)) {
        doc.executeCommand(DocumentCommand.createTransform(
            Selection.create(doc, layers), Transform.createTranslate(margins.left, margins.top)));
    }

    // key : Le nom de l'ancrage « haut gauche » (ou le premier ancrage disponible à défaut).
    const key = SpatialAnchor.keys.find(k => /top.*left/i.test(k)) ?? SpatialAnchor.keys[0];    // k : Un nom d'ancrage testé.
    doc.setSpreadSizeWithAnchor(doc.currentSpread, nw, nh, SpatialAnchor[key]);

    // poly : Le tracé qui contient les rectangles du contour (haut, bas, gauche, droite).
    //        Un côté d'épaisseur 0 n'est pas créé.
    const poly = PolyCurve.create();
    if (margins.top > 0)    poly.addCurve(rectangleCurve(0, 0, nw, margins.top));
    if (margins.bottom > 0) poly.addCurve(rectangleCurve(0, nh - margins.bottom, nw, nh));
    if (margins.left > 0)   poly.addCurve(rectangleCurve(0, margins.top, margins.left, nh - margins.bottom));
    if (margins.right > 0)  poly.addCurve(rectangleCurve(nw - margins.right, margins.top, nw, nh - margins.bottom));

    // def : La définition de l'élément « contour » : rempli de la couleur choisie, sans trait.
    const def = PolyCurveNodeDefinition.create(poly,
        FillDescriptor.createSolid(colour, BlendMode.Normal),   // remplissage
        FillDescriptor.createNone(),                            // pas de couleur de trait
        LineStyleDescriptor.createDefault(1),                   // style de trait par défaut
        FillDescriptor.createNone());                           // pas de transparence
    def.userDescription = "Polaroid";

    const builder = AddChildNodesCommandBuilder.create();   // builder : Le constructeur de commande qui ajoute le contour.
    builder.addNode(def);
    doc.executeCommand(builder.createCommand(false));

    return { width: doc.widthPixels, height: doc.heightPixels };
}

// ---------------------------------------------------------------
// Fonction principale.
//
// Paramètres d'entrée :
//   (aucun) - Utilise le document courant.
//
// Retour :
//   (aucun) - Demande le côté le plus large, les épaisseurs et la couleur,
//             puis ajoute le contour Polaroid et écrit un message dans la
//             console. S'arrête (avec un message) s'il n'y a pas de document,
//             si l'utilisateur annule ou si aucune épaisseur n'est demandée.
// ---------------------------------------------------------------
function main() {
    const doc = Document.current;   // doc : Le document actif.

    // -----------------------------
    // Est-ce qu'il y a un document?
    // -----------------------------
    if (!doc) {
        notify(msgs.noDoc);
        return;
    }

    // ------------------------------
    // Obtenir les options désirées.
    // ------------------------------
    const opt = askOptions(doc.widthPixels, doc.heightPixels);  // opt : Les options choisies (voir askOptions), ou null si annulé.
    if (!opt) {
        console.log(msgs.cancelled);
        return;
    }

    // margins : L'épaisseur du contour sur chaque côté.
    const margins = buildMargins(opt.side, opt.thin, opt.wide);
    if (margins.top + margins.right + margins.bottom + margins.left === 0) {
        console.log(msgs.nothing);
        return;
    }

    // ----------------------------
    // Ajouter le contour Polaroid.
    // ----------------------------
    const size = applyPolaroid(doc, margins, opt.colour);   // size : Les nouvelles dimensions du document { width, height }.
    console.log(msgs.done(size.width, size.height));
}

main();

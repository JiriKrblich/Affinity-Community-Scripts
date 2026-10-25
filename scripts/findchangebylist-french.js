/**
 * name: FindChangeByList French
 * version: 1.0.1
 * description: Applies French typography spacing rules to selected text objects, protecting URLs.
 * author: Siqoya
 *
 * 1.0.1: Preserve the ellipsis when inserting a following space.
 * Original submission: https://github.com/JiriKrblich/Affinity-Community-Scripts/issues/244
 */
'use strict';

const { DocumentCommand } = require('/commands.js');
const { Document } = require('/document.js');
const { Selection, TextSelection } = require('/selections.js');

const NNBSP = '\u202F';
const NBSP = '\u00A0';

function findURLs(text) {
  const urls = [];
  const regex = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"«»]+/gi;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const candidate = match[0];
    const trimmed = candidate.replace(/[.,;:!?…]+$/, '');
    const start = match.index;
    let end = start + trimmed.length;

    while (
      end > start &&
      text[end - 1] === ')' &&
      (text.slice(start, end).match(/\(/g) || []).length <
      (text.slice(start, end).match(/\)/g) || []).length
    ) {
      end--;
    }

    if (end > start) {
      urls.push({ start, end });
    }
  }

  return urls;
}

function protectURLs(text) {
  const urls = findURLs(text);
  const protectedURLs = [];

  for (let i = urls.length - 1; i >= 0; i--) {
    const url = urls[i];
    const token = '\uE000' + i + '\uE001';

    protectedURLs.unshift({
      token,
      value: text.slice(url.start, url.end)
    });

    text =
      text.slice(0, url.start) +
      token +
      text.slice(url.end);
  }

  return { text, protectedURLs };
}

function correctTypography(originalText) {
  const protectedData = protectURLs(originalText);
  let text = protectedData.text;

  const rules = [
    // Espaces multiples
    [/[ \t]{2,}/g, ' '],

    // Apostrophes : supprimer les espaces autour
    [/[ \t\u00A0\u202F]+(['\u2019\u02BC])/g, '$1'],
    [/(['\u2019\u02BC])[ \t\u00A0\u202F]+/g, '$1'],

    // Aucune espace avant virgule et point
    [/[ \t\u00A0\u202F]+([,.])/g, '$1'],

    // Une espace après la virgule
    [/,([^\s])/g, ', $1'],

    // Espace fine insécable avant ; : ? !
    [/[ \t\u00A0\u202F]*([;:?!])/g, NNBSP + '$1'],

    // Une espace après ; et :
    [/([;:])(?=[^\s])/g, '$1 '],

    // Une espace après ? et !
    [/([?!])(?=[^\s»”’)\]}])/g, '$1 '],

    // Guillemets français
    [/«[ \t\u00A0\u202F]*/g, '«' + NNBSP],
    [/[ \t\u00A0\u202F]*»/g, NNBSP + '»'],

    // Une espace après le guillemet fermant
    [/»(?=[A-Za-zÀ-ÖØ-öø-ÿ(])/g, '» '],

    // Parenthèses : aucune espace à l'intérieur
    [/\([ \t\u00A0\u202F]+/g, '('],
    [/[ \t\u00A0\u202F]+\)/g, ')'],

    // Espace avant une parenthèse ouvrante
    [/([A-Za-zÀ-ÖØ-öø-ÿ0-9])\(/g, '$1 ('],

    // Points de suspension : pas d'espace avant
    [/[ \t\u00A0\u202F]+(?=\.{3,}|…)/g, ''],

    // Trois points ou plus deviennent …
    [/\.{3,}/g, '…'],

    // Espace après les points de suspension
    [/…(?=\S)/g, '… '],

    // Espace après un point si une lettre ou une parenthèse suit
    [/\.([A-Za-zÀ-ÖØ-öø-ÿ«(])/g, '. $1'],

    // Espace fine insécable avant % et €
    [/[ \t\u00A0\u202F]*%/g, NNBSP + '%'],
    [/[ \t\u00A0\u202F]*€/g, NNBSP + '€'],

    // Nettoyage des espaces en fin de ligne
    [/[ \t]+(?=\r|\n|$)/g, ''],

    // Suppression des tabulations en début de paragraphe
    [/\r\t+/g, '\r']
  ];

  for (const [pattern, replacement] of rules) {
    text = text.replace(pattern, replacement);
  }

  // Normaliser « etc… » ou « etc... » en « etc. »
  // Le groupe capturé conserve la casse exacte : Etc, etc ou ETC.
  text = text.replace(
    /\b(etc)\s*(?:…|\.{2,})/gi,
    (match, word) => word + '.'
  );

  // Espace insécable avant « etc. », sans modifier sa casse.
  text = text.replace(
    /[ \t\u00A0\u202F]+(etc\.)(?=\s|$)/gi,
    (match, word) => NBSP + word
  );

  // Restaurer les URL sans les modifier
  for (const item of protectedData.protectedURLs) {
    text = text.replace(item.token, item.value);
  }

  return text;
}

function main() {
  const doc = Document.current;
  if (!doc) return;

  const nodes = [...new Set(
    doc.selection.nodes.filter(n => n.isTextNode)
  )];

  if (!nodes.length) return;

  for (const node of nodes) {
    const original = node.story.text;
    const corrected = correctTypography(original);

    if (corrected === original) continue;

    const selection = Selection.create(doc, node);

    selection.addSubSelectionForNode(
      node,
      TextSelection.create([{
        begin: 0,
        end: original.length
      }])
    );

    doc.executeCommand(
      DocumentCommand.createSetText(selection, corrected)
    );
  }
}

main();

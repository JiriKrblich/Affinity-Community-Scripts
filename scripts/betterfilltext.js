'use strict';

/**
 * name: Better Filltext
 * description: Better Filltext — fills the selected text frame(s) with placeholder
 *              text in a choice of styles (Lorem, Hipster, Cupcake, Bacon,
 *              Cheese, Pirate, Cat, Corporate, Coffee, Zombie, Cosmic, Legalese).
 *              Choose the amount by paragraphs, sentences, words or characters,
 *              and optionally begin with the style's signature opening. Gives
 *              exact-count control that Affinity's native filler text does not.
 * version: 1.1.0
 * author: olliollio - analog digitalagentur
 */

const { app } = require('/application');
const { Document } = require('/document');
const { Selection } = require('/selections');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Dialog, DialogResult } = require('/dialog');
const { UnitType } = require('/units');

const VERSION = 'v1.1';
const TITLE = 'Better Filltext';

// Paragraph separator written into the frame. Affinity treats a newline as a
// paragraph break in a set-text; if paragraphs run together, switch to '\r'.
const PARA = '\n';

const MODES = ['Paragraphs', 'Sentences', 'Words', 'Characters'];
const MODE_PARAS = 0, MODE_SENTENCES = 1, MODE_WORDS = 2, MODE_CHARS = 3;
const DEFAULT_COUNT = { 0: 3, 1: 5, 2: 50, 3: 400 };

// ---------------------------------------------------------------------------
// Theme registry. Each theme is a word bank + a signature opening. All banks
// are generated word lists (not copyrighted quote sets), so they are safe to
// bundle and publish. To add a theme, append an entry — nothing else changes.
// ---------------------------------------------------------------------------
function bank(str) { return str.split(/\s+/).filter(Boolean); }

const THEMES = [
  { name: 'Lorem',
    opening: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    words: bank('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod t dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laborisnisi aliquip ex ea commodo consequat duis aute irure reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt
mollit anim id est laborum vero eos accusamus iusto odio dignissimos ducimus blanditiisiti atque corrupti dolores quas molestias excepturi similique mollitia animi dolorumfuga harum quidem rerum facilis expedita distinctio nam libero tempore soluta nobis eligendi optio cumque nihil impedit quo porro quisquam') },

  { name: 'Hipster',
    opening: 'I am baby vegan cold-pressed cardigan, artisan mustache kombucha selvage.
    words: bank('artisan austin banjo bespoke bicycle brunch cardigan craft distillery ennui fixie flannel gastropub gentrify hashtag heirloom kombucha locavore mixtape mustache narwhal normcore organic
pickled polaroid quinoa ramps retro sartorial selfie small-batch sriracha sustainable tvegan vinyl wayfarers yr biodiesel chambray cliche cronut fanny pack forage humblebraglomo migas photobooth pinterest pug schlitz semiotics thundercats twee unicorn viral waistcoat') },

  { name: 'Cupcake',
    opening: 'Cupcake ipsum dolor sit amet jelly gummies chocolate marzipan.',
    words: bank('sugar cupcake chocolate candy caramel dessert icing sweet marshmallow cookie gingerbread jelly lollipop macaroon muffin pastry pie pudding sprinkles tart toffee wafer cake cheesecake
croissant donut fudge gummies halvah liquorice brownie bonbon danish souffle topping bin dragee jujubes chupa oat bear claw sweet-roll cotton-candy sesame-snaps lemon-dropsapple-pie') },

  { name: 'Bacon',
    opening: 'Bacon ipsum dolor amet ribeye brisket sausage meatball pork.',
    words: bank('bacon pork beef ribeye brisket meatball sausage ham pancetta prosciutto salami chuck shank sirloin tenderloin turkey chicken kielbasa pastrami jerky bresaola capicola cow drumstick filet
mignon flank frankfurter hamburger jowl landjaeger leberkas meatloaf pig porchetta rumpstrip-steak swine t-bone tail tri-tip venison boudin fatback kevin') },

  { name: 'Cheese',
    opening: 'Cheese ipsum dolor sit amet cheddar brie gouda fondue.',
    words: bank('cheese cheesy cheddar brie gouda camembert roquefort stilton mozzarellere edam emmental manchego mascarpone ricotta fondue melted croque paneer boursinjarlsberg taleggio gorgonzola dolcelatte fromage bavarian bergkase fontina cheese-triangles cheese-slices port-salut red-leicester squirty rubber goats caerphilly cheese-strings babybel wensleydale') },

  { name: 'Pirate',
    opening: 'Yarr ipsum dolor sit amet, shiver me timbers and a bottle of grog.',
    words: bank('arr avast matey ahoy booty doubloon plunder scallywag buccaneer corsair cutlass galleon grog hornswaggle jolly-roger keelhaul landlubber marooned mutiny parley privateer quartermaster
scurvy shanty swashbuckler treasure wench yardarm bilge brig cannon capstan coffer crowr nautical port starboard sea-dog spyglass plank rum kraken tide') },

  { name: 'Cat',
    opening: 'Cat ipsum dolor sit amet, meow purr and knock things off the table.',
    words: bank('cat kitty meow purr feline whiskers paw tail mouse catnip scratch haire knead pounce hiss tuna chase laser box yarn zoomies biscuits headbutt chirp floof boop toe-beans loaf chonk blep tabby tuxedo calico ginger kitten human keyboard judge ignore nibble stretch groom windowsill treat') },

  { name: 'Corporate',
    opening: 'Synergy ipsum dolor sit amet, leverage core competencies to move the need
    words: bank('synergy leverage paradigm disrupt streamline bandwidth deliverable stakeholder alignment ideate actionable scalable holistic agile pivot ecosystem roadmap touchpoint low-hanging deep-dive
circle-back value-add core-competency best-practice granular incentivize monetize optimritical thought-leadership north-star drill-down table-stakes quick-win unpackwheelhouse bleeding-edge next-gen empower cadence velocity onboarding vertical') },

  { name: 'Coffee',
    opening: 'Coffee ipsum dolor sit amet espresso crema single-origin froth.',
    words: bank('coffee espresso latte cappuccino mocha americano macchiato cortado ristretto affogato arabica robusta barista brew crema froth roast bean grind portafilter steamed foam single-origin
pour-over cold-brew flat-white caffeine decaf dark-roast medium-roast aroma cup mug sauseasonal artisan fair-trade aromatic morning refill blend tamp') },

  { name: 'Zombie',
    opening: 'Zombie ipsum dolor sit amet braaains groan shamble undead.',
    words: bank('zombie braaains undead groan shamble horde decay rotting flesh moan apeak survivor barricade shotgun bite reanimated corpse graveyard lurch stagger feasthunger relentless swarm wasteland bunker quarantine mindless night terror dread chomp gnaw festering plague contagion shuffle grave tomb crypt ghoul revenant bleak') },

  { name: 'Cosmic',
    opening: 'Cosmos ipsum dolor sit amet stardust nebula billions of stars.',
    words: bank('cosmos galaxy nebula stardust orbit quasar pulsar cosmic stellar celestial void interstellar asteroid comet supernova gravity universe planet meteor radiant luminous spacetime horizon
infinite wonder billions atoms elements hydrogen expanse telescope photon quantum dark-ear drifting boundless ancient glowing distant exploration vast realm cradle') },

  { name: 'Legalese',
    opening: 'Whereas ipsum dolor sit amet, hereinafter the party of the first part.',
    words: bank('heretofore whereas hereinafter aforementioned party indemnify liabilitvenant jurisdiction arbitration provision clause therein thereof herewith stipulatewarranty hereunder breach remedy damages plaintiff defendant tort statute allege counsel affidavit subpoena deposition jurisprudence consideration obligation forthwith aforesaid henceforth waiver addendum
in-perpetuity force-majeure good-faith due-diligence without-prejudice witnesseth') },
];

// -- Text generation --------------------------------------------------------
function ri(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function pick(words) { return words[Math.floor(Math.random() * words.length)]; }

function sentence(words) {
  const n = ri(5, 14);
  const w = [];
  for (let i = 0; i < n; i++) w.push(pick(words));
  if (n > 6 && Math.random() < 0.6) {           // sprinkle a comma
    const c = ri(2, n - 3);
    w[c] = w[c] + ',';
  }
  const s = w.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

function makeSentence(theme, first, useOpening) {
  return (first && useOpening && theme.opening) ? theme.opening : sentence(theme.words)
}

function paragraph(words) {
  const n = ri(3, 6);
  const s = [];
  for (let i = 0; i < n; i++) s.push(sentence(words));
  return s.join(' ');
}

function generate(theme, modeIdx, count, useOpening) {
  count = Math.max(1, Math.floor(count));
  const words = theme.words;

  if (modeIdx === MODE_WORDS) {
    const opener = (useOpening && theme.opening)
      ? theme.opening.replace(/[^\w\s'-]/g, '').toLowerCase().split(/\s+/).filter(Boole
      : null;
    const w = [];
    for (let i = 0; i < count; i++) {
      w.push(opener && i < opener.length ? opener[i] : pick(words));
    }
    const s = w.join(' ');
    return s.charAt(0).toUpperCase() + s.slice(1) + '.';
  }

  if (modeIdx === MODE_SENTENCES) {
    const s = [];
    for (let i = 0; i < count; i++) s.push(makeSentence(theme, i === 0, useOpening));
    return s.join(' ');
  }

  if (modeIdx === MODE_CHARS) {
    let out = '', first = true;
    while (out.length < count) {
      out += (out ? ' ' : '') + makeSentence(theme, first, useOpening);
      first = false;
    }
    if (out.length > count) {
      out = out.slice(0, count);
      const sp = out.lastIndexOf(' ');
      if (sp > count * 0.6) out = out.slice(0, sp);    // don't cut mid-word
      out = out.replace(/[\s,]+$/, '');
      if (!/[.!?]$/.test(out)) out += '.';
    }
    return out;
  }

  // MODE_PARAS (default)
  const paras = [];
  for (let i = 0; i < count; i++) {
    if (i === 0 && useOpening && theme.opening) {
      const s = [theme.opening];
      const extra = ri(2, 4);
      for (let j = 0; j < extra; j++) s.push(sentence(words));
      paras.push(s.join(' '));
    } else {
      paras.push(paragraph(words));
    }
  }
  return paras.join(PARA);
}

// -- Targets: selected nodes that own a text story --------------------------
function targetFrames(doc) {
  const frames = [], seen = new Set();
  const add = (n) => {
    try { if (n && n.storyInterface && n.storyInterface.story && !seen.has(n)) { seen.add(n); frames.push(n); } }
    catch (e) {}
  };
  const sel = doc.selection;
  try { if (sel && sel.items) for (const it of sel.items) add(it.node); } catch (e) {}
  if (frames.length === 0) { try { add(sel && sel.firstNode); } catch (e) {} }
  return frames;
}

function main() {
  const doc = Document.current;
  if (!doc) { app.alert('Open a document first.', TITLE); return; }

  const frames = targetFrames(doc);
  if (frames.length === 0) {
    app.alert('Select a text frame to fill with placeholder text.', TITLE);
    return;
  }

  // -- Dialog --------------------------------------------------------------
  const dlg = Dialog.create(TITLE + ' ' + VERSION);
  dlg.initialWidth = 380;
  const col = dlg.addColumn();
  const grp = col.addGroup('Placeholder text');

  const styleCombo = grp.addComboBox('Style', THEMES.map((t) => t.name), 0);
  const modeCombo  = grp.addComboBox('Amount of', MODES, MODE_PARAS);
  const countEdit  = grp.addUnitValueEditor('Count', UnitType.Number, UnitType.Number,
    DEFAULT_COUNT[MODE_PARAS], 1, 100000);
  countEdit.precision = 0;
  const chkOpening = grp.addCheckBox('Start with signature opening', true);
  grp.addStaticText('Target', frames.length + ' text frame' + (frames.length === 1 ? ''

  // Switching mode resets the count to that mode's sensible default.
  modeCombo.onValueChangedHandler = () => {
    countEdit.value = DEFAULT_COUNT[modeCombo.selectedIndex];
  };

  if (dlg.runModal() !== DialogResult.Ok) return;

  const theme = THEMES[styleCombo.selectedIndex] || THEMES[0];
  const modeIdx = modeCombo.selectedIndex;
  const count = Math.max(1, Math.round(Number(countEdit.value)));
  const useOpening = chkOpening.value;

  // -- Apply: fresh text per frame, one undo step -------------------------
  try {
    const builder = CompoundCommandBuilder.create();
    for (const f of frames) {
      const text = generate(theme, modeIdx, count, useOpening);
      const selF = Selection.create(doc, f);
      builder.addCommand(DocumentCommand.createSetText(selF, text));
    }
    doc.executeCommand(builder.createCommand());
    app.alert('Filled ' + frames.length + ' frame' + (frames.length === 1 ? '' : 's') +
      ' with ' + count + ' ' + MODES[modeIdx].toLowerCase() + ' of ' + theme.name + ' t
  } catch (err) {
    app.alert('Could not set text:\n' + (err && err.message ? err.message : err), TITLE
  }
}

main();

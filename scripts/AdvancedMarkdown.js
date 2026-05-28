/**
 * name: Advanced Markdown To Affinity
 * category: Text Formatting
 * author: Torsten Dinkheller <affinity-scripts@m-gd.com>
 * description: Imports a Markdown file and applies paragraph and character styles
 *              to the selected text frame in Affinity Publisher.
 * compatibility: Affinity Suite 3.2 Publisher
 * version: 5.01.001
 */

"use strict";

(function () {
  // ─── Imports ──────────────────────────────────────────────────────────────
  const { app } = require("/application");
  const { File } = require("/fs");
  const { Document } = require("/document");
  const { Selection, TextSelection } = require("/selections");
  const { StoryRange } = require("affinity:story");
  const { DocumentCommand } = require("/commands");
  const { StoryDelta } = require("/storydelta");
  const {
    ParagraphAttStringType,
    ParagraphAttDoubleType,
  } = require("/paragraphatts");
  const { GlyphAttStringType } = require("/glyphatts");
  const { Dialog, DialogResult } = require("/dialog");

  // ─── Style base lists ─────────────────────────────────────────────────────
  var PARA_STYLE_DEFAULTS = [
    "Heading 1",
    "Heading 2",
    "Heading 3",
    "Heading 4",
    "Heading 5",
    "Heading 6",
    "Body",
    "Quote",
    "Bullet 1",
    "Numbered 1",
    "Code",
    "Horizontal Rule",
  ];
  var CHAR_STYLE_DEFAULTS = [
    "Strong",
    "Emphasis",
    "Strong Emphasis",
    "Code",
    "Bold",
    "Italic",
    "Bold Italic",
    "No Style",
  ];

  // ─── ComboBox helpers ─────────────────────────────────────────────────────
  /** Merges addList items missing from baseList; returns sorted combined list. */
  function mergeStyleList(baseList, addList) {
    var result = baseList.slice();
    for (var i = 0; i < addList.length; i++) {
      if (result.indexOf(addList[i]) < 0) result.push(addList[i]);
    }
    // localeCompare not used – not supported by all JS engines
    result.sort(function (a, b) {
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return result;
  }

  /** Creates a ComboBox and safely sets selectedIndex to the saved value. */
  function addStyleCombo(group, label, items, savedValue) {
    var idx = items.indexOf(savedValue);
    if (idx < 0) idx = 0;
    var ctrl = group.addComboBox(label, items, idx);
    try {
      ctrl.selectedIndex = idx;
    } catch (e) {}
    return ctrl;
  }

  /** Reads the selected value from a ComboBox; falls back to savedVal on error. */
  function readCombo(ctrl, items, savedVal) {
    if (!ctrl) return savedVal;
    try {
      var idx = ctrl.selectedIndex;
      if (typeof idx === "number" && idx >= 0 && idx < items.length)
        return items[idx];
    } catch (e) {}
    return savedVal;
  }

  // ─── Configuration ────────────────────────────────────────────────────────
  var DEFAULTS = {
    customStyles: [], // user-saved custom style names
    para: {
      h1: "Heading 1",
      h2: "Heading 2",
      h3: "Heading 3",
      h4: "Heading 4",
      h5: "Heading 5",
      h6: "Heading 6",
      body: "Body",
      quote: "Quote",
      bullet: "Bullet 1",
      numbered: "Numbered 1",
      code: "Code",
    },
    glyph: {
      strong: "Strong",
      emphasis: "Emphasis",
      strongEmphasis: "Strong Emphasis",
      inlineCode: "Code",
    },
    opts: {
      hrStyle: "Horizontal Rule",
      clearFrame: false,
      bulletSimulate: false,
      numberedSimulate: false,
      listIndent: 10,
      listHang: 5,
      strongSimulate: false,
      emphasisSimulate: false,
      strongEmphasisSimulate: false,
      masterSimulate: false,
    },
  };

  /** Returns the path to the config file on the Desktop. */
  function configPath() {
    try {
      return app.userDesktopPath + "/md-to-affinity-config.json";
    } catch (e) {
      return "";
    }
  }

  /** Loads and parses the saved configuration; returns null on error. */
  function loadConfig() {
    var path = configPath();
    if (!path) return null;
    try {
      var buf = File.readAll(path);
      return buf ? JSON.parse(String(buf)) : null;
    } catch (e) {
      return null;
    }
  }

  /** Saves the configuration as a JSON file on the Desktop. */
  function saveConfig(cfg) {
    var path = configPath();
    if (!path) return;
    try {
      var f = new File(path, "w");
      f.writeString(JSON.stringify(cfg, null, 2));
      f.close();
    } catch (e) {}
  }

  /** Recursively fills missing keys from defaults into saved config. */
  function mergeDefaults(saved, defaults) {
    if (typeof saved !== "object" || saved === null)
      return JSON.parse(JSON.stringify(defaults));
    var merged = JSON.parse(JSON.stringify(saved));
    for (var key in defaults) {
      var dv = defaults[key];
      if (typeof dv === "object" && dv !== null && !Array.isArray(dv)) {
        merged[key] = mergeDefaults(saved[key], dv);
      } else if (merged[key] === undefined) {
        merged[key] = Array.isArray(dv) ? dv.slice() : dv;
      }
    }
    return merged;
  }

  // Load saved configuration; null = first run
  var savedConfig = loadConfig();
  var isFirstRun = savedConfig === null;
  var cfg = mergeDefaults(savedConfig, DEFAULTS);
  var p = cfg.para,
    g = cfg.glyph,
    o = cfg.opts;

  // ─── First run: welcome message ───────────────────────────────────────────
  if (isFirstRun) {
    app.alert(
      "Welcome.\n\n" +
        "To use this script you must have a text frame selected " +
        "that is not linked to other text frames.\n\n",
      "Advanced Markdown to Affinity",
    );
  }

  // ─── Text frame validation ────────────────────────────────────────────────
  var doc = Document.current;
  if (!doc) {
    app.alert("No open document.", "Error");
    return;
  }

  var selectedNodes = doc.selection.nodes;
  if (!selectedNodes || selectedNodes.length !== 1) {
    app.alert("Please select exactly one text frame.", "Error");
    return;
  }
  var frame = selectedNodes.first;
  if (!frame || !frame.isFrameTextNode || !frame.storyInterface) {
    app.alert("The selected object is not a text frame.", "Error");
    return;
  }
  if (frame.storyInterface.isMultiFrameTextFlow) {
    app.alert(
      "The selected text frame is linked to other text frames.\n" +
        "Please select a standalone (unlinked) frame.",
      "Error",
    );
    return;
  }

  // ─── Load Markdown file ───────────────────────────────────────────────────
  var filePath;
  try {
    filePath = app.chooseFile();
  } catch (e) {
    app.alert("File selection failed.", "Error");
    return;
  }
  if (!filePath) {
    app.alert("No file selected.", "Markdown to Affinity");
    return;
  }

  var markdown;
  try {
    var buf = File.readAll(filePath);
    if (!buf) throw new Error("File is empty or unreadable.");
    markdown = String(buf);
    // Strip BOM (Windows editors add UTF-8 BOM; Affinity filters it on insert,
    // which shifts all character positions by 1 – remove it explicitly here)
    if (markdown.charCodeAt(0) === 0xfeff) {
      markdown = markdown.slice(1);
    }
    markdown = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  } catch (e) {
    app.alert(String(e.message || e), "Error reading file");
    return;
  }

  // ─── Detect used MD types ─────────────────────────────────────────────────
  /** Scans the Markdown with regexes and returns which block/inline types are present. */
  function detectUsedTypes(src) {
    var u = {
      h1: false,
      h2: false,
      h3: false,
      h4: false,
      h5: false,
      h6: false,
      body: false,
      quote: false,
      bullet: false,
      numbered: false,
      codeBlock: false,
      hr: false,
      strong: false,
      emphasis: false,
      strongEmphasis: false,
      inlineCode: false,
    };
    var lines = src.split("\n");
    var inFence = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^(\s*)(`{3,}|~{3,})/.test(line)) {
        inFence = !inFence;
        u.codeBlock = true;
        continue;
      }
      if (inFence) continue;
      var t = line.trim();
      if (!t) continue;
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
        u.hr = true;
        continue;
      }
      var hm = t.match(/^(#{1,6})\s/);
      if (hm) {
        u["h" + hm[1].length] = true;
      } else if (/^\s*[-*+]\s/.test(line)) {
        u.bullet = true;
      } else if (/^\s*\d+[.)]\s/.test(line)) {
        u.numbered = true;
      } else if (/^\s*>\s?/.test(line)) {
        u.quote = true;
      } else {
        u.body = true;
      }
      // Inline markers – check longest first
      if (/\*{3}|_{3}/.test(t)) {
        u.strongEmphasis = true;
        u.strong = true;
        u.emphasis = true;
      } else if (/\*{2}|_{2}/.test(t)) {
        u.strong = true;
      }
      if (/(?:^|[^*])\*(?:[^*]|$)/.test(t) || /(?:^|[^_])_(?:[^_]|$)/.test(t)) {
        u.emphasis = true;
      }
      if (/`[^`]/.test(t)) {
        u.inlineCode = true;
      }
    }
    return u;
  }
  var used = detectUsedTypes(markdown);

  // ─── Current selection (preserved across dialog re-opens) ─────────────────
  var curSel = {
    h1: p.h1,
    h2: p.h2,
    h3: p.h3,
    h4: p.h4,
    h5: p.h5,
    h6: p.h6,
    body: p.body,
    quote: p.quote,
    bullet: p.bullet,
    numbered: p.numbered,
    code: p.code,
    hr: o.hrStyle,
    inlineCode: g.inlineCode,
    cStrong: g.strong,
    cEmphasis: g.emphasis,
    cSE: g.strongEmphasis,
    clearFrame: o.clearFrame,
    bulletSim: o.bulletSimulate,
    numberedSim: o.numberedSimulate,
    strongSim: o.strongSimulate,
    emphasisSim: o.emphasisSimulate,
    seSim: o.strongEmphasisSimulate,
    masterSim: o.masterSimulate,
  };

  /** Disables a character-style control while its simulate switch is active. */
  function syncCharStyleCtrl(sw, ctrl) {
    try {
      ctrl.isEnabled = !Boolean(sw.value);
    } catch (e) {}
  }
  /** Reads a switch value; returns savedVal if the switch is unavailable. */
  function readSw(sw, savedVal) {
    if (!sw) return savedVal;
    try {
      return Boolean(sw.value);
    } catch (e) {
      return savedVal;
    }
  }

  var continueLoop = true;

  // ─── Dialog loop (main dialog; "Manage Styles" opens the style manager) ───
  while (continueLoop) {
    continueLoop = false;

    // Build style lists including current customStyles (alphabetically sorted)
    var allParaStyles = mergeStyleList(
      PARA_STYLE_DEFAULTS,
      cfg.customStyles || [],
    );
    var allCharStyles = mergeStyleList(
      CHAR_STYLE_DEFAULTS,
      cfg.customStyles || [],
    );

    var dlg = Dialog.create("Markdown \u2013 Affinity \u2013 Style Assignment");
    var col1 = dlg.addColumn();
    var col2 = dlg.addColumn();
    var ctrls = {};

    // ── Column 1: Paragraph styles ────────────────────────────────────────
    var HN_LABELS = {
      h1: "# H1",
      h2: "## H2",
      h3: "### H3",
      h4: "#### H4",
      h5: "##### H5",
      h6: "###### H6",
    };
    var usedHn = ["h1", "h2", "h3", "h4", "h5", "h6"].filter(function (k) {
      return used[k];
    });
    if (usedHn.length > 0) {
      var grpHeadings = col1.addGroup("Headings");
      for (var hi = 0; hi < usedHn.length; hi++) {
        var hk = usedHn[hi];
        ctrls[hk] = addStyleCombo(
          grpHeadings,
          HN_LABELS[hk],
          allParaStyles,
          curSel[hk],
        );
      }
    }

    var BLOCK_DEFS = [
      {
        key: "body",
        label: "Body (fallback)",
        isChar: false,
        v: function () {
          return curSel.body;
        },
      },
      {
        key: "quote",
        label: "> Block quote",
        isChar: false,
        v: function () {
          return curSel.quote;
        },
      },
      {
        key: "bullet",
        label: "- List (style)",
        isChar: false,
        v: function () {
          return curSel.bullet;
        },
      },
      {
        key: "numbered",
        label: "1. Numbered (style)",
        isChar: false,
        v: function () {
          return curSel.numbered;
        },
      },
      {
        key: "codeBlock",
        label: "``` Code block",
        isChar: false,
        v: function () {
          return curSel.code;
        },
      },
      {
        key: "inlineCode",
        label: "`Inline code`",
        isChar: true,
        v: function () {
          return curSel.inlineCode;
        },
      },
      {
        key: "hr",
        label: "--- Horizontal rule",
        isChar: false,
        v: function () {
          return curSel.hr;
        },
      },
    ];
    var usedBlocks = BLOCK_DEFS.filter(function (b) {
      return used[b.key];
    });
    if (usedBlocks.length > 0) {
      var grpBlocks = col1.addGroup("Blocks");
      for (var bi = 0; bi < usedBlocks.length; bi++) {
        var bd = usedBlocks[bi];
        ctrls[bd.key] = addStyleCombo(
          grpBlocks,
          bd.label,
          bd.isChar ? allCharStyles : allParaStyles,
          bd.v(),
        );
      }
    }

    // ── Column 2: Options + simulate switches ─────────────────────────────
    var grpOptions = col2.addGroup("Options");
    var swClear = grpOptions.addSwitch(
      "Replace existing text",
      curSel.clearFrame,
    );

    var SIM_DEFS = [
      {
        key: "strong",
        label: "**Bold** via font weight 700",
        v: function () {
          return curSel.strongSim;
        },
      },
      {
        key: "emphasis",
        label: "*Italic* via italic flag",
        v: function () {
          return curSel.emphasisSim;
        },
      },
      {
        key: "strongEmphasis",
        label: "***Bold+Italic*** via font",
        v: function () {
          return curSel.seSim;
        },
      },
      {
        key: "bullet",
        label: "Simulate bullet (\u2022)",
        v: function () {
          return curSel.bulletSim;
        },
      },
      {
        key: "numbered",
        label: "Simulate numbering (1.)",
        v: function () {
          return curSel.numberedSim;
        },
      },
    ];
    var usedSims = SIM_DEFS.filter(function (s) {
      return used[s.key];
    });
    var swMaster =
      usedSims.length > 1
        ? grpOptions.addSwitch("MASTER TOGGLE", curSel.masterSim)
        : null;
    var swSimMap = {};
    for (var si = 0; si < usedSims.length; si++) {
      var sd = usedSims[si];
      swSimMap[sd.key] = grpOptions.addSwitch(sd.label, sd.v());
    }

    var CHAR_DEFS = [
      {
        key: "strong",
        label: "**Bold**",
        v: function () {
          return curSel.cStrong;
        },
      },
      {
        key: "emphasis",
        label: "*Italic*",
        v: function () {
          return curSel.cEmphasis;
        },
      },
      {
        key: "strongEmphasis",
        label: "***Bold+Italic***",
        v: function () {
          return curSel.cSE;
        },
      },
    ];
    var usedCharStyles = CHAR_DEFS.filter(function (c) {
      return used[c.key];
    });
    if (usedCharStyles.length > 0) {
      var grpCharStyles = col2.addGroup(
        "Character styles (when not simulated)",
      );
      for (var ci = 0; ci < usedCharStyles.length; ci++) {
        var cd = usedCharStyles[ci];
        var ctrlKey = "charStyle_" + cd.key;
        ctrls[ctrlKey] = addStyleCombo(
          grpCharStyles,
          cd.label,
          allCharStyles,
          cd.v(),
        );
        if (swSimMap[cd.key])
          syncCharStyleCtrl(swSimMap[cd.key], ctrls[ctrlKey]);
      }
    }

    // ── Full-width action button at the bottom of column 2 ────────────────
    // item[0] = "Manage Styles"  → opens style manager, main dialog rebuilds
    // item[1] = "Apply" (default) → runs the import immediately
    var grpAction = col2.addGroup("Action");
    var btnAction = grpAction.addButtonSet(
      "",
      ["\nManage Styles\n", "\nApply\n"],
      1,
    );
    btnAction.isFullWidth = true;

    // Event handlers: simulate switch → enable/disable character-style combo
    (function () {
      for (var ei = 0; ei < usedCharStyles.length; ei++) {
        (function (ck) {
          var sw = swSimMap[ck];
          var ctrl = ctrls["charStyle_" + ck];
          if (sw && ctrl)
            sw.onValueChangedHandler = function () {
              syncCharStyleCtrl(sw, ctrl);
            };
        })(usedCharStyles[ei].key);
      }
    })();

    if (swMaster) {
      swMaster.onValueChangedHandler = function () {
        var v = swMaster.value;
        for (var k in swSimMap) {
          if (swSimMap[k]) swSimMap[k].value = v;
        }
      };
    }

    // ─── Show dialog ──────────────────────────────────────────────────────
    if (dlg.runModal() != DialogResult.Ok) {
      return;
    }

    // ─── Save current selection ───────────────────────────────────────────
    curSel.h1 = readCombo(ctrls.h1 || null, allParaStyles, curSel.h1);
    curSel.h2 = readCombo(ctrls.h2 || null, allParaStyles, curSel.h2);
    curSel.h3 = readCombo(ctrls.h3 || null, allParaStyles, curSel.h3);
    curSel.h4 = readCombo(ctrls.h4 || null, allParaStyles, curSel.h4);
    curSel.h5 = readCombo(ctrls.h5 || null, allParaStyles, curSel.h5);
    curSel.h6 = readCombo(ctrls.h6 || null, allParaStyles, curSel.h6);
    curSel.body = readCombo(ctrls.body || null, allParaStyles, curSel.body);
    curSel.quote = readCombo(ctrls.quote || null, allParaStyles, curSel.quote);
    curSel.bullet = readCombo(
      ctrls.bullet || null,
      allParaStyles,
      curSel.bullet,
    );
    curSel.numbered = readCombo(
      ctrls.numbered || null,
      allParaStyles,
      curSel.numbered,
    );
    curSel.code = readCombo(
      ctrls.codeBlock || null,
      allParaStyles,
      curSel.code,
    );
    curSel.hr = readCombo(ctrls.hr || null, allParaStyles, curSel.hr);
    curSel.inlineCode = readCombo(
      ctrls.inlineCode || null,
      allCharStyles,
      curSel.inlineCode,
    );
    curSel.cStrong = readCombo(
      ctrls.charStyle_strong || null,
      allCharStyles,
      curSel.cStrong,
    );
    curSel.cEmphasis = readCombo(
      ctrls.charStyle_emphasis || null,
      allCharStyles,
      curSel.cEmphasis,
    );
    curSel.cSE = readCombo(
      ctrls.charStyle_strongEmphasis || null,
      allCharStyles,
      curSel.cSE,
    );
    curSel.clearFrame = readSw(swClear, curSel.clearFrame);
    curSel.bulletSim = readSw(swSimMap["bullet"] || null, curSel.bulletSim);
    curSel.numberedSim = readSw(
      swSimMap["numbered"] || null,
      curSel.numberedSim,
    );
    curSel.strongSim = readSw(swSimMap["strong"] || null, curSel.strongSim);
    curSel.emphasisSim = readSw(
      swSimMap["emphasis"] || null,
      curSel.emphasisSim,
    );
    curSel.seSim = readSw(swSimMap["strongEmphasis"] || null, curSel.seSim);
    curSel.masterSim = readSw(swMaster, curSel.masterSim);

    // ─── Which action button was pressed? ─────────────────────────────────
    var actionIdx = 1;
    try {
      actionIdx = btnAction.selectedIndex;
    } catch (e) {}

    if (actionIdx === 0) {
      // "Manage Styles" → open the style manager dialog

      var smDlg = Dialog.create("Manage Styles");
      var smCol = smDlg.addColumn();

      // ── Input group ───────────────────────────────────────────────────
      var smGrpIn = smCol.addGroup("Style name");
      var smTb = smGrpIn.addTextBox("", "");

      // 3-item ButtonSet: [O=neutral | +=add | -=delete], isFullWidth
      var smBtn = smGrpIn.addButtonSet("", ["O", "+", "-"], 0);
      smBtn.isFullWidth = true;

      // ── Display group: all custom styles ──────────────────────────────
      var smGrpList = smCol.addGroup("Custom styles");
      var smLbl1 = smGrpList.addStaticText("", "");
      var smLbl2 = smGrpList.addStaticText("", "");
      var smLbl3 = smGrpList.addStaticText("", "");
      var smLbl4 = smGrpList.addStaticText("", "");

      // Working copy + original snapshot for Cancel
      var smWorkStyles = Array.isArray(cfg.customStyles)
        ? cfg.customStyles.slice()
        : [];
      var smOrigStyles = smWorkStyles.slice();

      // Distributes smWorkStyles across 4 label rows (4 styles per row)
      var smUpdateDisplay = function () {
        var lbls = [smLbl1, smLbl2, smLbl3, smLbl4];
        if (smWorkStyles.length === 0) {
          smLbl1.text = "(none)";
          for (var li = 1; li < lbls.length; li++) lbls[li].text = "";
          return;
        }
        var CHUNK = 4;
        var lines = [];
        for (var ci = 0; ci < smWorkStyles.length; ci += CHUNK) {
          lines.push(smWorkStyles.slice(ci, ci + CHUNK).join(", "));
        }
        for (var li2 = 0; li2 < lbls.length; li2++) {
          lbls[li2].text = lines[li2] || "";
        }
      };

      var smAddStyle = function () {
        var nm = smTb.text ? smTb.text.trim() : "";
        if (!nm) return;
        if (smWorkStyles.indexOf(nm) < 0) {
          smWorkStyles.push(nm);
          smWorkStyles.sort(function (a, b) {
            return a < b ? -1 : a > b ? 1 : 0;
          });
        }
        smTb.text = "";
        smUpdateDisplay();
      };

      var smDeleteStyle = function () {
        var nm = smTb.text ? smTb.text.trim() : "";
        if (!nm) return;
        var idx = smWorkStyles.indexOf(nm);
        if (idx >= 0) smWorkStyles.splice(idx, 1);
        smTb.text = "";
        smUpdateDisplay();
      };

      smUpdateDisplay(); // initial display

      var _smBusy = false;
      smBtn.onValueChangedHandler = function () {
        if (_smBusy) return;
        var idx = smBtn.selectedIndex;
        if (idx === 0) return; // 'O' = neutral, do nothing
        _smBusy = true;
        smBtn.selectedIndex = 0;
        _smBusy = false;
        if (idx === 1) smAddStyle();
        else if (idx === 2) smDeleteStyle();
      };

      var smResult = smDlg.runModal();

      if (smResult === DialogResult.Ok) {
        // Determine deleted styles and clear affected curSel fields
        var smDeleted = [];
        for (var di = 0; di < smOrigStyles.length; di++) {
          if (smWorkStyles.indexOf(smOrigStyles[di]) < 0) {
            smDeleted.push(smOrigStyles[di]);
          }
        }
        if (smDeleted.length > 0) {
          var selKeys = [
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "body",
            "quote",
            "bullet",
            "numbered",
            "code",
            "hr",
            "inlineCode",
            "cStrong",
            "cEmphasis",
            "cSE",
          ];
          for (var ki = 0; ki < selKeys.length; ki++) {
            if (smDeleted.indexOf(curSel[selKeys[ki]]) >= 0) {
              curSel[selKeys[ki]] = null;
            }
          }
        }
        cfg.customStyles = smWorkStyles;
        saveConfig(cfg);
        continueLoop = true;
      } else {
        // Cancel: restore original styles
        cfg.customStyles = smOrigStyles;
        continueLoop = true;
      }
    }
    // actionIdx === 1 ("Apply"): continueLoop stays false → import starts
  }

  // ─── Save final configuration ─────────────────────────────────────────────
  cfg = {
    customStyles: cfg.customStyles || [],
    para: {
      h1: curSel.h1,
      h2: curSel.h2,
      h3: curSel.h3,
      h4: curSel.h4,
      h5: curSel.h5,
      h6: curSel.h6,
      body: curSel.body,
      quote: curSel.quote,
      bullet: curSel.bullet,
      numbered: curSel.numbered,
      code: curSel.code,
    },
    glyph: {
      strong: curSel.cStrong,
      emphasis: curSel.cEmphasis,
      strongEmphasis: curSel.cSE,
      inlineCode: curSel.inlineCode,
    },
    opts: {
      hrStyle: curSel.hr,
      clearFrame: curSel.clearFrame,
      bulletSimulate: curSel.bulletSim,
      numberedSimulate: curSel.numberedSim,
      listIndent: o.listIndent,
      listHang: o.listHang,
      strongSimulate: curSel.strongSim,
      emphasisSimulate: curSel.emphasisSim,
      strongEmphasisSimulate: curSel.seSim,
      masterSimulate: curSel.masterSim,
    },
  };
  saveConfig(cfg);
  p = cfg.para;
  g = cfg.glyph;
  o = cfg.opts;

  // ─── Inline parser (Bold / Italic / Code) ────────────────────────────────
  /** Parses bold/italic/code markers; returns cleaned text + span plan. */
  function parseInline(text) {
    var spans = [],
      chars = [],
      stack = [];
    var i = 0,
      inCode = false,
      codeStart = -1;

    while (i < text.length) {
      // Escape sequences
      if (text[i] === "\\" && i + 1 < text.length) {
        var next = text[i + 1];
        if ("*_`\\".indexOf(next) >= 0) {
          chars.push(next);
          i += 2;
          continue;
        }
      }
      // Backtick → inline code
      if (text[i] === "`") {
        if (!inCode) {
          inCode = true;
          codeStart = chars.length;
        } else {
          inCode = false;
          if (chars.length > codeStart)
            spans.push({
              start: codeStart,
              end: chars.length,
              styleType: "inlineCode",
            });
        }
        i += 1;
        continue;
      }
      if (inCode) {
        chars.push(text[i]);
        i += 1;
        continue;
      }

      // Bold/Italic markers
      var marker = null;
      if (text.startsWith("***", i) || text.startsWith("___", i))
        marker = text.slice(i, i + 3);
      else if (text.startsWith("**", i) || text.startsWith("__", i))
        marker = text.slice(i, i + 2);
      else if (text[i] === "*" || text[i] === "_") marker = text[i];

      if (!marker) {
        chars.push(text[i]);
        i += 1;
        continue;
      }

      var top = stack.length > 0 ? stack[stack.length - 1] : null;
      if (top && top.marker === marker) {
        stack.pop();
        if (top.start < chars.length) {
          var type =
            marker.length === 3
              ? "strongEmphasis"
              : marker.length === 2
                ? "strong"
                : "emphasis";
          spans.push({ start: top.start, end: chars.length, styleType: type });
        }
      } else {
        stack.push({ marker: marker, start: chars.length });
      }
      i += marker.length;
    }
    // Unclosed markers: output verbatim
    for (var j = stack.length - 1; j >= 0; j--) {
      var unclosed = stack[j];
      var literal = unclosed.marker.split("");
      chars.splice.apply(chars, [unclosed.start, 0].concat(literal));
      for (var k = 0; k < spans.length; k++) {
        if (spans[k].start >= unclosed.start) spans[k].start += literal.length;
        if (spans[k].end >= unclosed.start) spans[k].end += literal.length;
      }
    }
    return { text: chars.join(""), spans: spans };
  }

  // ─── Block parser ─────────────────────────────────────────────────────────
  /** Splits Markdown into blocks (headings, lists, quotes …) and builds text + plans. */
  function parseMarkdown(source, simOpts) {
    var lines = source.split("\n");
    var blocks = [];
    var paraBuffer = [];
    var inFence = false,
      fenceLines = [];

    /** Flushes buffered lines as a paragraph block. */
    function flushPara() {
      if (!paraBuffer.length) return;
      var t = paraBuffer.join(" ").trim();
      if (t) blocks.push({ type: "paragraph", level: 0, text: t });
      paraBuffer = [];
    }
    /** Closes an open code-fence block and appends it. */
    function flushFence() {
      if (!inFence) return;
      blocks.push({ type: "code", level: 0, text: fenceLines.join("\n") });
      inFence = false;
      fenceLines = [];
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // Code fence
      if (/^(\s*)(`{3,}|~{3,})/.test(line)) {
        if (!inFence) {
          flushPara();
          inFence = true;
          fenceLines = [];
        } else {
          flushFence();
        }
        continue;
      }
      if (inFence) {
        fenceLines.push(line);
        continue;
      }

      var trimmed = line.trim();
      if (!trimmed) {
        flushPara();
        continue;
      }

      // HR
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        flushPara();
        blocks.push({ type: "hr", level: 0, text: "\u200B" });
        continue;
      }
      // Headings
      var hMatch = trimmed.match(/^(#{1,6})\s+(.*)/);
      if (hMatch) {
        flushPara();
        blocks.push({
          type: "heading",
          level: hMatch[1].length,
          text: hMatch[2],
        });
        continue;
      }
      // Bullet
      var bMatch = line.match(/^\s*[-*+]\s+(.*)/);
      if (bMatch) {
        flushPara();
        blocks.push({ type: "bullet", level: 0, text: bMatch[1] });
        continue;
      }
      // Numbered
      var nMatch = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (nMatch) {
        flushPara();
        blocks.push({ type: "numbered", level: 0, text: nMatch[1] });
        continue;
      }
      // Quote
      var qMatch = line.match(/^\s*>\s?(.*)/);
      if (qMatch) {
        flushPara();
        blocks.push({ type: "quote", level: 0, text: qMatch[1] });
        continue;
      }

      paraBuffer.push(trimmed);
    }
    flushFence();
    flushPara();

    // Build full text string + plan arrays
    var fullText = [],
      paragraphPlan = [],
      inlinePlan = [];
    var pos = 0,
      listNumber = 0;

    for (var idx = 0; idx < blocks.length; idx++) {
      var blk = blocks[idx];
      // Prepend simulated list markers
      if (blk.type === "bullet" && simOpts.bullet)
        blk.text = "\u2022  " + blk.text;
      if (blk.type === "numbered" && simOpts.numbered) {
        listNumber =
          idx > 0 && blocks[idx - 1].type === "numbered" ? listNumber + 1 : 1;
        blk.text = listNumber + ". " + blk.text;
      }

      var parsed =
        blk.type === "code"
          ? { text: blk.text, spans: [] }
          : parseInline(blk.text);
      if (!parsed.text && blk.type !== "hr") continue;

      if (fullText.length > 0) {
        fullText.push("\n");
        pos += 1;
      }
      var blockStart = pos;
      fullText.push(parsed.text);
      pos += parsed.text.length;

      paragraphPlan.push({
        begin: blockStart,
        end: pos,
        blockType: blk.type,
        level: blk.level,
      });
      for (var s = 0; s < parsed.spans.length; s++) {
        var sp = parsed.spans[s];
        if (sp.end > sp.start)
          inlinePlan.push({
            begin: blockStart + sp.start,
            end: blockStart + sp.end,
            styleType: sp.styleType,
          });
      }
    }
    return {
      text: fullText.join(""),
      paragraphPlan: paragraphPlan,
      inlinePlan: inlinePlan,
    };
  }

  var parsed = parseMarkdown(markdown, {
    bullet: o.bulletSimulate,
    numbered: o.numberedSimulate,
  });

  // ─── Selection and formatting helpers ─────────────────────────────────────
  /** Creates a TextSelection for the given character range in the frame. */
  function makeRange(begin, end) {
    var sel = Selection.create(doc, frame);
    sel.addSubSelectionForNode(
      frame,
      TextSelection.create(new StoryRange(begin, end)),
    );
    return sel;
  }

  /** Applies the first available paragraph style from the list (fallback chain). */
  function applyPara(begin, end, styleNames) {
    for (var i = 0; i < styleNames.length; i++) {
      if (!styleNames[i]) continue;
      try {
        doc.executeCommand(
          DocumentCommand.createFormatText(
            makeRange(begin, end),
            StoryDelta.createParagraphString(
              ParagraphAttStringType.StyleName,
              styleNames[i],
            ),
          ),
        );
        return;
      } catch (e) {}
    }
  }

  /** Applies the first available character style from the list (fallback chain). */
  function applyGlyph(begin, end, styleNames) {
    for (var i = 0; i < styleNames.length; i++) {
      if (!styleNames[i]) continue;
      try {
        doc.executeCommand(
          DocumentCommand.createFormatText(
            makeRange(begin, end),
            StoryDelta.createGlyphString(
              GlyphAttStringType.StyleName,
              styleNames[i],
            ),
          ),
        );
        return;
      } catch (e) {}
    }
  }

  /** Simulates list indentation via left indent + hanging indent instead of a real list style. */
  function applyListSimulated(begin, end, styleName, indent, hang) {
    applyPara(begin, end, [styleName, "Body Text", "Body"]);
    try {
      // ParagraphAttDoubleType.FirstLineIndent: key name is runtime-dependent;
      // createLeftIndent alone is a safe fallback if FirstLineIndent is unavailable.
      doc.executeCommand(
        DocumentCommand.createFormatText(
          makeRange(begin, end),
          StoryDelta.createComposite([
            StoryDelta.createLeftIndent(indent),
            StoryDelta.createParagraphDouble(
              ParagraphAttDoubleType.FirstLineIndent,
              -hang,
            ),
          ]),
        ),
      );
    } catch (e) {
      // Fallback: set left indent only
      try {
        doc.executeCommand(
          DocumentCommand.createFormatText(
            makeRange(begin, end),
            StoryDelta.createLeftIndent(indent),
          ),
        );
      } catch (e2) {}
    }
  }

  // ─── Insert text ──────────────────────────────────────────────────────────
  var storyIface = frame.storyInterface;
  var story = storyIface.story;
  var textOff = 0;

  if (o.clearFrame) {
    // Replace entire frame content: explicitly select storyRange.begin..end
    // (Selection.create without a Range would only append, not replace)
    var range = storyIface.storyRange;
    doc.executeCommand(
      DocumentCommand.createSetText(
        makeRange(range.begin, range.end),
        parsed.text,
      ),
    );
    var updatedRange = frame.storyInterface.storyRange;
    textOff = updatedRange.begin; // = 0 (confirmed by FormatPositionTest)
    // Reset base formatting
    doc.executeCommand(
      DocumentCommand.createFormatText(
        makeRange(updatedRange.begin, updatedRange.end),
        StoryDelta.createComposite([
          StoryDelta.createParagraphString(
            ParagraphAttStringType.StyleName,
            "Body Text",
          ),
          StoryDelta.createWeight(400),
          StoryDelta.createItalic(false),
        ]),
      ),
    );
  } else {
    var existingText = story ? String(story.text || "") : "";
    var existingEnd = storyIface.storyRange.end;
    // endsWith fallback (safety for older JS engines)
    var lastChar =
      existingText.length > 0 ? existingText[existingText.length - 1] : "";
    var needNewline = existingText.length > 0 && lastChar !== "\n";
    doc.executeCommand(
      DocumentCommand.createSetText(
        makeRange(existingEnd, existingEnd),
        (needNewline ? "\n" : "") + parsed.text,
      ),
    );
    // FIX: storyRange.end = text.length + 1 (paragraph marker).
    // Text is inserted at position text.length (marker shifts),
    // NOT at storyRange.end (= text.length + 1). Use existingText.length instead.
    textOff = existingText.length + (needNewline ? 1 : 0);
  }

  // ─── Apply paragraph styles ───────────────────────────────────────────────
  for (var i = 0; i < parsed.paragraphPlan.length; i++) {
    var blk = parsed.paragraphPlan[i];
    if (blk.end <= blk.begin) continue;
    var from = textOff + blk.begin;
    var to = textOff + blk.end;
    var level = Math.max(1, Math.min(6, blk.level));

    switch (blk.blockType) {
      case "heading":
        applyPara(from, to, [
          p["h" + level],
          DEFAULTS.para["h" + level],
          "Body Text",
        ]);
        break;
      case "hr":
        applyPara(from, to, [o.hrStyle, "Horizontal Rule", "Body Text"]);
        break;
      case "bullet":
        if (o.bulletSimulate)
          applyListSimulated(from, to, p.bullet, o.listIndent, o.listHang);
        else applyPara(from, to, [p.bullet, DEFAULTS.para.bullet, "Body Text"]);
        break;
      case "numbered":
        if (o.numberedSimulate)
          applyListSimulated(from, to, p.numbered, o.listIndent, o.listHang);
        else
          applyPara(from, to, [
            p.numbered,
            DEFAULTS.para.numbered,
            "Body Text",
          ]);
        break;
      case "quote":
        applyPara(from, to, [p.quote, DEFAULTS.para.quote, "Body Text"]);
        break;
      case "code":
        applyPara(from, to, [p.code, DEFAULTS.para.code, "Body Text"]);
        break;
      default:
        applyPara(from, to, [p.body, "Body Text"]);
        break;
    }
  }

  // ─── Apply character styles ───────────────────────────────────────────────
  // StoryRange is exclusive at the end (confirmed by org_importer): no -1 needed.
  for (var j = 0; j < parsed.inlinePlan.length; j++) {
    var span = parsed.inlinePlan[j];
    if (span.end <= span.begin) continue;
    var from = textOff + span.begin;
    var to = textOff + span.end;

    switch (span.styleType) {
      case "strong":
        if (o.strongSimulate)
          doc.executeCommand(
            DocumentCommand.createFormatText(
              makeRange(from, to),
              StoryDelta.createWeight(700),
            ),
          );
        else applyGlyph(from, to, [g.strong, DEFAULTS.glyph.strong]);
        break;
      case "emphasis":
        if (o.emphasisSimulate)
          doc.executeCommand(
            DocumentCommand.createFormatText(
              makeRange(from, to),
              StoryDelta.createItalic(true),
            ),
          );
        else applyGlyph(from, to, [g.emphasis, DEFAULTS.glyph.emphasis]);
        break;
      case "strongEmphasis":
        if (o.strongEmphasisSimulate) {
          doc.executeCommand(
            DocumentCommand.createFormatText(
              makeRange(from, to),
              StoryDelta.createComposite([
                StoryDelta.createWeight(700),
                StoryDelta.createItalic(true),
              ]),
            ),
          );
        } else {
          applyGlyph(from, to, [
            g.strongEmphasis,
            DEFAULTS.glyph.strongEmphasis,
            g.strong,
          ]);
        }
        break;
      case "inlineCode":
        applyGlyph(from, to, [g.inlineCode, DEFAULTS.glyph.inlineCode]);
        break;
    }
  }

  // ─── Done ─────────────────────────────────────────────────────────────────
  app.alert(
    "Markdown imported.\n\n" +
      "Paragraphs:     " +
      parsed.paragraphPlan.length +
      "\n" +
      "Inline spans:   " +
      parsed.inlinePlan.length +
      "\n" +
      "Total chars:    " +
      parsed.text.length +
      "\n\n" +
      (o.clearFrame ? "Existing text was replaced." : "Text was appended."),
    "Markdown to Affinity",
  );
})();

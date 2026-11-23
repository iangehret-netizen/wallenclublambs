// Wallen Club Lambs — sale catalog PDF reader (Lamb Roster, Sales, Herd Roster ewe import)
//
// window.gscReadSalePdf(file, onProgress) -> Promise<{ lots, extraKeys, source, pages }>
//   lots:      [{ lot, tag, sex, breed, dob, sire, damTag, damSire, comments, extra: { "Key": "value" } }]
//   extraKeys: catalog fields that don't match a lot field (e.g. "Location of Animals"),
//              in the order first seen, with a suggested default ("comments" or "ignore").
//   source:    "text" (normal PDF) or "scan" (read with text recognition)
//
// Reads two layouts:
//   * blocks — "Lot 12 ..." heading followed by "Tag: ...", "Sire: ..." lines (online sale sites)
//   * tables — a header row like "Lot | Tag | Sex | DOB | Sire | Dam" with one row per lot
// Nothing here touches saved records; it only returns what it found for the preview.
(function () {
  "use strict";

  function load(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = function () { rej(new Error("Couldn't load " + src + " — open the app once with a connection.")); };
      document.head.appendChild(s);
    });
  }
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve();
    return load("./pdf.min.js").then(function () { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdf.worker.min.js"; });
  }
  function loadTess() { return window.Tesseract ? Promise.resolve() : load("./tesseract.min.js"); }

  // ---------- field names ----------
  function nk(k) { return String(k || "").toLowerCase().replace(/[’'`]/g, "").replace(/[^a-z0-9#]+/g, " ").trim(); }
  var FIELD = {
    lot: ["lot", "lot #", "lot no", "lot number", "lot num"],
    tag: ["tag", "tag #", "tag no", "tag number", "ear tag", "farm tag", "flock tag", "id", "id #", "animal id"],
    sex: ["sex", "gender"],
    breed: ["breed", "breed type", "breeds"],
    dob: ["date of birth", "dob", "birth date", "birthdate", "born", "birthday", "birth"],
    sire: ["sire", "sire name", "sired by"],
    damTag: ["dam", "dam tag", "dam id", "dam #", "dam no", "dam number", "dam name"],
    damSire: ["dams sire", "dam sire", "dam s sire", "maternal grandsire", "mgs", "sire of dam", "dams sire name"],
    comments: ["comments", "comment", "description", "notes", "remarks", "lot comments", "lot notes", "info"]
  };
  var KEYMAP = {};
  Object.keys(FIELD).forEach(function (f) { FIELD[f].forEach(function (k) { KEYMAP[nk(k)] = f; }); });
  function fieldFor(key) { return KEYMAP[nk(key)] || null; }
  function fixKey(key) {
    if (fieldFor(key)) return key;
    var w = String(key).trim().split(/\s+/);
    for (var i = 1; i < w.length; i++) { var k = w.slice(i).join(" "); if (fieldFor(k)) return k; }
    return key;
  }
  var KNOWN_INLINE = /\s((?:Dam['’]?s Sire|Dam Sire|Date of Birth|Sire|Dam|Sex|Tag|DOB|Comments))\s*:\s*/;
  function splitInline(k, v, out) {
    var m = KNOWN_INLINE.exec(" " + v);
    if (m && m.index > 0) { out.push([k, v.slice(0, m.index - 1)]); splitInline(m[1], v.slice(m.index - 1 + m[0].length), out); }
    else out.push([k, v]);
    return out;
  }
  function isPriceKey(k) { return /price|bid|buy ?now|reserve|starting|opening/i.test(k); }

  function normSex(v) {
    var s = String(v || "").trim().toLowerCase();
    if (/^(w|wether|whether|weth)/.test(s)) return "Wether";
    if (/^(e|ewe|ewe lamb|f|female|doe)\b/.test(s)) return "Ewe";
    if (/^(r|ram|ram lamb|buck|m|male)\b/.test(s)) return "Ram";
    return String(v || "").trim();
  }
  function normDate(v) {
    var s = String(v || "").trim(), m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2);
    if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(s))) {
      var y = +m[3]; if (y < 100) y += 2000;
      return y + "-" + ("0" + m[1]).slice(-2) + "-" + ("0" + m[2]).slice(-2);
    }
    var t = Date.parse(s);
    if (!isNaN(t)) { var d = new Date(t); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
    return s;
  }
  function clean(s) { return String(s || "").replace(/\s+/g, " ").replace(/\s+([,.;])/g, "$1").trim(); }

  // ---------- text with positions ----------
  // pages -> [{ lines: [{ y, items: [{ x, w, str }] }] }]
  function groupLines(items) {
    items.sort(function (a, b) { return b.y - a.y || a.x - b.x; });
    var lines = [];
    items.forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var L = lines.length ? lines[lines.length - 1] : null;
      if (L && Math.abs(L.y - it.y) <= Math.max(2, it.h * 0.45)) L.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    });
    lines.forEach(function (L) { L.items.sort(function (a, b) { return a.x - b.x; }); });
    return lines;
  }
  function lineText(L) {
    var out = "", prevEnd = null;
    L.items.forEach(function (it) {
      if (prevEnd != null) {
        var gap = it.x - prevEnd, ch = Math.max(3, (it.h || 10) * 0.5);
        out += gap > ch * 2.2 ? "   " : (gap > ch * 0.15 || !/^[,.;:)]/.test(it.str) ? " " : "");
      }
      out += it.str; prevEnd = it.x + (it.w || it.str.length * (it.h || 10) * 0.5);
    });
    return out.replace(/ {4,}/g, "   ");
  }
  async function readText(file, prog) {
    await loadPdfJs();
    var pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise, pages = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      prog && prog("Reading page " + p + " of " + pdf.numPages + "…");
      var page = await pdf.getPage(p), tc = await page.getTextContent(), items = [];
      tc.items.forEach(function (it) {
        if (!it.str) return;
        var h = Math.abs(it.transform[3]) || Math.abs(it.height) || 10;
        items.push({ x: it.transform[4], y: it.transform[5], w: it.width, h: h, str: it.str });
      });
      pages.push({ lines: groupLines(items) });
    }
    return { pdf: pdf, pages: pages };
  }
  async function readScan(pdf, prog) {
    await loadTess();
    prog && prog("This looks like a scanned catalog — reading the pictures (can take 10–30 seconds a page)…");
    var worker = await window.Tesseract.createWorker("eng", 1, { workerPath: "./tess-worker.min.js", corePath: "./", langPath: "./", gzip: true });
    var pages = [];
    try {
      for (var p = 1; p <= pdf.numPages; p++) {
        prog && prog("Reading scanned page " + p + " of " + pdf.numPages + "…");
        var page = await pdf.getPage(p), vp = page.getViewport({ scale: 2.5 }), cv = document.createElement("canvas");
        cv.width = vp.width; cv.height = vp.height;
        await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
        var r = await worker.recognize(cv), items = [];
        ((r.data && r.data.words) || []).forEach(function (w) {
          if ((w.confidence || 0) < 60 || !/[A-Za-z0-9]/.test(w.text || "")) return; // photo noise
          var b = w.bbox; // canvas coords (y down) -> flip so bigger y = higher on page, like PDF text
          items.push({ x: b.x0 / 2.5, y: (vp.height - b.y1) / 2.5, w: (b.x1 - b.x0) / 2.5, h: Math.max(6, (b.y1 - b.y0) / 2.5), str: w.text });
        });
        pages.push({ lines: groupLines(items) });
      }
    } finally { try { await worker.terminate(); } catch (e) {} }
    return pages;
  }

  // ---------- layout 1: blocks ----------
  var LOT_RE = /^\s*lot\s*(?:#|no\.?|number|num\.?)?\s*[:\-]?\s*([A-Za-z]?\d+[A-Za-z]?)\b\s*[:\-]?\s*(.*)$/i;
  var KV_RE = /^\s*([A-Za-z#][A-Za-z0-9’'`#\/\.\-() ]{0,38}?)\s*:\s*(.*)$/;
  function parseBlocks(lines) {
    var lots = [], cur = null, lastKey = null;
    var clean_ = lines.map(function (raw) { return raw.replace(/\u00a0/g, " ").trim(); }).filter(Boolean);
    clean_.forEach(function (s, i) {
      // a heading without a lot number (e.g. "Swag" followed by "Lot Details") ends the current lot
      if (!LOT_RE.test(s) && /^lot details$/i.test(clean_[i + 1] || "")) { cur = null; lastKey = null; return; }
      var m = LOT_RE.exec(s);
      if (m && !/^lot details/i.test(s)) {
        cur = { lot: m[1], head: clean(m[2]), kv: {}, order: [] }; lots.push(cur); lastKey = null; return;
      }
      if (!cur) return;
      if (/^lot details$/i.test(s)) return;
      var kv = KV_RE.exec(s);
      if (kv && kv[1].trim().split(/\s+/).length <= 5 && !/^https?$/i.test(kv[1].trim())) {
        splitInline(fixKey(clean(kv[1])), kv[2], []).forEach(function (pr) {
          var k = pr[0];
          if (!(k in cur.kv)) cur.order.push(k);
          cur.kv[k] = clean((cur.kv[k] ? cur.kv[k] + " " : "") + pr[1]); lastKey = k;
        });
        return;
      }
      if (lastKey) cur.kv[lastKey] = clean(cur.kv[lastKey] + " " + s);
    });
    return lots.filter(function (l) { return l.order.length > 0; });
  }

  // ---------- layout 2: tables ----------
  function cellsOf(L) {
    // split a line into cells wherever there's a wide gap
    var cells = [], c = null, prevEnd = null;
    L.items.forEach(function (it) {
      var gap = prevEnd == null ? 99 : it.x - prevEnd, ch = Math.max(3, (it.h || 10) * 0.5);
      if (!c || gap > ch * 1.8) { c = { x: it.x, str: it.str }; cells.push(c); }
      else c.str += (gap > ch * 0.15 ? " " : "") + it.str;
      prevEnd = it.x + (it.w || it.str.length * ch);
    });
    cells.forEach(function (c) { c.str = clean(c.str); });
    return cells;
  }
  function parseTables(pages) {
    var lots = [];
    pages.forEach(function (pg) {
      var cols = null;
      pg.lines.forEach(function (L) {
        var cells = cellsOf(L);
        var known = cells.filter(function (c) { return fieldFor(c.str); }).length;
        if (known >= 3 && cells.some(function (c) { return fieldFor(c.str) === "lot" || fieldFor(c.str) === "tag"; })) {
          cols = cells.map(function (c) { return { x: c.x, key: c.str }; }); return;
        }
        if (!cols) return;
        var row = {};
        cells.forEach(function (c) {
          var best = 0;
          cols.forEach(function (col, i) { if (c.x >= col.x - 6) best = i; });
          var k = cols[best].key; row[k] = row[k] ? row[k] + " " + c.str : c.str;
        });
        var lotKey = cols.filter(function (c) { return fieldFor(c.key) === "lot"; })[0];
        var startsRow = lotKey ? /^[A-Za-z]?\d+[A-Za-z]?$/.test(row[lotKey.key] || "") : Object.keys(row).length >= Math.min(3, cols.length);
        if (startsRow) {
          var lot = { lot: lotKey ? row[lotKey.key] : String(lots.length + 1), head: "", kv: {}, order: [] };
          cols.forEach(function (c) { if (lotKey && c === lotKey) return; if (row[c.key] != null) { lot.kv[c.key] = row[c.key]; lot.order.push(c.key); } });
          lots.push(lot);
        } else if (lots.length) {
          var last = lots[lots.length - 1];
          Object.keys(row).forEach(function (k) { if (lotKey && k === lotKey.key) return; last.kv[k] = clean((last.kv[k] || "") + " " + row[k]); if (last.order.indexOf(k) < 0) last.order.push(k); });
        }
      });
    });
    return lots;
  }

  // ---------- layout 3: a plain list of animals (Import Ewe PDF / Roster Import PDF) ----------
  // e.g. a "Southdowns" title, then a header row "Tag | Sire | Notes/'26 Lambs" and one ewe per row.
  var EWE_FIELD = {
    tag: ["tag", "tag #", "tag no", "tag number", "ear tag", "ewe", "ewe tag", "ewe #", "id", "id #", "flock tag", "farm tag"],
    name: ["name", "ewe name"],
    breed: ["breed", "breed type"],
    sire: ["sire", "sire name", "sired by"],
    damSire: ["dams sire", "dam sire", "dam s sire", "maternal grandsire", "mgs"],
    dob: ["date of birth", "dob", "birth date", "birthdate", "born", "birth year", "year born"],
    sex: ["sex", "gender"],
    dam: ["dam", "dam tag", "dam id", "dam #", "dam no", "dam number"],
    scrapie: ["scrapie", "scrapie tag", "scrapie #", "scrapie id", "usda tag", "usda id"]
  };
  var EWEMAP = {};
  Object.keys(EWE_FIELD).forEach(function (f) { EWE_FIELD[f].forEach(function (k) { EWEMAP[nk(k)] = f; }); });
  function eweField(s) { var k = nk(s); if (EWEMAP[k]) return EWEMAP[k]; if (/^(notes?|comments?|remarks|lambs?)\b/.test(k) || /\bnotes?\b/.test(k)) return "notes"; return null; }
  function parseEweList(pages) {
    var ewes = [], title = "";
    pages.forEach(function (pg) {
      var cols = null;
      pg.lines.forEach(function (L) {
        var cells = cellsOf(L);
        if (!cols) {
          var fs = cells.map(function (c) { return eweField(c.str); });
          if (fs.indexOf("tag") >= 0 && fs.filter(Boolean).length >= 2 && !cells.some(function (c) { return fieldFor(c.str) === "lot"; })) {
            cols = cells.map(function (c, i) { var w = c.str.length * 5; return { cx: c.x + w / 2, f: fs[i], key: c.str }; });
            L.items.forEach(function (it, i) { if (cols[i]) cols[i].cx = it.x + (it.w || 0) / 2; });
            // centres from the actual header words
            cols.forEach(function (col) { var hit = L.items.filter(function (it) { return clean(it.str) === col.key || col.key.indexOf(clean(it.str)) === 0; })[0]; if (hit) col.cx = hit.x + (hit.w || 0) / 2; });
          } else if (!title && cells.length === 1 && cells[0].str.length < 40 && !/\d{3,}/.test(cells[0].str)) title = cells[0].str;
          return;
        }
        var row = {};
        cells.forEach(function (c) {
          var cw = c.x + c.str.length * 2.5, best = 0, bd = 1e9;
          L.items.forEach(function (it) { if (clean(it.str) && c.str.indexOf(clean(it.str)) === 0 && Math.abs(it.x - c.x) < 1) cw = it.x + (it.w || 0) / 2; });
          cols.forEach(function (col, i) { var dd = Math.abs(col.cx - cw); if (col.f === "tag") dd = Math.abs(col.cx - (c.x + 12)) * 1.4; if (dd < bd) { bd = dd; best = i; } });
          row[best] = row[best] ? row[best] + " " + c.str : c.str;
        });
        var ti = -1; cols.forEach(function (c, i) { if (c.f === "tag" && ti < 0) ti = i; });
        var tg = clean(row[ti] || "");
        if (tg && /\d/.test(tg) && tg.length <= 14) {
          var e = { tag: tg, name: "", breed: "", sire: "", damSire: "", dob: "", notes: "", sex: "", dam: "", scrapie: "" }, extra = [];
          cols.forEach(function (c, i) {
            if (i === ti || row[i] == null) return;
            var v = clean(row[i]);
            if (c.f === "notes") e.notes = clean(e.notes + " " + v);
            else if (c.f === "dob") e.dob = /^\d{4}$/.test(v) ? v : normDate(v);
            else if (c.f) e[c.f] = e[c.f] ? e[c.f] + " " + v : v;
            else extra.push(c.key + ": " + v);
          });
          if (extra.length) e.notes = clean((e.notes ? e.notes + " \u00b7 " : "") + extra.join(" \u00b7 "));
          ewes.push(e);
        } else if (ewes.length) {
          var last = ewes[ewes.length - 1]; Object.keys(row).forEach(function (i) { last.notes = clean(last.notes + " " + row[i]); });
        }
      });
    });
    // same tag listed twice -> one ewe (fill blanks, keep both notes)
    var merged = [], byTag = {};
    ewes.forEach(function (e) {
      var k = nk(e.tag), m = byTag[k];
      if (!m) { m = byTag[k] = Object.assign({ twice: 0 }, e); merged.push(m); return; }
      m.twice++;
      ["name", "breed", "sire", "damSire", "dob", "sex", "dam", "scrapie"].forEach(function (f) { if (!m[f] && e[f]) m[f] = e[f]; });
      if (e.notes && m.notes.indexOf(e.notes) < 0) m.notes = clean(m.notes + " \u00b7 " + e.notes);
    });
    merged.forEach(function (e) { if (e.sex) e.sex = normSex(e.sex); });
    var breed = clean(title).replace(/\b(ewes?|flock|list|females?|dams?)\b/ig, "").trim().replace(/ies$/i, "y").replace(/([^s])s$/i, "$1");
    return { ewes: merged, breed: breed, title: title };
  }

  // ---------- shape the result ----------
  function shape(raw) {
    var extraKeys = [], seen = {};
    var lots = raw.map(function (r) {
      var o = { lot: r.lot, tag: "", sex: "", breed: "", dob: "", sire: "", damTag: "", damSire: "", comments: "", extra: {} };
      r.order.forEach(function (k) {
        var f = fieldFor(k), v = r.kv[k];
        if (f === "lot") return;
        if (f && !o[f]) o[f] = v;
        else if (f && f === "comments") o.comments = clean(o.comments + " " + v);
        else {
          o.extra[k] = v;
          if (!seen[k]) { seen[k] = 1; extraKeys.push(k); }
        }
      });
      if (!o.tag && r.head) o.tag = r.head.split(/\s{2,}/)[0];
      ["tag", "sire", "damTag", "damSire", "sex", "breed"].forEach(function (f) { o[f] = clean(String(o[f] || "").replace(/(\s+[^\s]{1})+$/, "")); });
      o.sex = normSex(o.sex); o.dob = o.dob ? normDate(o.dob) : "";
      return o;
    });
    var keys = extraKeys.map(function (k) {
      var vals = lots.map(function (l) { return l.extra[k]; }).filter(function (v) { return v != null; });
      var same = vals.length > 1 && vals.every(function (v) { return v === vals[0]; });
      return { key: k, use: isPriceKey(k) || same ? "ignore" : "comments", sample: vals[0] || "" };
    });
    return { lots: lots, extraKeys: keys };
  }

  window.gscReadSalePdf = async function (file, prog) {
    var t = await readText(file, prog), pages = t.pages, source = "text";
    var chars = pages.reduce(function (a, p) { return a + p.lines.reduce(function (b, L) { return b + L.items.reduce(function (c, i) { return c + i.str.trim().length; }, 0); }, 0); }, 0);
    if (chars < 40 * pages.length) { pages = await readScan(t.pdf, prog); source = "scan"; }
    var all = []; pages.forEach(function (p) { p.lines.forEach(function (L) { all.push(lineText(L)); }); });
    var blocks = parseBlocks(all), tables = parseTables(pages);
    var raw = tables.length > blocks.length ? tables : blocks;
    var out = shape(raw);
    out.source = source; out.pages = pages.length; out.layout = raw === tables ? "table" : "blocks";
    out.text = all.join("\n");
    out.eweList = parseEweList(pages);
    return out;
  };
})();

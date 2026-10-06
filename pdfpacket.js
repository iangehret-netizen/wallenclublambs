/* Wallen Club Lambs — PDF packet builder.
 * Builds a list of "sections" (one per PDF page-group / Excel tab) from live app data,
 * then renders them as a PDF (window.gscExportPacket) or as Excel sheets (window.gscSheets).
 * kind = "showlambs" | "herd". Needs jsPDF only for PDF export.
 */
(function () {
  var PW = 612, PH = 792, M = 36, USABLE = PW - 2 * M;

  function isoParts(v) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v || "");
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function fmtFull(v) {
    var p = isoParts(v);
    return p ? p.m + "/" + p.d + "/" + p.y : (v == null ? "" : String(v));
  }
  function fmtMD(v) {
    var p = isoParts(v);
    if (p) return p.m + "/" + p.d;
    var s = String(v == null ? "" : v);
    var m = /^(\d{1,2})[\/-](\d{1,2})/.exec(s);
    return m ? +m[1] + "/" + +m[2] : s;
  }
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function ordinal(n) {
    var j = n % 10, k = n % 100;
    if (j === 1 && k !== 11) return n + "st";
    if (j === 2 && k !== 12) return n + "nd";
    if (j === 3 && k !== 13) return n + "rd";
    return n + "th";
  }
  function fmtLong(v) {
    var p = isoParts(v);
    return p ? MONTHS[p.m - 1] + " " + ordinal(p.d) : (v == null ? "" : String(v));
  }
  function dateKey(v) {
    var p = isoParts(v);
    if (p) return p.y * 10000 + p.m * 100 + p.d;
    var t = Date.parse(v);
    return isNaN(t) ? 99999999 : t;
  }
  function str(v) { return v == null ? "" : String(v); }

  // Wrap text to a width, hard-breaking words that are too long for the cell.
  function wrap(doc, text, maxW) {
    var out = [];
    String(text).split(/\r?\n/).forEach(function (para) {
      var lines = doc.splitTextToSize(para, maxW);
      lines.forEach(function (ln) {
        if (doc.getTextWidth(ln) <= maxW + 0.5) { out.push(ln); return; }
        var cur = "";
        for (var i = 0; i < ln.length; i++) {
          if (doc.getTextWidth(cur + ln[i]) > maxW && cur) { out.push(cur); cur = ln[i]; } else cur += ln[i];
        }
        if (cur) out.push(cur);
      });
    });
    return out.length ? out : [""];
  }

  function drawHeader(doc, x, y, widths, labels, fs, h) {
    var total = widths.reduce(function (a, b) { return a + b; }, 0);
    doc.setFillColor(0, 0, 0);
    doc.rect(x, y, total, h, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(fs);
    var cx = x;
    for (var i = 0; i < widths.length; i++) {
      if (labels[i]) doc.text(String(labels[i]), cx + widths[i] / 2, y + h / 2, { align: "center", baseline: "middle" });
      cx += widths[i];
    }
    doc.setTextColor(0, 0, 0);
  }

  function drawRow(doc, x, y, widths, cells, rh, fs, aligns, boldCols) {
    doc.setLineWidth(0.5);
    doc.setDrawColor(0, 0, 0);
    var cx = x, lh = fs * 1.2;
    for (var i = 0; i < widths.length; i++) {
      doc.rect(cx, y, widths[i], rh);
      var txt = cells && cells[i] != null ? String(cells[i]) : "";
      if (txt) {
        doc.setFont("helvetica", boldCols && boldCols.indexOf(i) >= 0 ? "bold" : "normal");
        doc.setFontSize(fs);
        var lines = wrap(doc, txt, widths[i] - 6);
        var top = y + (rh - lines.length * lh) / 2;
        var al = (aligns && aligns[i]) || "center";
        var tx = al === "left" ? cx + 3 : cx + widths[i] / 2;
        doc.text(lines, tx, top, { align: al === "left" ? "left" : "center", baseline: "top", lineHeightFactor: 1.2 });
      }
      cx += widths[i];
    }
  }

  function rowHeight(doc, widths, cells, fs, minRh) {
    var lh = fs * 1.2, most = 1;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(fs);
    for (var i = 0; i < widths.length; i++) {
      var t = cells && cells[i] != null ? String(cells[i]) : "";
      if (t) most = Math.max(most, wrap(doc, t, widths[i] - 6).length);
    }
    return Math.max(minRh, most * lh + 8);
  }

  // Paginated table. opts: widths, headers, rows, fs, minRh, headerH, aligns, boldCols,
  // title (string drawn above the header on each page), topExtra (fn(doc,y)->y), padBlank (bool)
  function table(doc, opts, firstPageAlreadyStarted) {
    var widths = opts.widths, total = widths.reduce(function (a, b) { return a + b; }, 0);
    var x = (PW - total) / 2, headerH = opts.headerH || 16, bottom = PH - M;
    var needPage = !firstPageAlreadyStarted;
    var y;
    function startPage() {
      if (needPage) doc.addPage();
      needPage = true;
      y = M + 10;
      if (opts.band) {
        doc.setFillColor(0, 0, 0);
        doc.rect(x, y, total, 16, "F");
        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8.5);
        doc.text(opts.band, PW / 2, y + 8, { align: "center", baseline: "middle", maxWidth: total - 10 });
        doc.setTextColor(0, 0, 0);
        doc.setDrawColor(255, 255, 255);
        doc.setLineWidth(0.5);
        y += 16;
        doc.line(x, y, x + total, y);
      }
      if (opts.title) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(opts.titleFs || 9);
        doc.setTextColor(0, 0, 0);
        doc.text(opts.title, PW / 2, y + 8, { align: "center", baseline: "middle" });
        y += 22;
      }
      drawHeader(doc, x, y, widths, opts.headers, opts.hfs || opts.fs, headerH);
      y += headerH;
    }
    startPage();
    opts.rows.forEach(function (cells) {
      var rh = rowHeight(doc, widths, cells, opts.fs, opts.minRh);
      if (y + rh > bottom) startPage();
      drawRow(doc, x, y, widths, cells, rh, opts.fs, opts.aligns, opts.boldCols);
      y += rh;
    });
    if (opts.padBlank) {
      while (y + opts.minRh <= bottom) {
        drawRow(doc, x, y, widths, null, opts.minRh, opts.fs, opts.aligns, opts.boldCols);
        y += opts.minRh;
      }
    }
    return y;
  }

  function loadImage(url) {
    return fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () {
          var img = new Image();
          img.onload = function () { res({ data: fr.result, w: img.naturalWidth, h: img.naturalHeight }); };
          img.onerror = rej;
          img.src = fr.result;
        };
        fr.onerror = rej;
        fr.readAsDataURL(b);
      });
    });
  }

  function addDays(v, n) {
    var p = isoParts(v);
    if (!p) return "";
    var d = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + "/" + d.getUTCFullYear();
  }
  function num(v) {
    if (v === "" || v == null) return "";
    var n = Number(v);
    return isNaN(n) ? v : n;
  }
  function sheepName(sheep, id, fallback) {
    var sp = id ? sheep.filter(function (s) { return s.id === id; })[0] : null;
    return sp ? sp.name : str(fallback);
  }
  function sortedShows(d) {
    return (d.shows || []).slice().sort(function (a, b) { return dateKey(a.date || "9999-12-31") - dateKey(b.date || "9999-12-31"); });
  }
  function scale(w, total) {
    var sum = w.reduce(function (a, b) { return a + b; }, 0);
    return w.map(function (x) { return Math.round(x / sum * total * 10) / 10; });
  }

  // ---------- Section builders (data only, no drawing) ----------
  function showLambSections(d) {
    var sheep = d.sheep || [], out = [];
    var fall = /fall/i.test(d.year || "");
    out.push({
      type: "table", name: "Showmen", title: str(d.year) + " Showmen",
      widths: [100, 50, 70, 60, 75, 85, 50],
      headers: ["Name", "4H Age", "County", "# of Sheep", "Target Show", "Target Show Date", fall ? "NAILE?" : "OSF?"],
      rows: (d.exhibitors || []).map(function (e) {
        var n = e.numSheep;
        if (n === "" || n == null) n = sheep.filter(function (s) { return s.showman && s.showman === e.name; }).length || "";
        return [e.name, e.age, e.county, n, e.targetShow, fmtFull(e.targetShowDate), e.osf ? "X" : ""];
      }),
      fs: 8, minRh: 30, headerH: 18, boldCols: [0]
    });
    out.push({
      type: "table", name: "Roster",
      widths: [46, 30, 36, 30, 42, 38, 48, 58, 36, 34, 46, 36, 60],
      headers: ["Name", "Sex", "L Ear", "R Ear", "Birthdate", "Breed", "Sire", "Dam", "Breeder", "Price", "Showman", "County", "Additional Notes"],
      rows: sheep.map(function (s) {
        return [s.name, s.sex, s.lEar, s.rEar, fmtFull(s.birthdate), s.breed, s.sire, s.dam, s.breeder, s.price, s.showman, s.county, s.notes];
      }),
      fs: 5.5, hfs: 5.5, minRh: 22, headerH: 13, boldCols: [0]
    });
    if (sheep.length) out.push({ type: "weights", name: "Weights", sheep: sheep, weights: d.weights || {} });
    var shows = sortedShows(d);
    if (shows.length) {
      out.push({
        type: "table", name: "Show Calendar", title: "SHOWS", titleFs: 7,
        widths: [70, 190, 90, 35, 155],
        headers: ["Date", "Show Name", "City", "State", "Judge"],
        rows: shows.map(function (s) { return [fmtLong(s.date), s.name, s.city, s.state, s.judge]; }),
        xHeaders: ["Date", "Show Name", "City", "State", "Judge", "Attending", "Notes"],
        xRows: shows.map(function (s) {
          return [fmtFull(s.date), s.name, s.city, s.state, s.judge,
            (s.attendees || []).map(function (id) { return sheepName(sheep, id, ""); }).filter(Boolean).join(", "), s.notes];
        }),
        fs: 7.5, hfs: 7.5, minRh: 22, headerH: 16, aligns: ["left", "center", "center", "center", "left"]
      });
    }
    // One section per show that has results
    var groups = {}, order = [];
    (d.results || []).forEach(function (r) {
      var k = str(r.showName).trim();
      if (!k) return;
      (groups[k] = groups[k] || []).push(r);
    });
    shows.forEach(function (s) { if (groups[s.name] && order.indexOf(s.name) < 0) order.push(s.name); });
    Object.keys(groups).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    order.forEach(function (name) {
      out.push({
        type: "table", name: name, band: name,
        widths: [110, 100, 150, 180],
        headers: ["Showman", "Sheep", "Showed As", "Placing"],
        rows: groups[name].map(function (r) { return [r.exhibitor, sheepName(sheep, r.sheepId, r.sheepName), r.showedAs, r.placing]; }),
        fs: 7, hfs: 7.5, minRh: 22, headerH: 15, padBlank: true
      });
    });
    var exNames = [];
    (d.exhibitors || []).forEach(function (e) { if (e && e.name && exNames.indexOf(e.name) < 0) exNames.push(e.name); });
    var exRows = [];
    exNames.forEach(function (nm) {
      var low = nm.trim().toLowerCase(), match = function (t) { return String(t || "").split(/\s*[\/,&]\s*|\s+and\s+/i).some(function (p) { return p.trim().toLowerCase() === low; }); };
      var lambIds = sheep.filter(function (s) { return match(s.showman); }).map(function (s) { return s.id; });
      (d.results || []).filter(function (r) { return match(r.exhibitor) || lambIds.indexOf(r.sheepId) >= 0 && !r.exhibitor; }).forEach(function (r) {
        var sh = (d.shows || []).filter(function (s) { return s.name === r.showName; })[0];
        exRows.push([nm, sheepName(sheep, r.sheepId, r.sheepName), r.showName, sh ? fmtFull(sh.date) : "", r.showedAs, r.placing]);
      });
    });
    if (exRows.length) out.push({ type: "table", name: "Exhibitor Placings", title: "Placings by Exhibitor", widths: [80, 70, 130, 55, 90, 110], headers: ["Exhibitor", "Lamb", "Show", "Date", "Showed As", "Placing"], rows: exRows, fs: 6.5, hfs: 7, minRh: 20, headerH: 15, boldCols: [0] });
    // Excel-only extras
    var feed = [];
    sheep.forEach(function (s) {
      ((d.feed || {})[s.id] || []).forEach(function (rt) {
        (rt.lines || []).forEach(function (l) {
          feed.push([s.name, fmtFull(rt.date), l.type, l.product,
            l.type === "Feed" ? (l.lbs || 0) + " lbs " + (l.oz || 0) + " oz" : l.type === "Supplement" ? (l.amt || 0) + " oz" : l.type === "Drench" ? (l.amt || 0) + " cc" : (l.amt || 0) + " handfuls"]);
        });
      });
    });
    out.push({ type: "table", name: "Feed Log", pdf: false, headers: ["Sheep", "Date", "Type", "Product", "Amount"], widths: [100, 70, 80, 150, 140], rows: feed });
    var hl = [];
    sheep.forEach(function (s) {
      ((d.health || {})[s.id] || []).forEach(function (rt) {
        hl.push([s.name, fmtFull(rt.date), rt.type, rt.product, ((rt.doseGiven || "") + " " + (rt.doseUnit || "")).trim(),
          rt.withdrawalDays || "", rt.withdrawalDays ? addDays(rt.date, +rt.withdrawalDays) : "", rt.notes]);
      });
    });
    out.push({ type: "table", name: "Health Records", pdf: false, headers: ["Sheep", "Date", "Type", "Product", "Dose", "Withdrawal (days)", "Clears On", "Notes"], widths: [80, 60, 60, 90, 60, 60, 60, 70], rows: hl });
    return out;
  }

  function herdSections(d) {
    var out = [], lambs = d.lambing || [];
    var roster = (d.herd || []).map(function (s) {
      return [s.name, s.sex, s.lEar, s.rEar, fmtFull(s.birthdate), s.breed, s.sire, s.dam, s.breeder, s.born, s.reared, s.notes];
    });
    out.push({
      type: "table", name: "Herd Roster", title: "Herd Roster",
      widths: [52, 28, 36, 36, 46, 44, 52, 52, 40, 26, 30, 98],
      headers: ["Name", "Sex", "L Ear", "R Ear", "Birthdate", "Breed", "Sire", "Dam", "Breeder", "Born", "Reared", "Notes"],
      rows: roster, fs: 6, hfs: 6, minRh: 22, headerH: 13, boldCols: [0]
    });
    var br = (d.breeding || []).map(function (b) {
      return [b.ewe, b.eweTag, fmtFull(b.breedingDate) + (b.rebreedDate ? " / re-bred " + fmtFull(b.rebreedDate) : ""), b.via, b.rebreedDate && b.rebreedBuck ? b.buck + " / " + b.rebreedBuck : b.buck, (b.rebreedDate || b.breedingDate) ? addDays(b.rebreedDate || b.breedingDate, 147) : "",
        b.ultrasound, fmtFull(b.actualLambing), b.carriedToTerm, b.bornAlive, b.males, b.females];
    });
    if (br.length) out.push({
      type: "table", name: "Breeding", title: "Breeding",
      widths: [60, 40, 48, 36, 62, 54, 50, 54, 30, 40, 33, 33],
      headers: ["Ewe", "Tag", "Bred", "Via", "Buck", "Exp. Lambing", "Ultrasound", "Actual Lambing", "CTT", "Born Alive", "M", "F"],
      rows: br, fs: 6, hfs: 6, minRh: 22, headerH: 15, boldCols: [0]
    });
    var lb = lambs.map(function (l) {
      return [l.tag, l.sex, l.sire, l.dam, fmtFull(l.dob), l.soldTo, l.price, l.showedBy, l.notes];
    });
    if (lb.length) out.push({
      type: "table", name: "Lambing", title: "Lambing",
      widths: [48, 28, 64, 64, 46, 58, 36, 56, 140],
      headers: ["Tag", "Sex", "Sire", "Dam", "DOB", "Sold To", "Price", "Showed By", "Notes"],
      rows: lb, fs: 6.5, hfs: 6.5, minRh: 22, headerH: 15, boldCols: [0]
    });
    var rs = (d.results || []).map(function (r) {
      var l = lambs.filter(function (z) { return z.id === r.lambId; })[0] || {};
      return [r.showName, l.dam, l.tag, r.showedAs, r.placing];
    });
    if (rs.length) out.push({
      type: "table", name: "Results", title: "Results",
      widths: [150, 90, 60, 120, 120],
      headers: ["Show", "Dam", "Lamb", "Showed As", "Placing"],
      rows: rs, fs: 7, hfs: 7.5, minRh: 22, headerH: 15
    });
    var hh = [], allA = (d.herd || []).concat(d.sold || []);
    Object.keys(d.herdHealth || {}).forEach(function (id) { var a = allA.filter(function (z) { return z.id === id; })[0]; ((d.herdHealth || {})[id] || []).forEach(function (rt) {
      hh.push([a ? a.name : "(removed animal)", fmtFull(rt.date), rt.type, rt.product, ((rt.doseGiven || "") + " " + (rt.doseUnit || "")).trim(), rt.withdrawalDays || "", rt.withdrawalDays ? addDays(rt.date, +rt.withdrawalDays) : "", rt.notes]); }); });
    hh.sort(function (x, y) { return dateKey(y[1]) - dateKey(x[1]); });
    if (hh.length) out.push({ type: "table", name: "Herd Health", title: "Herd Health", widths: [70, 50, 55, 90, 50, 45, 55, 125], headers: ["Animal", "Date", "Type", "Product", "Dose", "Withdrawal", "Clears", "Notes"], rows: hh, fs: 6.5, hfs: 6.5, minRh: 20, headerH: 15, boldCols: [0] });
    var so = (d.sold || []).map(function (s) { return [s.name, s.breed, s.sire, s.dam, fmtFull(s.soldDate)]; });
    if (so.length) out.push({
      type: "table", name: "Sold or Removed", title: "Sold / Removed",
      widths: [120, 100, 100, 120, 100],
      headers: ["Name", "Breed", "Sire", "Dam", "Sold Date"],
      rows: so, fs: 7, hfs: 7.5, minRh: 22, headerH: 15, boldCols: [0]
    });
    return out;
  }

  function buildSections(kind, d) {
    return kind === "herd" ? herdSections(d) : showLambSections(d);
  }

  // ---------- PDF rendering ----------
  function buildCover(doc, logo) {
    if (!logo) return;
    var w = 400, h = w * logo.h / logo.w;
    doc.addImage(logo.data, "PNG", (PW - w) / 2, PH / 2 - h / 2 - 20, w, h);
  }

  function weightDates(sec) {
    var set = {};
    sec.sheep.forEach(function (s) { (sec.weights[s.id] || []).forEach(function (w) { if (w && w.date) set[w.date] = 1; }); });
    return Object.keys(set).sort(function (a, b) { return dateKey(a) - dateKey(b); });
  }
  function weightMap(sec, s) {
    var map = {};
    (sec.weights[s.id] || []).forEach(function (w) { if (w && w.date) map[w.date] = w.weight; });
    return map;
  }

  function buildWeights(doc, sec) {
    var sheep = sec.sheep, dates = weightDates(sec);
    var NAMEW = 62, DW = 27, perPage = Math.floor((USABLE - NAMEW) / DW);
    var rowH = 22, headerH = 15, rowsPerPage = Math.floor((PH - 2 * M - 10 - headerH) / rowH);
    var dateChunks = [];
    for (var i = 0; i < Math.max(dates.length, 1); i += perPage) dateChunks.push(dates.slice(i, i + perPage));
    dateChunks.forEach(function (chunk) {
      var cols = chunk.slice();
      while (cols.length < perPage) cols.push(null);
      var widths = [NAMEW].concat(cols.map(function () { return DW; }));
      var headers = ["Name"].concat(cols.map(function (c) { return c ? fmtMD(c) : ""; }));
      for (var r = 0; r < sheep.length; r += rowsPerPage) {
        doc.addPage();
        var y = M + 10;
        var x = (PW - widths.reduce(function (a, b) { return a + b; }, 0)) / 2;
        drawHeader(doc, x, y, widths, headers, 6, headerH);
        y += headerH;
        sheep.slice(r, r + rowsPerPage).forEach(function (s) {
          var map = weightMap(sec, s);
          var cells = [s.name].concat(cols.map(function (c) { return c && map[c] != null ? map[c] : ""; }));
          drawRow(doc, x, y, widths, cells, rowH, 6, ["left"].concat(cols.map(function () { return "center"; })), [0]);
          y += rowH;
        });
      }
    });
  }

  function renderSection(doc, sec) {
    if (sec.pdf === false) return;
    if (sec.type === "weights") return buildWeights(doc, sec);
    table(doc, sec, false);
  }

  window.gscBuildSections = buildSections;

  // ---------- Excel sheets (aoa + column widths), same order as the PDF ----------
  function safeSheetName(name, used) {
    var base = String(name || "Sheet").replace(/[\\\/\?\*\[\]:]/g, "-").trim().slice(0, 31) || "Sheet";
    var n = base, i = 2;
    while (used[n.toLowerCase()]) {
      var suf = " (" + i++ + ")";
      n = base.slice(0, 31 - suf.length) + suf;
    }
    used[n.toLowerCase()] = 1;
    return n;
  }
  window.gscSheets = function (kind, data) {
    var used = {}, out = [];
    buildSections(kind, data).forEach(function (sec) {
      var aoa = [], cols;
      if (sec.type === "weights") {
        var dates = weightDates(sec);
        aoa.push(["Name"].concat(dates.map(fmtFull)));
        sec.sheep.forEach(function (s) {
          var map = weightMap(sec, s);
          aoa.push([s.name].concat(dates.map(function (c) { return map[c] != null ? num(map[c]) : ""; })));
        });
        cols = [22].concat(dates.map(function () { return 10; }));
      } else {
        var headers = sec.xHeaders || sec.headers, rows = sec.xRows || sec.rows;
        if (sec.band) aoa.push([sec.band]);
        else if (sec.title) aoa.push([sec.title]);
        aoa.push(headers);
        rows.forEach(function (r) { aoa.push(headers.map(function (_, i) { return r[i] == null ? "" : r[i]; })); });
        var w = sec.xHeaders ? sec.xHeaders.map(function (h, i) { return sec.widths[i] || 40; }) : sec.widths;
        cols = scale(w, 120).map(function (x, i) {
          var longest = headers[i] ? String(headers[i]).length : 6;
          rows.forEach(function (r) { longest = Math.max(longest, Math.min(String(r[i] == null ? "" : r[i]).length, 50)); });
          return Math.max(8, Math.min(55, Math.max(Math.round(x / 3), longest + 2)));
        });
      }
      out.push({ name: safeSheetName(sec.name, used), aoa: aoa, cols: cols });
    });
    return out;
  };

  window.gscExportPacket = function (data, kind) {
    kind = kind || "showlambs";
    if (!window.jspdf || !window.jspdf.jsPDF) {
      alert("PDF engine didn't load. Open the app once with a connection, then try again.");
      return Promise.resolve();
    }
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ unit: "pt", format: "letter" });
    return loadImage("./logo-pdf.png").catch(function () { return null; }).then(function (logo) {
      buildCover(doc, logo);
      buildSections(kind, data).forEach(function (sec) { renderSection(doc, sec); });
      var name = "Wallen Club Lambs - " + (kind === "herd" ? "Herd" : (data.year || "Packet")) + ".pdf";
      doc.save(name);
    }).catch(function (err) {
      console.error(err);
      alert("Couldn't build the PDF: " + (err && err.message ? err.message : err));
    });
  };
})();

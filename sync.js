// Wallen Club Lambs — cross-device sync
//
// Loaded BEFORE bundle.js. Responsibilities:
//   1. Define window.__gscSyncPush synchronously so bundle.js's window.storage
//      wrapper can call it the instant it exists, even before Firebase is ready
//      (calls just queue up).
//   2. Show a full-screen passcode overlay that blocks interaction with the app
//      until the device is unlocked. The passcode is checked by Firebase Auth
//      server-side (real security), but the UI never shows "email" or "login" —
//      just a single passcode field. Once unlocked on a device, Firebase keeps
//      the session cached locally, so the passcode is only needed once per
//      device (and works offline after that first successful unlock).
//   3. Push local changes to Firestore (best-effort; Firestore's own offline
//      persistence queues writes automatically when there's no connection and
//      sends them once the device is back online — this is why Firebase was
//      chosen for this).
//   4. Listen for remote changes from other devices and merge them into
//      localStorage using last-write-wins (by timestamp), per storage key.
//      Since the app has already rendered from local data, a merged remote
//      update surfaces as a small "Refresh" banner rather than silently
//      yanking data out from under someone mid-edit.
//   5. Show a small sync-status pill (Locked / Syncing / Synced / Offline).
(function () {
  "use strict";

  // =====================================================================
  //  FIREBASE SETUP — paste this family's own Firebase values below.
  //  Until apiKey, projectId and SYNC_EMAIL are filled in, the app runs in
  //  "this device only" mode: no passcode screen, no sync, nothing breaks.
  //  See SETUP-SYNC.md in this folder for the step-by-step.
  // =====================================================================
  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyBqwGqWivFLuGX4qcUyDYcW93knoxaNV_4",
    authDomain: "wallen-club-lambs.firebaseapp.com",
    projectId: "wallen-club-lambs",
    storageBucket: "wallen-club-lambs.firebasestorage.app",
    messagingSenderId: "231680998708",
    appId: "1:231680998708:web:0aa964301fc0db5f1e7961",
  };

  // The email of the single sync user you create in Firebase Authentication.
  // Its password IS the passcode people type to unlock a device.
  var SYNC_EMAIL = "ian+wallenclublambs@gmail.com";
  // =====================================================================

  var SYNC_ENABLED = !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId && SYNC_EMAIL);

  var LOCAL_PREFIX = "wcl:";
  var META_PREFIX = "wcl:__syncmeta:";
  var SYNC_KEY_PREFIX = "sheepwrld:"; // only sync app data, not misc local keys

  var pendingPushQueue = [];
  var fbApp, auth, db;
  var authReady = false;
  var currentUser = null;
  var firstSnapshotProcessed = false;
  var bannerShown = false;
  var pillEl = null;
  var overlayEl = null;

  // ---------------------------------------------------------------------
  // 1. Synchronous bridge — must exist before bundle.js runs.
  // ---------------------------------------------------------------------
  window.__gscSyncPush = function (key, value) {
    if (!SYNC_ENABLED) return;
    if (typeof key !== "string" || key.indexOf(SYNC_KEY_PREFIX) !== 0) return;
    pendingPushQueue.push({ key: key, value: value, ts: Date.now() });
    flushQueue();
  };

  function flushQueue() {
    if (!authReady || !currentUser || !db) return;
    while (pendingPushQueue.length) {
      var item = pendingPushQueue.shift();
      pushToFirestore(item.key, item.value, item.ts);
    }
  }

  // ---------------------------------------------------------------------
  // 2. UI (plain DOM, no framework — keeps this independent of bundle.js)
  // ---------------------------------------------------------------------
  function buildStatusPill() {
    var pill = document.createElement("div");
    pill.id = "gsc-sync-pill";
    pill.style.cssText =
      "position:fixed;bottom:10px;right:10px;z-index:9998;font-size:11px;" +
      "padding:4px 9px;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
      "pointer-events:none;transition:opacity .3s;opacity:.9;letter-spacing:.2px;";
    document.body.appendChild(pill);
    return pill;
  }

  function setPillState(state) {
    if (!pillEl) return;
    var map = {
      locked: ["Locked", "#555"],
      syncing: ["Syncing…", "#8a6d00"],
      synced: ["Synced", "#2e7d32"],
      offline: ["Offline — saved on device", "#5a5a5a"],
      error: ["Sync error", "#8b2f2f"],
    };
    var m = map[state] || map.offline;
    pillEl.textContent = m[0];
    pillEl.style.background = m[1];
  }

  function buildOverlay() {
    var overlay = document.createElement("div");
    overlay.id = "gsc-sync-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:#0F1115;display:flex;" +
      "align-items:center;justify-content:center;flex-direction:column;gap:14px;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
      "color:#fff;padding:24px;box-sizing:border-box;text-align:center;";
    overlay.innerHTML =
      '<div style="font-size:20px;font-weight:600;">Wallen Club Lambs</div>' +
      '<div style="font-size:14px;color:#aaa;max-width:280px;">Enter the passcode to unlock this device.</div>' +
      '<input id="gsc-sync-passcode" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
      'style="width:220px;padding:12px 14px;border-radius:8px;border:1px solid #444;background:#2A2A2A;color:#fff;' +
      'font-size:16px;text-align:center;" placeholder="Passcode" />' +
      '<button id="gsc-sync-unlock" style="width:220px;padding:12px;border-radius:8px;border:none;' +
      'background:#1C3F99;color:#FFFFFF;font-size:15px;font-weight:600;cursor:pointer;">Unlock</button>' +
      '<div id="gsc-sync-error" style="font-size:13px;color:#e57373;min-height:16px;max-width:280px;"></div>';
    document.body.appendChild(overlay);

    var input = overlay.querySelector("#gsc-sync-passcode");
    var btn = overlay.querySelector("#gsc-sync-unlock");
    function submit() {
      var val = input.value;
      if (!val) return;
      attemptSignIn(val);
    }
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") submit();
    });
    setTimeout(function () {
      input.focus();
    }, 50);
    return overlay;
  }

  function setOverlayError(msg) {
    if (!overlayEl) return;
    var el = overlayEl.querySelector("#gsc-sync-error");
    if (el) el.textContent = msg || "";
  }

  function setOverlayBusy(busy) {
    if (!overlayEl) return;
    var btn = overlayEl.querySelector("#gsc-sync-unlock");
    var input = overlayEl.querySelector("#gsc-sync-passcode");
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? "Checking…" : "Unlock";
      btn.style.opacity = busy ? "0.7" : "1";
    }
    if (input) input.disabled = busy;
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.style.display = "none";
  }
  function showOverlay() {
    if (overlayEl) overlayEl.style.display = "flex";
  }

  function showUpdateBanner() {
    if (bannerShown) return;
    bannerShown = true;
    var banner = document.createElement("div");
    banner.id = "gsc-sync-banner";
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:9997;background:#0A2570;color:#fff;" +
      "padding:10px 14px;display:flex;align-items:center;justify-content:center;gap:12px;" +
      "font-size:13px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
      "box-shadow:0 2px 6px rgba(0,0,0,.3);";
    banner.innerHTML =
      "<span>New data synced from another device.</span>" +
      '<button id="gsc-sync-refresh-btn" style="background:#fff;color:#0A2570;border:none;' +
      'border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer;font-size:12px;">Refresh</button>';
    document.body.appendChild(banner);
    banner.querySelector("#gsc-sync-refresh-btn").addEventListener("click", function () {
      window.location.reload();
    });
  }

  // ---------------------------------------------------------------------
  // 3 & 4. Firebase wiring
  // ---------------------------------------------------------------------
  function attemptSignIn(passcode) {
    if (!auth) return;
    setOverlayError("");
    setOverlayBusy(true);
    window.__fb
      .signInWithEmailAndPassword(auth, SYNC_EMAIL, passcode)
      .catch(function (err) {
        setOverlayBusy(false);
        var code = err && err.code;
        console.error("[Sync] Sign-in error:", code, err);
        if (code === "auth/network-request-failed") {
          setOverlayError(
            "No internet connection. Connect once to unlock this device — after that it stays unlocked."
          );
        } else if (code === "auth/too-many-requests") {
          setOverlayError("Too many attempts. Wait a moment and try again.");
        } else {
          setOverlayError("Incorrect passcode. Try again.");
        }
      });
  }

  function pushToFirestore(key, value, ts) {
    var FB = window.__fb;
    var ref = FB.doc(db, "wallen_sync", key);
    var payload =
      value === null
        ? { deleted: true, value: null, ts: ts, serverTs: FB.serverTimestamp() }
        : { deleted: false, value: value, ts: ts, serverTs: FB.serverTimestamp() };
    localStorage.setItem(META_PREFIX + key, String(ts));
    setPillState(navigator.onLine === false ? "offline" : "syncing");
    FB.setDoc(ref, payload).catch(function (err) {
      // Firestore's offline persistence normally queues this silently when
      // truly offline — but log it so a permissions/rules problem is visible.
      console.error("[Sync] Write failed for", key, ":", err && err.code, err);
    });
  }

  function backfillMissingLocalKeys(remoteKeysSeen) {
    for (var i = 0; i < localStorage.length; i++) {
      var rawKey = localStorage.key(i);
      if (!rawKey || rawKey.indexOf(LOCAL_PREFIX + SYNC_KEY_PREFIX) !== 0) continue;
      if (rawKey.indexOf(META_PREFIX) === 0) continue;
      var key = rawKey.slice(LOCAL_PREFIX.length);
      if (remoteKeysSeen[key]) continue;
      var value = localStorage.getItem(rawKey);
      if (value === null) continue;
      var ts = Date.now();
      pushToFirestore(key, value, ts);
    }
  }

  function startListening() {
    var FB = window.__fb;
    var colRef = FB.collection(db, "wallen_sync");
    FB.onSnapshot(
      colRef,
      function (snap) {
        var sawChange = false;
        var remoteKeysSeen = {};
        snap.docChanges().forEach(function (change) {
          var key = change.doc.id;
          remoteKeysSeen[key] = true;
          var data = change.doc.data();
          if (!data) return;
          var remoteTs = data.ts || 0;
          var localTsRaw = localStorage.getItem(META_PREFIX + key);
          var localTs = localTsRaw ? parseInt(localTsRaw, 10) : 0;
          if (remoteTs <= localTs) return; // we already have this (or our own echoed write)

          if (data.deleted) {
            localStorage.removeItem(LOCAL_PREFIX + key);
          } else if (typeof data.value === "string") {
            var existing = localStorage.getItem(LOCAL_PREFIX + key);
            if (existing === data.value) {
              localStorage.setItem(META_PREFIX + key, String(remoteTs));
              return;
            }
            localStorage.setItem(LOCAL_PREFIX + key, data.value);
            sawChange = true;
          }
          localStorage.setItem(META_PREFIX + key, String(remoteTs));
        });

        if (!firstSnapshotProcessed) {
          firstSnapshotProcessed = true;
          backfillMissingLocalKeys(remoteKeysSeen);
        }

        if (sawChange) showUpdateBanner();
        setPillState(navigator.onLine === false ? "offline" : "synced");
      },
      function (err) {
        console.error("[Sync] Firestore listener error:", err && err.code, err);
        setPillState("offline");
      }
    );
  }

  function initFirebase() {
    var FB = window.__fb;
    if (!FB) {
      // firebase-vendor.js failed to load (e.g. blocked script) — app still
      // works fully offline via localStorage, just without cross-device sync.
      setPillState("error");
      hideOverlay();
      return;
    }
    try {
      fbApp = FB.initializeApp(FIREBASE_CONFIG);
      auth = FB.getAuth(fbApp);
      try {
        db = FB.initializeFirestore(fbApp, {
          localCache: FB.persistentLocalCache({ tabManager: FB.persistentMultipleTabManager({}) }),
        });
      } catch (e) {
        // Firestore already initialized (hot reload / duplicate script), or this
        // environment doesn't support persistent local cache (e.g. no IndexedDB,
        // private browsing) — fall back to an in-memory Firestore instance so
        // sync still works this session even without offline queuing.
        try {
          db = FB.initializeFirestore(fbApp, {});
        } catch (e2) {
          throw e2;
        }
      }

      FB.onAuthStateChanged(
        auth,
        function (user) {
          currentUser = user;
          if (user) {
            authReady = true;
            hideOverlay();
            setPillState("syncing");
            startListening();
            flushQueue();
          } else {
            authReady = false;
            setPillState("locked");
            showOverlay();
          }
        },
        function (err) {
          // Auth state listener itself errored (e.g. no IndexedDB at all) —
          // degrade to "no sync", but never block the app.
          console.error("[Sync] Auth listener error:", err && err.code, err);
          setPillState("error");
          hideOverlay();
        }
      );
    } catch (e) {
      // Any unexpected Firebase init failure: the sheep records already live
      // safely in localStorage, so never let a sync problem block the app.
      console.error("[Sync] Firebase init failed:", e);
      setPillState("error");
      hideOverlay();
    }
  }

  // ---------------------------------------------------------------------
  // Boot — runs synchronously as the script parses (document.body already
  // exists since this tag sits right after <div id="root">).
  // ---------------------------------------------------------------------
  if (!SYNC_ENABLED) {
    // No Firebase project configured yet — run as a local, this-device-only app.
    return;
  }

  pillEl = buildStatusPill();
  overlayEl = buildOverlay();
  setPillState("locked");

  window.addEventListener("online", function () {
    if (currentUser) setPillState("syncing");
  });
  window.addEventListener("offline", function () {
    setPillState("offline");
  });

  initFirebase();
})();

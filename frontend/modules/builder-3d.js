window.EFTForge = window.EFTForge || {};

// ============================================================
// 3D BUILDER
//
// The builder's main mode on desktop: the Kitbash! 3D viewer fills the build area
// and our own UI floats over it (build controls top left, the current build panel,
// the attachment table docked on the right, the view panels in builder-3d-panels.js).
// The 2D workbench stays one click away and the choice is remembered.
//
// The viewer is an iframe at config.VIEWER_URL, driven only through its postMessage
// protocol (Kitbash! spec/viewer-api.md, "Embedding"). We stay the source of truth
// for the build: every pick goes through installAttachment/removeAttachment and we
// send the result with setBuild.
// ============================================================

(function () {
    const MODE_KEY   = "eftforge_builder_mode";   // "3d" | "2d"
    const PICKER_KEY = "eftforge_b3d_picker";     // "table" | "game"
    const DOCK_KEY   = "eftforge_b3d_stats_dock"; // {pos: [fx, fy], collapsed}
    const READY_TIMEOUT_MS = 25000;
    const CALL_TIMEOUT_MS  = 20000;
    const PROTOCOL = 1;
    // Keys the viewer binds (Kitbash! keys.js). Letters only reach it while no part list
    // is open, so type-to-search in the attachment table keeps working.
    const VIEW_LETTERS = new Set(["v", "m", "b", "h"]);

    const _read = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
    const _write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

    let _mode = _read(MODE_KEY, "3d") === "2d" ? "2d" : "3d";
    let _pickerStyle = _read(PICKER_KEY, "table") === "game" ? "game" : "table";
    let _failedThisSession = false;

    // The frame and its handshake.
    let _stage = null, _frame = null, _hud = null, _origin = null, _loading = null;
    let _drawing = false;         // a build is on its way to the viewer
    let _holds = 0;               // our own loads covering the build area (holdLoading)
    let _ready = false, _readyTimer = null;
    let _nextId = 1;
    const _pending = new Map();   // id -> {resolve, reject, timer}
    let _queue = [];              // calls made before "ready"

    // Build sync.
    let _nodeById = new Map();    // viewer part id -> our tree node
    let _syncedKey = null, _syncedGunId = null, _syncScheduled = false;
    let _notifiedMissing = "";
    const _sentNames = new Map(); // tpl -> short name the viewer has (setPartNames)
    let _pendingFlashes = [];     // [{parentNode, slotId, kind}] waiting for the build they follow // the parts the last notice named, so each set is named once

    // Part lists over the view: our attachment table (docked) or the game's dropdown.
    let _tableKey = null;         // viewer slot key the table is open for
    let _native = null;           // {key, parentNode, slot, items, byTpl}
    let _nativeSeq = 0;

    function _supported() {
        return !!EFTForge.config.VIEWER_URL && !isMobileLayout();
    }

    function isActive() {
        return document.body.classList.contains("builder-3d");
    }

    function _t(key) { return EFTForge.lang.t(key); }

    // --------------------------------------------------------- frame messaging

    function _post(msg) {
        if (_frame?.contentWindow && _origin) _frame.contentWindow.postMessage({ kitbash: PROTOCOL, ...msg }, _origin);
    }

    // Call a viewer command; resolves with its result. Calls made before the viewer is
    // ready wait for it.
    function call(name, ...args) {
        if (!_frame) return Promise.reject(new Error("3D view is not open"));
        return new Promise((resolve, reject) => {
            const run = () => {
                const id = _nextId++;
                const timer = setTimeout(() => {
                    _pending.delete(id);
                    reject(new Error(`3D view: ${name} timed out`));
                }, CALL_TIMEOUT_MS);
                _pending.set(id, { resolve, reject, timer });
                _post({ call: name, args, id });
            };
            if (_ready) run(); else _queue.push(run);
        });
    }

    // Fire and forget: no answer wanted, failures only logged.
    function send(name, ...args) {
        call(name, ...args).catch(err => console.warn("[builder-3d]", err.message));
    }

    function _onMessage(e) {
        if (!_frame || e.source !== _frame.contentWindow || e.origin !== _origin) return;
        const m = e.data;
        if (!m || m.kitbash !== PROTOCOL) return;
        if (m.id !== undefined && _pending.has(m.id)) {
            const p = _pending.get(m.id);
            _pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
            return;
        }
        if (m.event === "loaded") { _post({ call: "hello", id: 0 }); return; }
        if (m.event === "ready") { _onReady(); return; }
        if (m.event === "error") { _fail(m.data?.message); return; }
        if (m.event) _onEvent(m.event, m.data);
    }

    function _onReady() {
        if (_ready) return;
        _ready = true;
        clearTimeout(_readyTimer);
        _frame.classList.add("b3d-frame-ready");
        const queued = _queue;
        _queue = [];
        queued.forEach(run => run());
        send("setLanguage", EFTForge.state.lang === "zh" ? "zh" : "en");
        send("setHudStyle", _hudStyle());
        send("setPointerTracking", true);
        // app.js loads after us, so we hook the parallax here rather than at load.
        if (!_parallaxHooked && EFTForge.dotParallax) {
            _parallaxHooked = true;
            EFTForge.dotParallax.onChange(_sendParallax);
        }
        _sendBackdrop();
        onAimSettings();
        EFTForge.builder3dPanels?.onReady();
        _syncedKey = null;
        _scheduleSync();
    }

    function _fail(message) {
        console.warn("[builder-3d] viewer failed:", message || "no answer");
        _failedThisSession = true;
        replaceToast("builder-3d", _t("b3d.failed"), _t("b3d.failedMsg"), 5000, "#e74c3c");
        _leave3d();
        _renderModeToggle();
    }

    // --------------------------------------------------------- style and backdrop

    // Our design language for the slot overlay (Kitbash! setHudStyle).
    function _hudStyle() {
        return {
            vars: {
                font: '"Bender", Arial, sans-serif',
                slotBg: "rgba(24, 24, 24, 0.88)",
                slotEmptyBg: "rgba(14, 14, 14, 0.72)",
                slotBorder: "#333",
                // The name on a slot box, as the attachment table's icons show it (.slot-shortname).
                slotName: "#aaa",
                slotNameSize: "10px",
                slotNameWeight: "600",
                slotNameShadow: "0 0 2px #000, 0 0 4px #000",
                slotNameTop: "2px",
                slotNameLeft: "auto",
                slotNameRight: "2px",
                slotNameHeight: "auto",
                slotNameLineHeight: "1.05",
                slotNameMaxWidth: "52px",
                slotNameWrap: "normal",
                slotNameBreak: "break-word",
                slotNameTransform: "scaleY(1.05)",
                // The Arcadia watermark: level with our top left controls, clear of the edge tab.
                watermarkTop: "20px",
                watermarkRight: "46px",
                watermarkHeight: "50px",
                slotRadius: "0px",
                slotShadow: "none",
                slotHotShadow: "none",
                slotOpenBorder: "currentColor",
                dropdownButton: "none",
                // The compact picker's cells, a little smaller than the game's 64px.
                menuCell: "58px",
                menuNameSize: "10px",
                // Incompatible parts keep the normal cursor; a click explains (partblocked).
                menuDisabledCursor: "pointer",
                flashColor: "rgba(220, 50, 50, 0.45)",
                // Part icons shimmer while they load, as ours do (eft-img-shimmer in styles.css).
                iconLoading: "linear-gradient(90deg, #181818 25%, #242424 50%, #181818 75%)",
                // The viewer's diagnostics dock in our design language: the frosted glass of
                // .b3d-panel, .b3d-chip buttons, .b3d-mini-title headings, gold and teal accents.
                diagBg: "rgba(20, 20, 20, 0.82)",
                diagBackdrop: "blur(6px)",
                diagBorder: "#2a2a2a",
                diagRadius: "8px",
                diagShadow: "0 6px 12px -2px rgba(0, 0, 0, 0.7)",
                diagFont: '"Bender", Arial, sans-serif',
                diagDragCursor: "default", // our dragged panels keep the default cursor
                diagText: "#ccc",
                diagMuted: "#888",
                diagDim: "#777",
                diagValue: "#eee",
                diagLine: "#2a2a2a",
                diagRowLine: "#1f1f1f",
                diagFocus: "#f5c542",
                diagTitle: "#f5c542",
                diagTitleBar: "3px solid #f5c542",
                diagTitlePad: "8px",
                diagSection: "#f5c542",
                diagSectionBar: "#333",
                diagBtnBg: "#1a1a1a",
                diagBtnColor: "#ccc",
                diagBtnBorder: "#333",
                diagBtnRadius: "4px",
                diagBtnHoverBg: "#252525",
                diagBtnHoverColor: "#fff",
                diagBtnHoverBorder: "#444",
                diagBtnOnBg: "#333",
                diagBtnOnColor: "#f5c542",
                diagBtnOnBorder: "#444",
                // The history window's trigger as our .custom-select-trigger; its list is ours.
                diagSelectRadius: "999px",
                diagSelectBg: "#1a1a1a",
                diagSelectBorder: "#444",
                diagSelectColor: "#eee",
                diagSelectArrow: "#888",
                diagLive: "#888",
                diagAim: "#00c8b4",
                diagFrozen: "#f5c542",
                diagScrollbar: "#444",
                diagGrid: "#2a2a2a",
                diagChartText: "#777",
                diagZero: "#3a3a3a",
                diagChartBg: "rgba(0, 0, 0, 0.25)",
                diagOverswing: "#f5c542",
                diagSway: "#00c8b4",
                // Hover: the outline takes the slot's colour and the fill lifts, as our buttons do.
                slotHoverBorder: "currentColor",
                slotHoverBg: "rgba(37, 37, 37, 0.92)",
                slotEmptyHoverBg: "rgba(30, 30, 30, 0.82)",
                slotTransition: "border-color 0.15s ease, background-color 0.15s ease",
                labelBg: "rgba(20, 20, 20, 0.9)",
                labelColor: "#ccc",
                labelSize: "11px",
                labelRadius: "3px",
                labelBadBg: "rgba(231, 76, 60, 0.92)",
                labelBadColor: "#fff",
                circleBg: "#141414",
                lineOpacity: 0.55,
            },
            colors: { master: "#f5c542", gear: "#00c8b4", functional: "#cccccc", bad: "#e74c3c" },
        };
    }

    // "rgba(r, g, b, a)" or "rgb(r, g, b)" at alpha 0, so the blob fades out in its own colour.
    function _clearOf(color) {
        const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
        return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, 0)` : "rgba(0, 0, 0, 0)";
    }

    // The build area's background (styles.css, .container:not(.no-gun)) as the viewer's
    // backdrop layers, so the view blends into the page.
    function _backdropSpec() {
        const root = getComputedStyle(document.documentElement);
        const blob = root.getPropertyValue("--blob-color").trim() || "rgba(245, 197, 66, 0.1)";
        const rect = _frame.getBoundingClientRect();
        return { layers: [
            { type: "linear", angle: 160, stops: [[0, "#141414"], [0.5, "#111111"], [1, "#0f0e0b"]] },
            // The page's dots are fixed to the viewport: line ours up with them. The
            // parallax shift goes separately (setBackdropOffset), so the cursor never repaints.
            { type: "dots", spacing: 30, radius: 1, color: "rgba(255, 255, 255, 0.11)", offset: [-rect.left, -rect.top] },
            { type: "radial", x: 0.85, y: 0.9, rx: 0.7, ry: 0.7, stops: [[0, blob], [0.7, _clearOf(blob)]] },
            { type: "radial", x: 0.5, y: 0.5, rx: 1, ry: 1, stops: [[0.2, "rgba(0, 0, 0, 0)"], [1, "rgba(0, 0, 0, 0.72)"]] },
        ] };
    }

    let _lastBackdrop = "", _lastParallax = "", _parallaxHooked = false;
    function _sendBackdrop() {
        if (!_ready) return;
        const spec = _backdropSpec();
        const key = JSON.stringify(spec);
        if (key !== _lastBackdrop) {
            _lastBackdrop = key;
            send("setBackdrop", spec);
        }
        _sendParallax();
    }

    // The page's dot parallax (app.js), snapped to whole device pixels: each change redraws
    // the whole 3D view, and the grid only moves about one pixel per few hundred pixels
    // of cursor travel, so this keeps it to a handful of redraws across the screen.
    function _sendParallax() {
        if (!_ready || !isActive() || !EFTForge.dotParallax) return;
        const dpr = window.devicePixelRatio || 1;
        const [x, y] = EFTForge.dotParallax.offset.map(v => Math.round(v * dpr) / dpr);
        const key = `${x} ${y}`;
        if (key === _lastParallax) return;
        _lastParallax = key;
        send("setBackdropOffset", x, y);
    }

    // --blob-color eases over 1s (styles.css): follow it for a little longer than that.
    let _blobFollowUntil = 0, _blobFrame = 0, _blobLastSent = 0;
    function _followBlob() {
        _blobFollowUntil = performance.now() + 1200;
        if (_blobFrame) return;
        const step = (now) => {
            if (now - _blobLastSent > 60) { _blobLastSent = now; _sendBackdrop(); }
            if (now < _blobFollowUntil) _blobFrame = requestAnimationFrame(step);
            else { _blobFrame = 0; _sendBackdrop(); }
        };
        _blobFrame = requestAnimationFrame(step);
    }

    // Only a change of the glow's colour (utils.js, inline on the root) repaints the
    // viewer's backdrop.
    let _lastBlob = document.documentElement.style.getPropertyValue("--blob-color");
    new MutationObserver(() => {
        if (!isActive()) return;
        const blob = document.documentElement.style.getPropertyValue("--blob-color");
        if (blob !== _lastBlob) { _lastBlob = blob; _followBlob(); }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

    // --------------------------------------------------------- build sync

    function _scheduleSync() {
        if (_syncScheduled) return;
        _syncScheduled = true;
        requestAnimationFrame(() => { _syncScheduled = false; _sync(); });
    }

    async function _sync() {
        if (!isActive() || !_ready) return;
        const gun = EFTForge.state.currentGun, tree = EFTForge.state.buildTree;
        if (!gun || !tree) return;
        const nodes = new Map();
        const payload = _bpWalkTreeToSptItems(gun, tree, (id, node) => nodes.set(id, node));
        if (!payload) return; // slots not loaded yet; the next render syncs
        const key = gun.id + "|" + JSON.stringify(payload.items);
        if (key === _syncedKey) { _flushFlashes(); return; }
        const gunChanged = _syncedGunId !== gun.id;
        // A new gun covers the view at once; a part swap only if it takes a while.
        _drawing = true;
        _setLoading(true, { delayed: !gunChanged });
        _syncedKey = key;
        _syncedGunId = gun.id;
        _nodeById = nodes;
        // A new build closes the compact picker, as the game's dropdown does. Our table stays
        // open (the 2D builder keeps it too); the viewer forgets the open slot on a new build,
        // so we tell it again once drawn.
        if (_native) { _native = null; _clearHoverDeltas({ compare: false }); }
        _nativeSeq++;
        // Our short names on its slot boxes, in the user's language; only ones it lacks.
        const names = {};
        for (const node of nodes.values()) {
            const item = node === tree ? null : node.item;
            const name = item && (item.short_name || item.name);
            if (name && _sentNames.get(item.id) !== name) { names[item.id] = name; _sentNames.set(item.id, name); }
        }
        if (Object.keys(names).length) send("setPartNames", names);
        try {
            await call("setBuild", payload.items);
            if (key !== _syncedKey) return;
            _drawing = false;
            _setLoading(false);
            if (_tableKey && _tableOpen()) send("setSlotOpen", _tableKey);
            _flushFlashes();
            if (gunChanged) send("reset");
            onStats();
            _checkModels(payload.items, key);
        } catch (err) {
            if (key === _syncedKey) { _drawing = false; _setLoading(false); }
            console.warn("[builder-3d] setBuild failed:", err.message);
        }
    }

    // delayed: fade in only after half a second, so quick part swaps never flash it.
    function _setLoading(on, { delayed = false } = {}) {
        if (!_loading) return;
        // Stays up while the viewer starts, a build draws or one of our loads holds it.
        if (!on && (!_ready || _drawing || _holds > 0)) return;
        if (on && _loading.classList.contains("on")) {
            // Already up: keep its timing, unless this one should not wait.
            if (!delayed) _loading.classList.remove("delayed");
            return;
        }
        _loading.classList.toggle("delayed", !!delayed);
        _loading.classList.toggle("on", !!on);
    }

    // Our own loading over the build area (utils.js startPanelLoading on the left panel,
    // which the 3D view spans) shows as this veil rather than a second overlay on top.
    // Returns the release.
    function holdLoading() {
        if (!isActive()) return () => {};
        _holds++;
        _setLoading(true, { delayed: false });
        let released = false;
        return () => {
            if (released) return;
            released = true;
            _holds = Math.max(0, _holds - 1);
            _setLoading(false);
        };
    }

    // The viewer aims with our totals (setBuild clears them, so send after every build).
    function onStats() {
        if (!isActive() || !_ready) return;
        const ergo = EFTForge.state.lastTotalErgo, weight = EFTForge.state.lastTotalWeight;
        if (!Number.isFinite(ergo) || !Number.isFinite(weight)) return;
        send("setWeaponStats", { ergonomics: ergo, weight });
        onAimSettings();
    }

    // Our Strength level and equipment ergo modifier drive the viewer's ADS model too, so its
    // arm stamina and overswing match the stats panel.
    function onAimSettings() {
        if (!_frame || !_ready) return;
        send("setSkills", { strength: EFTForge.state.currentStrengthLevel ?? 10 });
        send("setEquipmentErgonomics", EFTForge.state.currentEquipErgoModifier ?? 0);
    }

    // A notice when parts have no 3D model (they stay installed, just not drawn).
    async function _checkModels(items, key) {
        const tpls = [...new Set(items.slice(1).map(i => i._tpl))];
        if (!tpls.length) { _notifiedMissing = ""; return; }
        try {
            const withModels = new Set(await call("hasModels", tpls));
            if (key !== _syncedKey) return;
            const missing = items.slice(1).filter(i => !withModels.has(i._tpl));
            const missingKey = missing.map(i => i._tpl).sort().join(",");
            // Only a change in what is missing is news; picking other parts is not.
            if (missingKey === _notifiedMissing) return;
            _notifiedMissing = missingKey;
            if (missing.length > 0) {
                replaceToast("builder-3d-models", _t("b3d.noModel"),
                    EFTForge.lang.tFmt("b3d.noModelMsg", { n: missing.length }), 4000, "#f5a623");
            }
        } catch (err) {
            console.warn("[builder-3d] hasModels failed:", err.message);
        }
    }

    // The viewer's slot key ("<parent part id>/<game slot name>") as our tree node and slot.
    function _resolveSlot(key) {
        const cut = key.indexOf("/");
        if (cut < 0) return null;
        const parentNode = _nodeById.get(key.slice(0, cut));
        const gameSlot = key.slice(cut + 1);
        if (!parentNode) return null;
        const itemId = parentNode === EFTForge.state.buildTree ? EFTForge.state.currentGun?.id : parentNode.item?.id;
        const slots = EFTForge.state.slotCache[itemId] || [];
        const slot = slots.find(s => (s.slot_game_name || s.slot_name) === gameSlot);
        return slot ? { parentNode, slot } : null;
    }

    // --------------------------------------------------------- part lists

    function _tableOpen() {
        return !!document.getElementById("attachment-table-container")?.firstElementChild;
    }

    function closePicker() {
        if (_tableOpen()) document.getElementById("att-table-close-btn")?.click();
        if (_native) { _native = null; _clearHoverDeltas({ compare: false }); }
        _nativeSeq++;
        if (_ready) send("closePartMenu");
    }

    function _onSlotClick(data) {
        const hit = _resolveSlot(data.key);
        if (!hit) {
            console.warn("[builder-3d] no workbench slot for", data.key);
            return;
        }
        // A second click on the open slot closes its list, as the game does.
        if ((_tableKey === data.key && _tableOpen()) || _native?.key === data.key) { closePicker(); return; }
        if (_pickerStyle === "game") _openNative(data.key, hit.parentNode, hit.slot);
        else _openTable(data.key, hit.parentNode, hit.slot);
    }

    function _openTable(key, parentNode, slot) {
        if (_native) closePicker();
        _tableKey = key;
        send("setSlotOpen", key);
        openSlotSelector(parentNode, slot);
    }

    // Traders sell it (at the user's trader levels) or not: flea only counts as not.
    function _nativeAvail(item) {
        return _itemAvailability(item) === "trader" ? "trader" : "none";
    }

    // Trader levels changed (price panel, optimizer): the open compact picker's badges follow.
    function onTraderLevelsChange() {
        if (!_native || !_ready) return;
        const byTpl = {};
        for (const e of _native.items) byTpl[e.item.id] = _nativeAvail(e.item);
        send("setPartAvailability", _native.key, byTpl);
    }

    async function _openNative(key, parentNode, slot) {
        if (_tableOpen()) document.getElementById("att-table-close-btn")?.click();
        const seq = ++_nativeSeq;
        const loaded = await _loadSlotCandidates(parentNode, slot, { stale: () => seq !== _nativeSeq });
        if (!loaded || seq !== _nativeSeq || !isActive()) return;
        const installedId = parentNode.children[slot.id]?.item?.id;
        // The game lists every part but the one installed.
        const items = loaded.processedItems;
        const listed = items.filter(e => e.item.id !== installedId)
            .sort((a, b) => (a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0));
        const candidates = listed.map(e => ({
            tpl: e.item.id,
            name: e.item.short_name || e.item.name,
            icon: e.item.icon_link || e.item.base_image_link || undefined,
            disabled: !!e.hasConflict,
            reason: e.hasConflict ? (e.conflictName || _t("toast.attachmentConflict")) : "",
            avail: _nativeAvail(e.item),
        }));
        _native = { key, parentNode, slot, items, byTpl: new Map(items.map(e => [e.item.id, e])) };
        try {
            const opened = await call("openPartMenu", key, { candidates, tooltips: false, badges: "corner" });
            if (!opened && _native?.key === key) _native = null;
        } catch (err) {
            _native = null;
            console.warn("[builder-3d] openPartMenu failed:", err.message);
        }
    }

    function _onPartHover({ key, tpl }) {
        if (!_native || _native.key !== key) return;
        const ctx = { parentNode: _native.parentNode, slot: _native.slot, items: _native.items, compare: false };
        const entry = tpl ? _native.byTpl.get(tpl) : null;
        if (entry && !entry.hasConflict) _showHoverDeltas(entry, ctx);
        else _clearHoverDeltas(ctx);
    }

    // An incompatible part in the compact picker was clicked: as in the 2D builder, a toast
    // and the conflicting slot flashing red, plus the conflicting part on the model.
    function _onPartBlocked({ key, tpl }) {
        if (!_native || _native.key !== key) return;
        const entry = _native.byTpl.get(tpl);
        if (!entry) return;
        replaceToast("attachment-conflict", _t("toast.attachmentConflict"), `${entry.item.name}\n${entry.conflictName || ""}`);
        flashConflict(entry.conflictingItemId, entry.conflictingSlotId);
    }

    // Flash what blocks a part in the 3D view: the installed item (template id) and/or our
    // slot id, as the 2D builder's flashConflictInGrid/flashConflictSlotInGrid do.
    function flashConflict(itemId, slotId) {
        if (!isActive() || !_ready) return;
        const parts = [], slots = [];
        const tree = EFTForge.state.buildTree;
        for (const [id, node] of _nodeById) {
            const nodeItemId = node === tree ? EFTForge.state.currentGun?.id : node.item?.id;
            if (itemId && nodeItemId === itemId) parts.push(id);
            if (slotId) {
                const slot = (EFTForge.state.slotCache[nodeItemId] || []).find(s => s.id === slotId);
                if (slot) slots.push(`${id}/${slot.slot_game_name || slot.slot_name}`);
            }
        }
        if (parts.length || slots.length) send("flashConflict", { parts, slots });
    }

    function _onPartPick({ key, tpl }) {
        const menu = _native;
        if (!menu || menu.key !== key) return;
        _native = null;
        _clearHoverDeltas({ items: menu.items, compare: false });
        const installed = menu.parentNode.children[menu.slot.id];
        if (!tpl) {
            if (installed) removeAttachment(menu.parentNode, menu.slot.id);
            return;
        }
        const entry = menu.byTpl.get(tpl);
        if (!entry || entry.hasConflict || installed?.item?.id === tpl) return;
        installAttachment(menu.parentNode, menu.slot.id, entry.item);
    }

    // Our table tells the viewer when it closes (its close button, a removal, a view
    // change): the slot box leaves its open state.
    new MutationObserver(() => {
        const open = _tableOpen();
        document.body.classList.toggle("b3d-picker-open", open);
        if (!open && _tableKey) {
            _tableKey = null;
            if (_ready) send("setSlotOpen", null);
        }
    }).observe(document.getElementById("attachment-table-container"), { childList: true });

    // --------------------------------------------------------- viewer events

    function _onEvent(name, data) {
        switch (name) {
            case "pointer": {
                // The page's dot grid follows the cursor over the view as it does elsewhere.
                const f = _frame?.getBoundingClientRect();
                if (data && f) EFTForge.dotParallax?.pointer(f.left + data.x, f.top + data.y);
                return;
            }
            case "slotclick": _onSlotClick(data); break;
            case "slotrightclick": _onSlotRightClick(data); break;
            case "parthover": _onPartHover(data); break;
            case "partpick": _onPartPick(data); break;
            case "partblocked": _onPartBlocked(data); break;
            case "select": _frameSelect(data); break;
            case "tooltip": {
                // The frame's own tooltips (the diagnostics dock), drawn as ours.
                const f = _frame?.getBoundingClientRect();
                if (data && f) EFTForge.tooltip?.showAt(data.text, f.left + data.x, f.top + data.y);
                else EFTForge.tooltip?.showAt(null);
                break;
            }
            case "partmenu":
                // A menu moving to another slot reports the old one closing after the new
                // one is ours: only a close of the current menu ends it.
                if (!data.key && _native && data.closed === _native.key) {
                    _clearHoverDeltas({ items: _native.items, compare: false });
                    _native = null;
                }
                break;
            case "escape": closePicker(); break;
            case "partclick": if (_tableOpen()) closePicker(); break;
            case "mode": if (data === "sight") closePicker(); break;
            default: break;
        }
        EFTForge.builder3dPanels?.onEvent(name, data);
    }

    // --------------------------------------------------------- frame dropdowns

    // A dropdown in the frame (the diagnostics dock's history window) opens our own list,
    // the custom select's (setupCustomSelect in app.js), under the trigger the frame drew;
    // the pick goes back to the frame.
    let _frameList = null; // {el, id}

    function _closeFrameSelect(tell) {
        if (!_frameList) return;
        const { el, id } = _frameList;
        _frameList = null;
        el.remove();
        if (tell) send("pickSelect", id, null);
    }

    function _frameSelect(data) {
        _closeFrameSelect(false);
        if (!data || !_frame) return;
        const f = _frame.getBoundingClientRect(), r = data.rect;
        const wrapper = document.createElement("div");
        wrapper.className = "custom-select-wrapper open b3d-frame-select";
        Object.assign(wrapper.style, {
            left: f.left + r.left + "px", top: f.top + r.top + "px",
            width: r.right - r.left + "px", height: r.bottom - r.top + "px",
        });
        const list = document.createElement("div");
        list.className = "custom-select-list";
        list.setAttribute("role", "listbox");
        data.options.forEach((opt, i) => {
            const item = document.createElement("div");
            item.className = "custom-select-option" + (opt.value === data.value ? " selected" : "");
            item.setAttribute("role", "option");
            item.style.setProperty("--i", i);
            const label = document.createElement("span");
            label.className = "marquee-text";
            label.textContent = opt.label;
            item.appendChild(label);
            item.addEventListener("click", () => {
                _closeFrameSelect(false);
                send("pickSelect", data.id, opt.value);
            });
            list.appendChild(item);
        });
        wrapper.appendChild(list);
        document.body.appendChild(wrapper);
        _frameList = { el: wrapper, id: data.id };
    }

    // A press anywhere else on our page, or Esc, closes it unpicked. Presses inside the
    // frame never reach us; the frame closes it itself and tells us (select null).
    document.addEventListener("pointerdown", (e) => {
        if (_frameList && !_frameList.el.contains(e.target)) _closeFrameSelect(true);
    }, true);
    document.addEventListener("keydown", (e) => {
        if (!_frameList || e.key !== "Escape") return;
        e.stopPropagation();
        _closeFrameSelect(true);
    }, true);

    // No browser context menu anywhere in the 3D viewer, as inside the frame itself. Only the
    // default goes: our own right-click actions (removing a part from the table) still run.
    document.addEventListener("contextmenu", (e) => {
        if (isActive() && e.target.closest?.("#main-container, .hidden-stats-popover, .b3d-frame-select")) e.preventDefault();
    });

    // --------------------------------------------------------- keys

    function _typing(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    }

    function _keyBlocked(e) {
        if (!isActive() || !_ready || e.ctrlKey || e.metaKey) return true;
        if (_typing(document.activeElement) || _typing(e.target)) return true;
        if (document.querySelector(".modal-overlay")) return true;
        return document.getElementById("main-container")?.hasAttribute("inert");
    }

    function _forward(type, e) {
        send("key", type, { key: e.key, code: e.code, repeat: e.repeat });
    }

    document.addEventListener("keydown", (e) => {
        if (_keyBlocked(e)) return;
        if (e.key === "Escape") {
            if (_tableOpen() || _native) { closePicker(); return; }
            _forward("down", e);
            return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") { _forward("down", e); return; }
        if (e.code === "AltLeft") { e.preventDefault(); _forward("down", e); return; }
        if (e.altKey || !VIEW_LETTERS.has(e.key.toLowerCase())) return;
        // With a part list open, letters go to its search as in the 2D builder.
        if (_tableOpen()) return;
        _forward("down", e);
    });
    document.addEventListener("keyup", (e) => {
        if (!isActive() || !_ready) return;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.code === "AltLeft") {
            if (e.code === "AltLeft") e.preventDefault();
            _forward("up", e);
        }
    });
    window.addEventListener("blur", () => {
        if (!isActive() || !_ready) return;
        for (const [key, code] of [["ArrowLeft", "ArrowLeft"], ["ArrowRight", "ArrowRight"], ["Alt", "AltLeft"]]) {
            send("key", "up", { key, code, repeat: false });
        }
    });

    // --------------------------------------------------------- layout

    const _el = (id) => document.getElementById(id);
    let _topLeft = null, _dock = null, _dockBody = null, _ammoRow = null, _pickerToggle = null;

    // The About button's icon (index.html, #about-btn).
    const _HANDLE_SVG = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="9" cy="9" r="7.5" stroke="currentColor" stroke-width="1.5"/>' +
        '<line x1="9" y1="8" x2="9" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
        '<circle cx="9" cy="5.5" r="0.85" fill="currentColor"/>' +
        '</svg>';

    function _buildChrome() {
        if (_topLeft) return;
        const area = _el("left-build-area");
        _topLeft = document.createElement("div");
        _topLeft.id = "b3d-topleft";
        // The full mag toggle and the ammo pickers (built inside #stats, see _moveAmmo).
        _ammoRow = document.createElement("div");
        _ammoRow.id = "b3d-ammo";
        _topLeft.append(_ammoRow);
        area.appendChild(_topLeft);
        // The compact picker switch joins the view buttons bottom right (_enter3d).
        _pickerToggle = document.createElement("button");
        _pickerToggle.id = "b3d-picker-toggle";
        _pickerToggle.className = "compare-toggle";
        _pickerToggle.type = "button";
        _pickerToggle.innerHTML = `<span class="b3d-picker-label"></span><span class="compare-toggle-track"><span class="compare-toggle-knob"></span></span>`;
        _pickerToggle.addEventListener("click", () => setPickerStyle(_pickerStyle === "game" ? "table" : "game"));

        _dock = document.createElement("div");
        _dock.id = "b3d-stats-dock";
        // The handle (the About button's icon) shows while collapsed, so the tab has
        // something bigger to drag it by.
        _dock.innerHTML = `<div class="b3d-dock-body"></div><div class="b3d-dock-handle" aria-hidden="true">${_HANDLE_SVG}</div><button class="b3d-dock-tab" type="button"></button>`;
        _dockBody = _dock.querySelector(".b3d-dock-body");
        _dockBody.addEventListener("scroll", () => EFTForge.statsPanel?.followHiddenStatsBtn(), { passive: true });
        area.appendChild(_dock);
        new ResizeObserver(() => _placeDock()).observe(_dock);
        _initDockDrag();
    }

    function _renderChromeLabels() {
        const btn = _pickerToggle;
        if (btn) {
            btn.classList.toggle("active", _pickerStyle === "game");
            btn.querySelector(".b3d-picker-label").textContent = _t("b3d.pickerStyle");
            btn.dataset.tooltip = _t("b3d.pickerStyleTip");
        }
        if (_dock) {
            const s = _dockState();
            _dock.classList.toggle("collapsed", !!s.collapsed);
            const tab = _dock.querySelector(".b3d-dock-tab");
            tab.innerHTML = s.collapsed ? "&#9654;" : "&#9664;";
            tab.setAttribute("aria-label", _t(s.collapsed ? "b3d.expand" : "b3d.collapse"));
        }
    }

    // The 2D/3D switch, at the end of the build/price row.
    function _renderModeToggle() {
        const row = _el("view-toggle");
        if (!row) return;
        let group = _el("b3d-mode-toggle");
        if (!_supported()) { group?.remove(); return; }
        if (!group) {
            group = document.createElement("div");
            group.id = "b3d-mode-toggle";
            group.innerHTML = `<button class="toggle-btn" data-mode="2d" type="button">2D</button><button class="toggle-btn" data-mode="3d" type="button">3D</button>`;
            group.querySelectorAll("button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
            row.appendChild(group);
        }
        group.setAttribute("aria-label", _t("b3d.modeTip"));
        const shown = isActive() ? "3d" : "2d";
        group.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.mode === shown));
    }

    // Stats dock: draggable, collapsible to its side tab, remembered (position as a
    // fraction of the build area) and put back by a double-click.
    function _dockState() {
        try { return JSON.parse(_read(DOCK_KEY, "{}")) || {}; } catch { return {}; }
    }
    function _saveDock(s) { _write(DOCK_KEY, JSON.stringify(s)); }

    const DOCK_MARGIN = 8; // the panel keeps this far inside the build area

    // Keep the whole panel inside the build area at its full height; only a panel taller
    // than the area itself scrolls.
    function _placeDock() {
        if (!_dock || !isActive()) return;
        const area = _el("main-container");
        const W = area.clientWidth, H = area.clientHeight;
        // The body is zoomed (styles.css), so its max-height is in its own, smaller pixels.
        const zoom = parseFloat(getComputedStyle(_dockBody).zoom) || 1;
        _dockBody.style.maxHeight = (H - 2 * DOCK_MARGIN) / zoom + "px";
        const s = _dockState();
        let x, y;
        if (s.pos) {
            x = s.pos[0] * W; y = s.pos[1] * H;
        } else {
            x = 16; y = (_topLeft ? _topLeft.offsetTop + _topLeft.offsetHeight : 120) + 12;
        }
        const w = _dock.offsetWidth, h = _dock.offsetHeight;
        x = Math.max(DOCK_MARGIN, Math.min(W - w - DOCK_MARGIN, x));
        y = Math.max(DOCK_MARGIN, Math.min(H - h - DOCK_MARGIN, y));
        _dock.style.left = x + "px";
        _dock.style.top = y + "px";
        // The advanced stats popover hangs off a button in here; take it along.
        EFTForge.statsPanel?.followHiddenStatsBtn();
    }

    // Anything the user clicks to use rather than to move the panel.
    const _DOCK_CONTROLS = "input, select, textarea, button, a, label, [contenteditable], [role=button], [role=listbox], [role=option], [onclick]";

    function _isControl(target) {
        if (!(target instanceof Element)) return false;
        if (target.closest(_DOCK_CONTROLS)) return true;
        // Custom widgets (the ammo pickers and the like) show a pointer.
        return getComputedStyle(target).cursor === "pointer";
    }

    // The whole panel drags, except its controls; a press on the side tab that never
    // moves toggles the panel.
    function _initDockDrag() {
        const tab = _dock.querySelector(".b3d-dock-tab");
        let drag = null;
        _dock.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            const onTab = tab.contains(e.target);
            if (!onTab && _isControl(e.target)) return;
            drag = { x: e.clientX, y: e.clientY, left: _dock.offsetLeft, top: _dock.offsetTop, moved: false, onTab, id: e.pointerId };
        });
        document.addEventListener("pointermove", (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (!drag.moved) {
                if (Math.hypot(dx, dy) < 4) return; // still a click
                drag.moved = true;
                _dock.setPointerCapture(e.pointerId);
                _dock.classList.add("moving");
                window.getSelection()?.removeAllRanges();
            }
            const area = _el("main-container");
            const s = _dockState();
            s.pos = [(drag.left + dx) / area.clientWidth, (drag.top + dy) / area.clientHeight];
            _saveDock(s);
            _placeDock();
        });
        const end = (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            if (_dock.hasPointerCapture(e.pointerId)) _dock.releasePointerCapture(e.pointerId);
            _dock.classList.remove("moving");
            if (drag.moved) {
                // Remember where the panel stopped, not where the pointer went past an edge.
                const area = _el("main-container");
                const st = _dockState();
                st.pos = [_dock.offsetLeft / area.clientWidth, _dock.offsetTop / area.clientHeight];
                _saveDock(st);
                // Swallow the click the drag ends with, so it doesn't count as a click
                // outside the popovers (the advanced stats) and close them.
                const swallow = (ev) => ev.stopPropagation();
                window.addEventListener("click", swallow, { capture: true, once: true });
                setTimeout(() => window.removeEventListener("click", swallow, true), 0);
            }
            if (!drag.moved && drag.onTab && e.type === "pointerup") {
                const s = _dockState();
                s.collapsed = !s.collapsed;
                _saveDock(s);
                _renderChromeLabels();
                _placeDock();
            }
            drag = null;
        };
        document.addEventListener("pointerup", end);
        document.addEventListener("pointercancel", end);
        _dock.addEventListener("dblclick", (e) => {
            if (_isControl(e.target) || tab.contains(e.target)) return;
            const s = _dockState();
            delete s.pos;
            _saveDock(s);
            _placeDock();
        });
    }

    // Move our own panels between the 2D layout and the floating 3D one.
    // The ammo rows (.mag-controls) live at the top of #stats, which builds them once per
    // gun; over the 3D view they sit top left with the other controls. They must go back
    // before #stats is cleared, or the next gun builds a second set with the same ids.
    function _moveAmmo(threeD) {
        const stats = _el("stats");
        if (threeD) {
            for (const row of stats.querySelectorAll(":scope > .mag-controls")) _ammoRow.appendChild(row);
        } else if (_ammoRow) {
            stats.prepend(..._ammoRow.querySelectorAll(":scope > .mag-controls"));
        }
    }

    new MutationObserver(() => { if (isActive()) _moveAmmo(true); })
        .observe(document.getElementById("stats"), { childList: true });

    function _arrange(threeD) {
        const area = _el("left-build-area");
        const controls = _el("build-controls"), toggle = _el("view-toggle");
        const stats = _el("stats"), slots = _el("slots"), price = _el("price-overview");
        const edgeTab = _el("optimizer-edge-tab"), placeholder = _el("attachment-placeholder");
        if (threeD) {
            _topLeft.prepend(controls, toggle);
            _dockBody.append(stats, price);
            _moveAmmo(true);
            _el("main-container").appendChild(edgeTab);
        } else {
            _moveAmmo(false);
            area.insertBefore(controls, area.firstChild);
            area.insertBefore(toggle, controls.nextSibling);
            area.insertBefore(stats, slots);
            area.insertBefore(price, slots.nextSibling);
            placeholder.appendChild(edgeTab);
        }
    }

    function _enter3d() {
        if (isActive()) return;
        _buildChrome();
        // As wide as the same controls are in the 2D left panel (its width less 20px of
        // padding and 20px of right margin), so switching modes leaves them in place.
        const width2d = parseFloat(document.querySelector(".left-panel")?.style.width) || 660;
        _topLeft.style.width = Math.max(300, width2d - 40) + "px";
        document.body.classList.add("builder-3d");
        document.body.classList.toggle("b3d-picker-open", _tableOpen());
        _arrange(true);
        const container = _el("main-container");
        _stage = document.createElement("div");
        _stage.id = "b3d-stage";
        _frame = document.createElement("iframe");
        _frame.id = "b3d-frame";
        _frame.src = EFTForge.config.VIEWER_URL;
        _origin = new URL(EFTForge.config.VIEWER_URL, location.href).origin;
        _hud = document.createElement("div");
        _hud.id = "b3d-hud";
        // The jumping Kitbash! wordmark over a dark veil while the viewer starts or draws.
        _loading = document.createElement("div");
        _loading.id = "b3d-loading";
        _loading.innerHTML = _bpWorkingLogoHtml();
        _stage.append(_frame, _hud, _loading);
        _drawing = true; // the first build
        _holds = 0;
        _setLoading(true, { delayed: false });
        container.prepend(_stage);
        _ready = false;
        _syncedKey = null;
        _syncedGunId = null;
        _notifiedMissing = "";
        _sentNames.clear();
        _lastBackdrop = "";
        _lastParallax = "";
        clearTimeout(_readyTimer);
        _readyTimer = setTimeout(() => { if (!_ready) _fail("timed out"); }, READY_TIMEOUT_MS);
        EFTForge.builder3dPanels?.mount(_hud, { call, send });
        _hud.querySelector(".b3d-viewbtns")?.prepend(_pickerToggle);
        _renderChromeLabels();
        requestAnimationFrame(_placeDock);
    }

    // rerender: draw the 2D workbench again (not while leaving the build altogether).
    function _leave3d({ rerender = true } = {}) {
        if (!isActive()) return;
        closePicker();
        EFTForge.tooltip?.showAt(null); // one of the frame's, which it can no longer hide
        _closeFrameSelect(false);
        clearTimeout(_readyTimer);
        for (const p of _pending.values()) { clearTimeout(p.timer); p.reject(new Error("3D view closed")); }
        _pending.clear();
        _queue = [];
        EFTForge.builder3dPanels?.unmount();
        _stage?.remove();
        _stage = _frame = _hud = _loading = null;
        _ready = false;
        _nodeById = new Map();
        _pendingFlashes = [];
        _tableKey = null;
        _native = null;
        _arrange(false);
        document.body.classList.remove("builder-3d", "b3d-picker-open");
        // The 2D panel widths skipped window resizes while hidden: let them check the size now.
        window.dispatchEvent(new Event("resize"));
        // The 2D workbench needs a fresh render of its slots.
        if (rerender && EFTForge.state.currentGun) renderFullTree(true);
    }

    // --------------------------------------------------------- public

    function setMode(mode) {
        const next = mode === "2d" ? "2d" : "3d";
        _mode = next;
        _write(MODE_KEY, next);
        if (next === "3d") _failedThisSession = false;
        if (EFTForge.state.currentGun) {
            if (next === "3d" && _supported()) _enter3d(); else _leave3d();
        }
        _renderModeToggle();
    }

    function setPickerStyle(style) {
        _pickerStyle = style === "game" ? "game" : "table";
        _write(PICKER_KEY, _pickerStyle);
        closePicker();
        _renderChromeLabels();
    }

    // selectGun: the build area is up.
    function onGunOpen() {
        if (_supported() && _mode === "3d" && !_failedThisSession) _enter3d();
        else _leave3d();
        _renderModeToggle();
        _renderChromeLabels();
        _scheduleSync();
    }

    // returnToGunSelection: close the view and free its WebGL context.
    function onBuildLeave() {
        _leave3d({ rerender: false });
    }

    // The 2D builder's flashSlot (tree.js) after an install or removal: the same slot's box
    // sweeps green or red in the 3D view, once the build it follows is drawn.
    function flashSlot(parentNode, slotId, kind) {
        if (!isActive()) return;
        _pendingFlashes.push({ parentNode, slotId, kind: kind === "remove" ? "remove" : "install" });
        _scheduleSync();
    }

    function _flushFlashes() {
        const flashes = _pendingFlashes;
        _pendingFlashes = [];
        if (!_ready) return;
        for (const { parentNode, slotId, kind } of flashes) {
            const key = _slotKeyOf(parentNode, slotId);
            if (key) send("flashSlot", key, kind);
        }
    }

    // Our tree node and slot id as the viewer's slot key, or null.
    function _slotKeyOf(parentNode, slotId) {
        let partId = null;
        for (const [id, node] of _nodeById) if (node === parentNode) { partId = id; break; }
        if (!partId) return null;
        const itemId = parentNode === EFTForge.state.buildTree ? EFTForge.state.currentGun?.id : parentNode.item?.id;
        const slot = (EFTForge.state.slotCache[itemId] || []).find(s => s.id === slotId);
        return slot ? `${partId}/${slot.slot_game_name || slot.slot_name}` : null;
    }

    // Right-clicking a slot box empties it, as right-clicking a workbench slot does in 2D.
    function _onSlotRightClick(data) {
        const hit = _resolveSlot(data.key);
        if (!hit) return;
        if (EFTForge.state.publishMode) { _showPublishLockedToast(); return; }
        if (hit.parentNode.children[hit.slot.id]) removeAttachment(hit.parentNode, hit.slot.id);
    }

    // Our short name for a viewer part id (the panels show sights by name), or null.
    function partName(partId) {
        const node = _nodeById.get(partId);
        if (!node || node === EFTForge.state.buildTree) return null;
        return node.item?.short_name || node.item?.name || null;
    }

    function prefetch(tpl) {
        if (isActive() && _ready && tpl) send("prefetch", tpl);
    }

    window.addEventListener("message", _onMessage);
    window.addEventListener("resize", () => { if (isActive()) { _placeDock(); _sendBackdrop(); } });

    // Every build change renders the workbench (attachment-grid.js, build-preview.js
    // chain on renderFullTree); we chain on top and sync the view from there.
    (function () {
        const prev = window.renderFullTree;
        window.renderFullTree = function (preserveScroll) {
            const result = prev(preserveScroll);
            Promise.resolve(result).then(() => { if (isActive()) _scheduleSync(); }).catch(() => {});
            return result;
        };
    })();

    // Back to the orbit view from the sight picture (a build tab switch always lands there);
    // the viewer ignores it outside the sight picture.
    function leaveSight() {
        if (isActive()) send("exitSight");
    }

    EFTForge.builder3d = {
        isActive, setMode, setPickerStyle, onGunOpen, onBuildLeave, onStats, onAimSettings, onTraderLevelsChange, prefetch, closePicker,
        leaveSight,
        flashConflict, flashSlot, partName, holdLoading,
        call, send,
        get mode() { return _mode; },
        get pickerStyle() { return _pickerStyle; },
    };
})();

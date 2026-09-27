window.EFTForge = window.EFTForge || {};

// ============================================================
// 3D BUILDER PANEL OVERLAPS
//
// Where one of our panels over the 3D view covers another, the one on top shows a faint
// outline of the buried panel's edge, so neither gets lost under the other. Every panel
// counts, dragged or fixed in place; the outline is drawn inside the top panel, in its
// own stacking context, so it never shows through anything laid over that panel.
// ============================================================

(function () {
    // Each panel: the element that draws it on top of others (host), and the box whose
    // edge shows when it is the one buried (shape), with that box's corner radius.
    function _panels() {
        const out = [];
        const dock = document.getElementById("b3d-stats-dock");
        if (dock) {
            // Only the panel itself counts, never its collapse tab: the body while expanded
            // (its cards carry the edges), the handle while collapsed.
            const collapsed = dock.classList.contains("collapsed");
            const shape = dock.querySelector(collapsed ? ".b3d-dock-handle" : ".b3d-dock-body");
            if (shape) out.push({ host: dock, shape, radius: collapsed ? 0 : 8 });
        }
        for (const el of document.querySelectorAll("#b3d-hud .b3d-panel")) out.push({ host: el, shape: el });
        const picker = document.querySelector("body.builder-3d .right-panel");
        if (picker) out.push({ host: picker, shape: picker });
        const popover = document.getElementById("hidden-stats-panel");
        if (popover) out.push({ host: popover, shape: popover });
        const shown = out.filter(p => _shown(p.host) && _shown(p.shape));
        // The viewer's diagnostics dock lives inside its frame, which lies under every panel
        // of ours: it only ever gets buried, at the box the frame reports for it.
        const box = EFTForge.builder3dPanels?.diagnosticsRect?.();
        const frame = document.getElementById("b3d-frame");
        if (box && frame) {
            const f = frame.getBoundingClientRect();
            shown.push({ host: null, radius: box.radius || 0,
                rect: new DOMRect(f.left + box.left, f.top + box.top, box.right - box.left, box.bottom - box.top) });
        }
        return shown;
    }

    function _shown(el) {
        if (!el.isConnected || el.hidden) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0.05;
    }

    function _radius(p) {
        return p.radius ?? (parseFloat(getComputedStyle(p.shape).borderTopLeftRadius) || 0);
    }

    // Which of two overlapping panels is drawn on top: the first of them the browser hits
    // at the middle of their overlap. The frame's dock (no host) is always the lower one.
    function _topOf(a, b, x, y) {
        if (!a.host || !b.host) return a.host ? a : b.host ? b : null;
        for (const el of document.elementsFromPoint(x, y)) {
            if (a.shape.contains(el)) return a;
            if (b.shape.contains(el)) return b;
        }
        return null;
    }

    const _layers = new Map(); // host -> {svg, key}

    function _layer(host) {
        let entry = _layers.get(host);
        // A panel that rebuilds its contents (the tactical list, the popover) drops our layer.
        if (!entry || entry.svg.parentNode !== host) {
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("class", "b3d-overlap");
            svg.setAttribute("aria-hidden", "true");
            host.appendChild(svg);
            entry = { svg, key: "" };
            _layers.set(host, entry);
        }
        return entry;
    }

    function _clear() {
        for (const { svg } of _layers.values()) svg.remove();
        _layers.clear();
    }

    function _draw() {
        const panels = _panels();
        for (const p of panels) if (p.shape) p.rect = p.shape.getBoundingClientRect();
        const buried = new Map(); // top panel -> the panels under it
        for (let i = 0; i < panels.length; i++) {
            for (let j = i + 1; j < panels.length; j++) {
                const a = panels[i], b = panels[j];
                if (a.host && b.host && (a.host.contains(b.host) || b.host.contains(a.host))) continue;
                const left = Math.max(a.rect.left, b.rect.left), right = Math.min(a.rect.right, b.rect.right);
                const top = Math.max(a.rect.top, b.rect.top), bottom = Math.min(a.rect.bottom, b.rect.bottom);
                if (right - left < 1 || bottom - top < 1) continue;
                const upper = _topOf(a, b, (left + right) / 2, (top + bottom) / 2);
                if (!upper) continue;
                const lower = upper === a ? b : a;
                if (!buried.has(upper)) buried.set(upper, []);
                buried.get(upper).push(lower);
            }
        }
        const drawn = new Set();
        for (const [upper, lowers] of buried) {
            const host = upper.host;
            const hr = host.getBoundingClientRect();
            // The layer covers the host's padding box, and a scrolled host carries it along;
            // a panel drawn by part of its host (the dock's body) gets a layer over that part.
            let ox, oy, w, h, lx, ly, radius;
            if (upper.shape === host) {
                ox = hr.left + host.clientLeft; oy = hr.top + host.clientTop;
                w = host.clientWidth; h = host.clientHeight;
                lx = host.scrollLeft; ly = host.scrollTop;
                radius = Math.max(0, (parseFloat(getComputedStyle(host).borderTopLeftRadius) || 0) - host.clientLeft);
            } else {
                ox = upper.rect.left; oy = upper.rect.top;
                w = upper.rect.width; h = upper.rect.height;
                lx = ox - hr.left - host.clientLeft; ly = oy - hr.top - host.clientTop;
                radius = _radius(upper);
            }
            const rects = lowers.map(p => {
                const x = p.rect.left - ox + 0.5, y = p.rect.top - oy + 0.5;
                const rw = Math.max(0, p.rect.width - 1), rh = Math.max(0, p.rect.height - 1);
                return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" rx="${_radius(p)}"/>`;
            }).join("");
            const key = `${w},${h},${lx},${ly},${radius}|${rects}`;
            const entry = _layer(host);
            drawn.add(host);
            if (entry.key === key) continue;
            entry.key = key;
            const svg = entry.svg;
            svg.setAttribute("width", w);
            svg.setAttribute("height", h);
            svg.style.left = lx + "px";
            svg.style.top = ly + "px";
            svg.style.borderRadius = radius + "px";
            svg.innerHTML = rects;
        }
        for (const [host, { svg }] of _layers) {
            if (!drawn.has(host)) { svg.remove(); _layers.delete(host); }
        }
    }

    // Panels move by dragging, resizing, scrolling and content changes alike, so we look
    // every frame while the 3D view is open; nothing is written unless an outline changes.
    let _frame = 0;
    function _tick() {
        _frame = requestAnimationFrame(_tick);
        _draw();
    }

    function _sync() {
        const on = document.body.classList.contains("builder-3d");
        if (on && !_frame) _frame = requestAnimationFrame(_tick);
        if (!on && _frame) { cancelAnimationFrame(_frame); _frame = 0; _clear(); }
    }

    new MutationObserver(_sync).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    _sync();
})();

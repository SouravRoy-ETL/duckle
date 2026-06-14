/* Duckle website behavior: theme toggle, GitHub star count, mobile nav. */
(function () {
    "use strict";

    var root = document.documentElement;

    /* ---- theme toggle (persisted; default dark, set pre-paint in <head>) ---- */
    var toggle = document.getElementById("themeToggle");
    if (toggle) {
        toggle.addEventListener("click", function () {
            var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
            root.setAttribute("data-theme", next);
            try { localStorage.setItem("duckle-theme", next); } catch (e) {}
        });
    }

    /* ---- mobile nav ---- */
    var navToggle = document.getElementById("navToggle");
    var navLinks = document.getElementById("navLinks");
    if (navToggle && navLinks) {
        navToggle.addEventListener("click", function () { navLinks.classList.toggle("open"); });
        navLinks.addEventListener("click", function (e) {
            if (e.target.tagName === "A") navLinks.classList.remove("open");
        });
    }

    /* ---- GitHub star count ----
       duckdb.org renders a static build-time count; we render a "★" fallback and
       upgrade it to the live number via the public API, cached for an hour so we
       do not hammer the rate limit on every page view. */
    var REPO = "SouravRoy-ETL/duckle";
    var countEl = document.getElementById("ghCount");
    function fmt(n) {
        if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
        return String(n);
    }
    function showStars(n) {
        if (countEl) countEl.textContent = "★ " + fmt(n);
    }
    if (countEl) {
        var cached = null;
        try { cached = JSON.parse(localStorage.getItem("duckle-stars") || "null"); } catch (e) {}
        var fresh = cached && (Date.now() - cached.t < 3600000);
        if (cached && typeof cached.n === "number") showStars(cached.n);
        if (!fresh) {
            fetch("https://api.github.com/repos/" + REPO, { headers: { Accept: "application/vnd.github+json" } })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                    if (d && typeof d.stargazers_count === "number") {
                        showStars(d.stargazers_count);
                        try { localStorage.setItem("duckle-stars", JSON.stringify({ n: d.stargazers_count, t: Date.now() })); } catch (e) {}
                    }
                })
                .catch(function () { /* keep fallback */ });
        }
    }

    /* ---- dismissible announcement bar (per-version, like duckdb.org) ---- */
    var ann = document.getElementById("announce");
    var annX = document.getElementById("announceX");
    if (ann && annX) {
        var annVer = ann.getAttribute("data-v") || "1";
        try { if (localStorage.getItem("duckle-announce") === annVer) ann.style.display = "none"; } catch (e) {}
        annX.addEventListener("click", function () {
            ann.style.display = "none";
            try { localStorage.setItem("duckle-announce", annVer); } catch (e) {}
        });
    }

    /* ---- docs sidebar: mark the current page active ---- */
    var here = location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll(".docs-side a").forEach(function (a) {
        var href = (a.getAttribute("href") || "").split("/").pop();
        if (href === here) a.classList.add("active");
    });

    /* ---- "Schedule a demo" modal ----
       Static site, no backend: a date/time picker that builds a Google Calendar
       invite to the maintainer (the visitor confirms with Save), plus a mailto
       fallback. Injected once and shared by every page's header button. */
    var HOST = "souravroy7864@gmail.com";
    var schedTriggers = document.querySelectorAll(".js-schedule");
    if (schedTriggers.length) {
        var overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.hidden = true;
        overlay.innerHTML =
            '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="schedTitle">'
          + '<button class="modal-x" type="button" aria-label="Close">'
          + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>'
          + '<h3 id="schedTitle">Schedule a demo</h3>'
          + '<p class="muted">Pick a time and we will send a calendar invite - a live walkthrough of Duckle.</p>'
          + '<form id="schedForm" novalidate>'
          + '<div class="frow"><label>Date<input type="date" name="date" required></label>'
          + '<label>Time<input type="time" name="time" required></label></div>'
          + '<div class="frow"><label>Duration<select name="dur"><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60">60 minutes</option></select></label>'
          + '<label>Your name<input type="text" name="name" placeholder="Jane Doe"></label></div>'
          + '<label>Your email<input type="email" name="email" placeholder="you@company.com" required></label>'
          + '<label>What would you like to cover?<textarea name="notes" rows="3" placeholder="Your stack and what you want to see"></textarea></label>'
          + '<button type="submit" class="btn btn-primary btn-pill">Add to calendar &amp; invite</button>'
          + '<p class="modal-alt">No Google Calendar? <a href="#" id="schedMail">Email the request instead</a></p>'
          + '</form></div>';
        document.body.appendChild(overlay);

        var modal = overlay.querySelector(".modal");
        var form = overlay.querySelector("#schedForm");

        function openModal(e) {
            if (e) e.preventDefault();
            var tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
            form.date.min = new Date().toISOString().slice(0, 10);
            if (!form.date.value) form.date.value = tomorrow.toISOString().slice(0, 10);
            if (!form.time.value) form.time.value = "10:00";
            overlay.hidden = false;
            document.body.style.overflow = "hidden";
        }
        function closeModal() { overlay.hidden = true; document.body.style.overflow = ""; }

        schedTriggers.forEach(function (b) { b.addEventListener("click", openModal); });
        overlay.querySelector(".modal-x").addEventListener("click", closeModal);
        overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModal(); });
        document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !overlay.hidden) closeModal(); });

        function pad(n) { return String(n).padStart(2, "0"); }
        function z(d) {
            return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
                + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + "00Z";
        }

        form.addEventListener("submit", function (e) {
            e.preventDefault();
            if (!form.date.value || !form.time.value || !form.email.value) {
                if (form.reportValidity) form.reportValidity();
                return;
            }
            var start = new Date(form.date.value + "T" + form.time.value);
            if (isNaN(start.getTime())) return;
            var end = new Date(start.getTime() + parseInt(form.dur.value, 10) * 60000);
            var name = form.name.value.trim();
            var title = "Duckle demo" + (name ? " with " + name : "");
            var details = "Duckle demo request"
                + (name ? "\nName: " + name : "")
                + "\nEmail: " + form.email.value
                + (form.notes.value.trim() ? "\n\n" + form.notes.value.trim() : "")
                + "\n\nDuckle: https://souravroy-etl.github.io/duckle/";
            var url = "https://calendar.google.com/calendar/render?action=TEMPLATE"
                + "&text=" + encodeURIComponent(title)
                + "&dates=" + z(start) + "/" + z(end)
                + "&details=" + encodeURIComponent(details)
                + "&add=" + encodeURIComponent(HOST);
            window.open(url, "_blank", "noopener");
            modal.innerHTML =
                '<div class="modal-ok"><span class="chk">'
              + '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>'
              + '<h3>Almost there</h3>'
              + '<p class="muted">Google Calendar opened with your slot and the Duckle team invited. Press <b>Save</b> there to send it. See you soon.</p>'
              + '<button type="button" class="btn btn-primary btn-pill" id="schedDone">Done</button></div>';
            modal.querySelector("#schedDone").addEventListener("click", closeModal);
        });

        overlay.querySelector("#schedMail").addEventListener("click", function (e) {
            e.preventDefault();
            var when = (form.date.value && form.time.value) ? (form.date.value + " " + form.time.value) : "(your preferred time)";
            var body = "Hi Sourav,%0D%0A%0D%0AI would like to schedule a Duckle demo."
                + "%0D%0A%0D%0APreferred time: " + encodeURIComponent(when)
                + "%0D%0ADuration: " + encodeURIComponent(form.dur.value + " min")
                + (form.name.value ? "%0D%0AName: " + encodeURIComponent(form.name.value) : "")
                + (form.email.value ? "%0D%0AEmail: " + encodeURIComponent(form.email.value) : "")
                + (form.notes.value ? "%0D%0A%0D%0A" + encodeURIComponent(form.notes.value) : "");
            window.location.href = "mailto:" + HOST + "?subject=" + encodeURIComponent("Duckle demo request") + "&body=" + body;
        });
    }
})();

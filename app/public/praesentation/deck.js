/*
 * Partizip-Deck — Folien-Mechanik (Progressive Enhancement).
 * Ohne diese Datei bleibt die Seite eine scrollbare Folienliste.
 * Keine externen Abhängigkeiten.
 */
(function () {
  "use strict";

  var deck = document.getElementById("deck");
  var slides = Array.prototype.slice.call(
    document.querySelectorAll(".slide")
  );
  if (!deck || slides.length === 0) return;

  deck.classList.add("deck--js");

  var index = 0;

  // --- Navigations-UI aufbauen ---
  var nav = document.createElement("div");
  nav.className = "deck-nav";
  nav.setAttribute("role", "toolbar");
  nav.setAttribute("aria-label", "Folien-Navigation");

  var btnPrev = document.createElement("button");
  btnPrev.type = "button";
  btnPrev.setAttribute("aria-label", "Vorherige Folie");
  btnPrev.innerHTML = "&#8592;";

  var counter = document.createElement("span");
  counter.className = "counter";
  counter.setAttribute("aria-live", "polite");

  var btnNext = document.createElement("button");
  btnNext.type = "button";
  btnNext.setAttribute("aria-label", "Nächste Folie");
  btnNext.innerHTML = "&#8594;";

  nav.appendChild(btnPrev);
  nav.appendChild(counter);
  nav.appendChild(btnNext);

  // Fortschritts-Punkte
  var progress = document.createElement("div");
  progress.className = "deck-progress";
  progress.setAttribute("role", "tablist");
  progress.setAttribute("aria-label", "Direkt zu Folie");
  var dots = slides.map(function (s, i) {
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute(
      "aria-label",
      "Folie " + (i + 1) + (s.dataset.title ? ": " + s.dataset.title : "")
    );
    b.addEventListener("click", function () {
      go(i);
    });
    progress.appendChild(b);
    return b;
  });

  // Klick-Zonen (unsichtbar, links/rechts)
  var zonePrev = document.createElement("button");
  zonePrev.type = "button";
  zonePrev.className = "click-zone click-zone--prev";
  zonePrev.setAttribute("aria-label", "Vorherige Folie");
  var zoneNext = document.createElement("button");
  zoneNext.type = "button";
  zoneNext.className = "click-zone click-zone--next";
  zoneNext.setAttribute("aria-label", "Nächste Folie");

  // Tastatur-Hinweis
  var hint = document.createElement("div");
  hint.className = "kbd-hint";
  hint.innerHTML =
    "<kbd>&#8592;</kbd> <kbd>&#8594;</kbd> blättern · <kbd>P</kbd> drucken";

  deck.appendChild(zonePrev);
  deck.appendChild(zoneNext);
  deck.appendChild(nav);
  deck.appendChild(progress);
  deck.appendChild(hint);

  btnPrev.addEventListener("click", function () {
    go(index - 1);
  });
  btnNext.addEventListener("click", function () {
    go(index + 1);
  });
  zonePrev.addEventListener("click", function () {
    go(index - 1);
  });
  zoneNext.addEventListener("click", function () {
    go(index + 1);
  });

  function clamp(i) {
    return Math.max(0, Math.min(slides.length - 1, i));
  }

  function go(i) {
    index = clamp(i);
    slides.forEach(function (s, n) {
      var active = n === index;
      s.classList.toggle("is-active", active);
      s.setAttribute("aria-hidden", active ? "false" : "true");
    });
    dots.forEach(function (d, n) {
      d.setAttribute("aria-current", n === index ? "true" : "false");
      d.setAttribute("aria-selected", n === index ? "true" : "false");
      d.tabIndex = n === index ? 0 : -1;
    });
    counter.textContent = index + 1 + " / " + slides.length;
    btnPrev.disabled = index === 0;
    btnNext.disabled = index === slides.length - 1;
    var id = slides[index].id;
    if (id && "replaceState" in history) {
      history.replaceState(null, "", "#" + id);
    }
  }

  // --- Tastatur ---
  document.addEventListener("keydown", function (e) {
    // Nicht stören, wenn Notizen-Fokus in einem Formularfeld liegt
    var tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    switch (e.key) {
      case "ArrowRight":
      case "PageDown":
      case " ":
      case "Spacebar":
        e.preventDefault();
        go(index + 1);
        break;
      case "ArrowLeft":
      case "PageUp":
        e.preventDefault();
        go(index - 1);
        break;
      case "ArrowDown":
        e.preventDefault();
        go(index + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        go(index - 1);
        break;
      case "Home":
        e.preventDefault();
        go(0);
        break;
      case "End":
        e.preventDefault();
        go(slides.length - 1);
        break;
      case "p":
      case "P":
        e.preventDefault();
        window.print();
        break;
      default:
        break;
    }
  });

  // --- Touch-Swipe ---
  var tsx = 0,
    tsy = 0,
    tracking = false;
  deck.addEventListener(
    "touchstart",
    function (e) {
      if (e.touches.length !== 1) return;
      tsx = e.touches[0].clientX;
      tsy = e.touches[0].clientY;
      tracking = true;
    },
    { passive: true }
  );
  deck.addEventListener(
    "touchend",
    function (e) {
      if (!tracking) return;
      tracking = false;
      var t = e.changedTouches[0];
      var dx = t.clientX - tsx;
      var dy = t.clientY - tsy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        go(dx < 0 ? index + 1 : index - 1);
      }
    },
    { passive: true }
  );

  // --- Deep-Link aus Hash ---
  function fromHash() {
    var h = window.location.hash.replace("#", "");
    if (!h) return 0;
    var n = slides.findIndex(function (s) {
      return s.id === h;
    });
    return n >= 0 ? n : 0;
  }

  window.addEventListener("hashchange", function () {
    go(fromHash());
  });

  go(fromHash());
})();

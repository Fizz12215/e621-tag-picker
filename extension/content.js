// e621 Tag Picker add-on: runs on e621's own pages.
// Puts a "Tag Picker" button under e621's search bar. The button opens the
// picker (the same page as the website) in a panel on top of e621.
// "Use this search" in the picker sends the search back here, and we run it.

"use strict";

// e621 has two kinds of search bar: the one on post pages, and the big one on the home page
const searchBox = document.querySelector("section.post-search, #home-search-form .home-search");
const searchText = searchBox && searchBox.querySelector("[name=tags]");

let overlay = null; // the open panel, or null
let frame = null;   // the picker inside it

function openPicker() {
  if (overlay) return;
  const start = searchText ? searchText.value.trim() : "";
  const address = browser.runtime.getURL("picker/index.html")
    + "?embed=1&from=" + encodeURIComponent(location.origin)
    + "#q=" + encodeURIComponent(start);

  overlay = document.createElement("div");
  overlay.className = "etp-overlay";
  const panel = document.createElement("div");
  panel.className = "etp-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "e621 Tag Picker");

  const bar = document.createElement("div");
  bar.className = "etp-bar";
  const title = document.createElement("span");
  title.textContent = "e621 Tag Picker";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "etp-close";
  close.title = "Close (Esc)";
  close.textContent = "✕ Close";
  close.addEventListener("click", closePicker);
  bar.append(title, close);

  frame = document.createElement("iframe");
  frame.className = "etp-frame";
  frame.src = address;
  panel.append(bar, frame);
  overlay.append(panel);

  // Tapping the dark area around the panel closes it too
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closePicker(); });

  document.body.append(overlay);
  document.documentElement.classList.add("etp-open"); // stops e621 scrolling behind the panel
}

function closePicker() {
  if (!overlay) return;
  overlay.remove();
  overlay = frame = null;
  document.documentElement.classList.remove("etp-open");
}

// Messages from the picker. Only listen to our own panel, not anything else on the page.
window.addEventListener("message", (e) => {
  if (!frame || e.source !== frame.contentWindow) return;
  if (e.data && e.data.type === "e621-tag-picker:theme") {
    overlay.classList.toggle("etp-dark", e.data.theme === "dark");
  }
  if (e.data && e.data.type === "e621-tag-picker:use" && typeof e.data.query === "string") {
    closePicker();
    location.href = "/posts" + (e.data.query ? "?tags=" + encodeURIComponent(e.data.query) : "");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && overlay) closePicker();
});

// Only pages with one of e621's search bars get the button
if (searchBox) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "etp-button";
  button.textContent = "Tag Picker";
  button.title = "Build this search with buttons";
  button.addEventListener("click", openPicker);
  searchBox.after(button);
}

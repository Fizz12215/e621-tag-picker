// Pick the theme before the page shows, so it doesn't flash the wrong colors.
// Blue is the default; dark is used if you switched to it last time.
// (This is its own file because the Firefox add-on doesn't allow scripts inside the HTML.)
try {
  if (JSON.parse(localStorage.getItem("e621-tag-picker:theme")) === "dark") {
    document.documentElement.dataset.theme = "dark";
  }
} catch {}

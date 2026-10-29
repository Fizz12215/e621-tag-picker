// e621 Tag Picker
// Lets you pick tags and filters with buttons, then writes the e621 search text for you.
// Search rules come from https://e621.net/help/cheatsheet

"use strict";

// ============================================================
// 1. Settings and lookup tables
// ============================================================

const MAX_TAGS = 40; // e621 allows 40 tags per search (metatags count too)
const STORAGE_SAVED = "e621-tag-picker:saved";
const STORAGE_CURRENT = "e621-tag-picker:current";

// e621 asks apps to say who they are. Browsers can't change the
// "User-Agent" header, so e621 accepts this "_client" value instead.
const CLIENT_NAME = "e621-tag-picker/1.0";

// e621 gives every tag a category number
const CATEGORY_NAMES = {
  0: "general", 1: "artist", 2: "contributor", 3: "copyright",
  4: "character", 5: "species", 6: "invalid", 7: "meta", 8: "lore",
};

const FILE_TYPES = ["jpg", "png", "gif", "webp", "mp4", "webm", "swf"];
const FILE_TYPE_NAMES = {
  jpg: "JPG", png: "PNG", gif: "GIF", webp: "WebP", mp4: "MP4", webm: "WebM", swf: "Flash",
};
const RATING_NAMES = { s: "Safe", q: "Questionable", e: "Explicit" };

const DATE_WORDS = {
  today: "uploaded today",
  week: "uploaded in the last 7 days",
  month: "uploaded in the last 30 days",
  year: "uploaded in the last year",
  yesterweek: "uploaded last week",
  yestermonth: "uploaded last month",
  yesteryear: "uploaded last year",
};

const STATUS_WORDS = {
  pending: "waiting for approval",
  flagged: "flagged for deletion",
  deleted: "that have been deleted",
  any: "including deleted ones",
};

// ============================================================
// 2. The current search
// ============================================================

// Each tag is stored as { name: "wolf", category: 5 }.
// category is null when we don't know it (for example, a tag typed with no suggestions).
const state = {
  must: [],
  anyGroups: [newGroup()], // a list of groups (see newGroup below)
  exclude: [],
};

// A group holds its tags, and whether posts may have "only one" of them
function newGroup(tags = [], onlyOne = false) {
  return { tags, onlyOne };
}

// Remembers the category of every tag we've seen in suggestions
const knownCategories = new Map();

// ============================================================
// 3. Small helpers
// ============================================================

const $ = (selector) => document.querySelector(selector);

// Turns what the user typed into a proper tag: "Red Panda" -> "red_panda"
function cleanTag(text) {
  return text.trim().toLowerCase().replace(/\s+/g, "_").replace(/^[-~]+/, "");
}

// Usernames, pool names and so on also use underscores instead of spaces
function cleanName(text) {
  return text.trim().replace(/\s+/g, "_");
}

// 1675471 -> "1.7M", 7391 -> "7.4k"
function shortNumber(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

// ["a", "b", "c"] -> "a, b and c" (or "a, b or c")
function joinWords(items, word) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " " + word + " " + items[items.length - 1];
}

// Builds e621's range text: (10, "") -> ">=10", ("", 5) -> "<=5", (1, 5) -> "1..5"
function rangeText(min, max) {
  if (min !== "" && max !== "") return min === max ? min : `${min}..${max}`;
  if (min !== "") return `>=${min}`;
  if (max !== "") return `<=${max}`;
  return null;
}

// The plain-English version of a range
function rangeWords(min, max) {
  if (min !== "" && max !== "") return min === max ? `exactly ${min}` : `between ${min} and ${max}`;
  if (min !== "") return `at least ${min}`;
  if (max !== "") return `at most ${max}`;
  return null;
}

function describeTag(name) {
  return name.includes("*") ? `anything matching ${name}` : name;
}

let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// localStorage can be turned off or full, so every use is wrapped in try/catch
function storageGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// 4. Tag suggestions from e621
// ============================================================

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every request to e621 goes through here. Requests wait in line, with a short
// gap between them, to stay under e621's limit of 2 requests per second.
// "urgent" requests (ones you're waiting to see, like suggestions) skip to the front.
const requestLine = [];
let lineRunning = false;
let lastRequestAt = 0;

function apiGet(path, params, { urgent = false } = {}) {
  const url = "https://e621.net" + path + "?"
    + new URLSearchParams({ ...params, _client: CLIENT_NAME });
  return new Promise((resolve, reject) => {
    const job = { url, resolve, reject };
    if (urgent) requestLine.unshift(job);
    else requestLine.push(job);
    runLine();
  });
}

async function runLine() {
  if (lineRunning) return;
  lineRunning = true;
  while (requestLine.length) {
    const job = requestLine.shift();
    const gap = Date.now() - lastRequestAt;
    if (gap < 600) await wait(600 - gap);
    lastRequestAt = Date.now();
    try {
      const response = await fetch(job.url);
      const data = await response.json().catch(() => ({}));
      // e621 explains what went wrong in "message", like "You cannot search for more than 40 tags"
      if (!response.ok) throw new Error(data.message || "e621 answered " + response.status);
      // e621 answers {} for "nothing found" on some pages, and {posts: [...]} for posts
      job.resolve(Array.isArray(data) ? data : data.posts || []);
    } catch (error) {
      job.reject(error); // one failed request shouldn't block the rest
    }
  }
  lineRunning = false;
}

const suggestionCache = new Map(); // "wol" -> list of results, so we never ask twice

async function fetchSuggestions(term) {
  if (suggestionCache.has(term)) return suggestionCache.get(term);
  const results = await apiGet("/tags/autocomplete.json", { "search[name_matches]": term, expiry: 7 }, { urgent: true });
  for (const tag of results) knownCategories.set(tag.name, tag.category);
  suggestionCache.set(term, results);
  return results;
}

// ============================================================
// 4b. Tag families (e621 calls these "implications")
// ============================================================
// Some tags automatically add others: every "wolf" post is also tagged
// "canis", which adds "canine", which adds "canid", which adds "mammal".

const parentsOf = new Map();  // "wolf" -> ["canis"]: the tags it adds directly
const childrenOf = new Map(); // "canine" -> [{ name, post_count, category }]: its direct sub-types
let familyLoading = false;
let familyFailed = false;

// Wildcards and metatags (like score:>5) have no family
const hasFamily = (name) => !name.includes("*") && !name.includes(":");

// Looks up the full chain of parents for these tags, one level at a time,
// asking about up to 40 tags per request.
async function loadParents(names, options) {
  let todo = [...new Set(names)].filter((n) => hasFamily(n) && !parentsOf.has(n));
  while (todo.length) {
    const found = new Set();
    for (let i = 0; i < todo.length; i += 40) {
      const chunk = todo.slice(i, i + 40);
      const rows = await apiGet("/tag_implications.json", {
        "search[antecedent_name]": chunk.join(","),
        "search[status]": "active",
        limit: 320,
      }, options);
      for (const name of chunk) parentsOf.set(name, []);
      for (const row of rows) {
        parentsOf.get(row.antecedent_name)?.push(row.consequent_name);
        found.add(row.consequent_name);
      }
    }
    todo = [...found].filter((n) => !parentsOf.has(n));
  }
}

// Looks up a tag's direct sub-types, sorted with the most popular first
async function loadChildren(name) {
  if (childrenOf.has(name)) return childrenOf.get(name);
  const rows = await apiGet("/tag_implications.json", {
    "search[consequent_name]": name,
    "search[status]": "active",
    limit: 320,
  }, { urgent: true });
  const names = rows.map((row) => row.antecedent_name);
  const children = [];
  for (let i = 0; i < names.length; i += 100) {
    const tags = await apiGet("/tags.json", { "search[name]": names.slice(i, i + 100).join(","), limit: 320 }, { urgent: true });
    for (const t of tags) {
      children.push({ name: t.name, post_count: t.post_count, category: t.category });
      knownCategories.set(t.name, t.category);
    }
  }
  children.sort((a, b) => b.post_count - a.post_count);
  childrenOf.set(name, children);
  return children;
}

// Tags typed by hand (not picked from suggestions) might be an old name that
// e621 swaps for another, like "dog" -> "domestic_dog". This looks them up,
// switches to the real name, and fills in the category (for the chip color).
async function resolveTags(tags) {
  const todo = tags.filter((t) => hasFamily(t.name) && t.category == null);
  if (!todo.length) return;
  const names = [...new Set(todo.map((t) => t.name))];
  const renamed = new Map();
  try {
    for (let i = 0; i < names.length; i += 40) {
      const rows = await apiGet("/tag_aliases.json", {
        "search[antecedent_name]": names.slice(i, i + 40).join(","),
        "search[status]": "active",
        limit: 320,
      }, { urgent: true });
      for (const row of rows) renamed.set(row.antecedent_name, row.consequent_name);
    }
    const realNames = [...new Set(names.map((n) => renamed.get(n) || n))].filter((n) => !knownCategories.has(n));
    for (let i = 0; i < realNames.length; i += 100) {
      const found = await apiGet("/tags.json", { "search[name]": realNames.slice(i, i + 100).join(","), limit: 320 }, { urgent: true });
      for (const t of found) knownCategories.set(t.name, t.category);
    }
  } catch {
    return; // e621 couldn't be reached: keep the tags as they were typed
  }

  const swaps = new Set();
  const missing = new Set();
  for (const tag of todo) {
    const real = renamed.get(tag.name);
    if (real) {
      swaps.add(`${tag.name} → ${real}`);
      tag.name = real;
    }
    tag.category = knownCategories.get(tag.name) ?? null;
    if (tag.category == null) missing.add(tag.name);
  }
  if (swaps.size) toast(`Switched to e621's name: ${[...swaps].join(", ")}`);
  else if (missing.size) toast(`e621 has no tag called ${joinWords([...missing], "or")}. Check the spelling?`);

  // A rename can create a double (dog -> domestic_dog when domestic_dog is already there)
  for (const list of [state.must, state.exclude, ...state.anyGroups.map((g) => g.tags)]) {
    const seen = new Set();
    for (let i = 0; i < list.length;) {
      if (seen.has(list[i].name)) {
        list.splice(i, 1); // keep the first one, remove later copies
      } else {
        seen.add(list[i].name);
        i++;
      }
    }
  }
  document.querySelectorAll(".tagbox").forEach((box) => box.redrawChips?.());
  update();
}

// Every tag that `name` adds automatically, with how many steps away it is.
// ancestorsOf("wolf") -> canis: 1, canine: 2, canid: 3, mammal: 4
function ancestorsOf(name) {
  const steps = new Map();
  let level = [name];
  for (let step = 1; level.length; step++) {
    const next = [];
    for (const n of level) {
      for (const parent of parentsOf.get(n) || []) {
        if (parent !== name && !steps.has(parent)) {
          steps.set(parent, step);
          next.push(parent);
        }
      }
    }
    level = next;
  }
  return steps;
}

// true when every `a` post is automatically also tagged `b`
const implies = (a, b) => ancestorsOf(a).has(b);

// The closest tag that all of these tags add, like wolf + fox -> canine.
// Only counts if it's at most 2 steps up from every tag, so we don't
// suggest something huge like "mammal" for wolf + tiger.
function sharedParent(names) {
  const maps = names.map(ancestorsOf);
  let best = null;
  let bestSteps = Infinity;
  for (const [parent] of maps[0] || []) {
    if (!maps.every((m) => m.has(parent))) continue;
    const steps = Math.max(...maps.map((m) => m.get(parent)));
    if (steps < bestSteps) {
      best = parent;
      bestSteps = steps;
    }
  }
  return bestSteps <= 2 ? best : null;
}

function allTagNames() {
  return [...state.must, ...state.exclude, ...state.anyGroups.flatMap((g) => g.tags)].map((t) => t.name);
}

let familyRetryAt = 0; // after a failure, wait a bit before asking e621 again

// Runs after every change: fetches families for any new tags, then redraws
function checkFamilies() {
  if (familyLoading || Date.now() < familyRetryAt) return;
  const missing = allTagNames().filter((n) => hasFamily(n) && !parentsOf.has(n));
  if (!missing.length) {
    familyFailed = false;
    return;
  }

  familyLoading = true;
  loadParents(missing)
    .then(() => { familyFailed = false; })
    .catch(() => {
      familyFailed = true;
      familyRetryAt = Date.now() + 30000;
      setTimeout(update, 30500); // try again by itself in 30 seconds
    })
    .finally(() => {
      familyLoading = false;
      update();
    });
}

// ============================================================
// 5. Tag box: chips + a text box + a suggestions list
// ============================================================

// `list` is the array this box adds tags to (for example state.must).
function createTagBox(list, { placeholder, allowWildcard, isExclude = false }) {
  // The box is a small form: phone keyboards always "submit" a form when you
  // press Enter / Go, even when they'd otherwise jump to the next text box.
  const box = document.createElement("form");
  box.className = "tagbox";
  box.addEventListener("submit", (e) => {
    e.preventDefault(); // don't reload the page
    submitTag();
  });

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.autocapitalize = "none";             // phones: don't start tags with a capital letter
  input.setAttribute("enterkeyhint", "enter"); // phones: show an Enter key, not "Next"

  const suggestList = document.createElement("ul");
  suggestList.className = "suggest";
  suggestList.hidden = true;

  box.append(input, suggestList);
  box.addEventListener("click", (e) => {
    if (e.target === box) input.focus();
  });

  let suggestions = [];
  let activeIndex = -1;
  let typingTimer;

  function drawChips() {
    // The "e.g. wolf" example only shows while the box is empty
    input.placeholder = list.length ? "" : placeholder;
    box.querySelectorAll(".chip").forEach((chip) => chip.remove());
    list.forEach((tag, index) => {
      const chip = document.createElement("span");
      const isWild = tag.name.includes("*");
      chip.className = "chip " + (isWild ? "cat-wild" : tag.category != null ? "cat-" + tag.category : "cat-unknown");
      chip.title = isWild ? "wildcard" : CATEGORY_NAMES[tag.category] || "tag";

      // Clicking the name opens the family pop-up (not for wildcards or metatags)
      const label = document.createElement(hasFamily(tag.name) ? "button" : "span");
      label.textContent = tag.name;
      if (hasFamily(tag.name)) {
        label.type = "button";
        label.className = "chip-label";
        label.title = "Click to see this tag's family";
        label.addEventListener("click", (e) => {
          e.stopPropagation(); // don't let the page-wide "close pop-ups" click run
          openFamilyPopup(tag.name, label, !isExclude);
        });
      }

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Remove " + tag.name);
      remove.addEventListener("click", () => {
        list.splice(index, 1);
        drawChips();
        update();
        input.focus();
      });

      chip.append(label, remove);
      box.insertBefore(chip, input);
    });
  }

  function addTag(text, category) {
    const name = cleanTag(text);
    if (!name) return;
    if (name.includes("*") && name.replace(/\*/g, "") === "") {
      toast("A wildcard needs some letters too, like african_*");
      return;
    }

    // A "-" in front means "not", so that tag belongs in the Exclude box
    if (!isExclude && text.trim().startsWith("-")) {
      input.value = "";
      hideSuggestions();
      if (state.exclude.some((t) => t.name === name)) {
        toast(name + " is already in Exclude");
      } else {
        addToExclude(name, category ?? knownCategories.get(name) ?? null);
        toast(`Moved ${name} to Exclude ("-" means "not")`);
      }
      return;
    }

    if (name.includes("*") && !allowWildcard) {
      toast("Wildcards (*) can't go in an \"Any of these\" group. e621 can't handle that.");
      return;
    }
    if (list.some((tag) => tag.name === name)) {
      toast(name + " is already in this box");
      return;
    }
    const tag = { name, category: category ?? knownCategories.get(name) ?? null };
    list.push(tag);
    input.value = "";
    hideSuggestions();
    drawChips();
    update();
    resolveTags([tag]); // check the name with e621 if it was typed by hand
  }

  function hideSuggestions() {
    suggestList.hidden = true;
    suggestions = [];
    activeIndex = -1;
  }

  function showStatus(message) {
    suggestList.replaceChildren();
    const li = document.createElement("li");
    li.className = "status";
    li.textContent = message;
    suggestList.append(li);
    suggestList.hidden = false;
  }

  function drawSuggestions() {
    suggestList.replaceChildren();
    if (suggestions.length === 0) {
      showStatus("No tags found. Press Enter to add it anyway.");
      return;
    }
    suggestions.forEach((tag, index) => {
      const li = document.createElement("li");
      if (index === activeIndex) li.classList.add("active");

      const left = document.createElement("span");
      const name = document.createElement("span");
      name.className = "cat-" + tag.category;
      name.textContent = tag.name;
      left.append(name);
      if (tag.antecedent_name) {
        // You typed an old/other name that e621 swaps for this tag
        const alias = document.createElement("span");
        alias.className = "alias";
        alias.textContent = "  ← " + tag.antecedent_name;
        left.append(alias);
      }

      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = (CATEGORY_NAMES[tag.category] || "") + " · " + shortNumber(tag.post_count);

      li.append(left, meta);
      // mousedown (not click) so the text box doesn't lose focus first
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        addTag(tag.name, tag.category);
      });
      suggestList.append(li);
    });
    suggestList.hidden = false;
    suggestList.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  async function lookUp() {
    const term = cleanTag(input.value);
    if (term.length < 3 || term.includes("*")) {
      hideSuggestions();
      return;
    }
    showStatus("Searching e621…");
    try {
      const results = await fetchSuggestions(term);
      // Ignore old answers if the user kept typing
      if (cleanTag(input.value) !== term) return;
      suggestions = results;
      activeIndex = -1;
      drawSuggestions();
    } catch {
      if (cleanTag(input.value) !== term) return;
      showStatus("Couldn't reach e621 for suggestions. You can still type tags and press Enter.");
    }
  }

  input.addEventListener("input", () => {
    clearTimeout(typingTimer);
    // Wait until the user pauses typing before asking e621
    typingTimer = setTimeout(lookUp, 300);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && suggestions.length) {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % suggestions.length;
      drawSuggestions();
    } else if (e.key === "ArrowUp" && suggestions.length) {
      e.preventDefault();
      activeIndex = activeIndex <= 0 ? suggestions.length - 1 : activeIndex - 1;
      drawSuggestions();
    } else if (e.key === "Enter") {
      e.preventDefault(); // handled here, so the form doesn't also submit
      submitTag();
    } else if (e.key === "Escape") {
      hideSuggestions();
    } else if (e.key === "Backspace" && input.value === "" && list.length) {
      list.pop();
      drawChips();
      update();
    }
  });

  input.addEventListener("blur", () => {
    clearTimeout(typingTimer);
    hideSuggestions();
  });

  // Enter: add the highlighted suggestion, or else what was typed
  function submitTag() {
    clearTimeout(typingTimer);
    if (activeIndex >= 0) {
      const tag = suggestions[activeIndex];
      addTag(tag.name, tag.category);
    } else {
      addTag(input.value);
    }
  }

  drawChips();
  box.redrawChips = drawChips; // lets the family pop-up add chips to the Exclude box
  return box;
}

// ============================================================
// 6. Drawing the tag boxes
// ============================================================

function drawGroups() {
  const host = $("#any-groups");
  host.replaceChildren();

  state.anyGroups.forEach((group, index) => {
    const wrap = document.createElement("div");
    wrap.className = "group";

    const head = document.createElement("div");
    head.className = "group-head";

    const title = document.createElement("span");
    title.textContent = "Group " + (index + 1);

    // "Only one" means: a post may have one of these tags, but not two or more
    const onlyOne = document.createElement("label");
    onlyOne.className = "only-one";
    onlyOne.title = "Posts may have one of these tags, but not two or more";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = group.onlyOne;
    check.addEventListener("change", () => {
      group.onlyOne = check.checked;
      update();
    });
    onlyOne.append(check, " Only one");

    const help = document.createElement("button");
    help.type = "button";
    help.className = "help";
    help.textContent = "?";
    help.setAttribute("aria-label", "What does Only one mean?");
    help.setAttribute("aria-expanded", "false");
    help.addEventListener("click", (e) => {
      e.stopPropagation(); // don't let the page-wide "click elsewhere" close it right away
      const opening = !note.dataset.forceOpen;
      closeHelpNotes(); // only one help note open at a time
      if (opening) {
        note.dataset.forceOpen = "yes";
        help.setAttribute("aria-expanded", "true");
      }
      updateGroupNotes();
    });

    const left = document.createElement("div");
    left.className = "group-left";
    left.append(title, onlyOne, help);
    head.append(left);

    if (state.anyGroups.length > 1) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove group";
      remove.addEventListener("click", () => {
        state.anyGroups.splice(index, 1);
        drawGroups();
        update();
      });
      head.append(remove);
    }
    wrap.append(head);

    wrap.append(createTagBox(group.tags, {
      placeholder: index === 0 ? "e.g. fox, then dog" : "another set of choices",
      allowWildcard: false,
    }));

    // Explanation under the box (filled in by updateGroupNotes)
    const note = document.createElement("div");
    note.className = "group-note";
    note.addEventListener("click", (e) => e.stopPropagation()); // clicking inside the note keeps it open
    groupNotes.set(group, note);

    // Tips about tag families (filled in by updateGroupNotes)
    const tips = document.createElement("div");
    tips.className = "group-tips";
    groupTips.set(group, tips);

    wrap.append(note, tips);

    host.append(wrap);
  });
  updateGroupNotes();
}

const groupNotes = new WeakMap(); // group -> its explanation box
const groupTips = new WeakMap();  // group -> its tag-family tips box

function removeFromGroup(group, name) {
  group.tags.splice(group.tags.findIndex((t) => t.name === name), 1);
  drawGroups();
  update();
}

// Tips that use tag families: warnings for "Only one", and shortcuts for normal groups
function drawGroupTips(group) {
  const box = groupTips.get(group);
  if (!box) return;
  box.replaceChildren();

  const addTip = (kind, text, buttons = []) => {
    const tip = document.createElement("div");
    tip.className = "tip " + kind;
    tip.append(Object.assign(document.createElement("span"), { textContent: text }));
    for (const [label, action] of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", action);
      tip.append(button);
    }
    box.append(tip);
  };

  const names = group.tags.map((t) => t.name);
  // Pairs where every `a` post is automatically also tagged `b`
  const pairs = [];
  for (const a of names) for (const b of names) if (a !== b && implies(a, b)) pairs.push([a, b]);

  if (group.onlyOne) {
    for (const [a, b] of pairs) {
      addTip("bad",
        `⚠️ Every ${a} post is automatically also tagged ${b}. That's 2 tags from this group, `
        + `so "Only one" will hide every ${a} post.`,
        [[`Remove ${a}`, () => removeFromGroup(group, a)], [`Remove ${b}`, () => removeFromGroup(group, b)]]);
    }
    return;
  }

  for (const [a, b] of pairs) {
    addTip("info", `💡 ${a} isn't needed here: ${b} already includes every ${a} post.`,
      [[`Remove ${a}`, () => removeFromGroup(group, a)]]);
  }
  if (!pairs.length && names.length >= 2) {
    const parent = sharedParent(names);
    if (parent) {
      addTip("info",
        `💡 These are all types of ${parent}. Searching ${parent} instead finds all of them, `
        + `plus other kinds of ${parent} you didn't list, and uses fewer tags.`,
        [[`Replace with ${parent}`, () => {
          const category = knownCategories.get(parent) ?? group.tags[0].category;
          group.tags.splice(0, group.tags.length, { name: parent, category });
          drawGroups();
          update();
        }]]);
    }
  }
}

// The explanation shows when "Only one" is ticked, or when "?" is clicked
function updateGroupNotes() {
  for (const group of state.anyGroups) {
    drawGroupTips(group);
    const note = groupNotes.get(group);
    if (!note) continue;
    const show = group.onlyOne || note.dataset.forceOpen;
    note.hidden = !show;
    if (!show) continue;

    const n = group.tags.length;
    const names = group.tags.map((t) => t.name);
    const lines = [];
    lines.push(
      "Only one: posts must have exactly one of these tags. "
      + "A post with two or more of them is hidden.",
    );
    if (n >= 2) {
      const example = n >= 3
        ? `A post tagged ${names[0]} shows up, but one tagged both ${names[0]} and ${names[1]} doesn't.`
        : `A post tagged ${names[0]} or ${names[1]} shows up, but one tagged both doesn't.`;
      lines.push(example);
      const extra = n - 1 + (n * (n - 1)) / 2;
      lines.push(`This adds ${extra} to your tag count (e621 allows 40 in total), so up to about 8 tags per group fit.`);
    } else {
      lines.push("Add at least 2 tags for this to do anything.");
    }
    if (!group.onlyOne) lines.push("Tick the box to turn it on.");
    note.textContent = lines.join(" ");
  }
}

function drawAllTagBoxes() {
  $("#must-box").replaceChildren(createTagBox(state.must, {
    placeholder: "e.g. wolf",
    allowWildcard: true,
  }));
  excludeBox = createTagBox(state.exclude, {
    placeholder: "e.g. human",
    allowWildcard: true,
    isExclude: true,
  });
  $("#exclude-box").replaceChildren(excludeBox);
  drawGroups();
}

let excludeBox;

// Adds a tag to the Exclude box, or takes it out again if it's already there
function toggleExclude(name, category) {
  const index = state.exclude.findIndex((t) => t.name === name);
  if (index >= 0) {
    state.exclude.splice(index, 1);
    excludeBox.redrawChips();
    update();
  } else {
    addToExclude(name, category);
  }
}

function addToExclude(name, category) {
  const tag = { name, category };
  state.exclude.push(tag);
  excludeBox.redrawChips();
  update();
  resolveTags([tag]);
}

// ============================================================
// 6b. The family pop-up (opens when you click a tag's name)
// ============================================================

const popup = document.createElement("div");
popup.className = "family-popup";
popup.hidden = true;
popup.addEventListener("click", (e) => e.stopPropagation()); // clicks inside don't close it
document.body.append(popup);

let popupInfo = null; // { name, canExclude, children } for the open pop-up

function closePopup() {
  popup.hidden = true;
  popupInfo = null;
}

async function openFamilyPopup(name, anchor, canExclude) {
  if (popupInfo?.name === name && !popup.hidden) {
    closePopup(); // clicking the same tag again closes it
    return;
  }
  popupInfo = { name, canExclude, children: null };
  popup.replaceChildren(Object.assign(document.createElement("p"), {
    className: "popup-loading",
    textContent: "Looking up " + name + "'s family on e621…",
  }));
  popup.hidden = false;

  // Place it under the tag, but keep it inside the window
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - 32);
  popup.style.width = width + "px";
  popup.style.top = rect.bottom + window.scrollY + 6 + "px";
  popup.style.left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)) + window.scrollX + "px";

  try {
    await loadParents([name], { urgent: true });
    const children = await loadChildren(name);
    if (popupInfo?.name !== name) return; // a different pop-up was opened meanwhile
    popupInfo.children = children;
    drawPopup();
  } catch {
    if (popupInfo?.name !== name) return;
    popup.querySelector(".popup-loading").textContent = "Couldn't reach e621 to look this up. Try again in a moment.";
  }
}

function drawPopup() {
  const { name, canExclude, children } = popupInfo;
  const make = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text });
  popup.replaceChildren();

  const category = knownCategories.get(name);
  const title = make("h4", "", name);
  if (category != null) title.append(make("span", "popup-cat", " " + CATEGORY_NAMES[category]));
  popup.append(title);

  // Top half: what this tag adds automatically
  popup.append(make("h5", "", "Automatically includes"));
  const ancestors = [...ancestorsOf(name)].sort((a, b) => a[1] - b[1]).map(([n]) => n);
  if (ancestors.length) {
    popup.append(make("p", "chain", name + " → " + ancestors.join(" → ")));
    popup.append(make("p", "popup-hint", `Every ${name} post is automatically tagged with these too.`));
  } else {
    popup.append(make("p", "popup-hint", "Nothing. This tag doesn't add any other tags."));
  }

  // Bottom half: its sub-types, each with an Exclude button
  popup.append(make("h5", "", `Types of ${name}` + (children.length ? ` (${children.length})` : "")));
  if (!children.length) {
    popup.append(make("p", "popup-hint", "None. No other tags automatically add this one."));
    return;
  }
  popup.append(make("p", "popup-hint", canExclude
    ? `Searching ${name} includes all of these. Exclude one to leave it out, like ${name} -${children[0].name}.`
    : `Searching ${name} includes all of these.`));

  const list = make("ul", "kids", "");
  for (const child of children) {
    const li = document.createElement("li");
    li.append(make("span", "cat-" + child.category, child.name), make("span", "count", shortNumber(child.post_count)));
    if (canExclude) {
      const excluded = state.exclude.some((t) => t.name === child.name);
      const button = make("button", excluded ? "excluded" : "", excluded ? "Excluded ✓" : "Exclude");
      button.type = "button";
      button.title = excluded ? "Click to stop excluding it" : `Hide ${child.name} posts`;
      button.addEventListener("click", () => {
        toggleExclude(child.name, child.category);
        drawPopup();
      });
      li.append(button);
    }
    list.append(li);
  }
  popup.append(list);
}

document.addEventListener("click", closePopup);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePopup();
});

// ============================================================
// 7. Filters (every input with a data-key attribute)
// ============================================================

const filterInputs = document.querySelectorAll("[data-key]");

function getFilters() {
  const filters = {};
  filterInputs.forEach((el) => {
    filters[el.dataset.key] = el.type === "checkbox" ? el.checked : el.value.trim();
  });
  return filters;
}

function setFilters(filters = {}) {
  filterInputs.forEach((el) => {
    const value = filters[el.dataset.key];
    if (el.type === "checkbox") el.checked = Boolean(value);
    else el.value = value ?? "";
  });
  showCustomDates();
  drawTypeButtons();
}

// File types have 3 states: "" (don't care), "yes" (want it) or "no" (exclude it).
// Older saves stored true for "want it".
function typeState(filters, type) {
  const value = filters["type_" + type];
  if (value === true || value === "true" || value === "yes") return "yes";
  return value === "no" ? "no" : "";
}

const TYPE_NEXT = { "": "yes", yes: "no", no: "" }; // what each click changes it to
const typeInput = (type) => $(`[data-key="type_${type}"]`);

function drawTypeButtons() {
  const f = getFilters();
  document.querySelectorAll(".tri").forEach((button) => {
    const type = button.dataset.type;
    const state = typeState(f, type);
    const name = FILE_TYPE_NAMES[type];
    button.className = "tri " + state;
    button.textContent = (state === "yes" ? "✓ " : state === "no" ? "✕ " : "") + name;
    button.title = state === "yes" ? `Wanted. Click to exclude ${name} instead`
      : state === "no" ? `Excluded. Click to clear`
        : `Click to want ${name}`;
  });
  // A row button looks wanted/excluded only when every type in its row is
  document.querySelectorAll(".tri-group").forEach((button) => {
    const states = TYPE_GROUPS[button.dataset.group].map((t) => typeState(f, t));
    const all = states.every((s) => s === states[0]) ? states[0] : "";
    const name = button.dataset.group === "pictures" ? "Pictures" : "Animations";
    button.className = "tri-group " + all;
    button.textContent = (all === "yes" ? "✓ " : all === "no" ? "✕ " : "") + name;
    button.title = all === "yes" ? `Click to exclude all ${name.toLowerCase()}`
      : all === "no" ? "Click to clear the whole row"
        : `Click to want every ${name.toLowerCase().slice(0, -1)} type`; // "picture" / "animation"
  });
}

// The "Pictures" and "Animations" buttons change their whole row at once
const TYPE_GROUPS = { pictures: ["jpg", "png", "webp"], animations: ["gif", "mp4", "webm"] };

document.querySelectorAll(".tri").forEach((button) => {
  button.addEventListener("click", () => {
    const input = typeInput(button.dataset.type);
    input.value = TYPE_NEXT[typeState({ ["type_" + button.dataset.type]: input.value }, button.dataset.type)];
    drawTypeButtons();
    update();
  });
});

document.querySelectorAll(".tri-group").forEach((button) => {
  button.addEventListener("click", () => {
    const f = getFilters();
    const types = TYPE_GROUPS[button.dataset.group];
    const states = types.map((t) => typeState(f, t));
    // Same cycle as a single type: all wanted -> all excluded -> all cleared -> all wanted
    const next = states.every((s) => s === "yes") ? "no" : states.every((s) => s === "no") ? "" : "yes";
    for (const t of types) typeInput(t).value = next;
    drawTypeButtons();
    update();
  });
});

function showCustomDates() {
  $("#custom-dates").hidden = $("#date").value !== "custom";
}

// ============================================================
// 8. Building the search text and the explanation
// ============================================================

function buildSearch() {
  const f = getFilters();
  const parts = [];    // pieces of the search text
  const details = [];  // plain-English pieces about filters
  const warnings = []; // { text, bad }
  let count = 0;

  const add = (text, tagsUsed = 1) => {
    parts.push(text);
    count += tagsUsed;
  };

  // ---- Tags ----
  const must = state.must.map((t) => t.name);
  const exclude = state.exclude.map((t) => t.name);
  const groups = state.anyGroups
    .filter((g) => g.tags.length)
    .map((g) => ({ names: g.tags.map((t) => t.name), onlyOne: g.onlyOne }));

  // A group with only one tag is just a "must have" tag
  const required = [...must];
  for (const g of groups) {
    if (g.names.length === 1 && !required.includes(g.names[0])) required.push(g.names[0]);
  }
  const orGroups = groups.filter((g) => g.names.length > 1);

  // ---- File type ----
  // Wanted types: pick whichever way is shorter: "type:png", "-type:swf ...", or "( ~type:jpg ~type:png )".
  // Excluded types only matter when no types are wanted (wanting PNG already leaves out everything else).
  const types = FILE_TYPES.filter((t) => typeState(f, t) === "yes");
  const notTypes = FILE_TYPES.filter((t) => typeState(f, t) === "no");
  const typeTags = [];
  let typeOrGroup = null;
  if (types.length === 1) {
    typeTags.push("type:" + types[0]);
  } else if (types.length > 1 && types.length < FILE_TYPES.length) {
    const notPicked = FILE_TYPES.filter((t) => !types.includes(t));
    if (notPicked.length <= types.length) notPicked.forEach((t) => typeTags.push("-type:" + t));
    else typeOrGroup = types.map((t) => "type:" + t);
  } else if (!types.length) {
    notTypes.forEach((t) => typeTags.push("-type:" + t));
  }

  // ~ groups need ( brackets ) when there's more than one of them
  const allOrGroups = [...orGroups.map((g) => g.names), ...(typeOrGroup ? [typeOrGroup] : [])];
  const useBrackets = allOrGroups.length > 1;

  required.forEach((t) => add(t));
  for (const g of allOrGroups) {
    const inner = g.map((t) => "~" + t).join(" ");
    // e621 needs a space after "(" and before ")"
    add(useBrackets ? `( ${inner} )` : inner, g.length);
  }

  // "Only one": for each tag, rule out that tag together with any tag after it.
  // wolf, fox, tiger -> -( wolf ~fox ~tiger ) -( fox tiger )
  // (Writing every pair as its own -( a b ) hits an e621 bug once there are 6 or more of them.)
  for (const g of orGroups) {
    if (!g.onlyOne) continue;
    g.names.slice(0, -1).forEach((name, i) => {
      const rest = g.names.slice(i + 1);
      const others = rest.length === 1 ? rest[0] : rest.map((t) => "~" + t).join(" ");
      add(`-( ${name} ${others} )`, 1 + rest.length);
    });
  }
  exclude.forEach((t) => add("-" + t));

  // ---- Rating ----
  const ratings = ["s", "q", "e"].filter((r) => f["rating_" + r]);
  if (ratings.length === 1) {
    add("rating:" + ratings[0]);
  } else if (ratings.length === 2) {
    // "Safe or Questionable" is the same as "not Explicit"
    add("-rating:" + ["s", "q", "e"].find((r) => !ratings.includes(r)));
  }
  if (ratings.length === 1 || ratings.length === 2) {
    details.push("rated " + joinWords(ratings.map((r) => RATING_NAMES[r]), "or"));
  }

  typeTags.forEach((t) => add(t));
  if (types.length && types.length < FILE_TYPES.length) {
    details.push("that are " + joinWords(types.map((t) => FILE_TYPE_NAMES[t]), "or") + " files");
  } else if (!types.length && notTypes.length) {
    details.push("that aren't " + joinWords(notTypes.map((t) => FILE_TYPE_NAMES[t]), "or") + " files");
  }
  if (!types.length && notTypes.length === FILE_TYPES.length - 1) { // every type that has a button (all but Flash)
    warnings.push({ text: "Every file type is excluded, so only old Flash posts will show up." });
  }

  // ---- Number ranges ----
  const ranges = [
    ["score", "score", (w) => `with a score of ${w}`],
    ["favs", "favcount", (w) => `with ${w} favorites`],
    ["width", "width", (w) => `${w} pixels wide`],
    ["height", "height", (w) => `${w} pixels tall`],
    ["duration", "duration", (w) => `${w} seconds long`],
  ];
  for (const [key, metatag, sentence] of ranges) {
    const min = f[key + "_min"];
    const max = f[key + "_max"];
    const text = rangeText(min, max);
    if (!text) continue;
    add(`${metatag}:${text}`);
    details.push(sentence(rangeWords(min, max)));
    if (min !== "" && max !== "" && Number(min) > Number(max)) {
      warnings.push({ text: `The ${metatag} minimum is bigger than the maximum, so nothing will match.`, bad: true });
    }
  }

  // ---- Date ----
  if (f.date === "custom") {
    const text = rangeText(f.date_from, f.date_to);
    if (text) {
      add("date:" + text);
      if (f.date_from && f.date_to) details.push(`uploaded between ${f.date_from} and ${f.date_to}`);
      else if (f.date_from) details.push(`uploaded on or after ${f.date_from}`);
      else details.push(`uploaded on or before ${f.date_to}`);
    }
  } else if (f.date) {
    add("date:" + f.date);
    details.push(DATE_WORDS[f.date]);
  }

  // ---- Advanced text boxes ----
  if (f.uploader) {
    add("user:" + cleanName(f.uploader));
    details.push("uploaded by " + f.uploader);
  }
  if (f.favby) {
    add("fav:" + cleanName(f.favby));
    details.push("favorited by " + f.favby);
  }
  if (f.pool) {
    add("pool:" + cleanName(f.pool).toLowerCase());
    details.push("in the pool " + f.pool);
  }
  if (f.set) {
    add("set:" + cleanName(f.set).toLowerCase());
    details.push("in the set " + f.set);
  }
  if (f.description) {
    const text = f.description.replace(/"/g, "");
    add(text.includes(" ") ? `description:"${text}"` : "description:" + text);
    details.push(`whose description contains "${text}"`);
  }
  if (f.status) {
    add("status:" + f.status);
    details.push(STATUS_WORDS[f.status]);
  }
  if (f.artverified) {
    add("artverified:true");
    details.push("uploaded by verified artists");
  }
  if (f.nopool) {
    add("inpool:false");
    details.push("not part of a pool");
  }
  if (f.noparent) {
    add("ischild:false");
    details.push("that aren't alternate versions of another post");
  }
  if (f.extra) {
    // Added exactly as typed. Each word counts as a tag, except brackets and ~
    const words = f.extra.split(/\s+/).filter((w) => !["(", ")", "~(", "-("].includes(w));
    add(f.extra.replace(/\s+/g, " "), words.length);
    details.push("matching your extra search text");
  }

  // ---- Sorting ----
  if (f.order) add("order:" + f.order);
  const orderLabel = $("#order").selectedOptions[0].textContent.replace(" (default)", "");

  // ---- Warnings ----
  if (count > MAX_TAGS) {
    warnings.push({ text: `e621 only allows ${MAX_TAGS} tags per search (filters count too). Remove ${count - MAX_TAGS}.`, bad: true });
  }
  const wildcards = required.filter((t) => t.includes("*"));
  if (wildcards.length > 1) {
    warnings.push({ text: "Only one wildcard (*) is allowed outside Exclude. Remove all but one.", bad: true });
  }
  if (wildcards.length && allOrGroups.length) {
    warnings.push({ text: "Wildcards and \"Any of these\" don't mix well on e621, so results may be wrong. Try removing one of them." });
  }
  const clash = required.filter((t) => exclude.includes(t));
  if (clash.length) {
    warnings.push({ text: `${joinWords(clash, "and")} is both required and excluded, so nothing will match.`, bad: true });
  }
  for (const g of orGroups) {
    for (const t of g.names.filter((n) => exclude.includes(n))) {
      warnings.push({ text: `${t} is in an "Any of these" group but also excluded, so it can never match. Remove it from one of them.` });
    }
  }
  if (f.date === "custom" && f.date_from && f.date_to && f.date_from > f.date_to) {
    warnings.push({ text: "The \"from\" date is after the \"to\" date, so nothing will match.", bad: true });
  }
  // Tag families: excluding a tag also hides every tag that adds it
  for (const r of required) {
    for (const e of exclude) {
      if (implies(r, e)) {
        warnings.push({ text: `Every ${r} post is automatically also tagged ${e}, so excluding ${e} hides all of them. Nothing will match.`, bad: true });
      }
    }
    for (const other of required) {
      if (other !== r && implies(r, other)) {
        warnings.push({ text: `${other} isn't needed: every ${r} post is already tagged ${other}.` });
      }
    }
  }
  for (const g of orGroups) {
    for (const t of g.names) {
      for (const e of exclude) {
        if (implies(t, e)) {
          warnings.push({ text: `Every ${t} post is also tagged ${e}, so while ${e} is excluded, ${t} in "Any of these" can never match.` });
        }
      }
    }
    if (g.onlyOne && g.names.some((a) => g.names.some((b) => a !== b && implies(a, b)))) {
      warnings.push({ text: "An \"Only one\" group has a tag that automatically adds another tag from the same group. See the note under the group.", bad: true });
    }
  }
  if (f.order === "random" && count <= 1) {
    warnings.push({ text: "Random order works best with a few tags. On its own it can be slow." });
  }

  // ---- The plain-English sentence ----
  const tagPhrases = [];
  if (required.length) tagPhrases.push("tagged " + joinWords(required.map(describeTag), "and"));
  for (const g of orGroups) {
    tagPhrases.push((g.onlyOne ? "tagged only one of " : "tagged ") + joinWords(g.names, "or"));
  }

  let sentence = tagPhrases.length ? "Posts " + tagPhrases.join(", and also ") : "All posts";
  if (exclude.length) {
    sentence += (tagPhrases.length ? ", but not " : " except ones ") + "tagged " + joinWords(exclude.map(describeTag), "or");
  }
  if (details.length) sentence += ", " + joinWords(details, "and");
  sentence += ". Sorted: " + orderLabel.toLowerCase() + ".";

  return { query: parts.join(" "), count, sentence, warnings };
}

// ============================================================
// 9. Showing the result (runs after every change)
// ============================================================

function update() {
  const { query, count, sentence, warnings } = buildSearch();
  updateGroupNotes();

  checkFamilies();
  const status = $("#family-status");
  status.hidden = !familyLoading && !familyFailed;
  status.textContent = familyLoading
    ? "Checking how your tags are related…"
    : "Couldn't reach e621 to check tag families, so some tips may be missing. Trying again soon.";

  // Close the family pop-up if its tag was removed
  if (popupInfo && !allTagNames().includes(popupInfo.name)) closePopup();

  // Don't overwrite the search box while you're typing your own changes in it
  if (!queryTyped) {
    queryBox.value = query;
    fitQueryBox();
  }

  scheduleMatchCheck(query, count);

  const counter = $("#counter");
  counter.textContent = `${count} / ${MAX_TAGS} tags`;
  counter.classList.toggle("over", count > MAX_TAGS);

  $("#explain").textContent = sentence;

  const list = $("#warnings");
  list.replaceChildren();
  const shown = new Set(); // the same warning can come up for several groups; show it once
  for (const w of warnings) {
    if (shown.has(w.text)) continue;
    shown.add(w.text);
    const li = document.createElement("li");
    li.textContent = (w.bad ? "⛔ " : "⚠️ ") + w.text;
    if (w.bad) li.classList.add("bad");
    list.append(li);
  }

  $("#open").href = "https://e621.net/posts" + (query ? "?tags=" + encodeURIComponent(query) : "");

  // Remember the current search so it's still there after closing the page
  storageSet(STORAGE_CURRENT, snapshot());
}

// ============================================================
// 9b. Do any posts match? And how many?
// ============================================================
// e621 has no "count" feature, so:
// - the quick check asks for just 1 post, to see if there are any at all
// - "Count posts" asks for single pages of 20 posts, jumping around to find
//   the last page (like guessing a number with "higher / lower")

const matchCache = new Map(); // search text -> "none", "some", or a count like { count, exact }
let matchTimer;
let matchFor = null; // the search the panel is showing results for

const PAGE_SIZE = 20;
const MAX_PAGE = 750; // e621 won't go past page 750

function scheduleMatchCheck(query, count) {
  clearTimeout(matchTimer);
  matchFor = query;
  if (count > MAX_TAGS) {
    showMatches("Too many tags for e621 to run this search.");
    return;
  }
  if (matchCache.has(query)) {
    showMatches(matchCache.get(query));
    return;
  }
  showMatches("waiting");
  // Wait until you stop changing things for a moment
  matchTimer = setTimeout(async () => {
    try {
      const posts = await apiGet("/posts.json", { tags: query, limit: 1 });
      matchCache.set(query, posts.length ? "some" : "none");
    } catch (error) {
      if (matchFor === query) showMatches("e621 couldn't run this search: " + error.message);
      return;
    }
    if (matchFor === query) showMatches(matchCache.get(query));
  }, 1200);
}

function showMatches(result) {
  const text = $("#match-text");
  const button = $("#count-btn");
  const box = $("#matches");
  box.className = "matches";
  button.hidden = true;

  if (result === "waiting") {
    text.textContent = "Checking for matching posts…";
  } else if (result === "counting") {
    text.textContent = "Counting… this takes a few seconds.";
  } else if (result === "none") {
    text.textContent = "⚠️ No posts match this search.";
    box.classList.add("none");
  } else if (result === "some") {
    text.textContent = "✅ Posts found.";
    button.hidden = false;
  } else if (typeof result === "object") {
    text.textContent = result.exact
      ? `✅ ${result.count.toLocaleString()} post${result.count === 1 ? "" : "s"} match.`
      : `✅ More than ${result.count.toLocaleString()} posts match.`;
  } else {
    text.textContent = "⚠️ " + result; // an error message
    box.classList.add("none");
  }
}

$("#count-btn").addEventListener("click", async () => {
  const query = matchFor;
  showMatches("counting");
  const sizes = new Map(); // page number -> how many posts are on it
  const pageSize = async (page) => {
    if (!sizes.has(page)) {
      sizes.set(page, (await apiGet("/posts.json", { tags: query, limit: PAGE_SIZE, page }, { urgent: true })).length);
    }
    return sizes.get(page);
  };

  try {
    let result;
    if (await pageSize(1) < PAGE_SIZE) {
      result = { count: await pageSize(1), exact: true }; // everything fits on page 1
    } else if (await pageSize(MAX_PAGE) === PAGE_SIZE) {
      result = { count: PAGE_SIZE * MAX_PAGE, exact: false }; // even the last page is full
    } else {
      // `low` is always a full page, `high` is always a page that isn't full
      let low = 1;
      let high = MAX_PAGE;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (await pageSize(middle) === PAGE_SIZE) low = middle;
        else high = middle;
      }
      result = { count: (high - 1) * PAGE_SIZE + await pageSize(high), exact: true };
    }
    matchCache.set(query, result);
    if (matchFor === query) showMatches(result);
  } catch (error) {
    if (matchFor === query) showMatches("Couldn't finish counting: " + error.message);
  }
});

// ============================================================
// 9c. Reading a typed or pasted search back into the boxes
// ============================================================

// Splits a search into pieces, keeping quoted text together:
// 'wolf description:"big tree" -( a b )' -> ["wolf", 'description:"big tree"', "-(", "a", "b", ")"]
function splitSearch(text) {
  return text.match(/[^\s"]*"[^"]*"\S*|\S+/g) || [];
}

// Turns the pieces into a list of tags and ( groups ), with their - and ~ marks
function readItems(words) {
  const items = [];
  while (words.length) {
    const word = words.shift();
    if (word === ")") break; // end of the group we're inside
    const mark = /^[-~]/.test(word) ? word[0] : "";
    const rest = mark ? word.slice(1) : word;
    if (rest === "(") items.push({ group: true, mark, items: readItems(words) });
    else items.push({ group: false, mark, text: rest });
  }
  return items;
}

function itemToText(item) {
  return item.group ? `${item.mark}( ${item.items.map(itemToText).join(" ")} )` : item.mark + item.text;
}

// Reads ranges like ">=10", "<5", "3..8", "10.." and "7"
function readRange(value) {
  let m;
  if ((m = value.match(/^>=(-?\d+)$/))) return { min: m[1], max: "" };
  if ((m = value.match(/^>(-?\d+)$/))) return { min: String(Number(m[1]) + 1), max: "" };
  if ((m = value.match(/^<=(-?\d+)$/))) return { min: "", max: m[1] };
  if ((m = value.match(/^<(-?\d+)$/))) return { min: "", max: String(Number(m[1]) - 1) };
  if ((m = value.match(/^(-?\d*)\.\.(-?\d*)$/)) && (m[1] || m[2])) return { min: m[1], max: m[2] };
  if ((m = value.match(/^(-?\d+)$/))) return { min: m[1], max: m[1] };
  return null;
}

const RANGE_KEYS = { score: "score", favcount: "favs", width: "width", height: "height", duration: "duration" };
const RATING_LETTERS = { s: "s", safe: "s", q: "q", questionable: "q", e: "e", explicit: "e" };

function parseSearch(text) {
  const items = readItems(splitSearch(text.toLowerCase()));
  const result = { must: [], exclude: [], anyGroups: [], filters: {} };
  const f = result.filters;
  const extra = [];
  const topAny = [];   // ~tags written without brackets
  const notGroups = []; // -( ... ) groups, which might be "Only one"
  const typesYes = [];
  const typesNo = [];
  const hasOption = (select, value) => [...$(select).options].some((o) => o.value === value);

  // Fills in a filter from a metatag like "score:>=50". Returns false if it isn't one we have a box for.
  function readMetatag(name, value, negative) {
    if (name === "type" && FILE_TYPES.includes(value) && value !== "swf") { // Flash has no button, so it stays as extra text
      (negative ? typesNo : typesYes).push(value);
      return true;
    }
    if (name === "rating" && RATING_LETTERS[value]) {
      const letter = RATING_LETTERS[value];
      for (const r of ["s", "q", "e"]) {
        if (negative ? r !== letter : r === letter) f["rating_" + r] = true;
      }
      return true;
    }
    if (negative) return false; // the rest can't be "not"-ed in the boxes
    if (RANGE_KEYS[name] && readRange(value)) {
      const range = readRange(value);
      f[RANGE_KEYS[name] + "_min"] = range.min;
      f[RANGE_KEYS[name] + "_max"] = range.max;
      return true;
    }
    if (name === "date") {
      if (hasOption("#date", value) && value !== "custom") {
        f.date = value;
        return true;
      }
      // Dates like 2024-05-01, as a single day or a range
      const day = /^\d{4}-\d{2}-\d{2}$/;
      const [from, to] = value.includes("..") ? value.split("..") : [value, value];
      const cleanFrom = from.replace(/^>=/, "");
      const cleanTo = to.replace(/^<=/, "");
      if (value.startsWith("<=")) Object.assign(f, { date_from: "", date_to: value.slice(2) });
      else Object.assign(f, { date_from: cleanFrom, date_to: value.startsWith(">=") ? "" : cleanTo });
      if (![f.date_from, f.date_to].every((v) => v === "" || day.test(v)) || (!f.date_from && !f.date_to)) {
        f.date_from = f.date_to = "";
        return false;
      }
      f.date = "custom";
      return true;
    }
    if (name === "order" && hasOption("#order", value)) {
      f.order = value;
      return true;
    }
    if (name === "status" && hasOption("#status", value)) {
      f.status = value;
      return true;
    }
    const textBoxes = { user: "uploader", fav: "favby", favoritedby: "favby", pool: "pool", set: "set", description: "description" };
    if (textBoxes[name]) {
      f[textBoxes[name]] = value.replace(/^"|"$/g, "");
      return true;
    }
    const checkboxes = { "artverified:true": "artverified", "inpool:false": "nopool", "ischild:false": "noparent" };
    if (checkboxes[name + ":" + value]) {
      f[checkboxes[name + ":" + value]] = true;
      return true;
    }
    return false;
  }

  for (const item of items) {
    if (item.group) {
      const plainOrs = item.items.every((i) => !i.group && i.mark === "~");
      if (!item.mark && plainOrs) {
        const names = item.items.map((i) => i.text);
        if (names.every((n) => n.startsWith("type:") && n !== "type:swf")) {
          typesYes.push(...names.map((n) => n.slice(5)));
        } else {
          result.anyGroups.push(names);
        }
      } else if (item.mark === "-") {
        notGroups.push(item);
      } else {
        extra.push(itemToText(item));
      }
      continue;
    }

    const colon = item.text.indexOf(":");
    const isMetatag = colon > 0 && /^[a-z_]+$/.test(item.text.slice(0, colon));
    if (item.mark === "~") {
      if (isMetatag && item.text.startsWith("type:") && item.text !== "type:swf") typesYes.push(item.text.slice(5));
      else topAny.push(item.text);
    } else if (isMetatag && readMetatag(item.text.slice(0, colon), item.text.slice(colon + 1), item.mark === "-")) {
      // handled: it filled in a filter
    } else if (isMetatag) {
      extra.push(itemToText(item));
    } else if (item.mark === "-") {
      result.exclude.push(item.text);
    } else {
      result.must.push(item.text);
    }
  }
  if (topAny.length) result.anyGroups.unshift(topAny);

  // File types: "type:png" marks png as wanted, "-type:swf" marks swf as excluded.
  // (If some types are wanted, the excluded ones are left out anyway.)
  for (const t of typesYes) f["type_" + t] = "yes";
  if (!typesYes.length) for (const t of typesNo) f["type_" + t] = "no";

  // "Only one": look for the -( ) groups this app writes for it (or older "every pair" ones)
  const notTexts = notGroups.map(itemToText);
  result.anyGroups = result.anyGroups.map((names) => {
    if (names.length < 2) return newGroup(names, false);
    const chain = names.slice(0, -1).map((n, i) => {
      const rest = names.slice(i + 1);
      return `-( ${n} ${rest.length === 1 ? rest[0] : rest.map((t) => "~" + t).join(" ")} )`;
    });
    const pairs = [];
    names.forEach((a, i) => names.slice(i + 1).forEach((b) => pairs.push(`-( ${a} ${b} )`)));
    for (const pattern of [chain, pairs]) {
      if (pattern.every((p) => notTexts.includes(p))) {
        for (const p of pattern) notTexts.splice(notTexts.indexOf(p), 1);
        return newGroup(names, true);
      }
    }
    return newGroup(names, false);
  });
  extra.push(...notTexts); // other -( ) groups go to the extra text

  // Tag lists become chips ({ name, category }); categories are filled in afterwards
  const chip = (name) => ({ name, category: knownCategories.get(name) ?? null });
  result.must = result.must.map(chip);
  result.exclude = result.exclude.map(chip);
  for (const g of result.anyGroups) g.tags = g.tags.map(chip);
  f.extra = extra.join(" ");
  return result;
}

// The search line is a text box. While you're typing in it, the page leaves it
// alone; Enter (or clicking somewhere else) reads it back into the boxes.
const queryBox = $("#query");
let queryTyped = false; // true while it holds changes that haven't been applied yet

function setQueryHint(text) {
  $("#query-hint").textContent = text;
}

// Makes the text box exactly as tall as its text
function fitQueryBox() {
  queryBox.style.height = "auto";
  queryBox.style.height = queryBox.scrollHeight + 2 + "px";
}

function applyQueryBox() {
  if (!queryTyped) return;
  queryTyped = false;
  setQueryHint("You can type or paste a search here too.");
  const parsed = parseSearch(queryBox.value);
  if (!parsed.anyGroups.length) parsed.anyGroups.push(newGroup());
  loadSnapshot(parsed);
  resolveTags([...state.must, ...state.exclude, ...state.anyGroups.flatMap((g) => g.tags)]);
  if (parsed.filters.extra) {
    toast("Filled in! Parts without a box went into Advanced filters → Extra search text.");
    $(".advanced").open = true;
  } else {
    toast("Filled in the boxes and filters!");
  }
}

queryBox.setAttribute("enterkeyhint", "go"); // phones: show a "Go" key
queryBox.addEventListener("input", () => {
  queryTyped = true;
  // Some phone keyboards add a new line for Enter instead of sending an Enter
  // key press. A search is one line, so a new line means "apply".
  if (queryBox.value.includes("\n")) {
    queryBox.value = queryBox.value.replace(/\n/g, " ");
    applyQueryBox();
    return;
  }
  setQueryHint("Press Enter (or click somewhere else) to apply. Esc to undo.");
  fitQueryBox();
});
queryBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault(); // a search is one line, so Enter applies instead of starting a new line
    applyQueryBox();
  } else if (e.key === "Escape") {
    queryTyped = false;
    setQueryHint("You can type or paste a search here too.");
    update(); // puts the search back the way it was
  }
});
queryBox.addEventListener("blur", applyQueryBox);

// ============================================================
// 10. Saving and loading
// ============================================================

// A copy of everything on the page, ready to store
function snapshot() {
  return JSON.parse(JSON.stringify({ ...state, filters: getFilters() }));
}

function loadSnapshot(snap) {
  // Work on a copy, so editing the page never changes a saved search by accident
  snap = snap ? JSON.parse(JSON.stringify(snap)) : null;
  state.must = Array.isArray(snap?.must) ? snap.must : [];
  state.exclude = Array.isArray(snap?.exclude) ? snap.exclude : [];
  state.anyGroups = Array.isArray(snap?.anyGroups) && snap.anyGroups.length
    // Older saves stored each group as a plain list of tags
    ? snap.anyGroups.map((g) => (Array.isArray(g) ? newGroup(g) : newGroup(g.tags || [], Boolean(g.onlyOne))))
    : [newGroup()];
  // Older saves had "Still pictures" / "Animated" buttons. Those used e621's
  // animated tag, so turn them into that tag.
  const kind = snap?.filters?.kind;
  if (kind === "animated" && !state.must.some((t) => t.name === "animated")) {
    state.must.push({ name: "animated", category: 7 });
  }
  if (kind === "still" && !state.exclude.some((t) => t.name === "animated")) {
    state.exclude.push({ name: "animated", category: 7 });
    if (!snap.filters.type_swf) snap.filters.type_swf = "no"; // "Still pictures" also left out Flash
  }
  // Older saves could have a Flash button setting. There's no button now, so
  // keep it as extra search text instead.
  // (If other types were wanted too, Flash is just dropped: "PNG or Flash"
  // can't be written as extra text, and excluding Flash is automatic then.)
  const flash = snap?.filters?.type_swf;
  const otherTypesWanted = FILE_TYPES.some((t) => t !== "swf" && typeState(snap?.filters || {}, t) === "yes");
  if (!otherTypesWanted && (flash === true || flash === "true" || flash === "yes" || flash === "no")) {
    const flashText = flash === "no" ? "-type:swf" : "type:swf";
    snap.filters.extra = [snap.filters.extra, flashText].filter(Boolean).join(" ");
  }
  setFilters(snap?.filters);
  drawAllTagBoxes();
  update();
}

function drawSaved() {
  const saved = storageGet(STORAGE_SAVED, []);
  const list = $("#saved-list");
  list.replaceChildren();

  if (saved.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No saved searches yet.";
    list.append(li);
    return;
  }

  saved.forEach((item, index) => {
    const li = document.createElement("li");

    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.name;
    const preview = document.createElement("code");
    preview.className = "preview";
    preview.textContent = item.query || "(everything)";
    preview.title = item.query;
    info.append(name, preview);

    const load = document.createElement("button");
    load.type = "button";
    load.textContent = "Load";
    load.addEventListener("click", () => {
      loadSnapshot(item.snapshot);
      toast("Loaded \"" + item.name + "\"");
    });

    // The "⋯" button opens a small menu with Rename and Delete
    const menuWrap = document.createElement("div");
    menuWrap.className = "menu-wrap";

    const dots = document.createElement("button");
    dots.type = "button";
    dots.className = "dots";
    dots.textContent = "⋯";
    dots.setAttribute("aria-label", "More options for " + item.name);
    dots.setAttribute("aria-expanded", "false");

    const menu = document.createElement("div");
    menu.className = "menu";
    menu.hidden = true;

    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "✏️ Rename";
    rename.addEventListener("click", () => {
      closeMenus();
      startRename(info, name, item, saved);
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "🗑️ Delete";
    del.addEventListener("click", () => {
      closeMenus();
      if (!confirm(`Delete the saved search "${item.name}"?`)) return;
      saved.splice(index, 1);
      storageSet(STORAGE_SAVED, saved);
      drawSaved();
    });

    dots.addEventListener("click", (e) => {
      e.stopPropagation(); // don't let the page-wide "close menus" click run
      const wasOpen = !menu.hidden;
      closeMenus();
      if (!wasOpen) {
        menu.hidden = false;
        dots.setAttribute("aria-expanded", "true");
        // If the menu would be cut off at the bottom of the column, open it upwards instead
        if (menu.getBoundingClientRect().bottom > $(".result").getBoundingClientRect().bottom) {
          menu.classList.add("up");
        }
      }
    });

    menu.append(rename, del);
    menuWrap.append(dots, menu);
    li.append(info, load, menuWrap);
    list.append(li);
  });
}

function closeMenus() {
  document.querySelectorAll(".saved-list .menu").forEach((menu) => {
    menu.hidden = true;
    menu.classList.remove("up");
    menu.previousElementSibling.setAttribute("aria-expanded", "false");
  });
}

// Swaps the name for a text box. Enter saves, Escape cancels.
function startRename(info, nameEl, item, saved) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename";
  input.value = item.name;
  input.setAttribute("aria-label", "New name");
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  function finish(keep) {
    if (finished) return;
    finished = true;
    const newName = input.value.trim();
    if (keep && newName && newName !== item.name) {
      if (saved.some((other) => other !== item && other.name === newName)) {
        toast("You already have a search called \"" + newName + "\"");
      } else {
        item.name = newName;
        storageSet(STORAGE_SAVED, saved);
        toast("Renamed to \"" + newName + "\"");
      }
    }
    drawSaved();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  // Clicking somewhere else also saves the new name
  input.addEventListener("blur", () => finish(true));
}

// Clicking anywhere else, or pressing Escape, closes an open menu
document.addEventListener("click", closeMenus);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenus();
});

$("#save-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const { query } = buildSearch();
  const nameInput = $("#save-name");
  const name = nameInput.value.trim() || (query ? query.slice(0, 40) : "Everything");

  const saved = storageGet(STORAGE_SAVED, []);
  const existing = saved.findIndex((item) => item.name === name);
  const entry = { name, query, snapshot: snapshot() };
  if (existing >= 0) saved[existing] = entry; // same name replaces the old one
  else saved.unshift(entry);

  if (storageSet(STORAGE_SAVED, saved)) {
    nameInput.value = "";
    drawSaved();
    toast("Saved \"" + name + "\"");
  } else {
    toast("Couldn't save: your browser is blocking storage for this page.");
  }
});

// Export: downloads all saved searches as a file you can keep anywhere
$("#export").addEventListener("click", () => {
  const saved = storageGet(STORAGE_SAVED, []);
  if (!saved.length) {
    toast("No saved searches to export yet");
    return;
  }
  const file = new Blob([JSON.stringify({ app: "e621-tag-picker", saved }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = "e621-saved-searches.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast(`Exported ${saved.length} saved search${saved.length === 1 ? "" : "es"}`);
});

// Import: reads a file made by Export and adds its searches to your list
$("#import").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // so picking the same file again still works
  if (!file) return;

  let incoming;
  try {
    const data = JSON.parse(await file.text());
    incoming = (Array.isArray(data) ? data : data.saved)
      .filter((item) => typeof item?.name === "string" && item.snapshot && typeof item.snapshot === "object");
  } catch {
    toast("That file doesn't look like an export from this app");
    return;
  }

  const saved = storageGet(STORAGE_SAVED, []);
  let added = 0;
  for (const item of incoming) {
    const same = saved.find((s) => s.name === item.name);
    if (same && same.query === item.query) continue; // already have this exact one
    let name = item.name;
    while (saved.some((s) => s.name === name)) name += " (imported)";
    saved.push({ name, query: String(item.query ?? ""), snapshot: item.snapshot });
    added++;
  }
  if (storageSet(STORAGE_SAVED, saved)) {
    drawSaved();
    toast(added ? `Imported ${added} search${added === 1 ? "" : "es"}` : "Nothing new to import: you already have all of those");
  } else {
    toast("Couldn't save: your browser is blocking storage for this page.");
  }
});

// ============================================================
// 11. Buttons and start-up
// ============================================================

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older way of copying, for browsers that block the one above
    const temp = document.createElement("textarea");
    temp.value = text;
    document.body.append(temp);
    temp.select();
    document.execCommand("copy");
    temp.remove();
  }
}

$("#copy").addEventListener("click", async () => {
  const { query } = buildSearch();
  if (!query) {
    toast("Nothing to copy yet");
    return;
  }
  await copyText(query);
  toast("Copied the search!");
});

// The full e621 address, for pasting into a private window
$("#copy-link").addEventListener("click", async () => {
  await copyText($("#open").href);
  toast("Copied the link! Paste it into a private window.");
});

$("#clear").addEventListener("click", () => {
  if (!buildSearch().query) {
    toast("Already empty");
    return;
  }
  if (!confirm("Clear all tags and filters?")) return;
  loadSnapshot(null);
  toast("Cleared");
});

// The pop-up is placed using the page layout, which changes when the window is resized
window.addEventListener("resize", closePopup);

// Advanced filters is at the bottom of the page, so when it opens, scroll
// down to show it (otherwise it can open below the edge of the window)
// ============================================================
// 10b. "?" buttons: detailed help for every section and filter
// ============================================================
// Any element with data-help="key" in index.html gets a "?" button next to it.
// Each entry is a list of paragraphs.

const HELP = {
  tags: [
    "Type a tag and press Enter to add it. After 3 letters, e621 suggests real tag names. Use ↑ ↓ and Enter, or click one. Picking a suggestion avoids spelling mistakes.",
    "Tag colors show e621's tag types: orange = species, yellow = artist, green = character, pink = copyright (the show, game or brand), light blue = general, white = meta (things about the file, like hi_res), dark green = lore.",
    "Click a tag's name to see its family: which tags it automatically includes, and its sub-types. Click × to remove a tag, or press Backspace in an empty box to remove the last one.",
    "Spaces become underscores automatically, so typing red panda gives red_panda.",
  ],
  must: [
    "Every tag here is required: a post only shows up if it has ALL of them.",
    "Each tag you add makes the results smaller. For example, wolf + snow only finds posts tagged with both wolf and snow.",
    "On e621 these are written plainly with spaces between them: wolf snow",
    "Wildcards: a * matches anything, so african_* finds african_wild_dog, african_golden_cat and so on. e621 allows only one wildcard outside Exclude, and wildcard results can be incomplete.",
  ],
  any: [
    "A group means \"at least one of these\". A post needs one or more tags from the group, not all of them. For example, a group with fox and dog finds posts with a fox, a dog, or both.",
    "With several groups, a post needs a match from EACH group: (fox or dog) and also (snow or forest).",
    "On e621 these get a ~ in front, with brackets around each group when there's more than one: ( ~fox ~dog ) ( ~snow ~forest )",
    "Tick \"Only one\" to hide posts that have two or more tags from that group. A group with just one tag works the same as Must have.",
  ],
  exclude: [
    "Hides every post that has ANY of these tags. If a post has even one of them, it's left out of the results.",
    "On e621 these get a - in front: -human -comic",
    "Excluding a tag also hides every tag that automatically includes it. For example, excluding canine also hides wolves and foxes, because every wolf post is also tagged canine.",
    "Tip: typing a tag with - in front (like -human) into any box moves it here. Wildcards like -african_* are allowed here, as many as you like.",
  ],
  filters: [
    "Filters narrow the results by things other than tags: rating, popularity, file type and upload date. Leaving a filter empty means \"no limit\".",
    "Each filter you use counts toward e621's limit of 40 tags per search.",
  ],
  rating: [
    "Every post on e621 has one rating. Safe: no nudity or sexual content. Questionable: suggestive, or some nudity, but no sex. Explicit: sexual content.",
    "Tick the ratings you want to see. Ticking more than one shows all of them. Leaving all three unticked allows every rating.",
    "On e621 this is written rating:s (or rating:q, rating:e). Picking two is written as \"not the third one\": Safe + Questionable becomes -rating:e.",
  ],
  order: [
    "Which posts come first. The default is newest first.",
    "Highest score = most liked by voters. Most favorites = saved to favorites by the most people. Hot = popular right now. Random gives a different mix every time you open the search.",
    "The options under \"More\" sort by size, length, number of tags and so on.",
  ],
  score: [
    "A post's score is its upvotes minus its downvotes, so it's a rough measure of how much people liked it. It can be negative.",
    "Fill in a minimum, a maximum, or both. Leave a box empty for no limit. For example, a minimum of 50 finds well-liked posts only.",
    "On e621 this is written score:>=50 (or score:10..50 for a range).",
  ],
  favs: [
    "How many people added the post to their favorites. Like score, it's a sign of popularity, but it can't go below 0.",
    "Fill in a minimum, a maximum, or both. Leave a box empty for no limit. On e621 this is written favcount:>=100",
  ],
  type: [
    "Click a type once to want it (✓ green), twice to exclude it (✕ red), and a third time to clear it. Leaving every type clear allows all of them.",
    "Click Pictures or Animations to do that for the whole row at once. For example, one click on Pictures wants JPG, PNG and WebP.",
    "If you want some types, every other type is left out anyway, so excluding only matters when nothing is wanted.",
    "File types: JPG, PNG and WebP are pictures. GIF is in Animations because almost every GIF on e621 moves (about 97%). MP4 and WebM are videos.",
    "Flash has no button: it's an old format that browsers can't play anymore, and picking any types here leaves Flash out. To find Flash posts on purpose, type type:swf into the search box.",
    "Tip: a few PNGs and WebPs move, and a few GIFs are still, so file type isn't perfect. For an exact split, use e621's animated tag: put animated in Must have to get only moving posts, or in Exclude to hide them.",
    "On e621 file types are written type:png and -type:gif.",
  ],
  date: [
    "When the post was uploaded to e621 (not when the art was made).",
    "\"In the last 7 days\" counts back from right now. \"Last week\" means the whole previous calendar week, and the same goes for last month and last year.",
    "\"Between two dates\" lets you pick exact days. Leave one of them empty to have no start or no end.",
  ],
  advanced: [
    "Less common filters: image size, video length, who uploaded or favorited a post, pools and sets, post status, and a box for any extra search text.",
    "Like the other filters, leave anything empty to not use it.",
  ],
  size: [
    "The image or video size in pixels. Fill in a minimum, a maximum, or both.",
    "For example, a minimum width of 1920 and a minimum height of 1080 finds pictures big enough for a full HD wallpaper.",
  ],
  duration: [
    "How long a video or animation is, in seconds. Only videos and animations have a length, so using this hides still pictures.",
    "For example, a minimum of 60 finds videos that are at least a minute long.",
  ],
  uploader: [
    "Only posts uploaded by this e621 user. Type their username; spaces become underscores.",
    "The uploader isn't always the artist. Many posts are uploaded by fans.",
  ],
  favby: [
    "Only posts this e621 user has added to their favorites. Type their username.",
    "Type me to use your own favorites. That only works when you're logged in to e621 in the same browser. It also won't work for users who keep their favorites hidden.",
  ],
  pool: [
    "A pool is an ordered collection of posts, usually a comic or a series. Type the pool's number (from its web address, like e621.net/pools/1234) or its name.",
    "Sort by \"Oldest first\" to read a comic in order.",
  ],
  set: [
    "A set is a collection that a user made, like a playlist. Type the set's number or its short name (shown on the set's page).",
  ],
  description: [
    "Finds posts whose description (the text under the picture on e621) contains these words. Spaces are fine.",
  ],
  status: [
    "e621 normally hides deleted posts. Use this to see posts waiting for approval, posts flagged for deletion, deleted posts, or everything including deleted ones.",
    "Deleted posts usually can't be viewed anymore, but their tags and details are still listed.",
  ],
  extra: [
    "Anything typed here is added to the search exactly as written. Use it for e621 search features this page has no box for (see e621's search cheatsheet).",
    "When you paste a search into \"Your search\", any parts that don't fit a box end up here, so nothing gets lost.",
    "Each word here counts toward the 40-tag limit.",
  ],
  other: [
    "Verified artists: only posts uploaded by the artist themselves, on an account e621 has confirmed belongs to them.",
    "Not part of a pool: hides comics and other series, so you only get single pictures.",
    "Hide alternate versions: some posts are linked as a \"child\" of another post, like a recolor, an edit or a different version. This hides those and keeps the originals.",
  ],
  search: [
    "This is the search that e621 understands, written from your choices. It updates whenever you change something.",
    "You can also type in it, or paste a search copied from e621, then press Enter. The boxes and filters fill in to match. Press Esc to undo your typing.",
    "The counter shows how many of e621's 40 tags per search you're using. Below it, the page checks whether any posts match, and \"Count posts\" finds the exact number (up to 15,000).",
    "Copy search copies just the search text. Copy link copies the full e621 address, which you can paste into a private window. Open on e621 opens the results in a new tab.",
  ],
  saved: [
    "Save the current search with a name so you can use it again later. Saving with a name that's already used replaces the old one.",
    "Load puts a saved search back into the boxes and filters. The ⋯ button has Rename and Delete.",
    "Saved searches are stored in this browser only. Clearing your browser data deletes them, and they won't show up in other browsers. Use Export to save a backup file, and Import to load it back.",
  ],
};

document.querySelectorAll("[data-help]").forEach((label) => {
  const paragraphs = HELP[label.dataset.help];
  if (!paragraphs) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "help";
  button.textContent = "?";
  button.setAttribute("aria-label", "More info about " + label.textContent.trim());
  button.setAttribute("aria-expanded", "false");

  const note = document.createElement("div");
  note.className = "help-note";
  note.hidden = true;
  for (const text of paragraphs) note.append(Object.assign(document.createElement("p"), { textContent: text }));

  // Put the label and its "?" side by side in a row, with the note under the row
  const row = document.createElement("div");
  row.className = "help-row";
  label.replaceWith(row);
  row.append(label, button);

  // In a section title bar, the note goes under the whole title bar
  const summary = row.closest("summary");
  const cardHead = row.closest(".card-head");
  (summary || cardHead || row).after(note);
  note.addEventListener("click", (e) => e.stopPropagation()); // clicking inside the note keeps it open

  button.addEventListener("click", (e) => {
    e.preventDefault();  // a "?" in a title bar shouldn't open/close the section
    e.stopPropagation(); // ...and the page-wide "click elsewhere" below shouldn't close it right away
    const opening = note.hidden;
    closeHelpNotes();    // only one help note open at a time
    if (opening) {
      note.hidden = false;
      button.setAttribute("aria-expanded", "true");
      if (summary) summary.parentElement.open = true; // show the note even if the section was closed
    }
  });
});

// Closes every open help note: the "?" ones above, and the "Only one" ones in groups
function closeHelpNotes() {
  document.querySelectorAll(".help-note:not([hidden])").forEach((note) => { note.hidden = true; });
  document.querySelectorAll('button.help[aria-expanded="true"]').forEach((b) => b.setAttribute("aria-expanded", "false"));
  let groupNoteWasOpen = false;
  for (const group of state.anyGroups) {
    const note = groupNotes.get(group);
    if (note?.dataset.forceOpen) {
      note.dataset.forceOpen = "";
      groupNoteWasOpen = true;
    }
  }
  if (groupNoteWasOpen) updateGroupNotes();
}

// Clicking anywhere else, or pressing Escape, closes help notes
document.addEventListener("click", closeHelpNotes);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeHelpNotes();
});

// Sections you can collapse (Tags, Filters, Advanced filters).
// The page remembers which ones you left open or closed.
const STORAGE_SECTIONS = "e621-tag-picker:sections";
const sectionState = storageGet(STORAGE_SECTIONS, {});

document.querySelectorAll(".collapsible").forEach((section) => {
  if (section.id in sectionState) section.open = sectionState[section.id];

  let clicked = false;
  section.querySelector("summary").addEventListener("click", () => { clicked = true; });
  section.addEventListener("toggle", () => {
    sectionState[section.id] = section.open;
    storageSet(STORAGE_SECTIONS, sectionState);
    // If it opened below the edge of the window, scroll down to show it
    // (only when you opened it yourself, not when the page did)
    if (section.open && clicked && section.getBoundingClientRect().bottom > window.innerHeight) {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    clicked = false;
  });
});

// Theme dropdown: "e621" (blue, the default) or "dark" (black and gray).
// The <head> of index.html picks the starting theme so the page doesn't flash.
const STORAGE_THEME = "e621-tag-picker:theme";
const themeSelect = $("#theme-select");
themeSelect.value = document.documentElement.dataset.theme === "dark" ? "dark" : "e621";

themeSelect.addEventListener("change", () => {
  if (themeSelect.value === "dark") document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme; // e621 is the normal colors
  storageSet(STORAGE_THEME, themeSelect.value);
});

$("#add-group").addEventListener("click", () => {
  state.anyGroups.push(newGroup());
  drawGroups();
  update();
  // Put the cursor in the new group's box
  const inputs = $("#any-groups").querySelectorAll("input");
  inputs[inputs.length - 1].focus();
});

filterInputs.forEach((el) => {
  el.addEventListener("input", update);
  el.addEventListener("change", update);
});
$("#date").addEventListener("change", showCustomDates);

// Start with whatever was on the page last time
loadSnapshot(storageGet(STORAGE_CURRENT, null));
drawSaved();

// ============================================================
// 13. Firefox add-on panel
// ============================================================
// The add-on opens this page in a panel on top of e621, with an address like
// index.html?embed=1&from=https://e621.net#q=wolf+snow
// In that case: start from the search that was in e621's search box, and
// "Open on e621" becomes "Use this search", which hands the search back to e621.
const embed = new URLSearchParams(location.search);
if (embed.has("embed") && window.parent !== window) {
  const parentOrigin = embed.get("from");
  document.documentElement.classList.add("embedded");

  const startQuery = new URLSearchParams(location.hash.slice(1)).get("q");
  if (startQuery && startQuery.trim()) {
    queryBox.value = startQuery;
    queryTyped = true;
    applyQueryBox();
  }

  const open = $("#open");
  open.textContent = "Use this search";
  open.removeAttribute("target");
  open.addEventListener("click", (e) => {
    e.preventDefault();
    applyQueryBox(); // in case the search box has changes that weren't applied yet
    window.parent.postMessage({ type: "e621-tag-picker:use", query: buildSearch().query }, parentOrigin);
  });

  // The panel's title bar is part of e621's page, so tell it which theme to match
  const tellTheme = () => window.parent.postMessage({ type: "e621-tag-picker:theme", theme: themeSelect.value }, parentOrigin);
  tellTheme();
  themeSelect.addEventListener("change", tellTheme);
}

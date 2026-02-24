// LOCAL:
let API_BASE = "http://localhost:8787";

// DOM
const filesEl = document.getElementById("files");
const fileListEl = document.getElementById("fileList");
const generateBtn = document.getElementById("generate");
const progressEl = document.getElementById("progress");

const lexStatusEl = document.getElementById("lexStatus");
const lexMetaEl = document.getElementById("lexMeta");
const refreshLexBtn = document.getElementById("refreshLex");

const containerEl = document.getElementById("container");
const wavSettings = document.getElementById("wavSettings");
const mp3Settings = document.getElementById("mp3Settings");

const scriptSelectEl = document.getElementById("scriptSelect");
const phoneticEditorEl = document.getElementById("phoneticEditor");
const refreshFromOriginalBtn = document.getElementById("refreshFromOriginal");
const previewNoteEl = document.getElementById("previewNote");

// Paste UI
const pasteTitleEl = document.getElementById("pasteTitle");
const pasteInputEl = document.getElementById("pasteInput");
const addPastedBtn = document.getElementById("addPasted");
const clearPastedBtn = document.getElementById("clearPasted");

// --- Safe event helper ---
function on(el, evt, fn) {
  if (!el) return;
  el.addEventListener(evt, fn);
}

// State
let scripts = []; // [{ id, name, originalText, phoneticText, source }]
let selectedIndex = -1;
let lexiconTerms = []; // [{term, spoken}]

function setProgress(msg) {
  if (progressEl) progressEl.textContent = msg || "";
}

function updateGenerateEnabled() {
  if (!generateBtn) return;
  generateBtn.disabled = scripts.length === 0;
}

on(containerEl, "change", () => {
  const c = containerEl?.value;
  if (wavSettings) wavSettings.style.display = c === "wav" ? "block" : "none";
  if (mp3Settings) mp3Settings.style.display = c === "mp3" ? "block" : "none";
});

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyLexiconPreview(text) {
  if (!lexiconTerms.length) return text;

  const sorted = [...lexiconTerms].sort((a, b) => (b.term || "").length - (a.term || "").length);
  let out = text;

  for (const { term, spoken } of sorted) {
    if (!term || !spoken) continue;

    const escaped = escapeRegExp(term).replace(/\\-/g, "[-\\s]?");
    const pattern = `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`;

    out = out.replace(new RegExp(pattern, "gi"), spoken);
  }

  return out;
}

function getSelectedScript() {
  if (selectedIndex < 0 || selectedIndex >= scripts.length) return null;
  return scripts[selectedIndex];
}

function rebuildScriptSelect() {
  if (!scriptSelectEl) return;
  scriptSelectEl.innerHTML = "";

  scripts.forEach((s, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = s.name;
    scriptSelectEl.appendChild(opt);
  });

  if (scripts.length > 0) {
    selectedIndex = Math.min(selectedIndex < 0 ? 0 : selectedIndex, scripts.length - 1);
    scriptSelectEl.value = String(selectedIndex);
  } else {
    selectedIndex = -1;
  }
}

function renderEditor() {
  const s = getSelectedScript();
  if (!s) {
    if (phoneticEditorEl) phoneticEditorEl.value = "";
    if (refreshFromOriginalBtn) refreshFromOriginalBtn.disabled = true;
    return;
  }

  if (phoneticEditorEl) phoneticEditorEl.value = s.phoneticText ?? "";
  if (refreshFromOriginalBtn) refreshFromOriginalBtn.disabled = false;
}

on(scriptSelectEl, "change", () => {
  selectedIndex = Number(scriptSelectEl.value);
  renderEditor();
});

on(phoneticEditorEl, "input", () => {
  const s = getSelectedScript();
  if (!s) return;
  s.phoneticText = phoneticEditorEl.value;
});

on(refreshFromOriginalBtn, "click", () => {
  const s = getSelectedScript();
  if (!s) return;

  s.phoneticText = applyLexiconPreview(s.originalText ?? "");
  if (phoneticEditorEl) phoneticEditorEl.value = s.phoneticText ?? "";
  setProgress(`Refreshed phonetic from original: ${s.name}`);
});

async function loadLexStatus() {
  try {
    const r = await fetch(`${API_BASE}/api/lexicon/status`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "status failed");

    if (lexStatusEl) lexStatusEl.textContent = `Loaded ${j.termCount} terms`;
    if (lexMetaEl) lexMetaEl.textContent = `Last updated: ${new Date(j.lastFetched).toLocaleString()}`;
  } catch (e) {
    if (lexStatusEl) lexStatusEl.textContent = "Lexicon error";
    if (lexMetaEl) lexMetaEl.textContent = e.message;
  }
}

async function loadLexiconTerms() {
  const r = await fetch(`${API_BASE}/api/lexicon/json`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "lexicon json failed");
  lexiconTerms = Array.isArray(j.terms) ? j.terms : [];
}

on(refreshLexBtn, "click", async () => {
  refreshLexBtn.disabled = true;
  refreshLexBtn.textContent = "Refreshing...";

  try {
    const r = await fetch(`${API_BASE}/api/lexicon/refresh`, { method: "POST" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "refresh failed");

    if (lexStatusEl) lexStatusEl.textContent = `Loaded ${j.termCount} terms`;
    if (lexMetaEl) lexMetaEl.textContent = `Last updated: ${new Date(j.lastFetched).toLocaleString()}`;

    await loadLexiconTerms();
    setProgress("Lexicon refreshed. Click “Refresh phonetic from original” to apply to a script.");
  } catch (e) {
    if (lexStatusEl) lexStatusEl.textContent = "Refresh failed";
    if (lexMetaEl) lexMetaEl.textContent = e.message;
  }

  refreshLexBtn.disabled = false;
  refreshLexBtn.textContent = "Refresh Lexicon";
});

async function readFileAsText(file) {
  const name = file.name || "script";
  const lower = name.toLowerCase();

  if (lower.endsWith(".txt")) {
    return await file.text();
  }

  if (lower.endsWith(".docx")) {
    if (!window.mammoth) throw new Error("DOCX support missing (mammoth not loaded).");
    const ab = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({ arrayBuffer: ab });
    const text = (result.value || "").trim();
    if (!text) throw new Error(`No readable text found in ${name}.`);
    return text;
  }

  throw new Error(`Unsupported file type: ${name}`);
}

function addScript({ name, originalText, source }) {
  const safeName = (name || "Script").trim() || "Script";
  const finalName = safeName.match(/\.(txt|docx)$/i) ? safeName : `${safeName}.txt`;

  const phoneticText = applyLexiconPreview(originalText || "");

  scripts.push({
    id: crypto?.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    name: finalName,
    originalText: originalText || "",
    phoneticText,
    source: source || "unknown",
  });

  rebuildScriptSelect();
  selectedIndex = scripts.length - 1;
  if (scriptSelectEl) scriptSelectEl.value = String(selectedIndex);
  renderEditor();
  updateGenerateEnabled();
}

on(filesEl, "change", async () => {
  const inputFiles = [...(filesEl.files || [])];
  if (fileListEl) fileListEl.textContent = inputFiles.length ? inputFiles.map(f => f.name).join("\n") : "";

  if (!inputFiles.length) return;

  setProgress("Loading uploaded scripts and generating phonetic...");
  try {
    for (const f of inputFiles) {
      const originalText = await readFileAsText(f);
      addScript({ name: f.name || "script.txt", originalText, source: "upload" });
    }

    setProgress("Uploaded scripts added. Edit phonetic, or refresh from original to reset.");
    if (previewNoteEl) {
      previewNoteEl.textContent =
        "Phonetic is generated from the original script + lexicon. Edit here. Click “Refresh phonetic from original” to regenerate and discard edits.";
    }
  } catch (e) {
    setProgress(`Upload load error: ${e.message}`);
  } finally {
    // allow uploading same files again
    if (filesEl) filesEl.value = "";
  }
});

on(addPastedBtn, "click", () => {
  const title = (pasteTitleEl?.value || "").trim() || `Pasted_${scripts.length + 1}`;
  const text = (pasteInputEl?.value || "").trim();

  if (!text) {
    setProgress("Paste text is empty.");
    return;
  }

  addScript({ name: title, originalText: text, source: "paste" });
  setProgress(`Added pasted script: ${title}`);
});

on(clearPastedBtn, "click", () => {
  if (pasteTitleEl) pasteTitleEl.value = "";
  if (pasteInputEl) pasteInputEl.value = "";
  setProgress("Paste cleared.");
});

on(generateBtn, "click", async () => {
  if (!scripts.length) return;

  // Commit editor text into selected script before generating
  const s = getSelectedScript();
  if (s && phoneticEditorEl) s.phoneticText = phoneticEditorEl.value;

  setProgress("Uploading phonetic scripts and generating audio...");

  const form = new FormData();

  for (const script of scripts) {
    const base = (script.name || "script").replace(/\.(txt|docx)$/i, "");
    const payloadText = script.phoneticText ?? "";

    const blob = new Blob([payloadText], { type: "text/plain;charset=utf-8" });
    const file = new File([blob], `${base}.txt`, { type: "text/plain" });
    form.append("files", file);
  }

  form.append("model", document.getElementById("model")?.value || "aura-2-thalia-en");
  form.append("container", containerEl?.value || "wav");
  form.append("longPauseDots", document.getElementById("longPauseDots")?.value || "6");
  form.append("useSilentPause", document.getElementById("useSilentPause")?.checked ? "true" : "false");

  if ((containerEl?.value || "wav") === "wav") {
    form.append("encoding", "linear16");
    form.append("sampleRate", "48000");
  } else {
    form.append("bitRate", document.getElementById("bitRate")?.value || "128000");
  }

  let r;
  try {
    r = await fetch(`${API_BASE}/api/narrate/batch`, { method: "POST", body: form });
  } catch (e) {
    setProgress(`Network error: ${e.message}`);
    return;
  }

  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    setProgress(`Error: ${j.error || r.statusText}`);
    return;
  }

  const contentType = r.headers.get("content-type") || "";
  const zipBlob = await r.blob();

  if (!contentType.includes("application/zip")) {
    setProgress(`Unexpected response type: ${contentType}`);
    return;
  }

  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "narrations.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setProgress("Done. ZIP downloaded.");
  await loadLexStatus();
});

// Init
(async () => {
  try {
    await loadLexStatus();
    await loadLexiconTerms();
  } catch (e) {
    setProgress(`Lexicon load warning: ${e.message}`);
  } finally {
    rebuildScriptSelect();
    renderEditor();
    updateGenerateEnabled();
  }
})();
// server.js (ESM) — complete file
import express from "express";
import multer from "multer";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import archiver from "archiver";
import dotenv from "dotenv";
import { parse as parseCsv } from "csv-parse/sync";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(compression());
app.use(helmet());

// ----- ENV -----
const PORT = Number(process.env.PORT || 8787);
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const LEXICON_CSV_URL = process.env.LEXICON_CSV_URL || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

// ----- CORS -----
// If ALLOWED_ORIGIN is blank, allow all (dev friendly)
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (!ALLOWED_ORIGIN) return cb(null, true);
      return cb(null, origin === ALLOWED_ORIGIN);
    },
  })
);

// ----- Rate limit -----
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 120,
  })
);

// ----- Uploads -----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 50 }, // 5MB each, 50 files
});

// =====================
// Lexicon cache
// =====================
const LEXICON_TTL_MS = 5 * 60 * 1000;

let lexiconCache = {
  map: new Map(), // key: normalized term, value: spoken
  rawTerms: [], // [{term, spoken}]
  lastFetched: null, // ISO string
  expiresAt: 0, // epoch ms
};

function normalizeTerm(s) {
  return String(s || "").trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchLexiconFromSheets() {
  const r = await fetch(LEXICON_CSV_URL, { method: "GET" });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Lexicon fetch failed: ${r.status} ${body.slice(0, 200)}`);
  }

  const csvText = await r.text();

  const records = parseCsv(csvText, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  const terms = [];
  const map = new Map();

  for (const row of records) {
    const term = normalizeTerm(row.term ?? row.Term ?? row.TERM ?? row.word ?? row.Word);
    const spoken = normalizeTerm(
      row.spoken ??
        row.Spoken ??
        row.SPOKEN ??
        row.pronunciation ??
        row.Pronunciation
    );

    if (!term || !spoken) continue;

    terms.push({ term, spoken });
    map.set(term.toLowerCase(), spoken);
  }

  // Longest first helps replacement correctness
  terms.sort((a, b) => b.term.length - a.term.length);

  return { map, terms };
}

async function refreshLexicon() {
  if (!LEXICON_CSV_URL) throw new Error("LEXICON_CSV_URL not set");

  const { map, terms } = await fetchLexiconFromSheets();

  lexiconCache = {
    map,
    rawTerms: terms,
    lastFetched: new Date().toISOString(),
    expiresAt: Date.now() + LEXICON_TTL_MS,
  };

  return {
    termCount: lexiconCache.rawTerms.length,
    lastFetched: lexiconCache.lastFetched,
    ttlSeconds: Math.floor(LEXICON_TTL_MS / 1000),
  };
}

async function getLexiconCached() {
  if (Date.now() < lexiconCache.expiresAt && lexiconCache.map.size) {
    return lexiconCache;
  }
  await refreshLexicon();
  return lexiconCache;
}

// =====================
// Text transforms
// =====================
function applyPauseTags(text, { longPauseDots = 6, useSilentPause = false } = {}) {
  let out = String(text || "");

  out = out.replace(/\r\n/g, "\n");

  out = out.replace(/\[PAUSE=SHORT\]/gi, ",");

  const dots = ".".repeat(Math.max(1, Number(longPauseDots) || 6));
  out = out.replace(/\[PAUSE\]/gi, useSilentPause ? ". . ." : dots);

  out = out.replace(/\[SILENT_PAUSE\]/gi, ". . .");

  return out;
}

function applyLexicon(text, lexTermsSorted) {
  let out = String(text || "");

  for (const { term, spoken } of lexTermsSorted) {
    if (!term || !spoken) continue;

    const escaped = escapeRegExp(term).replace(/\\-/g, "[-\\s]?");

    // Replace only full tokens (not inside other words)
    const pattern = `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`;

    out = out.replace(new RegExp(pattern, "gi"), spoken);
  }

  return out;
}

// =====================
// Deepgram chunking (fixes 2000-char limit)
// =====================
const DG_TTS_MAX_CHARS = 2000;

function chunkTextSmart(text, maxChars = DG_TTS_MAX_CHARS) {
  const clean = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  const paras = clean.split(/\n\s*\n+/g).map((s) => s.trim()).filter(Boolean);

  const chunks = [];
  let buf = "";

  const pushBuf = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = "";
  };

  for (const p of paras) {
    if (p.length > maxChars) {
      pushBuf();

      // sentence-ish split
      const sentences = p.split(/(?<=[.!?])\s+/g);

      let sBuf = "";
      for (const s of sentences) {
        if (!s) continue;

        const candidate = sBuf ? `${sBuf} ${s}` : s;

        if (candidate.length <= maxChars) {
          sBuf = candidate;
        } else {
          if (sBuf) chunks.push(sBuf.trim());
          sBuf = s;

          // Hard wrap if still too long
          while (sBuf.length > maxChars) {
            chunks.push(sBuf.slice(0, maxChars));
            sBuf = sBuf.slice(maxChars);
          }
        }
      }
      if (sBuf.trim()) chunks.push(sBuf.trim());
      continue;
    }

    const candidate = buf ? `${buf}\n\n${p}` : p;
    if (candidate.length <= maxChars) {
      buf = candidate;
    } else {
      pushBuf();
      buf = p;
    }
  }

  pushBuf();
  return chunks;
}

// Assumes standard PCM WAV with 44-byte header
function concatPcmWav(buffers) {
  if (!buffers.length) return Buffer.alloc(0);
  if (buffers.length === 1) return buffers[0];

  const header = Buffer.from(buffers[0].subarray(0, 44));
  const riff = header.toString("ascii", 0, 4);
  const wave = header.toString("ascii", 8, 12);

  if (riff !== "RIFF" || wave !== "WAVE") {
    // Fallback: naive concat
    return Buffer.concat(buffers);
  }

  const dataParts = [];
  dataParts.push(buffers[0].subarray(44));

  for (let i = 1; i < buffers.length; i++) {
    const b = buffers[i];
    dataParts.push(b.length > 44 ? b.subarray(44) : Buffer.alloc(0));
  }

  const pcmData = Buffer.concat(dataParts);
  const out = Buffer.concat([header, pcmData]);

  // RIFF size (file length - 8) at offset 4
  out.writeUInt32LE(out.length - 8, 4);
  // data chunk size at offset 40 (standard header)
  out.writeUInt32LE(pcmData.length, 40);

  return out;
}

function concatMp3(buffers) {
  return Buffer.concat(buffers);
}

async function deepgramSpeakOnce({
  apiKey,
  text,
  model,
  container,
  encoding,
  sampleRate,
  bitRate,
}) {
  const params = new URLSearchParams();
  params.set("model", model);
  params.set("container", container);

  if (container === "wav") {
    params.set("encoding", encoding || "linear16");
    params.set("sample_rate", String(sampleRate || 48000));
  }

  if (container === "mp3" && bitRate) {
    params.set("bit_rate", String(bitRate));
  }

  const url = `https://api.deepgram.com/v1/speak?${params.toString()}`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok) {
    let msg = buf.toString("utf8");
    try {
      msg = JSON.stringify(JSON.parse(msg));
    } catch {}
    throw new Error(`Deepgram TTS failed (${r.status}): ${msg}`);
  }

  return buf;
}

async function deepgramSpeakChunked(opts) {
  const chunks = chunkTextSmart(opts.text, DG_TTS_MAX_CHARS);
  if (!chunks.length) return Buffer.alloc(0);

  const audioParts = [];
  for (const chunk of chunks) {
    audioParts.push(await deepgramSpeakOnce({ ...opts, text: chunk }));
  }

  if (opts.container === "wav") return concatPcmWav(audioParts);
  if (opts.container === "mp3") return concatMp3(audioParts);
  return Buffer.concat(audioParts);
}

// =====================
// Routes
// =====================
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/lexicon/status", async (req, res) => {
  try {
    const lex = await getLexiconCached();
    res.json({
      termCount: lex.rawTerms.length,
      lastFetched: lex.lastFetched,
      ttlSeconds: Math.floor(LEXICON_TTL_MS / 1000),
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/lexicon/refresh", async (req, res) => {
  try {
    const status = await refreshLexicon();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/lexicon/json", async (req, res) => {
  try {
    const lex = await getLexiconCached();
    res.json({ terms: lex.rawTerms });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Batch narration -> ZIP (now chunked to avoid Deepgram 2000 char limit)
app.post("/api/narrate/batch", upload.array("files"), async (req, res) => {
  try {
    if (!DEEPGRAM_API_KEY) {
      return res.status(500).json({ error: "Server missing DEEPGRAM_API_KEY" });
    }

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "No files uploaded (field name must be 'files')." });
    }

    const model = String(req.body.model || "aura-2-thalia-en");
    const container = String(req.body.container || "wav").toLowerCase(); // wav|mp3

    const longPauseDots = Number(req.body.longPauseDots || 6);
    const useSilentPause = String(req.body.useSilentPause || "false") === "true";

    // WAV params
    const encoding = String(req.body.encoding || "linear16");
    const sampleRate = Number(req.body.sampleRate || 48000);

    // MP3 params
    const bitRate = Number(req.body.bitRate || 128000);

    if (!["wav", "mp3"].includes(container)) {
      return res.status(400).json({ error: "container must be wav or mp3" });
    }

    const lex = await getLexiconCached();

    // ZIP response
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="narrations.zip"');

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      console.error("ZIP error:", err);
      if (!res.headersSent) res.status(500).json({ error: "ZIP creation failed" });
      else res.end();
    });

    archive.pipe(res);

    // Process sequentially
    for (const f of files) {
      const originalName = f.originalname || "script.txt";
      const base = originalName.replace(/\.(txt|docx)$/i, "");
      const outName = `${base}.${container}`;

      const rawText = f.buffer.toString("utf-8");

      // 1) Pause tags
      let text = applyPauseTags(rawText, { longPauseDots, useSilentPause });

      // 2) Lexicon replacements
      text = applyLexicon(text, lex.rawTerms);

      // 3) Deepgram speak (chunked)
      const audioBuf = await deepgramSpeakChunked({
        apiKey: DEEPGRAM_API_KEY,
        text,
        model,
        container,
        encoding,
        sampleRate,
        bitRate,
      });

      archive.append(audioBuf, { name: outName });
    }

    await archive.finalize();
  } catch (e) {
    console.error("Narrate batch error:", e);
    if (!res.headersSent) {
      res.status(500).json({ error: String(e?.message || e) });
    } else {
      try {
        res.end();
      } catch {}
    }
  }
});

// ----- Start -----
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
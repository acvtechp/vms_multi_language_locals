import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";

// 🔑 Keys are loaded from .env (GEMINI_API_KEY_1, GEMINI_API_KEY_2, GEMINI_API_KEY_3)
try {
  process.loadEnvFile();
} catch {
  // No .env file — fall back to variables already set in the environment
}

const API_KEYS = [
  process.env.GEMINI_API_KEY_1
].filter(Boolean);

// Your updated language list
const languages = ["ar", "as", "bn", "de", "el", "es", "fa", "fr", "gu", "he", "hi", "id", "it", "ja", "kn", "ko", "mai", "ml", "mr", "ms", "nl", "or", "pa", "pl", "pt", "ro", "ru", "sw", "ta", "te", "th", "tr", "uk", "ur", "vi", "zh"];
const SOURCE_FILE = "locales/en.json";
// Snapshot of en.json from the last completed run, used to detect changed English values.
// Kept outside locales/ so it isn't published with the package.
const SNAPSHOT_FILE = "en.last-translated.json";

const BATCH_SIZE = 250;
const DELAY_BETWEEN_BATCHES = 1500;
const MAX_CHUNK_RETRIES = 4;

let currentKeyIndex = 0;

function getModelInstance(key) {
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({
    model: "gemini-3.5-flash-lite",
    generationConfig: { responseMimeType: "application/json" }
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const source = JSON.parse(fs.readFileSync(SOURCE_FILE, "utf8"));
// No snapshot yet (first run) -> null, meaning nothing counts as changed; this run creates the baseline.
const snapshot = fs.existsSync(SNAPSHOT_FILE)
  ? JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"))
  : null;

function getFlatEntries(obj, currentPath = []) {
  let entries = [];
  for (const key of Object.keys(obj)) {
    const path = [...currentPath, key];
    if (typeof obj[key] === "string") {
      entries.push({ path, value: obj[key], translated: "" });
    } else if (typeof obj[key] === "object" && obj[key] !== null) {
      entries = entries.concat(getFlatEntries(obj[key], path));
    }
  }
  return entries;
}

// Helper to safely get a value from a deeply nested object
function getValueByPath(obj, path) {
  let current = obj;
  for (const key of path) {
    if (current === undefined || current === null) return undefined;
    current = current[key];
  }
  return current;
}

function rebuildObject(entries) {
  const result = {};
  for (const entry of entries) {
    let current = result;
    for (let i = 0; i < entry.path.length; i++) {
      const part = entry.path[i];
      if (i === entry.path.length - 1) {
        current[part] = entry.translated;
      } else {
        current[part] = current[part] || {};
        current = current[part];
      }
    }
  }
  return result;
}

async function run() {
  if (API_KEYS.length === 0) {
    console.error("❌ Please provide at least one valid Gemini API Key in .env (GEMINI_API_KEY_1..3).");
    process.exit(1);
  }

  let model = getModelInstance(API_KEYS[currentKeyIndex]);

  for (const lang of languages) {
    const outputFile = `locales/${lang}.json`;
    let existingData = {};

    // Load existing translations if the file exists
    if (fs.existsSync(outputFile)) {
      existingData = JSON.parse(fs.readFileSync(outputFile, "utf8"));
      console.log(`\n🌍 Checking [${lang}] for new strings...`);
    } else {
      console.log(`\n🌍 Translating new file [${lang}] via Gemini AI...`);
    }

    const sourceEntries = getFlatEntries(source);
    const finalEntries = [];
    const entriesToTranslate = [];

    let changedCount = 0;

    // Compare source strings against existing translations
    for (const entry of sourceEntries) {
      const existingValue = getValueByPath(existingData, entry.path);
      const previousEnglish = snapshot ? getValueByPath(snapshot, entry.path) : undefined;
      const englishChanged = previousEnglish !== undefined && previousEnglish !== entry.value;
      if (englishChanged && existingValue !== undefined && existingValue !== "") changedCount++;

      if (existingValue !== undefined && existingValue !== "" && !englishChanged) {
        // We already have this translated, just map it over
        finalEntries.push({ ...entry, translated: existingValue });
      } else {
        // Missing/empty in the target file, or the English value changed: needs translation
        const newEntry = { ...entry, translated: "" };
        entriesToTranslate.push(newEntry);
        finalEntries.push(newEntry); // By reference, so it updates when translated
      }
    }

    const totalLines = entriesToTranslate.length;

    if (totalLines === 0) {
      console.log(`   ✅ No new strings found. Structure updated and saved.`);
      // We still rebuild and save to ensure the file order exactly matches en.json
      const outputStructure = rebuildObject(finalEntries);
      fs.writeFileSync(outputFile, JSON.stringify(outputStructure, null, 2));
      continue;
    }

    console.log(`   Found ${totalLines} strings to translate (${totalLines - changedCount} missing, ${changedCount} changed in English). Processing in ${Math.ceil(totalLines / BATCH_SIZE)} hyper-optimized chunks.`);

    let chunkRetryCount = 0;

    for (let i = 0; i < totalLines;) {
      const chunk = entriesToTranslate.slice(i, i + BATCH_SIZE);
      const batchPayload = {};
      chunk.forEach((e, idx) => { batchPayload[idx] = e.value; });

      const prompt = `You are an expert localization engine for a mobile application. 
Translate the values of the following JSON object into the language code "${lang}". 
Rules:
1. Ensure all strings are strictly valid JSON with all quotes properly escaped (\\").
2. Keep placeholders (e.g. {{name}}, {0}, %s), HTML tags, layout symbols, and technical variables completely intact.
3. Return ONLY a single raw valid JSON object matching the exact input keys.`;

      try {
        const result = await model.generateContent([prompt, JSON.stringify(batchPayload)]);
        let responseText = result.response.text().trim();

        // Strip markdown backticks if model wraps the output
        if (responseText.startsWith("```json")) responseText = responseText.slice(7);
        if (responseText.startsWith("```")) responseText = responseText.slice(3);
        if (responseText.endsWith("```")) responseText = responseText.slice(0, -3);
        responseText = responseText.trim();

        const translatedJson = JSON.parse(responseText);

        chunk.forEach((entry, idx) => {
          entry.translated = translatedJson[idx] || entry.value;
        });

        // Batch succeeded: advance loop and reset retry counter
        i += BATCH_SIZE;
        chunkRetryCount = 0;
        const completedCount = Math.min(i, totalLines);
        console.log(`   Progress: ${completedCount}/${totalLines} missing lines translated.`);
        await sleep(DELAY_BETWEEN_BATCHES);

      } catch (err) {
        const errMsg = err.message.toLowerCase();

        if (errMsg.includes("429") || errMsg.includes("quota")) {
          console.warn(`   ⚠️ Key index ${currentKeyIndex} hit the Per-Minute rate limit.`);
          currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;

          if (currentKeyIndex === 0) {
            console.log(`   ⏳ All keys are cooling down. Waiting 60 seconds...`);
            await sleep(60000);
          } else {
            console.log(`   🔄 Rotating to API Key index ${currentKeyIndex}...`);
          }

          model = getModelInstance(API_KEYS[currentKeyIndex]);
          // Does NOT increment i -> retries same chunk
        }
        else if (errMsg.includes("503") || errMsg.includes("service unavailable") || errMsg.includes("high demand")) {
          console.warn(`   ⚠️ Server overloaded (503). Retrying this chunk in 15 seconds...`);
          await sleep(15000);
          // Does NOT increment i -> retries same chunk
        }
        else {
          // JSON parsing failure or syntax glitch
          chunkRetryCount++;
          console.warn(`   ⚠️ Syntax / parse error at chunk ${i} (attempt ${chunkRetryCount}/${MAX_CHUNK_RETRIES}): ${err.message}`);

          if (chunkRetryCount < MAX_CHUNK_RETRIES) {
            console.log(`   🔁 Retrying chunk ${i} in 3 seconds...`);
            await sleep(3000);
            // Does NOT increment i -> requests a fresh response from Gemini
          } else {
            // Only after multiple failed attempts do we move on
            console.error(`   ❌ Failed chunk ${i} after ${MAX_CHUNK_RETRIES} attempts. Falling back to english for these keys.`);
            chunk.forEach(entry => entry.translated = entry.value);
            i += BATCH_SIZE;
            chunkRetryCount = 0;
          }
        }
      }
    }

    // Rebuild uses `finalEntries`, which contains BOTH existing translations and new translations
    const outputStructure = rebuildObject(finalEntries);
    fs.writeFileSync(
      outputFile,
      JSON.stringify(outputStructure, null, 2)
    );

    console.log(`✅ ${lang}.json completely updated!\n`);
  }

  // Only saved after every language finished, so an interrupted run re-detects the changes next time
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(source, null, 2));
  console.log(`📸 Saved English snapshot to ${SNAPSHOT_FILE}`);
}

run();

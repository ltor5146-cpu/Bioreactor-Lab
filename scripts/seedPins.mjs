#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
//  PIN Code Generator & Firebase Seeder
//  Generates 550 unique, cryptographically secure PIN codes and uploads
//  them to Firestore `validPins` collection.
//
//  Usage:  node scripts/seedPins.mjs
//  Re-run: Safe — skips PINs that already exist in Firestore.
// ══════════════════════════════════════════════════════════════════════════════

import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, getDoc } from "firebase/firestore";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Firebase Config (same as the app) ───────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyBGNHG4rxvrCPbikT-nVHipsniP8g3tfV8",
  authDomain: "bioreactor-27862.firebaseapp.com",
  projectId: "bioreactor-27862",
  storageBucket: "bioreactor-27862.firebasestorage.app",
  messagingSenderId: "660843396690",
  appId: "1:660843396690:web:6232013de06210f814a98b",
  measurementId: "G-DJB8Y9FDGF",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ─── PIN Generation Config ───────────────────────────────────────────────────
const PIN_COUNT = 550;
const PIN_LENGTH = 8; // Consistent with existing ~7 char format, fits within maxLength=12

// Character pools
const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const SPECIALS = "#@%&!$*?-";
const ALL_CHARS = UPPERCASE + LOWERCASE + DIGITS + SPECIALS;

// ─── Secure Random Helpers ───────────────────────────────────────────────────

/** Pick one random character from a string using crypto.randomBytes */
function secureRandomChar(charset) {
  // Use rejection sampling to avoid modulo bias
  const max = Math.floor(256 / charset.length) * charset.length;
  let byte;
  do {
    byte = randomBytes(1)[0];
  } while (byte >= max);
  return charset[byte % charset.length];
}

/**
 * Generate a single PIN that is guaranteed to contain at least one character
 * from each required category (uppercase, lowercase, digit, special).
 */
function generatePin() {
  const chars = [];

  // 1. Guarantee at least one from each category
  chars.push(secureRandomChar(UPPERCASE));
  chars.push(secureRandomChar(LOWERCASE));
  chars.push(secureRandomChar(DIGITS));
  chars.push(secureRandomChar(SPECIALS));

  // 2. Fill remaining positions from the full charset
  for (let i = chars.length; i < PIN_LENGTH; i++) {
    chars.push(secureRandomChar(ALL_CHARS));
  }

  // 3. Cryptographically shuffle using Fisher-Yates with secure randomness
  for (let i = chars.length - 1; i > 0; i--) {
    const max = Math.floor(256 / (i + 1)) * (i + 1);
    let byte;
    do {
      byte = randomBytes(1)[0];
    } while (byte >= max);
    const j = byte % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}

/**
 * Generate `count` unique PINs.
 */
function generateUniquePins(count) {
  const pins = new Set();
  let attempts = 0;
  const maxAttempts = count * 20; // Safety limit

  while (pins.size < count && attempts < maxAttempts) {
    pins.add(generatePin());
    attempts++;
  }

  if (pins.size < count) {
    throw new Error(`Could only generate ${pins.size}/${count} unique PINs after ${maxAttempts} attempts`);
  }

  console.log(`✅ Generated ${pins.size} unique PINs (${attempts} attempts, 0 duplicates)`);
  return Array.from(pins);
}

// ─── Firestore Upload ────────────────────────────────────────────────────────

async function uploadPins(pins) {
  let created = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`\n📤 Uploading ${pins.length} PINs to Firestore collection "validPins"...`);

  // Process in batches to avoid overwhelming the connection
  const BATCH_SIZE = 25;
  for (let i = 0; i < pins.length; i += BATCH_SIZE) {
    const batch = pins.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (pin) => {
      try {
        // Use PIN as document ID for O(1) lookups
        const docRef = doc(db, "validPins", pin);
        const existing = await getDoc(docRef);

        if (existing.exists()) {
          skipped++;
          return;
        }

        await setDoc(docRef, {
          pin: pin,
          status: "unused",
          createdAt: new Date().toISOString(),
          usedBy: null,
          usedAt: null,
        });
        created++;
      } catch (err) {
        failed++;
        console.error(`  ❌ Failed to upload PIN: ${err.message}`);
      }
    });

    await Promise.all(promises);

    // Progress update
    const progress = Math.min(i + BATCH_SIZE, pins.length);
    process.stdout.write(`\r  Progress: ${progress}/${pins.length} (${Math.round(progress / pins.length * 100)}%)`);
  }

  console.log(`\n\n📊 Upload Summary:`);
  console.log(`   ✅ Created: ${created}`);
  console.log(`   ⏭️  Skipped (already exist): ${skipped}`);
  if (failed > 0) console.log(`   ❌ Failed: ${failed}`);
  console.log();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Bioreactor Lab — PIN Code Generator & Seeder");
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log(`  Count:      ${PIN_COUNT}`);
  console.log(`  Length:     ${PIN_LENGTH} characters`);
  console.log(`  Charset:    A-Z, a-z, 0-9, ${SPECIALS}`);
  console.log(`  Guarantees: Each PIN has ≥1 uppercase, lowercase, digit, special`);
  console.log(`  Method:     crypto.randomBytes (CSPRNG)\n`);

  // 1. Generate PINs
  const pins = generateUniquePins(PIN_COUNT);

  // 2. Save to JSON for reference
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const jsonPath = join(__dirname, "generated_pins.json");
  const jsonData = {
    generatedAt: new Date().toISOString(),
    count: pins.length,
    pinLength: PIN_LENGTH,
    charset: `A-Z, a-z, 0-9, ${SPECIALS}`,
    pins: pins.map((pin, i) => ({ index: i + 1, pin, status: "unused" })),
  };
  writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
  console.log(`💾 Saved PIN list to: ${jsonPath}`);

  // 3. Upload to Firestore
  await uploadPins(pins);

  console.log("🎉 Done! PINs are now available in Firestore.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n💥 Fatal error:", err);
  process.exit(1);
});

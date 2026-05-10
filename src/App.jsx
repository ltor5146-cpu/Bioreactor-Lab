import { useState, useEffect, useRef, useCallback } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc, getDoc, getDocs, updateDoc, addDoc, collection, query, where, increment, arrayUnion } from "firebase/firestore";

// ══════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════════════════
// PIN validation is handled via Firestore `validPins` collection
// Each valid PIN allows up to 10 uses, tracked in `usageCount`
// Every attempt (new_session or reset) is logged in `pinAttempts` collection
const MAX_PIN_USES = 10;
// ⚠️ TESTING ONLY — Remove before production: gives test PIN 1000 attempts instead of 10
const getMaxPinUses = (pin) => pin === TEST_PIN ? 1000 : MAX_PIN_USES;

// ⚠️ TESTING ONLY — Remove before production
// This test PIN auto-seeds into Firestore on app load.
// To reset the counter: go to Firebase Console → Firestore → validPins → "TEST@1234!" → set usageCount to 0
const TEST_PIN = "TEST@1234!";

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBGNHG4rxvrCPbikT-nVHipsniP8g3tfV8",
  authDomain: "bioreactor-27862.firebaseapp.com",
  projectId: "bioreactor-27862",
  storageBucket: "bioreactor-27862.firebasestorage.app",
  messagingSenderId: "660843396690",
  appId: "1:660843396690:web:6232013de06210f814a98b",
  measurementId: "G-DJB8Y9FDGF"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ⚠️ TESTING ONLY — Auto-seed the test PIN into Firestore if it doesn't exist
(async () => {
  try {
    const testPinRef = doc(db, "validPins", TEST_PIN);
    const testPinDoc = await getDoc(testPinRef);
    if (!testPinDoc.exists()) {
      await setDoc(testPinRef, {
        pin: TEST_PIN,
        status: "unused",
        usageCount: 0,
        createdAt: new Date().toISOString(),
        isTestPin: true,
        usedBy: null,
        usedAt: null,
      });
      console.log("✅ Test PIN seeded into Firestore:", TEST_PIN);
    }
  } catch (e) { /* silent fail on seed */ }
})();

// ══════════════════════════════════════════════════════════════════════════════
//  FIELD COMPONENT
// ══════════════════════════════════════════════════════════════════════════════
function Field({ label, id, type = "text", value, onChange, error, placeholder, icon, maxLength }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ marginBottom: 18 }}>
      <label htmlFor={id} style={{
        display: "flex", alignItems: "center", gap: 6,
        fontSize: 11, fontWeight: 700, letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: focused ? "#059669" : "#6b7280",
        marginBottom: 7, transition: "color 0.2s",
        fontFamily: "'DM Mono', monospace",
      }}>
        <span style={{ fontSize: 14 }}>{icon}</span> {label}
      </label>
      <input
        id={id} type={type} value={value} maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoComplete="off"
        style={{
          width: "100%", padding: "11px 14px",
          background: focused ? "#f0fdf4" : "#f9fafb",
          border: `1.5px solid ${error ? "#ef4444" : focused ? "#059669" : "#e5e7eb"}`,
          borderRadius: 10, color: "#111827", fontSize: 14.5,
          fontFamily: "'DM Sans', sans-serif", outline: "none",
          transition: "all 0.2s", boxSizing: "border-box",
          boxShadow: focused ? "0 0 0 3px rgba(5,150,105,0.1)" : "0 1px 2px rgba(0,0,0,0.04)",
        }}
      />
      {error && (
        <p style={{ color: "#ef4444", fontSize: 11, marginTop: 5, fontFamily: "'DM Mono', monospace", display: "flex", alignItems: "center", gap: 4 }}>
          ⚠ {error}
        </p>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  LANDING FORM
// ══════════════════════════════════════════════════════════════════════════════
function LandingForm({ onAccessGranted }) {
  const [form, setForm] = useState({ fullName: "", studentId: "", university: "", faculty: "", courseName: "", courseCode: "", pin: "" });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState("idle");
  const [serverError, setServerError] = useState("");
  const [locationData, setLocationData] = useState({ ip: "unknown", country: "", city: "", latitude: "", longitude: "" });
  const [submitted, setSubmitted] = useState(false);
  const sessionKeyRef = useRef(null);

  // Determine trial type: "reset" if user clicked RESET, otherwise "new_session"
  const [trialType] = useState(() => {
    const stored = sessionStorage.getItem("bioreactor_trialType");
    sessionStorage.removeItem("bioreactor_trialType"); // consume the flag
    return stored || "new_session";
  });

  // Fetch geo-IP location data silently in background (HTTPS endpoint)
  useEffect(() => {
    fetch("https://ipapi.co/json/")
      .then(r => r.json())
      .then(d => {
        if (d && d.ip) {
          setLocationData({
            ip: d.ip || "unknown",
            country: d.country_name || d.country || "",
            city: d.city || "",
            latitude: String(d.latitude || ""),
            longitude: String(d.longitude || ""),
          });
        } else { throw new Error("Invalid response"); }
      })
      .catch(() => {
        // Fallback: try ipwho.is (also HTTPS)
        fetch("https://ipwho.is/")
          .then(r => r.json())
          .then(d => setLocationData({
            ip: d.ip || "unknown",
            country: d.country || "",
            city: d.city || "",
            latitude: String(d.latitude || ""),
            longitude: String(d.longitude || ""),
          }))
          .catch(() => {
            // Last resort: IP only
            fetch("https://api.ipify.org?format=json")
              .then(r => r.json())
              .then(d => setLocationData(prev => ({ ...prev, ip: d.ip })))
              .catch(() => { });
          });
      });
  }, []);

  useEffect(() => {
    if (!submitted) return;
    const startTime = Date.now();
    const log = () => {
      if (!sessionKeyRef.current) return;
      const endTime = Date.now();
      const durationMin = ((endTime - startTime) / 60000).toFixed(2);
      updateDoc(doc(db, "sessions", sessionKeyRef.current), {
        "Exit Time": new Date().toISOString(),
        "Current Session Duration (min)": durationMin,
        "overallExitTime": new Date().toISOString(),
      }).catch(() => { });
    };
    window.addEventListener("beforeunload", log);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") log(); });
    return () => window.removeEventListener("beforeunload", log);
  }, [submitted]);

  const set = (k) => (v) => { setForm(f => ({ ...f, [k]: v })); if (errors[k]) setErrors(e => ({ ...e, [k]: "" })); };

  const validate = () => {
    const e = {};
    if (!form.fullName.trim()) e.fullName = "Full name is required";
    if (!form.studentId.trim()) e.studentId = "Student ID is required";
    if (!form.university.trim()) e.university = "University is required";
    if (!form.faculty.trim()) e.faculty = "Faculty is required";
    if (!form.courseName.trim()) e.courseName = "Course name is required";
    if (!form.courseCode.trim()) e.courseCode = "Course code is required";
    if (!form.pin.trim()) e.pin = "PIN code is required";
    return e;
  };

  const handleSubmit = async () => {
    const errs = validate();
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    if (status === "loading" || status === "success") return;
    setStatus("loading"); setServerError("");

    // ── Validate PIN against Firestore `validPins` collection ──
    const enteredPin = form.pin.trim();
    try {
      const pinDocRef = doc(db, "validPins", enteredPin);
      const pinDoc = await getDoc(pinDocRef);

      if (!pinDoc.exists()) {
        setErrors({ pin: "Invalid PIN — check with your instructor" });
        setStatus("idle");
        return;
      }

      const pinData = pinDoc.data();
      const currentUsage = pinData.usageCount || 0;

      // Check if PIN has exceeded max uses
      if (currentUsage >= getMaxPinUses(enteredPin)) {
        setErrors({ pin: "You have reached your maximum number of attempts. Please contact your instructor." });
        setStatus("idle");
        return;
      }

      const newUsageCount = currentUsage + 1;
      const attemptTimestamp = new Date().toISOString();

      // Increment usage count and update PIN document
      await updateDoc(pinDocRef, {
        usageCount: increment(1),
        lastUsedBy: form.studentId.trim(),
        lastUsedAt: attemptTimestamp,
        status: newUsageCount >= getMaxPinUses(enteredPin) ? "exhausted" : "active",
      });

      // Log this attempt to `pinAttempts` collection
      addDoc(collection(db, "pinAttempts"), {
        pin_code: enteredPin,
        student_id: form.studentId.trim(),
        attempt_number: newUsageCount,
        trial_type: trialType,
        attempt_type: "new_session",
        timestamp: attemptTimestamp,
        location: { ...locationData },
      }).catch((err) => console.error("Failed to log attempt:", err));

    } catch (err) {
      console.error("PIN validation error:", err);
      setServerError("Unable to validate PIN. Please try again.");
      setStatus("idle");
      return;
    }

    const entryTime = new Date().toISOString();
    const studentId = form.studentId.trim();

    // ── Consolidate: find existing session doc by PIN or Student ID ──
    let existingDocId = null;

    // Priority 1: Check if a session doc exists for this PIN
    const pinSessionRef = doc(db, "sessions", `pin_${enteredPin}`);
    try {
      const pinSessionDoc = await getDoc(pinSessionRef);
      if (pinSessionDoc.exists()) {
        existingDocId = `pin_${enteredPin}`;
      }
    } catch { /* continue to next check */ }

    // Priority 2: If no PIN match, check by Student ID
    if (!existingDocId) {
      try {
        const studentQuery = query(
          collection(db, "sessions"),
          where("Student ID", "==", studentId)
        );
        const studentSnap = await getDocs(studentQuery);
        if (!studentSnap.empty) {
          existingDocId = studentSnap.docs[0].id;
        }
      } catch { /* continue to create new */ }
    }

    const sessionKey = existingDocId || `pin_${enteredPin}`;
    sessionKeyRef.current = sessionKey;

    if (existingDocId) {
      // ── UPDATE existing document ──
      updateDoc(doc(db, "sessions", existingDocId), {
        "Last Entry Time": entryTime,
        "Exit Time": "",
        "Current Session Duration (min)": "0.00",
        "IP Address": locationData.ip,
        "Location": { ...locationData },
        "Session Key": sessionKey,
        "overallExitTime": "",
        // Update student info in case it changed
        "Full Name": form.fullName.trim(),
        "University": form.university.trim(),
        "Faculty": form.faculty.trim(),
        "Course Name": form.courseName.trim(),
        "Course Code": form.courseCode.trim(),
      }).catch(() => { });
    } else {
      // ── CREATE new document (first time for this PIN) ──
      setDoc(doc(db, "sessions", sessionKey), {
        "Full Name": form.fullName.trim(),
        "Student ID": studentId,
        "University": form.university.trim(),
        "Faculty": form.faculty.trim(),
        "Course Name": form.courseName.trim(),
        "Course Code": form.courseCode.trim(),
        "PIN": enteredPin,
        "Last Entry Time": entryTime,
        "Exit Time": "",
        "Current Session Duration (min)": "0.00",
        "IP Address": locationData.ip,
        "Location": { ...locationData },
        "Session Key": sessionKey,
        "overallEntryTime": entryTime,
        "overallExitTime": "",
        "Latest Trial": null,
        "Trials History": []
      }).catch(() => { });
    }

    setStatus("success");
    setSubmitted(true);
    setTimeout(() => onAccessGranted({
      name: form.fullName.trim(),
      sessionKey,
      pin: enteredPin,
      studentId: form.studentId.trim(),
      locationData: { ...locationData },
      trialType,
      entryTime,
    }), 2400);
  };

  // ── Success screen ─────────────────────────────────────────────────────────
  if (status === "success") return (
    <div style={pageStyle}>
      <style>{css}</style>
      <div style={successCard}>
        <div style={successIconWrap}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 26, color: "#064e3b", margin: "20px 0 8px", fontWeight: 700 }}>Access Granted</h2>
        <p style={{ color: "#6b7280", fontFamily: "'DM Sans', sans-serif", fontSize: 15, margin: 0 }}>
          Welcome, <strong style={{ color: "#111827" }}>{form.fullName.trim()}</strong>
        </p>
        <p style={{ color: "#9ca3af", fontFamily: "'DM Mono', monospace", fontSize: 11, marginTop: 10, letterSpacing: "0.06em" }}>LAUNCHING BIOREACTOR SIMULATOR…</p>
        <div style={{ height: 3, background: "#d1fae5", borderRadius: 99, marginTop: 20, overflow: "hidden" }}>
          <div className="fill-bar" style={{ height: "100%", background: "linear-gradient(90deg,#10b981,#059669)", borderRadius: 99 }} />
        </div>
      </div>
    </div>
  );

  // ── Main form ──────────────────────────────────────────────────────────────
  return (
    <div style={pageStyle}>
      <style>{css}</style>

      {/* Decorative soft blobs */}
      <div style={{ position: "fixed", top: -140, right: -140, width: 440, height: 440, borderRadius: "50%", background: "radial-gradient(circle,rgba(16,185,129,0.1),transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "fixed", bottom: -120, left: -100, width: 380, height: 380, borderRadius: "50%", background: "radial-gradient(circle,rgba(5,150,105,0.07),transparent 70%)", pointerEvents: "none" }} />

      <div className="card-in" style={outerWrap}>

        {/* ── Left accent panel ── */}
        <div style={accentPanel}>
          <div style={{ position: "relative", zIndex: 2 }}>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 27, color: "#fff", fontWeight: 700, lineHeight: 1.25, margin: "0 0 14px" }}>
              Welcome to<br />Bioreactor<br />Lab
            </h2>
            <p style={{ color: "rgba(255,255,255,0.72)", fontSize: 13, fontFamily: "'DM Sans', sans-serif", lineHeight: 1.75, margin: "0 0 28px" }}>
              A real-time microbial growth simulation environment for undergraduate students.
            </p>
            <div style={{ borderTop: "1px solid rgba(255,255,255,0.18)", paddingTop: 20 }}>
              {["Real-time growth curves", "Multi-species support", "Nutrient & pH control", "Session auto-logging"].map((f, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 11, color: "rgba(255,255,255,0.82)", fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>
                  <span style={{ width: 18, height: 18, borderRadius: "50%", background: "rgba(255,255,255,0.18)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, flexShrink: 0 }}>✓</span>
                  {f}
                </div>
              ))}
            </div>
          </div>
          {/* Decorative rings */}
          <div style={{ position: "absolute", bottom: -50, right: -50, width: 200, height: 200, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.09)" }} />
          <div style={{ position: "absolute", bottom: -15, right: -15, width: 110, height: 110, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.14)" }} />
        </div>

        {/* ── Right form panel ── */}
        <div style={formPanel}>
          {/* Header */}
          <div style={{ marginBottom: 26 }}>
            <div style={{ textAlign: "center", marginBottom: 14 }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 99, padding: "4px 12px" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981", display: "inline-block" }} />
                <span style={{ fontSize: 10.5, fontWeight: 700, color: "#065f46", letterSpacing: "0.09em", fontFamily: "'DM Mono', monospace" }}>LAB SESSION ACCESS</span>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginBottom: 10 }}>
              <img src={`${import.meta.env.BASE_URL}bridge_capital_logo.png`} alt="Bridge Capital Financial Solutions" style={{ height: 160, width: "auto", objectFit: "contain", display: "block" }} />
              <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: "clamp(20px,3vw,28px)", fontWeight: 700, color: "#111827", margin: 0, textAlign: "center" }}>Student Sign-In</h1>
            </div>
            <p style={{ color: "#9ca3af", fontSize: 13.5, fontFamily: "'DM Sans', sans-serif", margin: 0, textAlign: "center" }}>All fields are required to access the simulator.</p>
          </div>

          {/* Fields */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 16px" }}>
            <Field id="fullName" label="Full Name" icon="👤" placeholder="e.g. Layla Hassan" value={form.fullName} onChange={set("fullName")} error={errors.fullName} />
            <Field id="studentId" label="Student ID" icon="🪪" placeholder="e.g. 20231234" value={form.studentId} onChange={set("studentId")} error={errors.studentId} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 16px" }}>
            <Field id="university" label="University" icon="🏛️" placeholder="e.g. Cairo University" value={form.university} onChange={set("university")} error={errors.university} />
            <Field id="faculty" label="Faculty" icon="🎓" placeholder="e.g. Faculty of Science" value={form.faculty} onChange={set("faculty")} error={errors.faculty} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 16px" }}>
            <Field id="courseName" label="Course Name" icon="📚" placeholder="e.g. Microbial Biotechnology" value={form.courseName} onChange={set("courseName")} error={errors.courseName} />
            <Field id="courseCode" label="Course Code" icon="🔖" placeholder="e.g. BIO-401" value={form.courseCode} onChange={set("courseCode")} error={errors.courseCode} />
          </div>
          <div style={{ maxWidth: 210 }}>
            <Field id="pin" label="Access PIN" icon="🔐" type="password" placeholder="••••••••" value={form.pin} onChange={set("pin")} error={errors.pin} maxLength={12} />
          </div>

          {serverError && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", borderRadius: 8, padding: "10px 14px", fontSize: 13, fontFamily: "'DM Mono', monospace", marginBottom: 16 }}>
              ⚠ {serverError}
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={status === "loading"}
            className="submit-btn"
            style={{
              width: "100%", padding: "14px 24px",
              background: status === "loading" ? "#6ee7b7" : "linear-gradient(135deg,#10b981,#059669)",
              color: "#fff", border: "none", borderRadius: 12,
              fontSize: 15.5, fontWeight: 700, fontFamily: "'DM Sans', sans-serif",
              cursor: status === "loading" ? "not-allowed" : "pointer",
              letterSpacing: "0.02em",
              boxShadow: "0 4px 14px rgba(5,150,105,0.28)",
              transition: "all 0.2s",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            }}
          >
            {status === "loading" ? <><span className="spinner" /> Validating…</> : "Enter Laboratory →"}
          </button>

          <p style={{ color: "#d1d5db", fontSize: 11, textAlign: "center", marginTop: 14, fontFamily: "'DM Mono', monospace", lineHeight: 1.6 }}>
            🔒 Session data logged for academic purposes · Entry &amp; exit times recorded
          </p>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  STYLES
// ══════════════════════════════════════════════════════════════════════════════
const pageStyle = {
  minHeight: "100vh",
  background: "linear-gradient(150deg,#f0fdf4 0%,#ffffff 45%,#f8fafc 100%)",
  display: "flex", alignItems: "center", justifyContent: "center",
  padding: "24px 16px", position: "relative", overflow: "hidden",
  fontFamily: "'DM Sans', sans-serif",
};

const outerWrap = {
  display: "flex", width: "100%", maxWidth: 860,
  background: "#ffffff",
  borderRadius: 20,
  boxShadow: "0 4px 6px rgba(0,0,0,0.04), 0 20px 60px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.05)",
  overflow: "hidden",
  position: "relative", zIndex: 5,
  flexWrap: "wrap",
};

const accentPanel = {
  background: "linear-gradient(160deg,#065f46 0%,#047857 60%,#059669 100%)",
  padding: "40px 30px",
  width: "100%", maxWidth: 250,
  flexShrink: 0,
  position: "relative",
  overflow: "hidden",
};

const formPanel = {
  flex: 1, minWidth: 280,
  padding: "36px 36px 28px",
  background: "#fff",
};

const successCard = {
  background: "#fff", borderRadius: 20, padding: "52px 48px", textAlign: "center",
  maxWidth: 400, width: "100%",
  boxShadow: "0 20px 60px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.05)",
  position: "relative", zIndex: 5,
};

const successIconWrap = {
  width: 72, height: 72, borderRadius: "50%",
  background: "#ecfdf5", border: "2px solid #6ee7b7",
  display: "flex", alignItems: "center", justifyContent: "center",
  margin: "0 auto",
  boxShadow: "0 0 0 8px rgba(16,185,129,0.07)",
};

// ══════════════════════════════════════════════════════════════════════════════
//  CSS
// ══════════════════════════════════════════════════════════════════════════════
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,600;0,700;1,600&family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500;700&display=swap');
  * { box-sizing: border-box; }
  input::placeholder { color: #d1d5db; }

  @keyframes cardIn {
    from { opacity:0; transform:translateY(20px) scale(0.98); }
    to   { opacity:1; transform:translateY(0) scale(1); }
  }
  .card-in { animation: cardIn 0.6s cubic-bezier(0.22,1,0.36,1) both; }

  .submit-btn:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(5,150,105,0.38) !important;
  }
  .submit-btn:active:not(:disabled) { transform: translateY(0); }

  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner {
    display: inline-block; width:16px; height:16px;
    border: 2px solid rgba(255,255,255,0.35);
    border-top-color: #fff; border-radius:50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes fillBar { from{width:0%} to{width:100%} }
  .fill-bar { animation: fillBar 2.2s ease-in-out forwards; }
`;

// ══════════════════════════════════════════════════════════════════════════════
//  BIOREACTOR PLATFORM
// ══════════════════════════════════════════════════════════════════════════════

// ─── NUTRIENT SYSTEM ──────────────────────────────────────────────────────────
const NUTRIENTS = {
  glucose: {
    label: "Glucose", symbol: "C₆H₁₂O₆", color: "#f59e0b", glow: "#f59e0b33",
    hue: 38, description: "Primary carbon/energy source", unit: "g/L",
    effect: { growthBoost: 1.0, oxygenDemand: 0.8, wasteGen: 1.0 },
  },
  aminoAcids: {
    label: "Amino Acids", symbol: "NH₂-CHR-COOH", color: "#a78bfa", glow: "#a78bfa33",
    hue: 270, description: "Nitrogen source for protein synthesis", unit: "g/L",
    effect: { growthBoost: 0.7, oxygenDemand: 0.4, wasteGen: 0.6 },
  },
  oxygen: {
    label: "Dissolved O₂", symbol: "O₂", color: "#38bdf8", glow: "#38bdf833",
    hue: 200, description: "Terminal electron acceptor (aerobes)", unit: "%sat",
    effect: { growthBoost: 0.6, oxygenDemand: -0.5, wasteGen: 0.3 },
  },
  nitrogen: {
    label: "Nitrogen", symbol: "N₂/NH₄⁺", color: "#34d399", glow: "#34d39933",
    hue: 160, description: "Inorganic nitrogen for biosynthesis", unit: "mmol/L",
    effect: { growthBoost: 0.5, oxygenDemand: 0.2, wasteGen: 0.4 },
  },
  phosphate: {
    label: "Phosphate", symbol: "PO₄³⁻", color: "#f472b6", glow: "#f472b633",
    hue: 320, description: "ATP synthesis & membrane components", unit: "mmol/L",
    effect: { growthBoost: 0.4, oxygenDemand: 0.1, wasteGen: 0.3 },
  },
};

// ─── SPECIES DATA ─────────────────────────────────────────────────────────────
const BACTERIA = {
  "Escherichia coli": {
    emoji: "🦠", color: "#00e87a", glow: "#00e87a33", shape: "rod", clusterSize: 1,
    temp: { min: 35, opt: 37, max: 42 }, ph: { min: 6.0, opt: 7.0, max: 7.5 },
    oxygen: "facultative", oxygen_pref: 80, nutrients: { min: 40, opt: 80, max: 100 },
    liquidBase: [18, 60, 45], description: "Gram-negative rod, facultative anaerobe", difficulty: "Easy",
    maxDensity: 100, growthRate: 0.018, wasteRate: 0.014, nutrientConsumption: 0.012,
    preferredNutrients: ["glucose", "aminoAcids", "nitrogen"],
    funFact: "K-12 strain used in >90% of molecular biology labs worldwide.",
  },
  "Lactobacillus acidophilus": {
    emoji: "🧫", color: "#ff6eb4", glow: "#ff6eb433", shape: "rod", clusterSize: 3,
    temp: { min: 30, opt: 37, max: 43 }, ph: { min: 4.5, opt: 5.5, max: 6.5 },
    oxygen: "anaerobic", oxygen_pref: 10, nutrients: { min: 50, opt: 85, max: 100 },
    liquidBase: [60, 20, 45], description: "Gram-positive rod, obligate anaerobe", difficulty: "Medium",
    maxDensity: 90, growthRate: 0.015, wasteRate: 0.018, nutrientConsumption: 0.016,
    preferredNutrients: ["glucose", "aminoAcids"],
    funFact: "Produces lactic acid that inhibits pathogens in yogurt & probiotics.",
  },
  "Bacillus subtilis": {
    emoji: "⚗️", color: "#ffd700", glow: "#ffd70033", shape: "rod", clusterSize: 2,
    temp: { min: 25, opt: 30, max: 50 }, ph: { min: 6.5, opt: 7.0, max: 8.5 },
    oxygen: "aerobic", oxygen_pref: 90, nutrients: { min: 30, opt: 70, max: 100 },
    liquidBase: [45, 50, 20], description: "Gram-positive, spore-forming aerobe", difficulty: "Hard",
    maxDensity: 85, growthRate: 0.014, wasteRate: 0.020, nutrientConsumption: 0.010,
    preferredNutrients: ["oxygen", "glucose", "phosphate"],
    funFact: "Forms heat-resistant endospores surviving 120°C for 30 minutes.",
  },
  "Staphylococcus aureus": {
    emoji: "🔬", color: "#ff8c42", glow: "#ff8c4233", shape: "coccus", clusterSize: 4,
    temp: { min: 10, opt: 37, max: 45 }, ph: { min: 4.2, opt: 7.4, max: 9.3 },
    oxygen: "facultative", oxygen_pref: 70, nutrients: { min: 35, opt: 75, max: 100 },
    liquidBase: [50, 35, 20], description: "Gram-positive coccus, highly adaptable", difficulty: "Easy",
    maxDensity: 95, growthRate: 0.016, wasteRate: 0.015, nutrientConsumption: 0.011,
    preferredNutrients: ["glucose", "aminoAcids", "phosphate"],
    funFact: "Golden pigment (staphyloxanthin) protects against immune oxidants.",
  },
  "Pseudomonas aeruginosa": {
    emoji: "💧", color: "#38d9f5", glow: "#38d9f533", shape: "rod", clusterSize: 1,
    temp: { min: 20, opt: 37, max: 42 }, ph: { min: 5.5, opt: 7.2, max: 8.0 },
    oxygen: "aerobic", oxygen_pref: 95, nutrients: { min: 20, opt: 60, max: 100 },
    liquidBase: [10, 55, 70], description: "Gram-negative aerobe, biofilm specialist", difficulty: "Hard",
    maxDensity: 80, growthRate: 0.013, wasteRate: 0.022, nutrientConsumption: 0.009,
    preferredNutrients: ["oxygen", "nitrogen", "phosphate"],
    funFact: "Produces pyocyanin, a blue-green pigment with antimicrobial activity.",
  },
  "Vibrio natriegens": {
    emoji: "🚀", color: "#06b6d4", glow: "#06b6d433", shape: "vibrio", clusterSize: 1,
    temp: { min: 25, opt: 37, max: 42 }, ph: { min: 6.5, opt: 7.5, max: 8.5 },
    oxygen: "facultative", oxygen_pref: 75, nutrients: { min: 35, opt: 75, max: 100 },
    liquidBase: [15, 50, 65], description: "Fastest-doubling bacterium known (~10 min gen time)", difficulty: "Medium",
    maxDensity: 110, growthRate: 0.025, wasteRate: 0.030, nutrientConsumption: 0.022,
    preferredNutrients: ["glucose", "aminoAcids", "oxygen"],
    funFact: "Doubles every 9.8 minutes — outpaces E. coli by 3×.",
  },
};

function getGrowthPhase(density, health, age) {
  if (age < 20) return "lag";
  if (health <= 0 || density < 2) return "crash";
  if (health < 20) return "death";
  if (density < 30 && health > 55 && age >= 20) return "exponential";
  if (density >= 30 && density < 75 && health > 35) return "stationary";
  if (health < 35 || density >= 75) return "decline";
  return "stationary";
}
function getPhaseColor(phase) {
  return {
    lag: "#5588ff",
    exponential: "#00e87a",
    stationary: "#ffd700",
    decline: "#ff8800",
    death: "#ff4444",
    crash: "#ff0000",
  }[phase] || "#aaa";
}
function calcEnvScore(params, species) {
  const b = BACTERIA[species];
  let score = 1.0;
  const t = params.temperature;
  if (t < b.temp.min || t > b.temp.max) score -= 0.45;
  else score -= Math.abs(t - b.temp.opt) / (b.temp.max - b.temp.min) * 0.3;
  const ph = params.ph;
  if (ph < b.ph.min || ph > b.ph.max) score -= 0.45;
  else score -= Math.abs(ph - b.ph.opt) / (b.ph.max - b.ph.min) * 0.25;
  const o2 = params.oxygen;
  if (b.oxygen === "aerobic" && o2 < 50) score -= 0.3;
  else if (b.oxygen === "anaerobic" && o2 > 30) score -= 0.4;
  else score -= Math.abs(o2 - b.oxygen_pref) / 100 * 0.15;
  return Math.max(0, Math.min(1, score));
}
function calcNutrientScore(activeNutrients, species) {
  const b = BACTERIA[species];
  const preferred = b.preferredNutrients;
  let score = 0;
  let totalConc = 0;
  for (const [id, conc] of Object.entries(activeNutrients)) {
    totalConc += conc;
    if (preferred.includes(id)) score += conc * 1.2;
    else score += conc * 0.6;
  }
  if (totalConc === 0) return 0;
  return Math.min(1, score / (preferred.length * 60));
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}
function drawTube(ctx, x1, y1, x2, y2, thickness, color1, color2) {
  ctx.save();
  const dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy);
  ctx.translate(x1, y1); ctx.rotate(Math.atan2(dy, dx));
  const g = ctx.createLinearGradient(0, -thickness, 0, thickness);
  g.addColorStop(0, color1); g.addColorStop(0.4, color2); g.addColorStop(1, color1);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.roundRect(0, -thickness / 2, len, thickness, thickness / 2); ctx.fill();
  ctx.restore();
}
function drawProbe(ctx, x1, y1, x2, y2, color, label) {
  ctx.save();
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
  ctx.strokeStyle = color + "88"; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.roundRect(x2 - 3, y1 + 8, 6, y2 - y1 - 18, 3);
  const pg = ctx.createLinearGradient(x2 - 3, 0, x2 + 3, 0);
  pg.addColorStop(0, "#445566"); pg.addColorStop(0.5, color + "cc"); pg.addColorStop(1, "#788898");
  ctx.fillStyle = pg; ctx.fill();
  ctx.beginPath(); ctx.arc(x2, y2 - 9, 4, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  ctx.font = "bold 13px 'Inter','Segoe UI',sans-serif"; ctx.fillStyle = color; ctx.textAlign = "center";
  ctx.fillText(label, x2, y1 + 5); ctx.textAlign = "left";
  ctx.restore();
}

// ─── BIOREACTOR FLOW FIELD ────────────────────────────────────────────────────
// Rushton turbine stirred-tank: radial discharge at impeller, upflow at walls,
// downward return along center shaft, tangential swirl throughout.
function getBioreactorFlowVelocity(x, y, tankCx, impellerY, tankTop, tankBottom, tankHalfW, speed) {
  const dx = x - tankCx;
  const dy = y - impellerY;
  const halfH = (tankBottom - tankTop) / 2;
  const nx = dx / tankHalfW;
  const ny_imp = dy / halfH;

  // 1. Radial discharge from impeller (horizontal jet outward at impeller height)
  const impellerZone = Math.exp(-Math.abs(ny_imp) * 3.0);
  const radialV = speed * 5.0 * nx * impellerZone;

  // 2. Wall upflow - fluid travels upward near the walls
  const wallProximity = Math.pow(Math.abs(nx), 1.6);
  const wallUpV = -speed * 6.0 * wallProximity * (1 - impellerZone * 0.6);

  // 3. Center downflow - return path down the center shaft
  const centerProximity = Math.max(0, 1 - Math.abs(nx) * 2.5);
  const centerDownV = speed * 4.2 * centerProximity * (1 - impellerZone * 0.5);

  // 4. Tangential swirl (rotation about vertical axis)
  const dist2d = Math.sqrt(dx * dx + dy * dy) + 1;
  const swirlStrength = speed * 110 / (dist2d * 0.45 + 6);
  const tx = -dy / dist2d * swirlStrength * 0.40;
  const ty = dx / dist2d * swirlStrength * 0.40;

  // 5. Bottom recirculation - wraps fluid under impeller back to center
  const belowImpeller = Math.max(0, ny_imp / halfH);
  const bottomInwardV = -speed * 2.5 * nx * belowImpeller * (1 - wallProximity * 0.5);

  // 6. Upper recirculation loop (above impeller) - fluid goes inward at top, down center
  const aboveImpeller = Math.max(0, -ny_imp / halfH);
  const topInwardV = -speed * 1.5 * nx * aboveImpeller * 0.5;

  return { vx: radialV + tx + bottomInwardV + topInwardV, vy: wallUpV + centerDownV + ty };
}

// ─── BIOREACTOR CANVAS ────────────────────────────────────────────────────────
function BioreactorCanvas({ species, params, health, density, wasteToxicity, growthPhase, activeNutrients, agitatorRpm = 200, co2Level = 0, n2Flow = 0, width = 440, height = 630 }) {
  const canvasRef = useRef(null);
  const stateRef = useRef({ impellerAngle: 0, bacteria: [], bubbles: [], nutrientParticles: [], flowTracers: [], time: 0 });
  const bacterium = BACTERIA[species];

  // Initialize bacteria & nutrient particles
  useEffect(() => {
    const s = stateRef.current;
    const cx = width / 2, tankTop = 125, tankH = 360, tankW = 200;
    // Density-scaled count: 600 at low density → 2400 at max density for a truly dense culture feel
    const countBase = Math.floor(400 + (density / 100) * 1200);
    s.bacteria = Array.from({ length: Math.min(1600, countBase) }, () => ({
      x: cx + (Math.random() - 0.5) * tankW * 0.85,
      y: tankTop + 20 + Math.random() * (tankH - 40),
      vx: (Math.random() - 0.5) * 0.5, vy: (Math.random() - 0.5) * 0.5,
      angle: Math.random() * Math.PI * 2, av: (Math.random() - 0.5) * 0.06,
      size: 1.6 + Math.random() * 2.0, phase: Math.random() * Math.PI * 2,
      opacity: 0.70 + Math.random() * 0.30, wobble: 0,
      wobbleRate: 0.015 + Math.random() * 0.035,
      flagellaPhase: Math.random() * Math.PI * 2,
      depth: Math.random(),  // 0=background, 1=foreground
      curvature: (Math.random() - 0.5) * 0.6, // for vibrio curved shape
      // Per-bacterium flow memory for smoother trajectories
      flowVx: 0, flowVy: 0,
    }));
    // Flow tracer particles (show the streamlines visually) — more at high density
    s.flowTracers = Array.from({ length: 220 }, () => ({
      x: cx + (Math.random() - 0.5) * tankW * 0.8,
      y: tankTop + 10 + Math.random() * (tankH - 20),
      life: Math.random(),
      maxLife: 0.6 + Math.random() * 1.4,
      size: 1.0 + Math.random() * 1.2,
    }));
    // Create separate nutrient particles per nutrient type
    s.nutrientParticles = [];
    for (const [id, nutData] of Object.entries(NUTRIENTS)) {
      for (let i = 0; i < 16; i++) {
        s.nutrientParticles.push({
          id, hue: nutData.hue, color: nutData.color,
          x: cx + (Math.random() - 0.5) * tankW * 0.78, y: tankTop + 20 + Math.random() * (tankH - 40),
          vx: (Math.random() - 0.5) * 0.5, vy: (Math.random() - 0.5) * 0.5,
          size: 1.8 + Math.random() * 2.5, phase: Math.random() * Math.PI * 2,
        });
      }
    }
    s.bubbles = [];
  }, [species, width, height]);

  useEffect(() => {
    const s = stateRef.current;
    const cx = width / 2, tankTop = 125, tankH = 360, tankW = 200;
    const targetCount = Math.min(1600, Math.floor(400 + (density / 100) * 1200));
    while (s.bacteria.length < targetCount) {
      s.bacteria.push({
        x: cx + (Math.random() - 0.5) * tankW * 0.85, y: tankTop + 20 + Math.random() * (tankH - 40),
        vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
        angle: Math.random() * Math.PI * 2, av: (Math.random() - 0.5) * 0.06,
        size: 1.6 + Math.random() * 2.0, phase: Math.random() * Math.PI * 2,
        opacity: 0.70 + Math.random() * 0.30, wobble: 0, wobbleRate: 0.015 + Math.random() * 0.035,
        flagellaPhase: Math.random() * Math.PI * 2,
        depth: Math.random(),
        curvature: (Math.random() - 0.5) * 0.6,
        flowVx: 0, flowVy: 0,
      });
    }
    if (s.bacteria.length > targetCount) s.bacteria.splice(targetCount);
  }, [density, width, height]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let raf;
    const cx = width / 2;
    const tankLeft = cx - 100, tankRight = cx + 100;
    const tankTop = 125, tankBottom = 500, tankH = tankBottom - tankTop, tankW = 200;
    const impY = tankBottom - 110;

    // Total nutrient level for liquid color
    function getTotalNutrientLevel() {
      return Math.min(100, Object.values(activeNutrients).reduce((s, v) => s + v, 0) / Object.keys(NUTRIENTS).length);
    }

    function getLiquidRgb() {
      const b = BACTERIA[species];
      const [r0, g0, b0] = b.liquidBase;
      const phRatio = (params.ph - 4) / 10;
      const nI = getTotalNutrientLevel() / 100;
      const wasteInfluence = wasteToxicity / 100;
      // Tint based on dominant active nutrient
      let dr = 0, dg = 0, db = 0;
      let totalActive = 0;
      for (const [id, conc] of Object.entries(activeNutrients)) {
        if (conc > 0) {
          const [nr, ng, nb] = hexToRgb(NUTRIENTS[id].color);
          dr += nr * conc; dg += ng * conc; db += nb * conc; totalActive += conc;
        }
      }
      if (totalActive > 0) {
        dr /= totalActive; dg /= totalActive; db /= totalActive;
      }
      return [
        Math.round(Math.min(255, r0 * nI * (1 - wasteInfluence * 0.5) + (phRatio > 0.5 ? 15 : 55) + wasteInfluence * 40 + dr * 0.04)),
        Math.round(Math.min(255, g0 * nI * (1 - wasteInfluence * 0.6) + 30 + dg * 0.04)),
        Math.round(Math.min(255, b0 * nI * (1 - wasteInfluence * 0.5) + (phRatio < 0.5 ? 60 : 15) + db * 0.04))
      ];
    }

    function drawBacterium(ctx, bac, bacterium, hr, crowding, nutScore) {
      ctx.save();
      ctx.translate(bac.x, bac.y);
      ctx.rotate(bac.angle);
      const sickTint = Math.max(0, (crowding - 0.5) * 0.6);
      // Nutrient-starved bacteria are dimmer and smaller
      const nutFade = Math.max(0.3, nutScore);
      const depthAlpha = 0.45 + bac.depth * 0.55;
      const alpha = Math.max(0.25, bac.opacity * depthAlpha * hr * (1 - sickTint * 0.25) * nutFade);
      ctx.globalAlpha = alpha;
      const depthScale = 0.55 + bac.depth * 0.9; // foreground bacteria appear larger
      const sizeScale = depthScale * (0.85 + nutScore * 0.2); // bacteria shrink slightly when starved
      const col = sickTint > 0.3 ? "#888866" : bacterium.color;

      if (bacterium.shape === "vibrio") {
        // Curved rod / comma shape for Vibrio natriegens — true comma with tapered ends
        const len = bac.size * 4.5 * sizeScale;
        const w = bac.size * 1.15 * sizeScale;
        const curve = bac.curvature !== undefined ? bac.curvature : 0.42;
        const midBend = len * 0.62 * curve;
        // Main curved body — thick stroke for comma appearance
        ctx.lineWidth = w * 2.2;
        ctx.lineCap = "round";
        ctx.shadowColor = col; ctx.shadowBlur = 6;
        ctx.strokeStyle = col + "dd";
        ctx.beginPath();
        ctx.moveTo(-len / 2, 0);
        ctx.quadraticCurveTo(0, midBend, len / 2, 0);
        ctx.stroke();
        // Inner gradient highlight
        ctx.lineWidth = w * 1.0;
        ctx.shadowBlur = 0;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(-len / 2 + 2, midBend * 0.1);
        ctx.quadraticCurveTo(0, midBend * 0.7, len / 2 - 2, 0);
        ctx.stroke();
        // Top glint
        ctx.lineWidth = w * 0.5;
        ctx.strokeStyle = "rgba(255,255,255,0.32)";
        ctx.beginPath();
        ctx.moveTo(-len / 2 + 2, midBend * 0.1 - w * 0.3);
        ctx.quadraticCurveTo(0, midBend * 0.5 - w * 0.6, len / 2 - 2, -w * 0.3);
        ctx.stroke();
        // Single polar flagellum for Vibrio
        if (hr > 0.3 && crowding < 0.8) {
          ctx.globalAlpha = Math.max(0.05, (bac.opacity * hr - 0.25) * 0.55);
          ctx.strokeStyle = col + "66";
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          const fx0 = len / 2;
          ctx.moveTo(fx0, 0);
          for (let t = 0; t <= 1; t += 0.08) {
            const fx = fx0 + t * 10;
            const fy = Math.sin(t * Math.PI * 2.5 + bac.flagellaPhase + bac.wobble) * 2.5;
            ctx.lineTo(fx, fy);
          }
          ctx.stroke();
          ctx.globalAlpha = alpha;
        }
      } else if (bacterium.shape === "rod") {
        const len = bac.size * 4.2 * sizeScale, w = bac.size * 1.1 * sizeScale;
        // Halo/shadow for visibility on light background
        ctx.shadowColor = col;
        ctx.shadowBlur = 6;
        const bg = ctx.createLinearGradient(-len / 2, -w / 2, len / 2, w / 2);
        bg.addColorStop(0, col + "cc"); bg.addColorStop(0.5, col); bg.addColorStop(1, col + "aa");
        ctx.beginPath(); ctx.roundRect(-len / 2, -w / 2, len, w, w / 2);
        ctx.fillStyle = bg; ctx.fill();
        ctx.shadowBlur = 0;
        ctx.beginPath(); ctx.roundRect(-len / 2 + 1, -w / 2 + 0.5, len - 2, w * 0.35, 2);
        ctx.fillStyle = `rgba(255,255,255,${0.18 + bac.depth * 0.28})`; ctx.fill();
        if (hr > 0.3 && crowding < 0.7) {
          ctx.globalAlpha = Math.max(0.08, (bac.opacity * bac.depth * hr - 0.15) * 0.75);
          ctx.strokeStyle = col + "77"; ctx.lineWidth = 0.6;
          for (let f = 0; f < 2; f++) {
            ctx.beginPath();
            const fx0 = f === 0 ? -len / 2 : len / 2, fdir = f === 0 ? -1 : 1;
            ctx.moveTo(fx0, 0);
            for (let t = 0; t <= 1; t += 0.1) {
              const fx = fx0 + fdir * t * 8;
              const fy = Math.sin(t * Math.PI * 2 + bac.flagellaPhase + bac.wobble) * 3;
              ctx.lineTo(fx, fy);
            }
            ctx.stroke();
          }
          ctx.globalAlpha = alpha;
        }
      } else {
        const offsets = bacterium.clusterSize === 4
          ? [[-4.0, -4.0], [4.0, -4.0], [-4.0, 4.0], [4.0, 4.0]]
          : bacterium.clusterSize === 3 ? [[-4.5, 1.8], [4.5, 1.8], [0, -4.5]] : [[0, 0]];
        for (const [ox, oy] of offsets) {
          const sickColor = sickTint > 0.3 ? "#888866" : bacterium.color;
          const s2 = bac.size * sizeScale;
          const cg = ctx.createRadialGradient(ox - s2 * 0.3, oy - s2 * 0.3, 0.5, ox, oy, s2);
          cg.addColorStop(0, sickColor + "ff"); cg.addColorStop(0.6, sickColor + "cc"); cg.addColorStop(1, sickColor + "55");
          ctx.shadowColor = sickColor; ctx.shadowBlur = 3 + bac.depth * 8;
          ctx.beginPath(); ctx.arc(ox, oy, s2, 0, Math.PI * 2);
          ctx.fillStyle = cg; ctx.fill();
          ctx.shadowBlur = 0;
          // Inner membrane ring
          ctx.beginPath(); ctx.arc(ox, oy, s2 * 0.55, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,255,255,${0.15 + bac.depth * 0.20})`; ctx.lineWidth = 0.8; ctx.stroke();
          // Specular glint
          ctx.beginPath(); ctx.arc(ox - s2 * 0.28, oy - s2 * 0.28, s2 * 0.28, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,${0.22 + bac.depth * 0.18})`; ctx.fill();
        }
      }
      ctx.restore();
    }

    function frame(ts) {
      const s = stateRef.current;
      s.time = ts * 0.001;
      const hr = Math.max(0.03, health / 100);
      const crowding = density / 100;
      const nutScore = calcNutrientScore(activeNutrients, species);
      // Speed proportional to nutrients AND health — boosted for more visible dynamics
      const mobilityFactor = Math.max(0.05, hr * (1 - crowding * 0.5) * (0.5 + nutScore * 0.5));
      // Impeller speed driven by agitatorRpm — direct physical coupling
      const rpmFactor = agitatorRpm / 400; // normalized around 400 RPM
      const impSpeed = rpmFactor * (0.06 + hr * 0.04) * (0.6 + nutScore * 0.4);
      s.impellerAngle += impSpeed;

      ctx.clearRect(0, 0, width, height);

      // ── PIPES & TUBES ──────────────────────────────────────────────────────────
      // MEDIA inlet (left top)
      drawTube(ctx, tankLeft + 28, tankTop, tankLeft - 22, tankTop - 40, 6, "#8a9aaa", "#bcccd8");
      drawTube(ctx, tankLeft - 22, tankTop - 40, tankLeft - 22, tankTop - 90, 6, "#8a9aaa", "#bcccd8");
      // O₂ inlet (right top)
      drawTube(ctx, tankRight - 28, tankTop, tankRight + 18, tankTop - 40, 6, "#5090c0", "#80c0f8");
      drawTube(ctx, tankRight + 18, tankTop - 40, tankRight + 18, tankTop - 90, 6, "#5090c0", "#80c0f8");
      // EFFLUENT out (right bottom)
      drawTube(ctx, tankRight - 2, tankBottom - 68, tankRight + 44, tankBottom - 68, 7, "#7a8a99", "#aabbc8");
      drawTube(ctx, tankRight + 38, tankBottom - 68, tankRight + 38, tankBottom - 20, 7, "#7a8a99", "#aabbc8");

      // ── CO₂ EXHAUST PIPE (left side, top) ──────────────────────────────────────
      // CO2 exits from top-left, goes up to vent — purple/violet color
      const co2PipeX = tankLeft - 48;
      drawTube(ctx, tankLeft + 10, tankTop + 30, co2PipeX, tankTop - 10, 5, "#7a40a0", "#c070f0");
      drawTube(ctx, co2PipeX, tankTop - 10, co2PipeX, tankTop - 80, 5, "#7a40a0", "#c070f0");
      // CO2 vent cap
      ctx.save();
      ctx.beginPath(); ctx.roundRect(co2PipeX - 8, tankTop - 88, 16, 10, 3);
      ctx.fillStyle = "#9050c0"; ctx.fill(); ctx.restore();
      // CO2 label
      ctx.font = "bold 13px 'Inter','Segoe UI',sans-serif"; ctx.fillStyle = "#9060c0";
      ctx.textAlign = "center";
      ctx.fillText("CO₂", co2PipeX, tankTop - 92);
      ctx.fillText("OUT", co2PipeX, tankTop - 82);
      ctx.textAlign = "left";
      // Animated CO2 bubbles in pipe — intensity scales with co2Level
      if (co2Level > 5) {
        const co2Alpha = Math.min(0.9, co2Level / 80);
        for (let b2 = 0; b2 < 3; b2++) {
          const bProgress = ((s.time * (1.2 + b2 * 0.4) + b2 * 0.33) % 1);
          const bx = tankLeft + 10 + (co2PipeX - tankLeft - 10) * Math.min(bProgress * 2, 1);
          const by = tankTop + 30 + (tankTop - 10 - tankTop - 30) * Math.min(bProgress * 2, 1);
          const by2 = bProgress > 0.5 ? tankTop - 10 + (tankTop - 80 - tankTop - 10) * ((bProgress - 0.5) * 2) : by;
          const drawX = bProgress > 0.5 ? co2PipeX : bx;
          const drawY = bProgress > 0.5 ? by2 : by;
          ctx.save();
          ctx.globalAlpha = co2Alpha * (0.4 + Math.sin(s.time * 4 + b2) * 0.3);
          ctx.beginPath(); ctx.arc(drawX, drawY, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(180,80,255,0.8)`; ctx.fill();
          ctx.restore();
        }
      }
      // CO2 level readout on pipe
      ctx.font = "bold 14px 'Inter','Segoe UI',sans-serif";
      const co2Color = co2Level < 30 ? "#9060c0" : co2Level < 60 ? "#ff8800" : "#ff2200";
      ctx.fillStyle = co2Color;
      ctx.textAlign = "center";
      ctx.fillText(`${co2Level.toFixed(0)}%`, co2PipeX, tankTop - 4);
      ctx.textAlign = "left";

      // ── N₂ INLET PIPE (far left, bottom half) ──────────────────────────────────
      // N2 enters from bottom-left, used for O2 stripping or nitrogen blanketing
      const n2PipeX = tankLeft - 30;
      drawTube(ctx, tankLeft + 8, tankBottom - 120, n2PipeX - 8, tankBottom - 120, 5, "#206040", "#40c080");
      drawTube(ctx, n2PipeX - 8, tankBottom - 200, n2PipeX - 8, tankBottom - 110, 5, "#206040", "#40c080");
      // N2 valve body
      ctx.save();
      ctx.beginPath(); ctx.roundRect(n2PipeX - 16, tankBottom - 220, 16, 22, 3);
      ctx.fillStyle = "#c8ecd8"; ctx.fill();
      ctx.strokeStyle = "#40c080"; ctx.lineWidth = 1; ctx.stroke();
      ctx.font = "bold 12px 'Inter','Segoe UI',sans-serif"; ctx.fillStyle = "#40c080"; ctx.textAlign = "center";
      ctx.fillText("N₂", n2PipeX - 8, tankBottom - 232);
      ctx.fillText("IN", n2PipeX - 8, tankBottom - 222);
      ctx.textAlign = "left"; ctx.restore();
      // N2 flow readout
      const n2Color = n2Flow < 5 ? "#206040" : n2Flow < 50 ? "#40c080" : "#80ffb0";
      ctx.font = "bold 14px 'Inter','Segoe UI',sans-serif"; ctx.fillStyle = n2Color;
      ctx.textAlign = "center";
      ctx.fillText(`${n2Flow.toFixed(0)}%`, n2PipeX - 8, tankBottom - 105);
      ctx.textAlign = "left";
      // Animated N2 flow particles
      if (n2Flow > 5) {
        const n2Alpha = Math.min(0.85, n2Flow / 70);
        for (let p2 = 0; p2 < 4; p2++) {
          const pProgress = ((s.time * (0.8 + p2 * 0.2) + p2 * 0.25) % 1);
          // Flow goes right from valve into tank
          const px = n2PipeX - 8 + (tankLeft + 8 - n2PipeX + 8) * pProgress;
          const py = tankBottom - 120;
          ctx.save();
          ctx.globalAlpha = n2Alpha * (0.5 + Math.sin(s.time * 3 + p2) * 0.3);
          ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(64,192,128,0.9)`; ctx.fill();
          ctx.restore();
        }
      }

      // Labels for existing tubes
      ctx.font = "bold 14px 'Inter','Segoe UI',sans-serif"; ctx.fillStyle = "#445566";
      ctx.fillText("MEDIA", tankLeft - 58, tankTop - 96);
      ctx.fillStyle = "#3060a0"; ctx.fillText("O₂ IN", tankRight + 4, tankTop - 96);
      ctx.fillStyle = "#445566"; ctx.fillText("OUT", tankRight + 44, tankBottom - 10);

      // MOTOR
      ctx.save();
      const mg = ctx.createLinearGradient(cx - 35, 0, cx + 35, 0);
      mg.addColorStop(0, "#dde6f0"); mg.addColorStop(0.35, "#5a6a7a"); mg.addColorStop(0.5, "#8a9aaa");
      mg.addColorStop(0.65, "#5a6a7a"); mg.addColorStop(1, "#dde6f0");
      ctx.fillStyle = mg; ctx.beginPath(); ctx.roundRect(cx - 35, tankTop - 60, 70, 44, 6); ctx.fill();
      ctx.strokeStyle = "#788898"; ctx.lineWidth = 1;
      for (let i = -4; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(cx + i * 7, tankTop - 60); ctx.lineTo(cx + i * 7, tankTop - 18); ctx.stroke(); }
      ctx.font = "bold 12px 'Inter','Segoe UI',sans-serif"; ctx.fillStyle = "#7a8898"; ctx.textAlign = "center";
      ctx.fillText("MOTOR DRIVE", cx, tankTop - 44);
      // RPM readout on motor
      const rpmColor2 = agitatorRpm < 100 ? "#ff8800" : agitatorRpm > 600 ? "#ff2200" : "#80c0d0";
      ctx.fillStyle = rpmColor2; ctx.font = "bold 14px 'Inter','Segoe UI',sans-serif";
      ctx.fillText(`${agitatorRpm} RPM`, cx, tankTop - 31);
      ctx.textAlign = "left"; ctx.restore();

      // SHAFT
      ctx.save();
      const sg = ctx.createLinearGradient(cx - 3, 0, cx + 3, 0);
      sg.addColorStop(0, "#445566"); sg.addColorStop(0.35, "#b0c8d4"); sg.addColorStop(1, "#445566");
      ctx.fillStyle = sg; ctx.fillRect(cx - 3, tankTop - 18, 6, tankH + 18); ctx.restore();

      // PROBES
      drawProbe(ctx, tankLeft + 22, tankTop + 44, tankLeft + 22, tankTop + 168, "#ff5555", "T");
      drawProbe(ctx, tankRight - 22, tankTop + 68, tankRight - 22, tankTop + 206, "#9060e8", "pH");
      drawProbe(ctx, tankRight - 22, tankTop + 244, tankRight - 22, tankTop + 330, "#2890e0", "DO");

      // LIQUID
      const liqY = tankTop + tankH * (1 - Math.min(1, health / 100));
      const [lr, lg2, lb] = getLiquidRgb();
      ctx.save();
      ctx.beginPath(); ctx.rect(tankLeft + 7, tankTop, tankW - 14, tankH); ctx.clip();

      const liquidGrad = ctx.createLinearGradient(tankLeft, liqY, tankRight, tankBottom);
      liquidGrad.addColorStop(0, `rgba(${lr},${lg2},${lb},0.82)`);
      liquidGrad.addColorStop(0.4, `rgba(${lr},${lg2},${lb},0.70)`);
      liquidGrad.addColorStop(1, `rgba(${Math.min(255, lr + 20)},${Math.min(255, lg2 + 15)},${Math.min(255, lb + 10)},0.88)`);
      ctx.fillStyle = liquidGrad;
      ctx.fillRect(tankLeft + 7, liqY, tankW - 14, tankBottom - liqY);

      if (wasteToxicity > 20) {
        ctx.globalAlpha = (wasteToxicity - 20) / 100 * 0.35;
        ctx.fillStyle = `rgba(80,40,10,0.8)`;
        ctx.fillRect(tankLeft + 7, liqY, tankW - 14, tankBottom - liqY);
        ctx.globalAlpha = 1;
      }

      // ── FLOW TRACERS (show toroidal circulation streamlines) ──
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      for (const tr of s.flowTracers) {
        const sv = getBioreactorFlowVelocity(tr.x, tr.y, cx, impY, tankTop, tankBottom, 90, impSpeed * 1.4);
        tr.x += sv.vx * 0.55;
        tr.y += sv.vy * 0.55;
        tr.life += 0.014 * hr;
        // Respawn when life expires or out of bounds
        if (tr.life > tr.maxLife || tr.x < tankLeft + 8 || tr.x > tankRight - 8 || tr.y < liqY + 4 || tr.y > tankBottom - 4) {
          tr.x = cx + (Math.random() - 0.5) * tankW * 0.72;
          tr.y = tankTop + 12 + Math.random() * (tankH - 24);
          tr.life = 0;
          tr.maxLife = 0.45 + Math.random() * 1.1;
        }
        const t = tr.life / tr.maxLife;
        const spd = Math.sqrt(sv.vx * sv.vx + sv.vy * sv.vy);
        const dy_imp = Math.abs(tr.y - impY);
        const dx_ctr = Math.abs(tr.x - cx);
        let trHue, trSat;
        if (dy_imp < 35) { trHue = 40; trSat = 95; }          // impeller zone - amber
        else if (dx_ctr > 62) { trHue = 200; trSat = 85; }    // wall upflow - cyan
        else { trHue = 270; trSat = 75; }                    // center downflow - violet
        // More visible tracers — higher base alpha and speed sensitivity
        const trAlpha = Math.max(0, Math.min(0.42, 0.12 + spd * 0.22) * hr * (1 - t * 0.6) * (0.35 + crowding * 0.65));
        ctx.globalAlpha = trAlpha;
        ctx.beginPath();
        ctx.arc(tr.x, tr.y, tr.size * (0.6 + spd * 0.35), 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${trHue},${trSat}%,78%,1)`;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";

      // ── FLOW STREAMLINE LOOPS (visible circulation paths) ──
      // Draw 4 looping streamlines showing the toroidal flow pattern
      for (let loop = 0; loop < 4; loop++) {
        const xSign = loop < 2 ? 1 : -1;             // right or left side
        const loopOffset = (loop % 2) * 0.22;            // stagger
        const progress = ((s.time * (0.28 + loop * 0.07) * hr + loopOffset) % 1);
        // Parametric path: right wall up → surface across → center down → impeller across
        let px, py;
        const wallX = cx + xSign * 80;
        const topY = liqY + 18;
        const botY = tankBottom - 18;
        if (progress < 0.3) {          // up the wall
          const t = progress / 0.3;
          px = wallX - xSign * (t * 12);
          py = botY + (topY - botY) * t;
        } else if (progress < 0.5) {  // across top toward center
          const t = (progress - 0.3) / 0.2;
          px = (wallX - xSign * 12) + (cx - (wallX - xSign * 12)) * t;
          py = topY + t * 18;
        } else if (progress < 0.8) {  // down the center
          const t = (progress - 0.5) / 0.3;
          px = cx + xSign * t * 14;
          py = topY + 18 + (impY - (topY + 18)) * t;
        } else {                     // outward at impeller level
          const t = (progress - 0.8) / 0.2;
          px = cx + xSign * (14 + (wallX - xSign * 12 - cx - xSign * 14) * t);
          py = impY + Math.sin(t * Math.PI) * 8;
        }
        if (px < tankLeft + 8 || px > tankRight - 8 || py < liqY || py > tankBottom) continue;
        ctx.globalAlpha = Math.max(0, 0.18 * hr * (1 - Math.abs(progress - 0.5) * 1.2));
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = loop < 2 ? `rgba(${lr + 60},${lg2 + 60},${lb + 80},0.9)` : `rgba(${lr + 40},${lg2 + 80},${lb + 60},0.9)`;
        ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.restore();

      // ── NUTRIENT PARTICLES — follow flow field, show concentration gradients ──
      for (const np of s.nutrientParticles) {
        const conc = activeNutrients[np.id] || 0;
        if (conc < 1) continue;
        const sv = getBioreactorFlowVelocity(np.x, np.y, cx, impY, tankTop, tankBottom, 90, impSpeed * 0.85);
        // Strong advection + weak Brownian
        np.vx += sv.vx * 0.055 + (Math.random() - 0.5) * 0.04;
        np.vy += sv.vy * 0.055 + (Math.random() - 0.5) * 0.04;
        np.vx *= 0.91; np.vy *= 0.91;
        np.x += np.vx; np.y += np.vy;
        if (np.x < tankLeft + 10) { np.vx = Math.abs(np.vx) * 0.7; np.x = tankLeft + 10; }
        if (np.x > tankRight - 10) { np.vx = -Math.abs(np.vx) * 0.7; np.x = tankRight - 10; }
        if (np.y < liqY + 4) { np.vy = Math.abs(np.vy) * 0.7; np.y = liqY + 4; }
        if (np.y > tankBottom - 4) { np.vy = -Math.abs(np.vy) * 0.7; np.y = tankBottom - 4; }
        // Concentration gradient: brighter near impeller (well-mixed zone)
        const distToImp = Math.sqrt((np.x - cx) ** 2 + (np.y - impY) ** 2);
        const concBoost = Math.max(0.5, 1.2 - distToImp / 120);
        const nutrientAlpha = Math.min(0.85, (0.12 + 0.55 * (conc / 100)) * concBoost);
        const glow = ctx.createRadialGradient(np.x, np.y, 0, np.x, np.y, np.size * 3);
        glow.addColorStop(0, `${np.color}${Math.round(nutrientAlpha * 220).toString(16).padStart(2, '0')}`);
        glow.addColorStop(0.5, `${np.color}${Math.round(nutrientAlpha * 80).toString(16).padStart(2, '0')}`);
        glow.addColorStop(1, `${np.color}00`);
        ctx.beginPath(); ctx.arc(np.x, np.y, np.size * 3, 0, Math.PI * 2);
        ctx.fillStyle = glow; ctx.fill();
        ctx.beginPath(); ctx.arc(np.x, np.y, np.size * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${np.hue},95%,82%,${Math.min(1, nutrientAlpha + 0.18)})`; ctx.fill();
      }

      // ── BACTERIA — advected by flow field, Brownian noise, depth-sorted ──
      // Sort back→front for depth effect
      s.bacteria.sort((a, b) => a.depth - b.depth);

      // Pre-compute impeller speed for this frame
      const impSpeedNorm = Math.min(1, impSpeed * 25); // 0–1 normalized impeller vigor

      for (const bac of s.bacteria) {
        const sv = getBioreactorFlowVelocity(bac.x, bac.y, cx, impY, tankTop, tankBottom, 90, impSpeed);
        const moveMult = mobilityFactor;
        const localSpeed = Math.sqrt(sv.vx * sv.vx + sv.vy * sv.vy);
        const nearImpeller = Math.exp(-Math.abs(bac.y - impY) / 35) * Math.exp(-Math.abs(bac.x - cx) / 40);
        const distToImp = Math.sqrt((bac.x - cx) ** 2 + (bac.y - impY) ** 2);
        // Smooth 0→1 influence that fades sharply beyond 120px from impeller
        const impellerInfluence = Math.pow(Math.max(0, 1 - distToImp / 120), 1.2);

        // ── Flow advection dominates near impeller; Brownian far away ──
        // advectionStrength: 0.75 near impeller → 0.22 far away (stronger coupling)
        const advectionStrength = 0.22 + impellerInfluence * 0.53;
        // Brownian: negligible near impeller (flow overwhelms), significant far away
        const brownianScale = 0.018 * (1 - impellerInfluence * 0.95) * (0.5 + nutScore * 0.5);

        // ── Density crowding: more bacteria = more collision resistance ──
        // At high density, bacteria pack tighter and slow down
        const crowdSlow = 1 - crowding * 0.52;
        const crowdJitter = crowding * 0.022; // high-density jostle/collision noise

        // Smooth flow memory: blend previous flow into current for inertia
        if (!bac.flowVx) bac.flowVx = sv.vx;
        if (!bac.flowVy) bac.flowVy = sv.vy;
        bac.flowVx += (sv.vx - bac.flowVx) * (0.22 + impellerInfluence * 0.15); // faster near impeller
        bac.flowVy += (sv.vy - bac.flowVy) * (0.22 + impellerInfluence * 0.15);

        bac.vx += bac.flowVx * advectionStrength * moveMult
          + (Math.random() - 0.5) * brownianScale * moveMult
          + (Math.random() - 0.5) * crowdJitter;
        bac.vy += bac.flowVy * advectionStrength * moveMult
          + (Math.random() - 0.5) * brownianScale * moveMult
          + (Math.random() - 0.5) * crowdJitter;

        // Damping: near impeller = less damping (bacteria whip around), far = more sluggish
        const dampFactor = 0.78 + (1 - impellerInfluence) * 0.14;
        bac.vx *= dampFactor * crowdSlow;
        bac.vy *= dampFactor * crowdSlow;

        // Velocity cap scaled by impeller proximity: fast near, slow far
        const maxV = (0.5 + impellerInfluence * 3.2) * moveMult;
        const speed = Math.sqrt(bac.vx ** 2 + bac.vy ** 2);
        if (speed > maxV) { bac.vx *= maxV / speed; bac.vy *= maxV / speed; }

        bac.x += bac.vx; bac.y += bac.vy;

        // ── Orientation alignment with flow ──
        // Near impeller: snap strongly to flow direction (shear alignment)
        // Far: gentle tumble
        if (Math.abs(bac.vx) + Math.abs(bac.vy) > 0.03) {
          const targetAngle = Math.atan2(bac.vy, bac.vx);
          const alignStrength = 0.08 + impellerInfluence * 0.30;
          let dAngle = targetAngle - bac.angle;
          // Shortest rotation path
          while (dAngle > Math.PI) dAngle -= Math.PI * 2;
          while (dAngle < -Math.PI) dAngle += Math.PI * 2;
          bac.angle += dAngle * alignStrength * moveMult;
        }
        // Residual tumble (suppressed near impeller where shear dominates)
        bac.angle += bac.av * moveMult * (0.15 + (1 - impellerInfluence) * 0.85);
        bac.wobble += bac.wobbleRate * moveMult;
        bac.flagellaPhase += (0.07 + localSpeed * 0.14) * moveMult;

        // Boundary bounce with slight randomization to prevent wall clumping
        if (bac.x < tankLeft + 10) { bac.vx = Math.abs(bac.vx) * 0.65 + (Math.random() * 0.3); bac.x = tankLeft + 10; }
        if (bac.x > tankRight - 10) { bac.vx = -Math.abs(bac.vx) * 0.65 - (Math.random() * 0.3); bac.x = tankRight - 10; }
        if (bac.y < liqY + 4) { bac.vy = Math.abs(bac.vy) * 0.65 + (Math.random() * 0.3); bac.y = liqY + 4; }
        if (bac.y > tankBottom - 4) { bac.vy = -Math.abs(bac.vy) * 0.65 - (Math.random() * 0.3); bac.y = tankBottom - 4; }

        // Depth-based: background bacteria smaller and dimmer
        const depthScale = 0.44 + bac.depth * 0.56;

        // ── Glow halo (reduced at ultra-high density to avoid mud) ──
        if (hr > 0.35) {
          ctx.save();
          const glowAlpha = Math.max(0, 0.05 * hr * (1 - crowding * 0.7) * (0.3 + nutScore * 0.7) * depthScale);
          ctx.globalAlpha = glowAlpha;
          ctx.beginPath(); ctx.arc(bac.x, bac.y, bac.size * 4.0 * depthScale, 0, Math.PI * 2);
          const halo = ctx.createRadialGradient(bac.x, bac.y, 0, bac.x, bac.y, bac.size * 4.0 * depthScale);
          halo.addColorStop(0, bacterium.color); halo.addColorStop(1, "transparent");
          ctx.fillStyle = halo; ctx.fill(); ctx.restore();
        }

        // ── Motion blur streak for fast bacteria near impeller ──
        if (nearImpeller > 0.15 && localSpeed > 0.18) {
          ctx.save();
          ctx.globalAlpha = 0.18 * nearImpeller * hr * depthScale * (1 - crowding * 0.45);
          ctx.beginPath();
          ctx.moveTo(bac.x, bac.y);
          ctx.lineTo(bac.x - bac.vx * moveMult * 9, bac.y - bac.vy * moveMult * 9);
          ctx.strokeStyle = bacterium.color;
          ctx.lineWidth = bac.size * 0.9 * depthScale; ctx.lineCap = "round"; ctx.stroke();
          ctx.restore();
        }

        // ── Dense-culture turbidity smear: at high density draw extra haze ──
        if (crowding > 0.45) {
          ctx.save();
          ctx.globalAlpha = (crowding - 0.45) * 0.13 * bac.opacity * depthScale * hr;
          ctx.beginPath(); ctx.arc(bac.x, bac.y, bac.size * 3.2 * depthScale, 0, Math.PI * 2);
          ctx.fillStyle = bacterium.color;
          ctx.fill(); ctx.restore();
        }

        const bacCopy = { ...bac, size: bac.size * depthScale, opacity: bac.opacity * depthScale };
        drawBacterium(ctx, bacCopy, bacterium, hr, crowding, nutScore);
      }

      // O2 BUBBLES
      const o2Conc = activeNutrients.oxygen || params.oxygen || 0;
      const maxBbl = Math.floor((o2Conc / 100) * 35);
      while (s.bubbles.length < maxBbl) {
        const angle = Math.random() * Math.PI * 2, radius = 25 + Math.random() * 28;
        s.bubbles.push({
          x: cx + Math.cos(angle) * radius, y: tankBottom - 15,
          vy: -(0.6 + Math.random() * 1.6), size: 1.5 + Math.random() * 4.5,
          wobble: Math.random() * Math.PI * 2, ws: 0.04 + Math.random() * 0.08,
          spin: Math.random() * Math.PI * 2,
        });
      }
      for (let i = s.bubbles.length - 1; i >= 0; i--) {
        const bbl = s.bubbles[i];
        // Bubbles follow horizontal swirl too
        const sv = getBioreactorFlowVelocity(bbl.x, bbl.y, cx, impY, tankTop, tankBottom, 90, impSpeed * 0.25);
        bbl.x += Math.sin(bbl.wobble) * 0.6 + sv.vx * 0.05;
        bbl.y += bbl.vy + sv.vy * 0.02;
        bbl.wobble += bbl.ws;
        if (bbl.y < liqY || i >= maxBbl) { s.bubbles.splice(i, 1); continue; }
        const ba = 0.35 + Math.sin(bbl.spin) * 0.08; bbl.spin += 0.05;
        const bubGrad = ctx.createRadialGradient(bbl.x - bbl.size * 0.3, bbl.y - bbl.size * 0.3, 0.2, bbl.x, bbl.y, bbl.size);
        bubGrad.addColorStop(0, `rgba(200,235,255,${ba * 0.5})`);
        bubGrad.addColorStop(0.6, `rgba(130,200,255,${ba * 0.2})`);
        bubGrad.addColorStop(1, `rgba(80,160,230,0)`);
        ctx.beginPath(); ctx.arc(bbl.x, bbl.y, bbl.size, 0, Math.PI * 2);
        ctx.fillStyle = bubGrad; ctx.fill();
        ctx.beginPath(); ctx.arc(bbl.x - bbl.size * 0.35, bbl.y - bbl.size * 0.38, bbl.size * 0.28, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${ba * 0.55})`; ctx.fill();
      }

      // SURFACE WAVES
      if (liqY < tankBottom) {
        ctx.globalAlpha = 0.45 * hr;
        ctx.beginPath();
        const wavePoints = 16;
        for (let i = 0; i <= wavePoints; i++) {
          const wx = tankLeft + 7 + (i / wavePoints) * (tankW - 14);
          const wy = liqY + Math.sin(s.time * 3.8 * hr + i * 0.9) * 2.5 * hr + Math.sin(s.time * 2.1 * hr + i * 1.8 + 1) * 1.5 * hr;
          i === 0 ? ctx.moveTo(wx, wy) : ctx.lineTo(wx, wy);
        }
        ctx.strokeStyle = `rgba(${lr + 80},${lg2 + 80},${lb + 80},0.7)`;
        ctx.lineWidth = 1.2; ctx.stroke();
        ctx.globalAlpha = 1;
      }

      const tempStress = (params.temperature - bacterium.temp.opt) / 10;
      if (Math.abs(tempStress) > 0.4) {
        ctx.globalAlpha = Math.min(0.18, Math.abs(tempStress) * 0.08);
        ctx.fillStyle = tempStress > 0 ? "#ff2200" : "#2244ff";
        ctx.fillRect(tankLeft + 7, liqY, tankW - 14, tankBottom - liqY); ctx.globalAlpha = 1;
      }
      const phStress = params.ph - bacterium.ph.opt;
      if (Math.abs(phStress) > 0.5) {
        ctx.globalAlpha = Math.min(0.12, Math.abs(phStress) * 0.04);
        ctx.fillStyle = phStress > 0 ? "#00ff88" : "#ff0088";
        ctx.fillRect(tankLeft + 7, liqY, tankW - 14, tankBottom - liqY); ctx.globalAlpha = 1;
      }

      // ── FLUID HAZE / MEDIUM DENSITY EFFECT ──
      // Simulates light scattering through the culture medium (turbidity gradient)
      // Brighter near impeller (high mixing energy), dimmer near walls
      const hazeGrad = ctx.createRadialGradient(cx, impY, 8, cx, impY, 120);
      hazeGrad.addColorStop(0, `rgba(${Math.min(255, lr + 50)},${Math.min(255, lg2 + 50)},${Math.min(255, lb + 60)},${0.12 * hr})`);
      hazeGrad.addColorStop(0.4, `rgba(${lr},${lg2},${lb},${0.05 * hr})`);
      hazeGrad.addColorStop(1, `rgba(${lr},${lg2},${lb},0)`);
      ctx.fillStyle = hazeGrad;
      ctx.fillRect(tankLeft + 7, liqY, tankW - 14, tankBottom - liqY);
      // Density gradient: medium denser (darker) near bottom
      const densityHaze = ctx.createLinearGradient(0, liqY, 0, tankBottom);
      densityHaze.addColorStop(0, `rgba(0,0,0,0)`);
      densityHaze.addColorStop(1, `rgba(0,0,0,${Math.min(0.28, crowding * 0.30)})`);
      ctx.fillStyle = densityHaze;
      ctx.fillRect(tankLeft + 7, liqY, tankW - 14, tankBottom - liqY);
      // High-density turbidity tint: culture looks opaque/cloudy at dense populations
      if (crowding > 0.4) {
        const turbidAlpha = Math.min(0.22, (crowding - 0.4) * 0.37);
        const [bcR, bcG, bcB] = hexToRgb(bacterium.color);
        ctx.fillStyle = `rgba(${bcR},${bcG},${bcB},${turbidAlpha})`;
        ctx.fillRect(tankLeft + 7, liqY, tankW - 14, tankBottom - liqY);
      }

      ctx.restore();

      // ── RUSHTON TURBINE IMPELLER ──────────────────────────────────────────────
      // Classic 6-blade flat Rushton turbine viewed from the front.
      // The vertical shaft is in the center; blades are mounted radially at impeller height.
      // This is the most common bioreactor impeller design.
      {
        const IMP_ARM = 58;    // blade tip radius
        const BLADE_H = 14;    // blade height (vertical extent, clearly visible)
        const BLADE_W = 18;    // blade width (radial extent)
        const DISK_R = IMP_ARM + 4;
        const DISK_TH = 5;     // disk half-thickness
        const HUB_R = 10;
        const N_BLADES = 6;

        ctx.save();
        ctx.translate(cx, impY);

        // ── Motion blur ghosts ──
        for (let g = 4; g >= 1; g--) {
          ctx.save();
          ctx.globalAlpha = 0.018 * g * Math.min(1, impSpeed * 18) * hr;
          const ghostA = s.impellerAngle - impSpeed * g * 3.5;
          for (let b = 0; b < N_BLADES; b++) {
            const theta = ghostA + (b / N_BLADES) * Math.PI * 2;
            const bx = Math.cos(theta) * IMP_ARM;
            ctx.save(); ctx.translate(bx, 0); ctx.rotate(theta);
            ctx.beginPath(); ctx.rect(-BLADE_W / 2, -BLADE_H / 2, BLADE_W, BLADE_H);
            ctx.fillStyle = "#aabbc8"; ctx.fill(); ctx.restore();
          }
          ctx.restore();
        }

        // ── Lower disk ──
        ctx.save();
        ctx.beginPath(); ctx.ellipse(0, DISK_TH, DISK_R, DISK_TH * 0.55, 0, 0, Math.PI * 2);
        const ldg = ctx.createLinearGradient(-DISK_R, 0, DISK_R, 0);
        ldg.addColorStop(0, "#1e2e3c"); ldg.addColorStop(0.45, "#4a6070"); ldg.addColorStop(0.55, "#6080a0"); ldg.addColorStop(1, "#1e2e3c");
        ctx.fillStyle = ldg; ctx.globalAlpha = 0.7; ctx.fill();
        ctx.restore();

        // ── 6 blades — back 3 drawn behind disk, front 3 in front ──
        // Sort: sin(theta) < 0 = back (drawn first), sin(theta) >= 0 = front
        const bladeAngles = Array.from({ length: N_BLADES }, (_, b) => s.impellerAngle + (b / N_BLADES) * Math.PI * 2);
        const backBlades = bladeAngles.filter(a => Math.sin(a) < 0);
        const frontBlades = bladeAngles.filter(a => Math.sin(a) >= 0);

        function drawBlade(theta) {
          const cosT = Math.cos(theta), sinT = Math.sin(theta);
          const bx = cosT * IMP_ARM;
          // Depth: back blades darker, front lighter
          const isFront = sinT >= 0;
          const depthL = isFront ? 62 : 32;
          const depthH = isFront ? 85 : 52;
          ctx.save();
          ctx.translate(bx, 0);
          ctx.rotate(theta); // blade faces tangentially
          ctx.globalAlpha = isFront ? 0.93 : 0.68;
          // Blade body
          const bg = ctx.createLinearGradient(-BLADE_W / 2, -BLADE_H / 2, BLADE_W / 2, BLADE_H / 2);
          bg.addColorStop(0, `hsl(210,22%,${depthL}%)`);
          bg.addColorStop(0.4, `hsl(205,32%,${depthH}%)`);
          bg.addColorStop(1, `hsl(210,22%,${depthL}%)`);
          ctx.fillStyle = bg;
          ctx.beginPath(); ctx.roundRect(-BLADE_W / 2, -BLADE_H / 2, BLADE_W, BLADE_H, 2); ctx.fill();
          // Top highlight
          ctx.fillStyle = `rgba(255,255,255,${isFront ? 0.28 : 0.10})`;
          ctx.beginPath(); ctx.roundRect(-BLADE_W / 2 + 1, -BLADE_H / 2 + 1, BLADE_W - 2, 3, 1); ctx.fill();
          // Bottom shadow
          ctx.fillStyle = `rgba(0,0,0,${isFront ? 0.18 : 0.08})`;
          ctx.beginPath(); ctx.roundRect(-BLADE_W / 2 + 1, BLADE_H / 2 - 4, BLADE_W - 2, 3, 1); ctx.fill();
          ctx.restore();
        }

        backBlades.forEach(drawBlade);

        // ── Upper disk ──
        ctx.save();
        ctx.beginPath(); ctx.ellipse(0, -DISK_TH, DISK_R, DISK_TH * 0.55, 0, 0, Math.PI * 2);
        const udg = ctx.createLinearGradient(-DISK_R, 0, DISK_R, 0);
        udg.addColorStop(0, "#788898"); udg.addColorStop(0.3, "#7090a8"); udg.addColorStop(0.5, "#b0ccd8"); udg.addColorStop(0.7, "#7090a8"); udg.addColorStop(1, "#788898");
        ctx.fillStyle = udg; ctx.globalAlpha = 0.88; ctx.fill();
        // Disk rim
        ctx.beginPath(); ctx.ellipse(0, -DISK_TH, DISK_R, DISK_TH * 0.55, 0, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(200,225,240,0.5)"; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();

        frontBlades.forEach(drawBlade);

        // ── Hub (center cylinder) ──
        ctx.save();
        ctx.beginPath(); ctx.ellipse(0, 0, HUB_R, HUB_R * 0.55, 0, 0, Math.PI * 2);
        const hg = ctx.createRadialGradient(-3, -2, 1, 0, 0, HUB_R);
        hg.addColorStop(0, "#ddeef8"); hg.addColorStop(0.6, "#7090a0"); hg.addColorStop(1, "#788898");
        ctx.fillStyle = hg; ctx.globalAlpha = 1; ctx.fill();
        ctx.restore();

        // ── RPM glow ring ──
        if (impSpeed > 0.02) {
          ctx.save();
          ctx.globalAlpha = Math.min(0.4, impSpeed * 6) * hr;
          ctx.beginPath(); ctx.ellipse(0, 0, DISK_R + 5, DISK_TH * 0.55 + 2, 0, 0, Math.PI * 2);
          ctx.strokeStyle = bacterium.color; ctx.lineWidth = 1.5; ctx.stroke();
          // Spinning arc
          ctx.beginPath();
          ctx.ellipse(0, 0, DISK_R + 8, DISK_TH * 0.55 + 3, 0, s.impellerAngle, s.impellerAngle + Math.PI * 0.9);
          ctx.strokeStyle = bacterium.color; ctx.lineWidth = 2.5; ctx.stroke();
          ctx.restore();
        }

        ctx.restore();
      }

      // SPARGER
      ctx.save();
      ctx.beginPath(); ctx.ellipse(cx, tankBottom - 10, 52, 9, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "#8090a0"; ctx.lineWidth = 2.5; ctx.stroke();
      for (let i = 0; i < 9; i++) {
        ctx.beginPath(); ctx.arc(cx + Math.cos((i / 9) * Math.PI * 2) * 52, tankBottom - 10 + Math.sin((i / 9) * Math.PI * 2) * 9, 2, 0, Math.PI * 2);
        ctx.fillStyle = "#5080a0"; ctx.fill();
      }
      ctx.restore();

      // GLASS WALLS
      ctx.save();
      const gwg = ctx.createLinearGradient(tankLeft, 0, tankRight, 0);
      gwg.addColorStop(0, "rgba(90,120,140,0.92)"); gwg.addColorStop(0.05, "rgba(190,225,240,0.62)");
      gwg.addColorStop(0.13, "rgba(70,100,120,0.12)"); gwg.addColorStop(0.87, "rgba(70,100,120,0.10)");
      gwg.addColorStop(0.95, "rgba(150,195,215,0.52)"); gwg.addColorStop(1, "rgba(70,100,120,0.88)");
      ctx.fillStyle = gwg; ctx.fillRect(tankLeft, tankTop, tankW, tankH);
      ctx.fillStyle = "rgba(210,235,250,0.09)"; ctx.fillRect(tankLeft + 5, tankTop + 5, 11, tankH - 10);
      ctx.strokeStyle = "rgba(140,185,205,0.72)"; ctx.lineWidth = 1.5; ctx.strokeRect(tankLeft, tankTop, tankW, tankH);
      ctx.restore();

      // REFLECTIONS
      ctx.save();
      const reflGrad = ctx.createLinearGradient(tankLeft, tankTop, tankLeft, tankBottom);
      reflGrad.addColorStop(0, "rgba(220,240,255,0.12)"); reflGrad.addColorStop(0.3, "rgba(220,240,255,0.04)");
      reflGrad.addColorStop(1, "rgba(220,240,255,0.08)");
      ctx.fillStyle = reflGrad; ctx.fillRect(tankLeft + 5, tankTop, 15, tankH);
      const reflY = tankTop + 25 + Math.sin(s.time * 0.4) * 18;
      ctx.globalAlpha = 0.18 + Math.sin(s.time * 0.7) * 0.06;
      ctx.beginPath(); ctx.moveTo(tankLeft + 6, reflY); ctx.lineTo(tankLeft + 14, reflY + 220);
      ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();

      // BASE
      ctx.save();
      const bsg = ctx.createLinearGradient(0, tankBottom, 0, tankBottom + 38);
      bsg.addColorStop(0, "#9aa8b4"); bsg.addColorStop(0.3, "#aabbc4"); bsg.addColorStop(1, "#9aa8b4");
      ctx.fillStyle = bsg; ctx.beginPath(); ctx.roundRect(tankLeft - 15, tankBottom, tankW + 30, 38, [0, 0, 8, 8]); ctx.fill();
      ctx.restore();

      // TOP CAP
      ctx.save();
      const tcg = ctx.createLinearGradient(0, tankTop - 22, 0, tankTop);
      tcg.addColorStop(0, "#788898"); tcg.addColorStop(0.5, "#8090a0"); tcg.addColorStop(1, "#7a8898");
      ctx.fillStyle = tcg; ctx.beginPath(); ctx.roundRect(tankLeft - 10, tankTop - 22, tankW + 20, 24, [8, 8, 0, 0]); ctx.fill();
      ctx.restore();

      // PROBE READOUTS
      ctx.font = "bold 15px 'Inter','Segoe UI',sans-serif";
      ctx.fillStyle = "#ff5555"; ctx.fillText(`${params.temperature.toFixed(1)}°C`, tankLeft - 62, tankTop + 124);
      ctx.fillStyle = "#9060e8"; ctx.fillText(`pH ${params.ph.toFixed(1)}`, tankRight + 10, tankTop + 160);
      ctx.fillStyle = "#2890e0"; ctx.fillText(`${params.oxygen.toFixed(0)}%`, tankRight + 10, tankTop + 286);

      // Growth phase indicator
      const phaseColor = getPhaseColor(growthPhase);
      ctx.font = "bold 13px 'Inter','Segoe UI',sans-serif"; ctx.fillStyle = phaseColor;
      ctx.textAlign = "center"; ctx.fillText(growthPhase.toUpperCase() + " PHASE", cx, tankTop - 5); ctx.textAlign = "left";

      if (health < 20) {
        const deathAlpha = (20 - health) / 20 * 0.08;
        ctx.save(); ctx.globalAlpha = deathAlpha + Math.sin(s.time * 3) * 0.03;
        ctx.fillStyle = "#ff0000"; ctx.fillRect(tankLeft + 7, liqY, tankW - 14, tankBottom - liqY);
        ctx.restore();
      }

      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [species, params, health, density, wasteToxicity, growthPhase, activeNutrients, width, height, bacterium]);

  return <canvas ref={canvasRef} width={width} height={height} style={{ display: "block", borderRadius: "8px" }} />;
}

// ─── NUTRIENT PANEL ───────────────────────────────────────────────────────────
function NutrientPanel({ activeNutrients, onUpdate }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div style={{ background: "#ffffff", borderRadius: "4px", border: "1px solid #c8d4e4", overflow: "hidden" }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{ padding: "4px 8px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: expanded ? "1px solid #d0d8e8" : "none" }}
      >
        <span style={{ fontSize: "9px", color: "#3a5a6a", letterSpacing: "0.15em", fontWeight: "bold" }}>MULTI-NUTRIENT FEED</span>
        <span style={{ fontSize: "10px", color: "#5a7888" }}>{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
        <div style={{ padding: "4px 6px", display: "flex", flexDirection: "column", gap: "3px" }}>
          {Object.entries(NUTRIENTS).map(([id, nut]) => {
            const val = activeNutrients[id] || 0;
            const isActive = val > 0;
            return (
              <div key={id} style={{ background: isActive ? `${nut.color}08` : "#f0f2f5", borderRadius: "3px", padding: "4px 6px", border: `1px solid ${isActive ? nut.color + "44" : "#d0d8e8"}`, transition: "all 0.3s" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: isActive ? "3px" : "0" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                    <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: isActive ? nut.color : "#4a5a6a", boxShadow: isActive ? `0 0 4px ${nut.color}` : "", flexShrink: 0 }} />
                    <div>
                      <span style={{ fontSize: "8px", color: isActive ? nut.color : "#445566", fontWeight: "bold", letterSpacing: "0.08em" }}>{nut.label}</span>
                      <span style={{ fontSize: "8px", color: "#4a5a6a", marginLeft: "4px" }}>{nut.symbol}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                    <span style={{ fontSize: "10px", color: isActive ? nut.color : "#788898", fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif", fontWeight: "bold", minWidth: "22px", textAlign: "right" }}>{val.toFixed(0)}</span>
                    <button
                      onClick={() => onUpdate(id, isActive ? 0 : 50)}
                      style={{ width: "16px", height: "16px", borderRadius: "2px", background: isActive ? `${nut.color}22` : "#e8ebf0", border: `1px solid ${isActive ? nut.color + "66" : "#4a5a6a"}`, color: isActive ? nut.color : "#445566", cursor: "pointer", fontSize: "10px", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "bold", padding: 0 }}
                    >
                      {isActive ? "−" : "+"}
                    </button>
                  </div>
                </div>
                {isActive && (
                  <div style={{ position: "relative", height: "4px", background: "#e8ebf0", borderRadius: "2px", boxShadow: "inset 0 1px 2px #00000066" }}>
                    <div style={{ position: "absolute", left: 0, width: `${val}%`, height: "100%", background: `linear-gradient(90deg,${nut.color}44,${nut.color})`, borderRadius: "2px", boxShadow: `0 0 4px ${nut.color}55`, transition: "width 0.1s" }} />
                    <div style={{ position: "absolute", left: `${val}%`, top: "50%", transform: "translate(-50%,-50%)", width: "8px", height: "8px", borderRadius: "50%", background: nut.color, boxShadow: `0 0 5px ${nut.color}`, border: "1.5px solid #07080f", pointerEvents: "none" }} />
                    <input type="range" min={1} max={100} step={1} value={val}
                      onChange={e => onUpdate(id, parseFloat(e.target.value))}
                      style={{ position: "absolute", inset: "-4px 0", width: "100%", height: "12px", opacity: 0, cursor: "pointer", margin: 0, zIndex: 2 }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── GROWTH CHART ─────────────────────────────────────────────────────────────
function GrowthChart({ densityHistory, healthHistory, wasteHistory, width = 260 }) {
  const h = 72;
  if (!densityHistory || densityHistory.length < 2) return null;
  const renderLine = (data, color) => {
    const max = 100, min = 0, range = max - min || 1;
    const w = width;
    const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * (h - 4) - 2}`).join(" ");
    return (
      <>
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" opacity="0.9" />
        <polyline points={`0,${h} ${pts} ${w},${h}`} fill={`${color}18`} stroke="none" />
      </>
    );
  };
  return (
    <div>
      <div style={{ display: "flex", gap: "10px", marginBottom: "5px" }}>
        {[["DENSITY", densityHistory, "#38bdf8"], ["VIABILITY", healthHistory, "#00e87a"], ["WASTE", wasteHistory, "#ff4444"]].map(([l, , c]) => (
          <div key={l} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <div style={{ width: "10px", height: "2px", background: c, borderRadius: "1px" }} />
            <span style={{ fontSize: "6px", color: "#788898", letterSpacing: "0.12em" }}>{l}</span>
          </div>
        ))}
      </div>
      <svg width={width} height={h} style={{ overflow: "visible", background: "#fafbfc", borderRadius: "4px" }}>
        {renderLine(densityHistory, "#38bdf8")}
        {renderLine(healthHistory, "#00e87a")}
        {renderLine(wasteHistory, "#ff4444")}
      </svg>
    </div>
  );
}

// ─── COCKPIT SLIDER ──────────────────────────────────────────────────────────
function CockpitSlider({ label, value, min, max, step, unit, onChange, color }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ marginBottom: "0", background: "#fafbfc", borderRadius: "4px", padding: "4px 8px", border: `1px solid ${color}44` }}>
      {label && <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2px" }}>
        <span style={{ fontSize: "8px", color: "#788898", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: "600" }}>{label}</span>
      </div>}
      <div style={{ position: "relative", height: "6px", background: "#e0e4ea", borderRadius: "3px", boxShadow: "inset 0 1px 2px #00000066" }}>
        <div style={{ position: "absolute", left: 0, width: `${pct}%`, height: "100%", background: `linear-gradient(90deg,${color}44,${color})`, borderRadius: "3px", transition: "width 0.1s", boxShadow: `0 0 6px ${color}55` }} />
        <div style={{ position: "absolute", left: `${pct}%`, top: "50%", transform: "translate(-50%,-50%)", width: "12px", height: "12px", borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}`, border: "2px solid #07080f", pointerEvents: "none" }} />
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          style={{ position: "absolute", inset: "-4px 0", width: "100%", height: "14px", opacity: 0, cursor: "pointer", margin: 0, zIndex: 2 }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "2px" }}>
        <span style={{ fontSize: "8px", color: "#4a5a6a", fontFamily: "'Inter','Segoe UI',sans-serif" }}>{min}{unit}</span>
        <span style={{ fontSize: "8px", color: "#4a5a6a", fontFamily: "'Inter','Segoe UI',sans-serif" }}>{max}{unit}</span>
      </div>
    </div>
  );
}

function CockpitGauge({ label, value, max, color, warn }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div style={{ background: "#fafbfc", borderRadius: "4px", padding: "5px 6px", border: `1px solid ${warn ? "#ff444466" : color + "44"}`, animation: warn ? "urgentPulse 1.5s infinite" : "none", textAlign: "center" }}>
      <div style={{ fontSize: "8px", color: "#445566", letterSpacing: "0.06em", marginBottom: "2px", textTransform: "uppercase", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "500" }}>{label}</div>
      <div style={{ fontSize: "14px", color: warn ? "#ff4444" : color, fontWeight: "bold", fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif", textShadow: `0 0 8px ${warn ? "#ff4444" : color}88`, marginBottom: "3px" }}>
        {value.toFixed(0)}%
      </div>
      <div style={{ height: "3px", background: "#e8ebf0", borderRadius: "2px", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: `linear-gradient(90deg,${color}66,${color})`, borderRadius: "2px", transition: "width 0.5s", boxShadow: `0 0 4px ${color}` }} />
      </div>
    </div>
  );
}

function ActionButton({ label, sublabel, color, onClick, cooldown, cooldownMax }) {
  const pct = cooldown > 0 ? (cooldown / cooldownMax) * 100 : 0;
  const ready = cooldown === 0;
  return (
    <button onClick={onClick} disabled={!ready} style={{
      flex: "1 1 auto", padding: "6px 4px",
      background: ready ? `${color}0e` : "#f0f2f5",
      border: `1px solid ${ready ? color + "55" : "#c8d4e0"}`,
      color: ready ? color : "#4a5a6a",
      borderRadius: "4px", cursor: ready ? "pointer" : "not-allowed",
      fontSize: "9px", letterSpacing: "0.12em",
      fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif",
      textAlign: "center", position: "relative", overflow: "hidden",
      transition: "all 0.2s",
      boxShadow: ready ? `0 0 12px ${color}18` : "none",
    }}>
      {pct > 0 && <div style={{ position: "absolute", bottom: 0, left: 0, height: "2px", width: `${100 - pct}%`, background: color + "77", transition: "width 0.5s", boxShadow: `0 0 4px ${color}` }} />}
      <div style={{ fontWeight: "bold", marginBottom: "1px", fontSize: "9px" }}>{label}</div>
      <div style={{ fontSize: "8px", color: ready ? "#445566" : "#8090a0", letterSpacing: "0.03em", fontFamily: "'Inter','Segoe UI',sans-serif" }}>{sublabel}</div>
    </button>
  );
}

let _lastSpeciesIdx = -1;
function pickRandomSpecies() {
  const keys = Object.keys(BACTERIA);
  let idx;
  do { idx = Math.floor(Math.random() * keys.length); } while (idx === _lastSpeciesIdx && keys.length > 1);
  _lastSpeciesIdx = idx;
  return keys[idx];
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
function BioreactorSim({ sessionKey, onReset, trialType = "new_session", entryTime }) {
  const trialEntryTimeRef = useRef(entryTime || new Date().toISOString());
  const [species, setSpecies] = useState(() => pickRandomSpecies());
  const [round, setRound] = useState(1);
  const bacterium = BACTERIA[species];

  const [phase, setPhase] = useState("intro");
  const [health, setHealth] = useState(75);
  const [timeLeft, setTimeLeft] = useState(300);
  // Start with WRONG parameters — player must know and fix immediately from their own research
  const [params, setParams] = useState({
    temperature: bacterium.temp.opt + (Math.random() > 0.5 ? (8 + Math.random() * 6) : -(6 + Math.random() * 5)),
    ph: bacterium.ph.opt + (Math.random() > 0.5 ? (1.5 + Math.random() * 1.5) : -(1.2 + Math.random() * 1.5)),
    oxygen: Math.random() * 40 + 10,
  });
  // Multi-nutrient state: id -> concentration 0-100
  const [activeNutrients, setActiveNutrients] = useState({ glucose: 70 });

  const [alerts, setAlerts] = useState([]);
  const [aiAdvice, setAiAdvice] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [score, setScore] = useState(0);
  const [fluctEvent, setFluctEvent] = useState(null);

  const [density, setDensity] = useState(15);
  const [wasteToxicity, setWasteToxicity] = useState(0);
  const [cultureAge, setCultureAge] = useState(0);
  const [growthPhase, setGrowthPhase] = useState("lag");
  const [healthHistory, setHealthHistory] = useState([75]);
  const [densityHistory, setDensityHistory] = useState([15]);
  const [wasteHistory, setWasteHistory] = useState([0]);
  const [cooldowns, setCooldowns] = useState({ feed: 0, dilute: 0, purge: 0, boost: 0 });
  const [agitatorRpm, setAgitatorRpm] = useState(200);      // RPM: 50–800
  const [co2Level, setCo2Level] = useState(0);               // CO2 buildup 0-100%
  const [n2Flow, setN2Flow] = useState(0);                   // N2 purge flow 0-100%

  const gameRef = useRef({});
  gameRef.current = { health, params, score, density, activeNutrients, wasteToxicity, cultureAge, cooldowns, timeLeft, agitatorRpm, co2Level, n2Flow };

  // Total nutrient level (for legacy compatibility)
  const totalNutrientLevel = Math.min(100, Object.values(activeNutrients).reduce((s, v) => s + v, 0) / Math.max(1, Object.keys(activeNutrients).filter(k => activeNutrients[k] > 0).length));
  const nutScore = calcNutrientScore(activeNutrients, species);

  const addAlert = useCallback((msg, color = "#ff4444") => {
    setAlerts(p => [{ msg, color, id: Date.now() + Math.random() }, ...p].slice(0, 6));
  }, []);

  const updateNutrient = useCallback((id, val) => {
    setActiveNutrients(prev => {
      const next = { ...prev };
      if (val <= 0) { delete next[id]; } else { next[id] = val; }
      return next;
    });
  }, []);

  // Game loop
  useEffect(() => {
    if (phase !== "playing") return;
    const iv = setInterval(() => {
      const g = gameRef.current;
      const b = BACTERIA[species];
      const envScore = calcEnvScore(g.params, species);
      const currentNutScore = calcNutrientScore(g.activeNutrients, species);
      setCultureAge(a => a + 1);
      const currentDensity = g.density;
      const currentWaste = g.wasteToxicity;
      const currentAge = g.cultureAge;

      // Carrying capacity: enforce species maxDensity
      const carryingCapacity = b.maxDensity;
      const densityInhibition = Math.max(0, 1 - (currentDensity / carryingCapacity));

      // Waste toxicity: inhibits growth above 40%, kills above 70%
      const wastePenalty = currentWaste < 40 ? 1.0
        : currentWaste < 70 ? 1.0 - (currentWaste - 40) / 45
          : 0;

      // Lag phase: first 20 ticks bacteria adapt slowly
      const lagFactor = currentAge < 20 ? (currentAge / 20) * 0.4 : 1.0;

      // Starvation: zero nutrients = zero growth
      const growthDelta = currentNutScore > 0.05
        ? b.growthRate * envScore * currentNutScore * densityInhibition * wastePenalty * lagFactor * 100
        : 0;

      // Death rate: lysis from overcrowding, toxicity, bad env, starvation
      // Tuned so bad conditions kill in ~8-15 seconds — forces fast reaction
      const overcrowdDeath = currentDensity > carryingCapacity * 0.75 ? (currentDensity - carryingCapacity * 0.75) * 0.18 : 0;
      const toxinDeath = currentWaste > 45 ? (currentWaste - 45) * 0.16 : 0;
      const envDeath = envScore < 0.40 ? (0.40 - envScore) * 14 : 0;  // bad conditions = fast death
      const starvationDeath = currentNutScore < 0.05 && currentDensity > 3 ? 1.5 : 0;  // starvation kills fast
      const healthCollapse = g.health < 20 ? (20 - g.health) * 0.22 : 0;

      const deathDelta = overcrowdDeath + toxinDeath + envDeath + starvationDeath + healthCollapse;

      // Net: growth wins when conditions good, death wins when conditions bad
      setDensity(d => Math.max(0, Math.min(carryingCapacity, d + growthDelta * 0.09 - deathDelta * 0.13)));

      // Consume active nutrients — scales with density (more cells = faster depletion)
      // Dense cultures starve quickly without regular feeding
      const densityFactor = Math.max(0.1, currentDensity / 100);
      const nutConsumption = b.nutrientConsumption * densityFactor * Math.max(0.3, envScore) * 100 * 0.18;
      setActiveNutrients(prev => {
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          // Preferred nutrients consumed faster by this species
          const prefMultiplier = b.preferredNutrients.includes(id) ? 1.4 : 0.7;
          next[id] = Math.max(0, next[id] - nutConsumption * prefMultiplier);
          if (next[id] < 0.5) delete next[id];
        }
        return next;
      });

      // Waste generation: dense cultures produce more metabolic waste
      // High glucose = high waste; aerobic metabolism produces less than fermentation
      const wasteMultiplier = Object.entries(g.activeNutrients).reduce((acc, [id, c]) => {
        return acc + (c / 100) * (NUTRIENTS[id]?.effect?.wasteGen || 1) * 0.25;
      }, 0.15);
      const wasteGen = b.wasteRate * Math.max(0.1, currentDensity / 100) * Math.max(0.3, envScore) * 100 * wasteMultiplier;
      // Natural waste breakdown (very slow, requires active management)
      const naturalBreakdown = 0.015;
      setWasteToxicity(w => Math.min(100, Math.max(0, w + wasteGen * 0.10 - naturalBreakdown)));

      setHealth(prev => {
        let delta = 0;
        // Environmental stress: wrong pH/temp/O2 = immediate damage
        const envPenalty = envScore < 0.5 ? (0.5 - envScore) * 9.0 : 0;
        delta -= envPenalty;
        // Overcrowding stress
        if (currentDensity > carryingCapacity * 0.75) delta -= (currentDensity - carryingCapacity * 0.75) * 0.14;
        // Waste toxicity
        if (currentWaste > 35) delta -= (currentWaste - 35) * 0.10;
        if (currentWaste > 65) delta -= (currentWaste - 65) * 0.20; // critical cascade
        // Starvation: fast health bleed
        if (currentNutScore < 0.05) delta -= 3.0;
        else if (currentNutScore < 0.15) delta -= (0.15 - currentNutScore) * 8;
        // Recovery: only when truly thriving — slow
        if (currentDensity > 10 && currentDensity < carryingCapacity * 0.60
          && envScore > 0.72 && currentNutScore > 0.40 && currentWaste < 30 && prev < 85)
          delta += 0.5;
        const next = Math.max(0, Math.min(100, prev + delta));
        if (next <= 0) setPhase("dead");
        return next;
      });
      setTimeLeft(prev => { if (prev <= 1) { setPhase("won"); return 0; } return prev - 1; });
      // Score: gain points for good conditions, lose points when culture crashes
      // Score: multi-factor — reward good management, penalize neglect
      const optimalBonus = envScore > 0.8 && currentNutScore > 0.5 && currentWaste < 25 && g.health > 70
        ? 3  // bonus for keeping ALL parameters excellent simultaneously
        : 0;
      const scoreDelta = envScore > 0.5 && currentNutScore > 0.2 && currentWaste < 60 && g.health > 20
        ? Math.round(1 + envScore * 2 + currentNutScore * 2 + (1 - currentWaste / 100) + optimalBonus)
        : g.health < 30
          ? -Math.round((30 - g.health) * 0.5)  // lose points fast as culture dies
          : -1;  // even mediocre management costs points
      setScore(p => Math.max(0, p + scoreDelta));
      setCooldowns(c => ({
        feed: Math.max(0, c.feed - 1),
        dilute: Math.max(0, c.dilute - 1),
        purge: Math.max(0, c.purge - 1),
        boost: Math.max(0, c.boost - 1),
      }));

      if (currentNutScore < 0.05) addAlert(`☠ STARVATION — CULTURE LYSING`, "#ff4444");
      else if (currentNutScore < 0.15) addAlert(`⬇ NUTRIENTS CRITICAL — FEED NOW`, "#fbbf24");
      if (currentWaste > 70) addAlert(`☠ TOXIC CRISIS: ${currentWaste.toFixed(0)}% — PURGE/DILUTE`, "#ff4444");
      else if (currentWaste > 50) addAlert(`⚠ WASTE TOXICITY: ${currentWaste.toFixed(0)}%`, "#ff6b35");
      if (currentDensity > carryingCapacity * 0.85) addAlert(`⬆ CARRYING CAPACITY REACHED`, "#ff6b35");
      if (currentDensity < 2 && cultureAge > 30) addAlert(`💀 CULTURE COLLAPSE IMMINENT`, "#ff4444");
      const p2 = g.params;
      if (p2.temperature > b.temp.max) addAlert(`🌡 T=${p2.temperature.toFixed(1)}°C — EXCEEDS MAX`, "#ff4444");
      else if (p2.temperature < b.temp.min) addAlert(`🌡 T=${p2.temperature.toFixed(1)}°C — BELOW MIN`, "#38bdf8");
      if (p2.ph < b.ph.min) addAlert(`⚗ pH ${p2.ph.toFixed(1)} — ACID STRESS`, "#9060e8");
      else if (p2.ph > b.ph.max) addAlert(`⚗ pH ${p2.ph.toFixed(1)} — ALKALINE STRESS`, "#f472b6");

      // ── WRONG NUTRIENT PENALTY ──
      // Adding nutrients the species doesn't prefer wastes resources AND produces extra metabolic byproducts
      let wrongNutPenalty = 0;
      for (const [id, conc] of Object.entries(g.activeNutrients)) {
        if (!b.preferredNutrients.includes(id) && conc > 10) {
          wrongNutPenalty += (conc / 100) * 0.4; // extra waste from unmetabolized substrates
        }
      }
      if (wrongNutPenalty > 0.05) {
        setWasteToxicity(w => Math.min(100, w + wrongNutPenalty));
        setHealth(h => Math.max(0, h - wrongNutPenalty * 0.5));
        if (wrongNutPenalty > 0.2) addAlert(`⚠ WRONG SUBSTRATE — METABOLIC STRESS`, "#ff8800");
      }

      // ── CONTINUOUS PARAMETER DRIFT — always happening, must be actively corrected ──
      // Temperature drifts toward ambient ~22°C — fast enough that you MUST keep adjusting
      const tempDrift = (22 - g.params.temperature) * 0.012;
      setParams(p => ({ ...p, temperature: p.temperature + tempDrift }));

      // Waste acidifies pH — faster at high waste
      if (currentWaste > 5) {
        const acidDrift = (currentWaste - 5) * 0.0018;
        setParams(p => ({ ...p, ph: Math.max(1.0, p.ph - acidDrift) }));
      }

      // O2 continuously consumed by growing culture — depletes fast if not boosted
      if (BACTERIA[species].oxygen !== "anaerobic" && currentDensity > 10) {
        const o2Demand = (currentDensity - 10) * 0.035 * b.growthRate * 800;
        setParams(p => ({ ...p, oxygen: Math.max(0, p.oxygen - o2Demand) }));
      }

      // Anaerobes: even a little O2 is toxic — health bleeds hard
      if (BACTERIA[species].oxygen === "anaerobic" && g.params.oxygen > 8) {
        const o2Damage = (g.params.oxygen - 8) * 0.15;
        setHealth(h => Math.max(0, h - o2Damage));
        if (g.params.oxygen > 20) addAlert(`☠ O₂ IS TOXIC — CULTURE DYING`, "#ff2200");
      }

      // ── RANDOM CRISIS EVENTS ──
      // Min 1%/s, ramps hard: after 60s = 8%, after 120s = 15%, after 180s = 22%, after 240s = 28%
      const elapsedFraction = (300 - g.timeLeft) / 300;
      const crisisProb = 0.01 + elapsedFraction * elapsedFraction * 0.27;
      if (Math.random() < crisisProb) {
        const evs = [
          { msg: "⚡ HEATER MALFUNCTION", key: "temperature", delta: +(6 + Math.random() * 8), color: "#ff4444" },
          { msg: "❄ COOLING FAULT", key: "temperature", delta: -(5 + Math.random() * 8), color: "#7dd3fc" },
          { msg: "💧 ACID CONTAMINATION", key: "ph", delta: -(1.0 + Math.random() * 1.8), color: "#a78bfa" },
          { msg: "⚗ BASE LEAK", key: "ph", delta: +(0.9 + Math.random() * 1.5), color: "#f472b6" },
          { msg: "💨 AERATION FAILURE", key: "oxygen", delta: -(20 + Math.random() * 30), color: "#38bdf8" },
          { msg: "🔥 THERMAL RUNAWAY", key: "temperature", delta: +(10 + Math.random() * 10), color: "#ff2200" },
          { msg: "🧪 ACID DUMP", key: "ph", delta: -(1.5 + Math.random() * 2.0), color: "#c084fc" },
          { msg: "💥 PUMP OVERSPEED — TEMP SPIKE", key: "temperature", delta: +(7 + Math.random() * 6), color: "#ff6600" },
          { msg: "⚙ AGITATOR FAULT — RPM LOST", key: "agitator", delta: 0, color: "#fbbf24" },
          { msg: "💨 CO₂ VENT BLOCKED", key: "co2block", delta: 0, color: "#a78bfa" },
          { msg: "🌊 CONTAMINATION — pH CRASH", key: "ph", delta: -(2.0 + Math.random() * 1.5), color: "#ff00ff" },
        ];
        const ev = evs[Math.floor(Math.random() * evs.length)];
        addAlert(`🚨 ${ev.msg}`, ev.color);
        setFluctEvent(ev.msg);
        setTimeout(() => setFluctEvent(null), 3000);
        if (ev.key === "agitator") {
          setAgitatorRpm(r => Math.max(50, r - (150 + Math.random() * 200)));
        } else if (ev.key === "co2block") {
          setCo2Level(c => Math.min(100, c + 25 + Math.random() * 20));
        } else {
          setParams(p => ({ ...p, [ev.key]: Math.max(0, Math.min(ev.key === "ph" ? 14 : 100, p[ev.key] + ev.delta)) }));
        }

        // After 2 min: guaranteed double-fault 40% of the time
        if (elapsedFraction > 0.4 && Math.random() < 0.40) {
          const ev2 = evs[Math.floor(Math.random() * evs.length)];
          setTimeout(() => {
            addAlert(`⚡ CASCADING FAULT: ${ev2.msg}`, "#ff0000");
            setFluctEvent(ev2.msg);
            setParams(p => ({ ...p, [ev2.key]: Math.max(0, Math.min(ev2.key === "ph" ? 14 : 100, p[ev2.key] + ev2.delta)) }));
          }, 1800);
        }
        // After 3.5 min: TRIPLE fault possible
        if (elapsedFraction > 0.7 && Math.random() < 0.35) {
          const ev3 = evs[Math.floor(Math.random() * evs.length)];
          setTimeout(() => {
            addAlert(`💀 CRITICAL: ${ev3.msg}`, "#ff0000");
            setFluctEvent(ev3.msg);
            setParams(p => ({ ...p, [ev3.key]: Math.max(0, Math.min(ev3.key === "ph" ? 14 : 100, p[ev3.key] + ev3.delta)) }));
          }, 3500);
        }
      }

      // ── AGITATOR RPM EFFECTS ──
      const rpm = g.agitatorRpm;
      const rpmNorm = rpm / 800; // 0–1
      // Low RPM (<100): poor mixing → O2 transfer drops, gradients form
      if (rpm < 100) {
        setParams(p => ({ ...p, oxygen: Math.max(0, p.oxygen - 0.4) }));
        if (Math.random() < 0.05) addAlert(`⚠ AGITATOR TOO SLOW — poor O₂ transfer`, "#fbbf24");
      }
      // Very high RPM (>600): shear stress kills cells
      if (rpm > 600) {
        const shearDamage = (rpm - 600) / 200 * 0.8;
        setHealth(h => Math.max(0, h - shearDamage));
        setDensity(d => Math.max(0, d - shearDamage * 0.3));
        if (Math.random() < 0.08) addAlert(`⚠ HIGH SHEAR — cell damage at ${rpm} RPM`, "#ff6b35");
      }
      // Good RPM range (150–500): boosts O2 transfer, mixing quality
      if (rpm >= 150 && rpm <= 500) {
        const mixBoost = 0.15 * rpmNorm;
        setParams(p => ({ ...p, oxygen: Math.min(100, p.oxygen + mixBoost) }));
      }

      // ── CO₂ BUILDUP — metabolic byproduct, acidifies medium ──
      // Aerobic respiration produces CO₂; rate proportional to growth and density
      const co2Production = b.growthRate * (currentDensity / 100) * Math.max(0.2, envScore) * 60 * (1 + rpmNorm * 0.5);
      // CO2 stripped by agitation (higher RPM = better stripping)
      const co2Strip = rpmNorm * 1.2 + 0.1;
      setCo2Level(prev => {
        const next = Math.max(0, Math.min(100, prev + co2Production * 0.12 - co2Strip * 0.08));
        // CO₂ dissolves as carbonic acid → drops pH
        if (next > 20) {
          const co2AcidDrift = (next - 20) * 0.0008;
          setParams(p => ({ ...p, ph: Math.max(1.0, p.ph - co2AcidDrift) }));
        }
        if (next > 60 && Math.random() < 0.06) addAlert(`☠ CO₂ EXCESS: ${next.toFixed(0)}% — acidification`, "#a78bfa");
        return next;
      });

      // ── N₂ PURGE FLOW ──
      // Strips dissolved O₂ (used for anaerobic cultures or nitrogen blanketing)
      // Also provides inorganic nitrogen for biosynthesis
      const n2 = g.n2Flow;
      if (n2 > 10) {
        // Strips O2 at rate proportional to N2 flow
        const o2Strip = (n2 / 100) * 1.8;
        setParams(p => ({ ...p, oxygen: Math.max(0, p.oxygen - o2Strip) }));
        // Also strips CO2 slightly (sparging effect)
        setCo2Level(prev => Math.max(0, prev - (n2 / 100) * 0.5));
      }
      // High N2 provides nitrogen nutrient benefit
      if (n2 > 40 && b.preferredNutrients.includes("nitrogen")) {
        setActiveNutrients(prev => ({ ...prev, nitrogen: Math.min(100, (prev.nitrogen || 0) + n2 * 0.003) }));
      }

      // ── NUTRIENT DECAY (nutrients degrade even without consumption) ──
      setActiveNutrients(prev => {
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          next[id] = Math.max(0, next[id] - 0.08);
          if (next[id] < 0.5) delete next[id];
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [phase, species, addAlert]);

  // ── FIREBASE TRIAL EXPORT ──
  useEffect(() => {
    if ((phase === "won" || phase === "dead") && sessionKey) {
      const exitTime = new Date().toISOString();
      const entryMs = new Date(trialEntryTimeRef.current).getTime();
      const exitMs = new Date(exitTime).getTime();
      const durationMin = ((exitMs - entryMs) / 60000).toFixed(2);

      const trialData = {
        trialId: round,
        trialType: trialType,
        entryTime: trialEntryTimeRef.current,
        exitTime: exitTime,
        duration: `${durationMin} min`,
        organism: species,
        outcome: phase === "won" ? "SURVIVED" : "DEAD",
        secondsSurvived: 300 - timeLeft,
        totalScore: score,
        healthAtEnd: health.toFixed(1) + "%",
        densityReached: density.toFixed(1) + "%",
        timeCompleted: exitTime
      };

      updateDoc(doc(db, "sessions", sessionKey), {
        "Latest Trial": trialData,
        "Trials History": arrayUnion(trialData),
        "overallExitTime": exitTime,
      }).catch(err => console.error("Firebase Export Error:", err));
    }
  }, [phase, sessionKey]);

  useEffect(() => { setGrowthPhase(getGrowthPhase(density, health, cultureAge)); }, [density, health, cultureAge]);
  useEffect(() => {
    if (phase !== "playing") return;
    const iv = setInterval(() => {
      setHealthHistory(h => [...h.slice(-59), health]);
      setDensityHistory(h => [...h.slice(-59), density]);
      setWasteHistory(h => [...h.slice(-59), wasteToxicity]);
    }, 3000);
    return () => clearInterval(iv);
  }, [phase, health, density, wasteToxicity]);

  const doFeed = () => {
    if (gameRef.current.cooldowns.feed > 0) return;
    setActiveNutrients(prev => {
      const next = { ...prev };
      // Feed primary nutrients for this species
      const prim = bacterium.preferredNutrients[0];
      next[prim] = Math.min(100, (next[prim] || 0) + 35);
      if (bacterium.preferredNutrients[1]) {
        const sec = bacterium.preferredNutrients[1];
        next[sec] = Math.min(100, (next[sec] || 0) + 20);
      }
      return next;
    });
    addAlert(`✅ FEED: ${NUTRIENTS[bacterium.preferredNutrients[0]].label} + secondary`, "#38c860");
    setScore(s => s + 50);
    setCooldowns(c => ({ ...c, feed: 20 }));
  };
  const doDilute = () => {
    if (gameRef.current.cooldowns.dilute > 0) return;
    setDensity(d => d * 0.55);
    setWasteToxicity(w => w * 0.45);
    setActiveNutrients(prev => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, v * 0.55])));
    addAlert("🔵 CULTURE DILUTED — density & waste reduced but nutrients lost!", "#38bdf8");
    setCooldowns(c => ({ ...c, dilute: 35 }));  // longer cooldown — powerful tool
  };
  const doPurge = () => {
    if (gameRef.current.cooldowns.purge > 0) return;
    setWasteToxicity(w => w * 0.20);  // stronger purge
    setParams(p => ({ ...p, ph: Math.max(p.ph, BACTERIA[species].ph.opt - 0.3) }));  // partial pH restore
    addAlert("🟡 WASTE PURGE — metabolites cleared, pH partially corrected", "#ffd700");
    setCooldowns(c => ({ ...c, purge: 28 }));
  };
  const doO2Boost = () => {
    if (gameRef.current.cooldowns.boost > 0) return;
    if (BACTERIA[species].oxygen === "anaerobic") {
      addAlert("⚠ O₂ BOOST HARMFUL TO ANAEROBE — aborted", "#ff4444");
      return;
    }
    setActiveNutrients(prev => ({ ...prev, oxygen: Math.min(100, (prev.oxygen || 0) + 40) }));
    setParams(p => ({ ...p, oxygen: Math.min(100, p.oxygen + 35) }));
    addAlert("💨 O₂ INJECTED — aeration restored", "#80c0f8");
    setCooldowns(c => ({ ...c, boost: 18 }));
  };

  const setParam = k => v => setParams(p => ({ ...p, [k]: v }));

  const getAiAdvice = async () => {
    setAiLoading(true);
    try {
      const nutSummary = Object.entries(activeNutrients).map(([id, c]) => `${NUTRIENTS[id].label}:${c.toFixed(0)}%`).join(", ") || "none";
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 1000,
          messages: [{ role: "user", content: `You are a terse bioreactor monitoring system. Report only observable system data — no advice, no hints. Species: ${species}. T=${params.temperature.toFixed(1)}°C, pH=${params.ph.toFixed(1)}, O₂=${params.oxygen.toFixed(0)}%, Active nutrients: ${nutSummary}, Waste=${wasteToxicity.toFixed(0)}%, Density=${density.toFixed(0)}%, Viability=${health.toFixed(0)}%, Phase=${growthPhase}, t=${300 - timeLeft}s elapsed. Give a 3-4 sentence clinical observation of current biological state only. Mention nutrient utilization efficiency. Do not suggest actions.` }],
        }),
      });
      const data = await res.json();
      setAiAdvice(data.content?.[0]?.text || "Telemetry offline.");
    } catch { setAiAdvice("Telemetry offline."); }
    setAiLoading(false);
  };

  const healthColor = health > 60 ? "#00e87a" : health > 30 ? "#ffd700" : "#ff4444";
  const densityColor = density < 40 ? "#38bdf8" : density < 70 ? "#ffd700" : "#ff4444";
  const wasteColor = wasteToxicity < 30 ? "#38c860" : wasteToxicity < 60 ? "#ffd700" : "#ff4444";
  const tm = Math.floor(timeLeft / 60), ts = timeLeft % 60;
  const phaseColor = getPhaseColor(growthPhase);

  const css = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    @keyframes fadeIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    @keyframes flicker{0%,100%{opacity:1}49%{opacity:.9}50%{opacity:.2}51%{opacity:.9}}
    @keyframes glow{0%,100%{filter:drop-shadow(0 0 8px currentColor)}50%{filter:drop-shadow(0 0 24px currentColor)}}
    @keyframes urgentPulse{0%,100%{border-color:rgba(255,68,68,0.3);box-shadow:0 0 6px rgba(255,68,68,0.2)}50%{border-color:rgba(255,68,68,0.08);box-shadow:none}}
    *{box-sizing:border-box}
    input[type=range]{-webkit-appearance:none;height:8px;background:transparent;width:100%}
    input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:currentColor;cursor:pointer;box-shadow:0 0 10px currentColor;transition:transform 0.15s}
    input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.25)}
    input[type=range]::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:currentColor;cursor:pointer;border:none;box-shadow:0 0 10px currentColor}
    ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:#e8ebf0}::-webkit-scrollbar-thumb{background:#b0c0d0}
  `;

  if (phase === "intro") {
    return (
      <div style={{ minHeight: "100vh", background: "#f0f4f8", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif", padding: "20px" }}>
        <style>{css}</style>
        <div style={{ textAlign: "center", maxWidth: "520px", width: "100%" }}>

          {/* CLASSIFIED HEADER */}
          <div style={{ fontSize: "12px", letterSpacing: "0.25em", color: "#4a5a6a", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "500", marginBottom: "20px" }}>STB-9000 · CONTAINMENT UNIT · ROUND {round}</div>

          {/* SPECIES IDENTITY — that's ALL they get */}
          <div style={{ fontSize: "60px", marginBottom: "12px", filter: `drop-shadow(0 0 18px ${bacterium.color})` }}>{bacterium.emoji}</div>
          <div style={{ fontSize: "12px", letterSpacing: "0.2em", color: "#788898", fontFamily: "'Inter','Segoe UI',sans-serif", marginBottom: "4px" }}>YOUR ASSIGNED ORGANISM</div>
          <h1 style={{ fontSize: "28px", color: bacterium.color, margin: "0 0 6px", fontWeight: "bold", letterSpacing: "0.08em", textShadow: `0 0 20px ${bacterium.color}88` }}>
            {species}
          </h1>
          <div style={{ fontSize: "9px", color: "#788898", marginBottom: "28px", letterSpacing: "0.12em", fontStyle: "italic" }}>{bacterium.description}</div>

          {/* WARNING BOX */}
          <div style={{ background: "#fff5f5", border: "1px solid #ff444444", borderRadius: "6px", padding: "18px", marginBottom: "20px", textAlign: "left" }}>
            <div style={{ fontSize: "9px", color: "#ff4444", letterSpacing: "0.35em", marginBottom: "12px", textAlign: "center" }}>⚠ OPERATOR WARNING</div>
            <div style={{ fontSize: "9px", color: "#445566", lineHeight: "2.0", letterSpacing: "0.04em" }}>
              <span style={{ color: "#ff6644" }}>No parameters will be shown to you.</span> The bioreactor does not know what this organism needs — <span style={{ color: "#ff6644" }}>you do.</span>
              <br /><br />
              You must set the correct <span style={{ color: "#ff5555" }}>temperature</span>, <span style={{ color: "#9060e8" }}>pH</span>, <span style={{ color: "#2890e0" }}>dissolved O₂</span>, and <span style={{ color: "#f59e0b" }}>nutrients</span> from your own biological knowledge.
              <br /><br />
              Wrong conditions kill the culture <span style={{ color: "#ff4444" }}>within seconds.</span> Wrong nutrients cause metabolic damage. Equipment will malfunction. Crises will escalate.
              <br /><br />
              <span style={{ color: "#ffd700" }}>You have 5 minutes.</span> The culture starts now or dies trying.
            </div>
          </div>

          {/* HOW TO PLAY — mechanics only, NO biological hints */}
          <div style={{ background: "#f5f7fa", border: "1px solid #0a1a2a", borderRadius: "6px", padding: "12px", marginBottom: "22px", textAlign: "left" }}>
            <div style={{ fontSize: "11px", color: "#4a5a6a", letterSpacing: "0.15em", marginBottom: "8px" }}>SYSTEM MECHANICS</div>
            {[
              ["SLIDERS", "Control temperature, pH, O₂ in real-time. You decide the values."],
              ["NUTRIENTS", "5 substrates available. Some help this organism, some destroy it. You choose."],
              ["FEED / DILUTE / PURGE / O₂", "Emergency tools — each has a cooldown. Use wisely."],
              ["CRISES", "Equipment faults hit randomly and worsen every minute. React in seconds."],
              ["SCORE", "Earned only when culture is thriving. Collapses when culture is dying."],
            ].map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: "10px", marginBottom: "6px", alignItems: "flex-start" }}>
                <span style={{ fontSize: "11px", color: "#3a5a8a", letterSpacing: "0.1em", minWidth: "110px", flexShrink: 0, paddingTop: "1px" }}>{k}</span>
                <span style={{ fontSize: "11px", color: "#788898", lineHeight: "1.5", fontFamily: "'Inter','Segoe UI',sans-serif" }}>{v}</span>
              </div>
            ))}
          </div>

          <button
            onClick={() => setPhase("playing")}
            style={{ background: `linear-gradient(135deg,${bacterium.color}1a,${bacterium.color}08)`, border: `2px solid ${bacterium.color}99`, color: bacterium.color, padding: "15px 52px", borderRadius: "4px", cursor: "pointer", fontSize: "12px", letterSpacing: "0.18em", fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif", boxShadow: `0 0 40px ${bacterium.color}33`, fontWeight: "bold", display: "block", width: "100%", marginBottom: "8px" }}>
            INITIALIZE CULTURE
          </button>
          <div style={{ fontSize: "11px", color: "#111820", letterSpacing: "0.2em" }}>
            no guidance will be given once the culture starts
          </div>
        </div>
      </div>
    );
  }

  if (phase === "dead" || phase === "won") return (
    <div style={{ minHeight: "100vh", background: "#f0f4f8", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif" }}>
      <style>{css}</style>
      <div style={{ textAlign: "center", animation: "fadeIn 0.5s ease", padding: "40px", maxWidth: "480px", width: "100%" }}>
        <div style={{ fontSize: "56px", marginBottom: "12px" }}>{phase === "won" ? "🎉" : "💀"}</div>
        <h1 style={{ fontSize: "22px", color: phase === "won" ? "#00e87a" : "#ff4444", margin: "0 0 4px", fontWeight: "normal", letterSpacing: "0.08em" }}>
          {phase === "won" ? "CULTURE SURVIVED 5 MINUTES" : "CULTURE TERMINATED"}
        </h1>
        <div style={{ fontSize: "9px", color: "#788898", marginBottom: "16px", letterSpacing: "0.1em" }}>{species} · Round {round}</div>
        <div style={{ fontSize: "28px", color: "#a07800", marginBottom: "16px", fontWeight: "bold", letterSpacing: "0.1em", textShadow: "0 0 20px #d4a80066" }}>{score.toLocaleString()} <span style={{ fontSize: "12px", color: "#8a7000" }}>PTS</span></div>
        <div style={{ background: "#070710", border: "1px solid #0e1e2e", borderRadius: "6px", padding: "14px", marginBottom: "12px", textAlign: "left" }}>
          <div style={{ fontSize: "11px", color: "#4a5a6a", marginBottom: "10px", letterSpacing: "0.25em" }}>TERMINAL STATE</div>
          {[
            ["Viability", `${health.toFixed(1)}%`, health > 60 ? "#00e87a" : health > 30 ? "#ffd700" : "#ff4444"],
            ["Cell Density", `${density.toFixed(0)} / ${BACTERIA[species].maxDensity}%`, density < 40 ? "#38bdf8" : density < 70 ? "#ffd700" : "#ff4444"],
            ["Waste Toxicity", `${wasteToxicity.toFixed(0)}%`, wasteToxicity < 30 ? "#38c860" : wasteToxicity < 60 ? "#ffd700" : "#ff4444"],
            ["Growth Phase", growthPhase.toUpperCase(), getPhaseColor(growthPhase)],
            ["Survived", `${300 - timeLeft}s / 300s`, timeLeft === 0 ? "#00e87a" : "#ff4444"],
          ].map(([l, v, c]) => (
            <div key={l} style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px", alignItems: "center" }}>
              <span style={{ fontSize: "11px", color: "#788898", letterSpacing: "0.04em", fontFamily: "'Inter','Segoe UI',sans-serif" }}>{l}</span>
              <span style={{ fontSize: "10px", color: c, fontWeight: "bold", fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif" }}>{v}</span>
            </div>
          ))}
        </div>
        {/* REVEAL the correct values AFTER the game — reward for playing */}
        <div style={{ background: "#f5f7fa", border: `1px solid ${bacterium.color}33`, borderRadius: "6px", padding: "14px", marginBottom: "12px", textAlign: "left" }}>
          <div style={{ fontSize: "11px", color: bacterium.color, letterSpacing: "0.35em", marginBottom: "10px" }}>
            {phase === "won" ? "✅ CORRECT PARAMETERS — YOUR KNOWLEDGE WAS RIGHT" : "📋 CORRECT PARAMETERS — STUDY FOR NEXT RUN"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", marginBottom: "10px" }}>
            {[
              ["🌡 TEMP", `${bacterium.temp.min}–${bacterium.temp.max}°C`, `opt ${bacterium.temp.opt}°C`, "#ff5555"],
              ["⚗ pH", `${bacterium.ph.min}–${bacterium.ph.max}`, `opt ${bacterium.ph.opt}`, "#9060e8"],
              ["💨 O₂", bacterium.oxygen, `pref ${bacterium.oxygen_pref}%`, "#2890e0"],
              ["🧬 DENSITY CAP", `${bacterium.maxDensity}%`, bacterium.difficulty, bacterium.color],
            ].map(([k, v, sub, c]) => (
              <div key={k} style={{ padding: "8px", border: `1px solid ${c}22`, borderRadius: "4px", background: `${c}08` }}>
                <div style={{ fontSize: "11px", color: c, letterSpacing: "0.1em", marginBottom: "2px" }}>{k}</div>
                <div style={{ fontSize: "12px", color: c, fontWeight: "bold" }}>{v}</div>
                <div style={{ fontSize: "11px", color: "#788898" }}>{sub}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: "11px", color: "#788898", letterSpacing: "0.2em", marginBottom: "5px" }}>PREFERRED NUTRIENTS</div>
          <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
            {bacterium.preferredNutrients.map(id => (
              <span key={id} style={{ padding: "3px 8px", border: `1px solid ${NUTRIENTS[id].color}44`, borderRadius: "3px", background: `${NUTRIENTS[id].color}0a`, fontSize: "11px", color: NUTRIENTS[id].color, fontFamily: "'Inter','Segoe UI',sans-serif" }}>
                {NUTRIENTS[id].label}
              </span>
            ))}
          </div>
          {bacterium.funFact && <div style={{ fontSize: "11px", color: "#2a4a3a", fontFamily: "'Inter','Segoe UI',sans-serif", marginTop: "10px", fontStyle: "italic", lineHeight: "1.6", padding: "8px", background: "#020a05", borderRadius: "4px", border: "1px solid #0a2a1a" }}>💡 {bacterium.funFact}</div>}
        </div>
        {phase === "dead" && (
          <div style={{ background: "#fff5f5", border: "1px solid #ff444422", borderRadius: "6px", padding: "10px 14px", marginBottom: "12px", textAlign: "left" }}>
            <div style={{ fontSize: "11px", color: "#ff4444", letterSpacing: "0.25em", marginBottom: "6px" }}>CAUSE OF DEATH</div>
            <div style={{ fontSize: "11px", color: "#ff444466", fontFamily: "'Inter','Segoe UI',sans-serif", lineHeight: "1.7" }}>
              {wasteToxicity > 65 ? "Lethal metabolic waste caused irreversible cell lysis. Purge earlier." :
                density < 3 ? "Culture starved — no viable nutrients for this organism." :
                  "Environmental parameters exceeded species tolerance. Check temp/pH/O₂."}
            </div>
          </div>
        )}
        <div style={{ display: "flex", gap: "12px", justifyContent: "center" }}>
          <button onClick={() => {
            const nextSpecies = pickRandomSpecies();
            const b = BACTERIA[nextSpecies];
            setSpecies(nextSpecies); setRound(r => r + 1); setPhase("intro");
            setHealth(75); setDensity(15); setActiveNutrients({ glucose: 70 }); setWasteToxicity(0); setCultureAge(0);
            setAgitatorRpm(200); setCo2Level(0); setN2Flow(0);
            setGrowthPhase("lag"); setAlerts([]); setAiAdvice(""); setTimeLeft(300); setScore(0);
            setHealthHistory([75]); setDensityHistory([15]); setWasteHistory([0]);
            setCooldowns({ feed: 0, dilute: 0, purge: 0, boost: 0 });
            // Start with WRONG parameters — player must know and fix them immediately
            setParams({
              temperature: b.temp.opt + (Math.random() > 0.5 ? (8 + Math.random() * 6) : -(6 + Math.random() * 5)),
              ph: b.ph.opt + (Math.random() > 0.5 ? (1.5 + Math.random() * 1.5) : -(1.2 + Math.random() * 1.5)),
              oxygen: Math.random() * 40 + 10,  // random O2, might be wrong for anaerobes or aerobes
            });
          }} style={{ background: "transparent", border: `1px solid ${bacterium.color}66`, color: bacterium.color, padding: "10px 28px", borderRadius: "4px", cursor: "pointer", fontSize: "10px", letterSpacing: "0.22em", fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif" }}>
            NEXT ROUND →
          </button>
          <button onClick={() => { if (onReset) onReset(); else window.location.reload(); }} style={{ background: "transparent", border: "1px solid #1e2e3e", color: "#445566", padding: "10px 28px", borderRadius: "4px", cursor: "pointer", fontSize: "10px", letterSpacing: "0.22em", fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif" }}>RESET</button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ height: "100vh", background: "#f0f4f8", color: "#2a3a4a", fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif", overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <style>{css}</style>

      {/* TOP STATUS BAR */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 16px", background: "#ffffff", borderBottom: "1px solid #d0d8e8", boxShadow: "0 1px 4px rgba(0,0,0,0.04)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div>
            <div style={{ fontSize: "8px", color: "#4a5a6a", letterSpacing: "0.12em", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "500" }}>STB-9000 · R{round}</div>
            <div style={{ fontSize: "12px", color: bacterium.color, fontWeight: "bold", textShadow: `0 0 8px ${bacterium.color}66` }}>{bacterium.emoji} {species}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "4px", padding: "2px 6px", background: `${phaseColor}0a`, border: `1px solid ${phaseColor}22`, borderRadius: "3px" }}>
            <div style={{ width: "4px", height: "4px", borderRadius: "50%", background: phaseColor, boxShadow: `0 0 4px ${phaseColor}` }} />
            <span style={{ fontSize: "8px", color: phaseColor, letterSpacing: "0.08em", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "600" }}>{growthPhase.toUpperCase()}</span>
          </div>
          <div style={{ display: "flex", gap: "3px" }}>
            {Object.entries(activeNutrients).filter(([, v]) => v > 0).map(([id]) => (
              <div key={id} style={{ padding: "1px 5px", borderRadius: "2px", background: `${NUTRIENTS[id].color}12`, border: `1px solid ${NUTRIENTS[id].color}33`, fontSize: "9px", color: NUTRIENTS[id].color }}>
                {NUTRIENTS[id].symbol}
              </div>
            ))}
          </div>
        </div>
        <div style={{ flex: "0 0 220px", textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
            <span style={{ fontSize: "8px", color: "#4a5a6a", letterSpacing: "0.08em", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "500" }}>VIABILITY</span>
            <span style={{ fontSize: "12px", color: healthColor, fontWeight: "bold", textShadow: `0 0 8px ${healthColor}66` }}>{health.toFixed(1)}%</span>
          </div>
          <div style={{ height: "4px", background: "#e8ebf0", borderRadius: "2px", overflow: "hidden", border: `1px solid ${healthColor}18` }}>
            <div style={{ height: "100%", width: `${health}%`, background: `linear-gradient(90deg,${healthColor}55,${healthColor})`, transition: "width 0.5s", boxShadow: `0 0 8px ${healthColor}66` }} />
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "8px", color: "#4a5a6a", letterSpacing: "0.08em", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "500" }}>TIME</div>
          <div style={{ fontSize: "18px", color: timeLeft < 60 ? "#ff4444" : "#7a8898", animation: timeLeft < 30 ? "flicker 1s infinite" : "none", fontWeight: "bold", letterSpacing: "0.05em" }}>
            {String(tm).padStart(2, "0")}:{String(ts).padStart(2, "0")}
          </div>
          <div style={{ fontSize: "10px", color: "#a07800", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "600" }}>{score.toLocaleString()} pts</div>
        </div>
      </div>

      {/* DANGER THREAT BAR — always visible during crises */}
      {/* LIVE THREAT INDICATOR */}
      {phase === "playing" && (() => {
        const b2 = BACTERIA[species];
        const threats = [];
        if (params.temperature > b2.temp.max) threats.push(`🌡 TEMP HIGH: ${params.temperature.toFixed(1)}°C`);
        else if (params.temperature < b2.temp.min) threats.push(`🌡 TEMP LOW: ${params.temperature.toFixed(1)}°C`);
        if (params.ph < b2.ph.min) threats.push(`⚗ pH ACID: ${params.ph.toFixed(2)}`);
        else if (params.ph > b2.ph.max) threats.push(`⚗ pH BASE: ${params.ph.toFixed(2)}`);
        if (params.oxygen < 20 && b2.oxygen !== "anaerobic") threats.push(`💨 O₂ LOW: ${params.oxygen.toFixed(0)}%`);
        if (wasteToxicity > 55) threats.push(`☠ WASTE: ${wasteToxicity.toFixed(0)}%`);
        if (Object.keys(activeNutrients).length === 0) threats.push(`🥣 STARVING`);
        if (agitatorRpm < 80) threats.push(`⚙ AGITATOR STALLED`);
        if (agitatorRpm > 620) threats.push(`⚙ SHEAR DAMAGE: ${agitatorRpm}RPM`);
        if (co2Level > 65) threats.push(`💨 CO₂ TOXIC: ${co2Level.toFixed(0)}%`);
        if (threats.length === 0) return null;
        return (
          <div style={{ background: "#fff0f0cc", borderBottom: "1px solid #ff444466", padding: "2px 16px", display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap", animation: "urgentPulse 0.8s infinite", flexShrink: 0 }}>
            {threats.map(t => <span key={t} style={{ fontSize: "9px", color: "#ff4444", letterSpacing: "0.06em", fontWeight: "bold", fontFamily: "'Inter','Segoe UI',sans-serif" }}>{t}</span>)}
          </div>
        );
      })()}
      {fluctEvent && (
        <div style={{ background: "#ff6b3510", borderBottom: "1px solid #ff6b3530", padding: "2px 16px", color: "#ff6b35", fontSize: "9px", letterSpacing: "0.06em", textAlign: "center", fontFamily: "'Inter','Segoe UI',sans-serif", animation: "fadeIn 0.3s ease", flexShrink: 0 }}>
          {fluctEvent}
        </div>
      )}

      {/* MAIN COCKPIT GRID */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px 1fr", gap: "0", flex: "1 1 0", minHeight: 0, alignItems: "stretch" }}>

        {/* LEFT PANEL */}
        <div style={{ padding: "6px 8px", background: "#f5f7fa", borderRight: "1px solid #0a1020", display: "flex", flexDirection: "column", gap: "4px", overflow: "hidden" }}>
          <div style={{ fontSize: "9px", letterSpacing: "0.15em", color: "#4a5a6a", paddingBottom: "3px", borderBottom: "1px solid #d0d8e8", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "600", flexShrink: 0 }}>THERMAL · CHEMICAL</div>

          <div style={{ background: "#fafbfc", borderRadius: "4px", padding: "6px 8px", border: "1px solid #ff555540" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2px" }}>
              <div style={{ fontSize: "9px", color: "#445566", letterSpacing: "0.06em", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "500" }}>TEMPERATURE</div>
              <div style={{ fontSize: "20px", color: "#ff5555", fontWeight: "bold", textShadow: "0 0 12px #ff555566" }}>{params.temperature.toFixed(1)}<span style={{ fontSize: "11px", color: "#ff555588" }}>°C</span></div>
            </div>
            <CockpitSlider label="" value={params.temperature} min={0} max={80} step={0.5} unit="°C" onChange={setParam("temperature")} color="#ff5555" />
          </div>

          <div style={{ background: "#fafbfc", borderRadius: "4px", padding: "6px 8px", border: "1px solid #9060e840" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2px" }}>
              <div style={{ fontSize: "9px", color: "#445566", letterSpacing: "0.06em", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "500" }}>pH LEVEL</div>
              <div style={{ fontSize: "20px", color: "#9060e8", fontWeight: "bold", textShadow: "0 0 12px #9060e866" }}>{params.ph.toFixed(2)}</div>
            </div>
            <CockpitSlider label="" value={params.ph} min={0} max={14} step={0.1} unit="" onChange={setParam("ph")} color="#9060e8" />
          </div>

          {/* AGITATOR RPM CONTROL */}
          <div style={{ background: "#fafbfc", borderRadius: "4px", padding: "6px 8px", border: "1px solid #5090a040" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2px" }}>
              <div style={{ fontSize: "9px", color: "#445566", letterSpacing: "0.06em", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "500" }}>⚙ AGITATOR</div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "8px", padding: "1px 5px", borderRadius: "2px", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "600", background: agitatorRpm < 100 ? "#ff880022" : agitatorRpm > 600 ? "#ff220022" : "#5090a022", border: `1px solid ${agitatorRpm < 100 ? "#ff8800" : agitatorRpm > 600 ? "#ff2200" : "#5090a0"}44`, color: agitatorRpm < 100 ? "#ff8800" : agitatorRpm > 600 ? "#ff4400" : "#5090a0", letterSpacing: "0.08em" }}>
                  {agitatorRpm < 100 ? "POOR MIX" : agitatorRpm > 600 ? "SHEAR RISK" : "OPTIMAL"}
                </span>
                <span style={{ fontSize: "18px", color: "#5090c0", fontWeight: "bold", textShadow: "0 0 12px #5090c066" }}>{agitatorRpm}<span style={{ fontSize: "10px", color: "#5090c088" }}> RPM</span></span>
              </div>
            </div>
            <CockpitSlider label="" value={agitatorRpm} min={50} max={800} step={10} unit="RPM" onChange={v => setAgitatorRpm(v)} color="#5090c0" />
          </div>

          {/* CO₂ LEVEL MONITOR */}
          <div style={{ background: "#fafbfc", borderRadius: "4px", padding: "5px 8px", border: "1px solid #9060c040" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
              <div style={{ fontSize: "9px", color: "#445566", letterSpacing: "0.06em", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "500" }}>CO₂ EXHAUST</div>
              <div style={{ fontSize: "12px", color: co2Level < 30 ? "#9060c0" : co2Level < 60 ? "#ff8800" : "#ff2200", fontWeight: "bold", fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif" }}>{co2Level.toFixed(0)}%</div>
            </div>
            <div style={{ height: "5px", background: "#f5f7fa", borderRadius: "3px", overflow: "hidden", border: "1px solid #9060c018" }}>
              <div style={{ height: "100%", width: `${co2Level}%`, background: `linear-gradient(90deg,#7040a0,${co2Level > 60 ? "#ff2200" : co2Level > 30 ? "#ff8800" : "#c070f0"})`, transition: "width 0.5s", boxShadow: `0 0 6px #9060c088` }} />
            </div>
          </div>

          {/* N₂ FLOW CONTROL */}
          <div style={{ background: "#fafbfc", borderRadius: "4px", padding: "6px 8px", border: "1px solid #40c08040" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2px" }}>
              <div style={{ fontSize: "9px", color: "#445566", letterSpacing: "0.06em", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "500" }}>N₂ PURGE FLOW</div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "8px", padding: "1px 5px", borderRadius: "2px", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "600", background: "#40c08018", border: "1px solid #40c08044", color: "#40c080", letterSpacing: "0.08em" }}>
                  {n2Flow < 5 ? "OFF" : n2Flow < 40 ? "LOW" : n2Flow < 70 ? "MED" : "HIGH"}
                </span>
                <span style={{ fontSize: "18px", color: "#40c080", fontWeight: "bold", textShadow: "0 0 10px #40c08066" }}>{n2Flow.toFixed(0)}<span style={{ fontSize: "10px", color: "#40c08088" }}>%</span></span>
              </div>
            </div>
            <CockpitSlider label="" value={n2Flow} min={0} max={100} step={1} unit="%" onChange={v => setN2Flow(v)} color="#40c080" />
          </div>

          {/* Growth chart */}
          <div style={{ background: "#fafbfc", borderRadius: "4px", padding: "5px 8px", border: "1px solid #d0dce8" }}>
            <div style={{ fontSize: "8px", color: "#4a5a6a", letterSpacing: "0.10em", marginBottom: "3px", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "600" }}>GROWTH vs TIME</div>
            <GrowthChart densityHistory={densityHistory} healthHistory={healthHistory} wasteHistory={wasteHistory} width={220} />
          </div>

          {/* System log */}
          <div style={{ background: "#ffffff", borderRadius: "4px", padding: "5px 8px", border: "1px solid #0a1020", flex: "1 1 auto", overflow: "hidden", minHeight: 0 }}>
            <div style={{ fontSize: "8px", color: "#4a5a6a", letterSpacing: "0.10em", marginBottom: "3px", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "600" }}>SYSTEM LOG</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px", overflowY: "auto", maxHeight: "90px" }}>
              {alerts.length === 0
                ? <div style={{ fontSize: "9px", color: "#6a8090", textAlign: "center", padding: "4px 0", letterSpacing: "0.04em", fontFamily: "'Inter','Segoe UI',sans-serif" }}>— nominal —</div>
                : alerts.map(a => (
                  <div key={a.id} style={{ padding: "2px 6px", background: `${a.color}0a`, border: `1px solid ${a.color}33`, borderRadius: "2px", color: a.color, fontSize: "9px", animation: "fadeIn 0.3s ease", letterSpacing: "0.02em", fontFamily: "'Inter','Segoe UI',sans-serif" }}>{a.msg}</div>
                ))}
            </div>
          </div>
        </div>

        {/* CENTER: BIOREACTOR */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", padding: "2px 0 0", background: "#e8ecf2", position: "relative", overflow: "hidden" }}>
          <BioreactorCanvas
            species={species} params={params} health={health}
            density={density} wasteToxicity={wasteToxicity} growthPhase={growthPhase}
            activeNutrients={activeNutrients}
            agitatorRpm={agitatorRpm} co2Level={co2Level} n2Flow={n2Flow}
            width={380} height={540}
          />
          <div style={{ width: "100%", padding: "4px 10px 6px", display: "flex", gap: "5px", background: "#e8ecf2", flexShrink: 0 }}>
            <ActionButton label="FEED" sublabel={cooldowns.feed > 0 ? `${cooldowns.feed}s` : "ready"} color="#38c860" onClick={doFeed} cooldown={cooldowns.feed} cooldownMax={20} />
            <ActionButton label="DILUTE" sublabel={cooldowns.dilute > 0 ? `${cooldowns.dilute}s` : "ready"} color="#38bdf8" onClick={doDilute} cooldown={cooldowns.dilute} cooldownMax={30} />
            <ActionButton label="PURGE" sublabel={cooldowns.purge > 0 ? `${cooldowns.purge}s` : "ready"} color="#ffd700" onClick={doPurge} cooldown={cooldowns.purge} cooldownMax={25} />
            <ActionButton label="O₂ BOOST" sublabel={cooldowns.boost > 0 ? `${cooldowns.boost}s` : "ready"} color="#80c0f8" onClick={doO2Boost} cooldown={cooldowns.boost} cooldownMax={15} />
          </div>
        </div>

        {/* RIGHT PANEL */}
        <div style={{ padding: "6px 8px", background: "#f5f7fa", borderLeft: "1px solid #0a1020", display: "flex", flexDirection: "column", gap: "4px", overflow: "hidden" }}>
          <div style={{ fontSize: "9px", letterSpacing: "0.15em", color: "#4a5a6a", paddingBottom: "3px", borderBottom: "1px solid #d0d8e8", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "600", flexShrink: 0 }}>
            NUTRIENTS · ENVIRONMENT
          </div>

          {/* Multi-Nutrient Panel */}
          <NutrientPanel activeNutrients={activeNutrients} onUpdate={updateNutrient} />

          {/* O2 slider */}
          <div style={{ background: "#fafbfc", borderRadius: "4px", padding: "6px 8px", border: "1px solid #2890e040" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2px" }}>
              <div style={{ fontSize: "9px", color: "#445566", letterSpacing: "0.06em", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "500" }}>DISSOLVED O₂</div>
              <div style={{ fontSize: "20px", color: "#2890e0", fontWeight: "bold", textShadow: "0 0 12px #2890e066" }}>{params.oxygen.toFixed(0)}<span style={{ fontSize: "11px", color: "#2890e088" }}>%</span></div>
            </div>
            <CockpitSlider label="" value={params.oxygen} min={0} max={100} step={1} unit="%" onChange={setParam("oxygen")} color="#2890e0" />
          </div>

          {/* Biological gauges */}
          <div style={{ background: "#fafbfc", borderRadius: "4px", padding: "5px 8px", border: "1px solid #d0dce8" }}>
            <div style={{ fontSize: "8px", color: "#4a5a6a", letterSpacing: "0.10em", marginBottom: "4px", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "600" }}>BIOLOGICAL STATE</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px" }}>
              <CockpitGauge label="Density" value={density} max={100} color={densityColor} warn={density > 75} />
              <CockpitGauge label="NutScore" value={nutScore * 100} max={100} color={nutScore < 0.25 ? "#ff4444" : "#38c860"} warn={nutScore < 0.25} />
              <CockpitGauge label="Waste" value={wasteToxicity} max={100} color={wasteColor} warn={wasteToxicity > 55} />
              <CockpitGauge label="Viability" value={health} max={100} color={healthColor} warn={health < 30} />
            </div>
          </div>

          {/* Species ref */}
          <div style={{ background: "#fafbfc", borderRadius: "4px", padding: "5px 8px", border: `1px solid ${bacterium.color}55` }}>
            <div style={{ fontSize: "8px", color: "#4a5a6a", letterSpacing: "0.10em", marginBottom: "3px", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "600" }}>SPECIES DATA</div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 8px", fontSize: "9px", alignItems: "center" }}>
              <span style={{ color: "#788898", letterSpacing: "0.03em", fontFamily: "'Inter','Segoe UI',sans-serif" }}>Temp</span>
              <span style={{ color: "#ff5555", fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif" }}>{bacterium.temp.min}–{bacterium.temp.max}°C</span>
              <span style={{ color: "#788898", letterSpacing: "0.03em", fontFamily: "'Inter','Segoe UI',sans-serif" }}>pH</span>
              <span style={{ color: "#9060e8", fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif" }}>{bacterium.ph.min}–{bacterium.ph.max}</span>
              <span style={{ color: "#788898", letterSpacing: "0.03em", fontFamily: "'Inter','Segoe UI',sans-serif" }}>O₂</span>
              <span style={{ color: "#2890e0", fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif" }}>{bacterium.oxygen}</span>
              <span style={{ color: "#788898", letterSpacing: "0.03em", fontFamily: "'Inter','Segoe UI',sans-serif" }}>Pref</span>
              <span style={{ color: bacterium.color, fontFamily: "'Inter','Segoe UI','Helvetica Neue',sans-serif" }}>{bacterium.preferredNutrients.map(id => NUTRIENTS[id].symbol).join(" + ")}</span>
            </div>
          </div>

          {/* AI Telemetry */}
          <div style={{ background: "#fafbfc", borderRadius: "4px", padding: "5px 8px", border: `1px solid ${bacterium.color}55`, flex: "0 0 auto" }}>
            <div style={{ fontSize: "8px", color: "#4a5a6a", letterSpacing: "0.10em", marginBottom: "4px", fontFamily: "'Inter','Segoe UI',sans-serif", fontWeight: "600" }}>BIOLOGICAL TELEMETRY</div>
            <button onClick={getAiAdvice} disabled={aiLoading} style={{ width: "100%", padding: "5px", background: aiLoading ? "#f0f2f5" : `${bacterium.color}0a`, border: `1px solid ${bacterium.color}33`, color: aiLoading ? "#4a5a6a" : bacterium.color, borderRadius: "3px", cursor: aiLoading ? "wait" : "pointer", fontSize: "9px", letterSpacing: "0.08em", fontFamily: "'Inter','Segoe UI',sans-serif", marginBottom: aiAdvice ? "4px" : 0, fontWeight: "700" }}>
              {aiLoading ? "ANALYZING..." : "REQUEST TELEMETRY"}
            </button>
            {aiAdvice && (
              <div style={{ fontSize: "9px", color: "#788898", lineHeight: "1.6", fontFamily: "'Inter','Segoe UI',sans-serif", padding: "5px", background: "#f5f7fa", borderRadius: "3px", border: `1px solid ${bacterium.color}55`, animation: "fadeIn 0.4s ease", maxHeight: "70px", overflowY: "auto", letterSpacing: "0.03em" }}>
                {aiAdvice}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROOT APP — landing gate → platform
// ══════════════════════════════════════════════════════════════════════════════
function BioreactorSimulator({ studentName, sessionKey, pin, studentId, locationData, trialType, entryTime }) {
  const [blocked, setBlocked] = useState(false);

  // ── Check PIN block status from Firebase on mount (works across all browsers) ──
  useEffect(() => {
    if (!pin) return;
    (async () => {
      try {
        const pinDocRef = doc(db, "validPins", pin);
        const pinDoc = await getDoc(pinDocRef);
        if (pinDoc.exists()) {
          const pinData = pinDoc.data();
          const currentUsage = pinData.usageCount || 0;
          if (currentUsage >= getMaxPinUses(pin)) {
            setBlocked(true);
          }
        }
      } catch (err) {
        console.error("PIN block check error:", err);
      }
    })();
  }, [pin]);

  const handleReset = async () => {
    // Check usage count before allowing reset
    try {
      const pinDocRef = doc(db, "validPins", pin);
      const pinDoc = await getDoc(pinDocRef);

      if (pinDoc.exists()) {
        const pinData = pinDoc.data();
        const currentUsage = pinData.usageCount || 0;

        if (currentUsage >= getMaxPinUses(pin)) {
          setBlocked(true);
          return;
        }

        const newUsageCount = currentUsage + 1;
        const attemptTimestamp = new Date().toISOString();

        // Increment usage count
        await updateDoc(pinDocRef, {
          usageCount: increment(1),
          lastUsedBy: studentId,
          lastUsedAt: attemptTimestamp,
          status: newUsageCount >= getMaxPinUses(pin) ? "exhausted" : "active",
        });

        // Fetch fresh location data for reset attempt
        let freshLocation = locationData || { ip: "unknown", country: "", city: "", latitude: "", longitude: "" };
        try {
          const geoRes = await fetch("https://ipapi.co/json/");
          const geoData = await geoRes.json();
          freshLocation = {
            ip: geoData.ip || freshLocation.ip,
            country: geoData.country_name || geoData.country || freshLocation.country,
            city: geoData.city || freshLocation.city,
            latitude: String(geoData.latitude || freshLocation.latitude),
            longitude: String(geoData.longitude || freshLocation.longitude),
          };
        } catch { /* use cached location */ }

        // Log reset attempt
        addDoc(collection(db, "pinAttempts"), {
          pin_code: pin,
          student_id: studentId,
          attempt_number: newUsageCount,
          attempt_type: "reset",
          timestamp: attemptTimestamp,
          location: freshLocation,
        }).catch((err) => console.error("Failed to log reset attempt:", err));
      }
    } catch (err) {
      console.error("Reset attempt tracking error:", err);
    }

    // Set sessionStorage flag so next load knows this is a "reset" trial
    sessionStorage.setItem("bioreactor_trialType", "reset");
    // Reload the page to reset the simulation
    window.location.reload();
  };

  // Show blocked screen if max attempts reached
  if (blocked) {
    return (
      <div style={{
        height: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "linear-gradient(150deg,#fef2f2 0%,#ffffff 45%,#fff5f5 100%)",
        fontFamily: "'DM Sans', sans-serif",
      }}>
        <div style={{
          background: "#fff", borderRadius: 20, padding: "52px 48px", textAlign: "center",
          maxWidth: 480, width: "100%",
          boxShadow: "0 20px 60px rgba(0,0,0,0.08), 0 0 0 1px rgba(239,68,68,0.15)",
        }}>
          <div style={{
            width: 72, height: 72, borderRadius: "50%",
            background: "#fef2f2", border: "2px solid #fca5a5",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 20px", fontSize: 32,
          }}>🚫</div>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 22, color: "#991b1b", fontWeight: 700, margin: "0 0 12px" }}>
            Maximum Attempts Reached
          </h2>
          <p style={{ color: "#6b7280", fontSize: 15, lineHeight: 1.6, margin: 0 }}>
            You have reached your maximum number of attempts ({MAX_PIN_USES}).<br />
            Please contact your instructor for assistance.
          </p>
        </div>
      </div>
    );
  }

  return <BioreactorSim sessionKey={sessionKey} onReset={handleReset} trialType={trialType} entryTime={entryTime} />;
}

export default function App() {
  const [session, setSession] = useState(null);
  if (!session) return <LandingForm onAccessGranted={setSession} />;
  return (
    <BioreactorSimulator
      studentName={session.name}
      sessionKey={session.sessionKey}
      pin={session.pin}
      studentId={session.studentId}
      locationData={session.locationData}
      trialType={session.trialType}
      entryTime={session.entryTime}
    />
  );
}

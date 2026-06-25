// Firebase monitoring for the public site: Performance Monitoring (page-load +
// network traces) and Google Analytics (GA4). The web config below is public
// client configuration (not a secret) — safe to ship in the bundle.
//
// Initialization is best-effort and guarded for the browser: a monitoring
// failure must never break the app, so errors are swallowed.
import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported as analyticsSupported } from "firebase/analytics";
import { getPerformance } from "firebase/performance";

const firebaseConfig = {
  apiKey: "AIzaSyDToztFOP5qrcvJ5O-eP1uyUm2Wv9h5RTk",
  authDomain: "stream-reduce.firebaseapp.com",
  projectId: "stream-reduce",
  storageBucket: "stream-reduce.firebasestorage.app",
  messagingSenderId: "403292673947",
  appId: "1:403292673947:web:1fab651ccba896f423333e",
  measurementId: "G-1V0P7TPJ9Z",
};

const firebaseApp = initializeApp(firebaseConfig);

// Performance Monitoring: automatic page-load + HTTP/S request traces.
try {
  getPerformance(firebaseApp);
} catch {
  // ignore — monitoring is non-critical
}

// Google Analytics: only where the SDK is supported (needs a browser with
// cookies/IndexedDB; skipped in unsupported contexts).
async function initializeAnalytics(): Promise<void> {
  try {
    if (await analyticsSupported()) getAnalytics(firebaseApp);
  } catch {
    // ignore — monitoring is non-critical
  }
}

void initializeAnalytics();

"use client";

// Persists a ?ref=CODE from any entry URL (e.g. /?ref=XGRID) so the referral
// page can offer to bind it after the wallet connects. Client-only; reads
// window.location to avoid a Suspense boundary.
import { useEffect } from "react";

export const PENDING_REF_KEY = "xkub.pendingRef";

export default function RefCapture() {
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref) localStorage.setItem(PENDING_REF_KEY, ref.toUpperCase().slice(0, 31));
  }, []);
  return null;
}

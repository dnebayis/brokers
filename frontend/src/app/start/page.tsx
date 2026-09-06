"use client";

// The participant onboarding lives on the campaign page now, with the seat lookup and the
// desks in one place. Links that were handed out as /start?broker=N keep working: they land
// on the campaign page with the same seat open.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function StartRedirect() {
  const router = useRouter();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("broker");
    router.replace(q ? `/campaign?broker=${encodeURIComponent(q)}` : "/campaign");
  }, [router]);
  return (
    <p className="text-ink-soft text-sm p-6">Taking you to the desk…</p>
  );
}

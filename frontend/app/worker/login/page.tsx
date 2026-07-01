"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Smartphone, KeyRound, ArrowLeft, Loader2 } from "lucide-react";
import { auth } from "@/lib/api";
import { setSession } from "@/lib/session";

type Step = "phone" | "code";

export default function WorkerLogin() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // The code is delivered by SMS only — it is never returned by the API, so
      // there's nothing to prefill. The user must enter what they received.
      await auth.requestOtp(phone.trim());
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send code");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await auth.verifyOtp(phone.trim(), code.trim());
      setSession(res.token, res.worker);
      router.push("/worker/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex-1 flex flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground mb-6"
        >
          <ArrowLeft size={16} /> Back
        </Link>

        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div className="grid place-items-center w-12 h-12 rounded-xl bg-indigo-50 text-brand mb-4">
            {step === "phone" ? <Smartphone size={24} /> : <KeyRound size={24} />}
          </div>
          <h1 className="text-xl font-bold mb-1">
            {step === "phone" ? "Sign in" : "Enter your code"}
          </h1>
          <p className="text-sm text-muted mb-5">
            {step === "phone"
              ? "We'll text you a 6-digit verification code."
              : `We sent a code to ${phone}.`}
          </p>

          {step === "phone" ? (
            <form onSubmit={sendCode} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Mobile number</label>
                <input
                  type="tel"
                  inputMode="tel"
                  autoFocus
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 555 000 1000"
                  className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base outline-none focus:border-brand focus:ring-2 focus:ring-indigo-100"
                />
              </div>
              <button
                type="submit"
                disabled={busy || !phone.trim()}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 font-medium text-white disabled:opacity-50"
              >
                {busy && <Loader2 size={18} className="animate-spin" />}
                Send code
              </button>
            </form>
          ) : (
            <form onSubmit={verify} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Verification code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  required
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="------"
                  className="w-full tracking-[0.5em] text-center text-2xl rounded-xl border border-border bg-white px-4 py-3 outline-none focus:border-brand focus:ring-2 focus:ring-indigo-100"
                />
              </div>
              <button
                type="submit"
                disabled={busy || code.length < 6}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 font-medium text-white disabled:opacity-50"
              >
                {busy && <Loader2 size={18} className="animate-spin" />}
                Verify &amp; continue
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep("phone");
                  setCode("");
                  setError(null);
                }}
                className="w-full text-sm text-muted hover:text-foreground"
              >
                Use a different number
              </button>
            </form>
          )}

          {error && (
            <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </p>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-muted">
          Demo worker: <span className="font-mono">+15550001000</span>
        </p>
      </div>
    </main>
  );
}

/**
 * Official WhatsApp (Meta) message templates, sent via Twilio's Content API.
 *
 * Out-of-session WhatsApp — messaging a contact outside the 24h customer-care
 * window (a recruit, or a worker who hasn't replied recently) — is only allowed
 * with a pre-approved template. Each template here maps to a Twilio Content SID
 * (HX…). The SID can be overridden per environment via its env key (so staging
 * and prod can point at different approved templates); the hardcoded default is
 * the production Content SID.
 *
 * Variable `samples` are the example values from the template catalog — used to
 * pre-fill the admin's editable inputs, not sent verbatim.
 */

export interface TemplateVariable {
  /** Positional index as Twilio expects it in contentVariables ("1".."N"). */
  position: string;
  /** Human label shown in the admin form. */
  label: string;
  /** Example value, pre-filled and editable. */
  sample: string;
  /**
   * Where the value comes from in a BULK template send. "worker_name" → resolved
   * per recipient from the matched Worker record (the admin's typed value is only
   * a fallback for unmatched manual numbers). Undefined → a global override the
   * admin types once and that applies to every recipient.
   */
  source?: "worker_name";
}

export interface MessageTemplate {
  /** Stable key used by the API + frontend dropdown. */
  key: string;
  /** Env var holding a Content SID override for this template. */
  envKey: string;
  /** Display name shown in the dropdown. */
  displayName: string;
  /** Production Content SID (HX…); used when the env override is unset. */
  defaultSid: string;
  variables: TemplateVariable[];
}

export const TEMPLATE_CATALOG: MessageTemplate[] = [
  {
    key: "shift_change_notification",
    envKey: "TWILIO_TEMPLATE_SHIFT_CHANGE_NOTIFICATION",
    displayName: "Shift Change Notification",
    defaultSid: "HX40c8840fa54cc3b4dfafc328cf598b46",
    variables: [
      { position: "1", label: "Worker name", sample: "James", source: "worker_name" },
      { position: "2", label: "Date", sample: "08/07/2026" },
      { position: "3", label: "Shift type", sample: "Day shift" },
      { position: "4", label: "Start time", sample: "07:00" },
      { position: "5", label: "Location", sample: "FedEx Marston Gate" },
    ],
  },
  {
    key: "shift_cancellation_notice",
    envKey: "TWILIO_TEMPLATE_SHIFT_CANCELLATION_NOTICE",
    displayName: "Shift Cancellation",
    defaultSid: "HXfd5a9d20bad000a9955f3d6afac5fddd",
    variables: [
      { position: "1", label: "Worker name", sample: "Lakshmi", source: "worker_name" },
      { position: "2", label: "Date", sample: "09/07/2026" },
      { position: "3", label: "Shift type", sample: "Late shift" },
      { position: "4", label: "Location", sample: "FedEx Kingsbury" },
    ],
  },
  {
    key: "weekly_availability_request",
    envKey: "TWILIO_TEMPLATE_WEEKLY_AVAILABILITY_REQUEST",
    displayName: "Weekly Availability",
    defaultSid: "HX3946f21b25f43845de1ff76530d39105",
    variables: [
      { position: "1", label: "Worker name", sample: "Chris", source: "worker_name" },
      { position: "2", label: "Agency name", sample: "Fast Rec" },
      { position: "3", label: "Week of", sample: "13/07/2026" },
    ],
  },
  {
    key: "shift_cover_request",
    envKey: "TWILIO_TEMPLATE_SHIFT_COVER_REQUEST",
    displayName: "Shift Cover Request",
    defaultSid: "HX2d5a9267082195416d3d65845def7cc3",
    variables: [
      { position: "1", label: "Worker name", sample: "Aneta", source: "worker_name" },
      { position: "2", label: "Date", sample: "10/07/2026" },
      { position: "3", label: "Location", sample: "Evri Bury St Edmunds" },
    ],
  },
  {
    key: "shift_confirmation",
    envKey: "TWILIO_TEMPLATE_SHIFT_CONFIRMATION",
    displayName: "Shift Confirmation",
    defaultSid: "HX6153c74dde591ffe2f4a9bec71423d76",
    variables: [
      { position: "1", label: "Worker name", sample: "James", source: "worker_name" },
      { position: "2", label: "Date", sample: "13/07/2026" },
      { position: "3", label: "Start time", sample: "19:00" },
      { position: "4", label: "Location", sample: "FedEx Atherstone" },
    ],
  },
];

/** Find a template by its stable key. */
export function getTemplate(key: string): MessageTemplate | undefined {
  return TEMPLATE_CATALOG.find((t) => t.key === key);
}

/** The active Content SID for a template — env override wins over the default. */
export function resolveContentSid(template: MessageTemplate): string {
  return process.env[template.envKey]?.trim() || template.defaultSid;
}

/**
 * Public, secret-free view of the catalog for the admin dropdown — display name,
 * key, and the editable variables (label + sample). Content SIDs stay server-side.
 */
export function templateCatalogForClient() {
  return TEMPLATE_CATALOG.map((t) => ({
    key: t.key,
    displayName: t.displayName,
    variables: t.variables.map((v) => ({
      position: v.position,
      label: v.label,
      sample: v.sample,
      source: v.source,
    })),
  }));
}

/**
 * Resolve the positional variable map for ONE recipient in a template send.
 *
 * The admin's input is authoritative — we NEVER silently fall back to a catalog
 * sample. If a field is cleared, an empty string is sent (the sample is only a
 * UI pre-fill hint, never dispatched).
 *  - "worker_name" variables → the matched Worker's name when available, else
 *    whatever the admin typed (empty for an unmatched manual number).
 *  - everything else → exactly what the admin typed (blank stays blank).
 * `overrides` is the position → value map typed once in the modal.
 */
export function buildTemplateValues(
  template: MessageTemplate,
  overrides: Record<string, unknown>,
  workerName?: string | null
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const v of template.variables) {
    const raw = overrides?.[v.position];
    // Preserve the literal characters the admin typed (only null/undefined → "").
    const typed = raw == null ? "" : String(raw);
    if (v.source === "worker_name") {
      values[v.position] = (workerName ?? "").trim() || typed;
    } else {
      values[v.position] = typed;
    }
  }
  return values;
}

/**
 * Render a readable one-line preview for the OUTBOUND inbox row, so the thread
 * shows what was sent (we don't have the approved template body text here).
 * e.g. "[Shift Confirmation] James · Mon 13 July · 19:00 · FedEx Atherstone".
 */
export function buildTemplatePreview(
  template: MessageTemplate,
  values: Record<string, string>
): string {
  // Reflect what was actually sent — skip blanks rather than backfilling samples.
  const parts = template.variables
    .map((v) => (values[v.position] ?? "").trim())
    .filter((p) => p !== "");
  return `[${template.displayName}]${parts.length ? " " + parts.join(" · ") : ""}`;
}

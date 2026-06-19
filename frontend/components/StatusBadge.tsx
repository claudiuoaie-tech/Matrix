import type { AllocationState } from "@/lib/types";
import { stateBadgeClass } from "@/lib/ui";

export default function StatusBadge({ state }: { state: AllocationState }) {
  const label =
    state.charAt(0) + state.slice(1).toLowerCase();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${stateBadgeClass(
        state
      )}`}
    >
      {label}
    </span>
  );
}

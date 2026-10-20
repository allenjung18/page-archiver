// Clears the previous run's smoke rows, so the report only ever shows this run.
import { rmSync } from "node:fs";
import { SMOKE_ROWS_DIR } from "./table.ts";

export default function clearRows(): void {
  rmSync(SMOKE_ROWS_DIR, { recursive: true, force: true });
}

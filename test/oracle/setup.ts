// Clears the previous run's oracle rows, so the table only ever shows this run.
import { rmSync } from "node:fs";
import { ROWS_DIR } from "./table.ts";

export default function clearRows(): void {
  rmSync(ROWS_DIR, { recursive: true, force: true });
}

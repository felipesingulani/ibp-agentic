/** W4 · validação em runtime de ExecutionMovement contra contracts/execution-movement.schema.json (falha → rollback). */
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

const ajv = new Ajv2020({ strict: false });
const validate = ajv.compile(JSON.parse(readFileSync(new URL("../../contracts/execution-movement.schema.json", import.meta.url), "utf8")));

export function assertExecutionMovement(m: unknown): void {
  if (!validate(m)) throw new Error(`ExecutionMovement fora do contrato: ${ajv.errorsText(validate.errors)}`);
}

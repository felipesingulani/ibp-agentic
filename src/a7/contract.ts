/** Validação em runtime contra contracts/decision-event.schema.json (fonte única da forma do DecisionEvent). */
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

const schema = JSON.parse(readFileSync(new URL("../../contracts/decision-event.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false });
const validate = ajv.compile(schema);

export function assertDecisionEvent(ev: unknown): void {
  if (!validate(ev)) throw new Error(`DecisionEvent fora do contrato: ${ajv.errorsText(validate.errors)}`);
}

/** T-A7-LEVE: resposta de POST /api/a7/evaluate contra contracts/a7-orchestration.schema.json (a7.orch.v1). */
const orchSchema = JSON.parse(readFileSync(new URL("../../contracts/a7-orchestration.schema.json", import.meta.url), "utf8"));
const validateOrch = ajv.compile(orchSchema);
export function assertA7Orchestration(out: unknown): void {
  if (!validateOrch(out)) throw new Error(`A7 orchestration fora do contrato: ${ajv.errorsText(validateOrch.errors)}`);
}

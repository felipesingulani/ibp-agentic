/** Validação em runtime de AlcadaQueueItem contra contracts/alcada-queue-item.schema.json (events[] → $ref decision-event). */
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

const load = (f: string) => JSON.parse(readFileSync(new URL(`../../contracts/${f}`, import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false });
ajv.addSchema(load("decision-event.schema.json"), "decision-event.schema.json");
const validate = ajv.compile(load("alcada-queue-item.schema.json"));

export function assertAlcadaItem(it: unknown): void {
  if (!validate(it)) throw new Error(`AlcadaQueueItem fora do contrato: ${ajv.errorsText(validate.errors)}`);
}

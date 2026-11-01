// Validação contra os JSON Schemas do contrato (contracts/a4-*.schema.json) — fonte única da forma de saída.
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

const load = (f: string) => JSON.parse(readFileSync(`contracts/${f}`, "utf8"));
const ajv = new Ajv2020({ strict: false });
ajv.addSchema(load("a4-reason.schema.json"), "a4-reason.schema.json");
export const validateSummary = ajv.compile(load("a4-run-summary.schema.json"));
export const validateReason = ajv.getSchema("a4-reason.schema.json")!;
export const validatePremiseCard = ajv.compile(load("premise-card.schema.json"));
export const validateDecisionEvent = ajv.compile(load("decision-event.schema.json"));
export const validateAlcadaItem = ajv.compile(load("alcada-queue-item.schema.json")); // $ref decision-event via $id
export const validateExecutionMovement = ajv.compile(load("execution-movement.schema.json")); // W4
export const validateA7Orch = ajv.compile(load("a7-orchestration.schema.json")); // T-A7-LEVE

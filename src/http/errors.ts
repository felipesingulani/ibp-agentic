import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

/** Mapeia erros do Postgres/zod para HTTP sem vazar detalhes internos. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err instanceof ZodError) return res.status(400).json({ error: "validation_failed", details: err.issues });
  const code = (err as { code?: string }).code;
  const map: Record<string, [number, string]> = {
    "23505": [409, "conflict"],
    "23503": [400, "invalid_reference"],
    "23514": [400, "check_violation"],
    "23502": [400, "not_null_violation"],
    "22P02": [400, "invalid_input"],
    "22007": [400, "invalid_input"],
    "42501": [403, "forbidden_by_rls"],
  };
  if (code && map[code]) {
    const [status, error] = map[code];
    return res.status(status).json({ error, detail: (err as { detail?: string; constraint?: string }).constraint });
  }
  if ((err as { type?: string }).type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
  console.error(err);
  return res.status(500).json({ error: "internal_error" });
}

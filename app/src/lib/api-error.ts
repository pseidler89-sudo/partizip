/**
 * api-error.ts — Einheitliches Fehlerformat für alle Route Handler
 *
 * Format: { error: { code: string, message: string } }
 */

import { NextResponse } from "next/server";

export type ApiErrorCode =
  | "TENANT_NOT_FOUND"
  | "VALIDATION_ERROR"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "TOKEN_USED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "ACCOUNT_INACTIVE"
  | "NOT_VERIFIED"
  | "NOT_ELIGIBLE"
  | "INTERNAL_ERROR";

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string
): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

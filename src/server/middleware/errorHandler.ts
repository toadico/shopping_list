import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/AppError.js';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    const details = err.errors.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details,
      },
    });
    return;
  }

  // Handle payload too large errors from body-parser (413)
  if (
    err &&
    typeof err === 'object' &&
    (('status' in err && (err as { status?: number }).status === 413) ||
      ('type' in err && (err as { type?: string }).type === 'entity.too.large'))
  ) {
    res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds the maximum allowed size',
      },
    });
    return;
  }

  // Handle JSON body parser syntax errors
  if (err instanceof SyntaxError && 'status' in err && (err as { status?: number }).status === 400) {
    res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Malformed JSON payload',
      },
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : message,
    },
  });
}

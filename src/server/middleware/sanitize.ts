import type { Request, Response, NextFunction } from 'express';

const DATA_IMAGE_REGEX = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i;

export function sanitizeString(value: string, keyName?: string): string {
  // Remove null bytes
  const noNulls = value.replace(/\0/g, '').trim();

  // Preserve valid base64 data URI images for item pictures
  if (keyName === 'imageData' || keyName === 'image_data') {
    if (noNulls === '' || DATA_IMAGE_REGEX.test(noNulls)) {
      return noNulls;
    }
  }

  // Strip HTML script/iframe/object/embed tags and inline event handlers
  return noNulls
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<\/?(script|iframe|object|embed|svg|math|style|link|meta)\b[^>]*>/gi, '')
    .replace(/[<>]/g, (char) => (char === '<' ? '&lt;' : '&gt;'));
}

export function sanitizeValue(value: unknown, keyName?: string): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value, keyName);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, keyName));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        continue;
      }
      result[k] = sanitizeValue(v, k);
    }
    return result;
  }
  return value;
}

export function sanitizeMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeValue(req.query) as Request['query'];
  }
  if (req.params && typeof req.params === 'object') {
    req.params = sanitizeValue(req.params) as Request['params'];
  }
  next();
}

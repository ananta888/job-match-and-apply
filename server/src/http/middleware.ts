import { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SafeHttpError } from '../services/safe-http-error.js';
import { CvAiStructuringError } from '../services/cv-ai-structuring.js';
import type { Express } from 'express';
import {
  cvAiPublicErrorDetail, errorClassName, reportUnexpectedError,
} from './app-support.js';
import type { AppContext } from './app-context.js';

/** Correlation id, audit log and observability record for every request. */
export function registerRequestLogging(app: Express, ctx: AppContext): void {
  const {
    audit, agentApi,
  } = ctx;

  app.use((request, response, next) => {
    const requestStartedAt = Date.now();
    const requested = request.header('x-correlation-id');
    const correlationId = requested && /^[a-zA-Z0-9_-]{8,80}$/.test(requested) ? requested : randomUUID();
    response.locals.correlationId = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    response.on('finish', () => {
      const safeErrorCode = typeof response.locals.safeErrorCode === 'string'
        ? response.locals.safeErrorCode : undefined;
      const safeErrorStage = typeof response.locals.safeErrorStage === 'string'
        ? response.locals.safeErrorStage : undefined;
      // A failure after the headers were sent cannot change the transmitted
      // status, so it would otherwise vanish from both logs. Record it as an
      // error against the honest status, identified by error class alone.
      const streamErrorClass = typeof response.locals.streamErrorClass === 'string'
        ? response.locals.streamErrorClass : undefined;
      // Concrete class of a failure the error contract does not model. Without
      // it every unexpected 500 logged the same constant and told us nothing.
      const unexpectedErrorClass = typeof response.locals.unexpectedErrorClass === 'string'
        ? response.locals.unexpectedErrorClass : undefined;
      const category = safeErrorStage
        ?? (streamErrorClass ? 'stream_aborted' : undefined)
        ?? unexpectedErrorClass;
      const errorClass = streamErrorClass ?? safeErrorStage ?? unexpectedErrorClass
        ?? (response.statusCode >= 500 ? 'server_error' : undefined);
      void audit.write({
        correlationId, operation: `${request.method} ${request.route?.path ?? request.path}`,
        status: response.statusCode, occurredAt: new Date().toISOString(),
        ...(category ? { category } : {}),
      }).catch(() => undefined);
      void agentApi.observability?.record({
        level: response.statusCode >= 500 || streamErrorClass
          ? 'error' : response.statusCode >= 400 ? 'warn' : 'info',
        component: 'http', operation: 'request',
        code: safeErrorCode ?? (streamErrorClass ? 'stream_aborted' : `status_${response.statusCode}`),
        correlationId, durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...(errorClass ? { errorClass } : {}),
      }).catch(() => undefined);
    });
    next();
  });
}

/** Maps thrown errors to the problem+json contract; must be registered after all routes. */
export function registerErrorHandler(app: Express, ctx: AppContext): void {
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const correlationId = String(response.locals.correlationId ?? randomUUID());
    // A streaming response (SSE) has already sent its status and content type.
    // Overwriting them here cannot reach the client, but it does mutate
    // response.statusCode before the finish listener reads it, which logged a
    // 500 for a request the client received as a healthy 200, and it would push
    // a JSON body into an event-stream. Close the connection instead and keep
    // the transmitted status truthful.
    if (response.headersSent) {
      response.locals.streamErrorClass = errorClassName(error);
      response.end();
      return;
    }
    if (error instanceof z.ZodError) {
      response.status(400).json({
        type: 'urn:job-match-and-apply:error:validation', title: 'Ungültige Eingabe', status: 400,
        category: 'validation', detail: 'Die Eingabe entspricht nicht dem erwarteten Vertrag.',
        error: 'Ungültige Eingabe.', details: error.issues, correlationId, instance: request.path
      });
      return;
    }
    const safeError = error instanceof SafeHttpError ? error : undefined;
    const cvAiError = error instanceof CvAiStructuringError ? error : undefined;
    const statusCode = safeError?.statusCode ?? cvAiError?.statusCode
      ?? (typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500);
    const category = statusCode === 400 || statusCode === 422
      ? 'validation'
      : statusCode === 409
        ? 'policy'
        : statusCode === 401 || statusCode === 403
          ? 'authentication'
          : statusCode === 429
            ? 'rate_limit'
            : statusCode === 503
              ? 'retryable_dependency'
              : 'internal';
    const message = safeError?.publicDetail ?? (cvAiError ? cvAiPublicErrorDetail(cvAiError.code) : undefined)
      ?? (statusCode >= 500
        ? 'Die lokale Abhängigkeit ist fehlgeschlagen.'
        : error instanceof Error ? error.message : 'Unbekannter Fehler');
    if (safeError || cvAiError) {
      response.locals.safeErrorCode = safeError?.errorCode ?? cvAiError!.code;
      response.locals.safeErrorStage = safeError?.stage ?? `cv_ai_${cvAiError!.stage}`;
    }
    // An unmodeled 5xx is a defect: no closed contract describes it, and its
    // only trace used to be the constant `server_error`, which is the same for
    // every cause. Keep the concrete error class and leave a diagnostic behind.
    if (statusCode >= 500 && !safeError && !cvAiError) {
      const unexpectedClass = errorClassName(error);
      response.locals.unexpectedErrorClass = unexpectedClass;
      reportUnexpectedError(`${request.method} ${request.route?.path ?? request.path}`, correlationId, unexpectedClass, error);
    }
    response.status(statusCode).json({
      type: `urn:job-match-and-apply:error:${category}`, title: 'Operation fehlgeschlagen', status: statusCode,
      category, detail: message, error: message, correlationId, instance: request.path,
      ...(safeError || cvAiError ? {
        errorCode: safeError?.errorCode ?? cvAiError!.code,
        stage: safeError?.stage ?? cvAiError!.stage,
        retryable: safeError?.retryable ?? cvAiError!.retryable,
      } : {}),
    });
  });
}

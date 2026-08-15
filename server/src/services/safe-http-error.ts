export type SafeHttpErrorStatus = 400 | 409 | 422 | 503;

export type SafeErrorStage =
  | 'cv_import_validation'
  | 'cv_import_normalization'
  | 'cv_fact_validation'
  | 'cv_profile_adoption'
  | 'cv_skill_contract';

const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,79}$/;

/**
 * An explicitly allowlisted, client-safe failure. Never construct this from an
 * upstream message: `publicDetail`, `errorCode`, and `stage` are part of the
 * server-owned public contract and may be returned and logged verbatim.
 */
export class SafeHttpError extends Error {
  readonly statusCode: SafeHttpErrorStatus;
  readonly errorCode: string;
  readonly stage: SafeErrorStage;
  readonly publicDetail: string;
  readonly retryable: boolean;

  constructor(input: {
    statusCode: SafeHttpErrorStatus;
    errorCode: string;
    stage: SafeErrorStage;
    publicDetail: string;
    retryable?: boolean;
  }) {
    if (!SAFE_ERROR_CODE.test(input.errorCode)) throw new Error('safe_http_error_code_invalid');
    super(input.publicDetail);
    this.name = 'SafeHttpError';
    this.statusCode = input.statusCode;
    this.errorCode = input.errorCode;
    this.stage = input.stage;
    this.publicDetail = input.publicDetail;
    this.retryable = input.retryable ?? input.statusCode === 503;
  }
}

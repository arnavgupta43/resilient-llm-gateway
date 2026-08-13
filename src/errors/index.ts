export abstract class GatewayError extends Error {
  abstract readonly httpStatus: number;
  // Operational errors are expected failure modes (bad input, a provider
  // erroring out) and get logged at warn; anything else is a bug and gets
  // logged at error. See CLAUDE.md "Error Handling".
  abstract readonly isOperational: boolean;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends GatewayError {
  readonly httpStatus = 400;
  readonly isOperational = true;
}

export class ProviderError extends GatewayError {
  readonly httpStatus = 502;
  readonly isOperational = true;

  constructor(message: string, readonly provider: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

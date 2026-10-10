export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
  static badRequest(message: string, detail?: Record<string, unknown>): AppError {
    return new AppError(400, 'BadRequest', message, detail);
  }
  static unauthorized(message = 'authentication required'): AppError {
    return new AppError(401, 'Unauthorized', message);
  }
  static forbidden(message = 'not permitted for this role', detail?: Record<string, unknown>): AppError {
    return new AppError(403, 'Forbidden', message, detail);
  }
  static notFound(what: string): AppError {
    return new AppError(404, 'NotFound', `${what} not found`);
  }
  static conflict(message: string, detail?: Record<string, unknown>): AppError {
    return new AppError(409, 'Conflict', message, detail);
  }
  static unprocessable(message: string, detail?: Record<string, unknown>): AppError {
    return new AppError(422, 'Unprocessable', message, detail);
  }
}

export class HttpError extends Error {
  readonly statusCode: number;
  readonly details: unknown;
  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const notFound = (what: string): HttpError => new HttpError(404, `${what} not found`);
export const conflict = (message: string, details?: unknown): HttpError =>
  new HttpError(409, message, details);
export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError(400, message, details);

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { Request, Response } from "express";
import { randomUUID } from "node:crypto";
export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
    public fields: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export const fail = (
  status: number,
  code: string,
  message = code,
  fields: Record<string, unknown> = {},
) => {
  throw new DomainError(status, code, message, fields);
};
export function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) fail(404, code);
  return value!;
}
@Catch()
export class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    let status = 500,
      code = "INTERNAL_ERROR",
      message = "服务暂时不可用",
      fields = {};
    if (error instanceof DomainError) {
      ({ status, code, message, fields } = error);
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code =
        status === 400
          ? "VALIDATION_ERROR"
          : status === 401
            ? "UNAUTHORIZED"
            : status === 403
              ? "FORBIDDEN"
              : status === 404
                ? "NOT_FOUND"
                : "HTTP_ERROR";
      message = error.message;
      fields = { details: error.getResponse() };
    } else
      console.error(
        JSON.stringify({
          requestId: req.headers["x-request-id"],
          error: String(error),
        }),
      );
    res
      .status(status)
      .json({ error: { code, message, requestId: randomUUID(), ...fields } });
  }
}

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Request } from "express";
import { fail } from "../common/errors";
import { AuthService, Principal } from "./auth.service";
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private auth: AuthService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { principal: Principal }>();
    if (
      ["/api/health", "/api/auth/login", "/api/auth/refresh"].includes(req.path)
    )
      return true;
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    req.principal = await this.auth.validate(token || "");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.path !== "/api/auth/logout" &&
      req.principal.role !== "admin" &&
      !req.path.match(/^\/api\/sequences\/[^/]+\/preview$/)
    )
      fail(403, "FORBIDDEN", "只读查看者不能执行写操作");
    return true;
  }
}

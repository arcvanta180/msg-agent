import { Inject, Injectable } from "@nestjs/common";
import { Response } from "express";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { Database, id } from "../../../../packages/db/src";
import { fail } from "../common/errors";
interface User {
  id: string;
  role: "admin" | "viewer";
  salt: string;
  passwordHash: string;
}
interface Session {
  id: string;
  userId: string;
  role: string;
  revoked: boolean;
  expiresAt: string;
}
interface Refresh {
  id: string;
  sessionId: string;
  used: boolean;
  expiresAt: string;
}
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export interface Principal {
  sessionId: string;
  userId: string;
  role: string;
}
@Injectable()
export class AuthService {
  constructor(@Inject(Database) private db: Database) {}
  cookie(res: Response, token: string) {
    res.cookie("refreshToken", token, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === "true",
      sameSite: "strict",
      path: "/api/auth",
      maxAge: 7 * 86400000,
    });
  }
  async access(session: Session) {
    const token = randomBytes(32).toString("base64url");
    await this.db.tx((s) =>
      s.put("refresh_tokens", {
        id: hash(token),
        kind: "access",
        sessionId: session.id,
        expiresAt: new Date(
          Date.now() + Number(process.env.ACCESS_TTL_SECONDS || 900) * 1000,
        ).toISOString(),
      }),
    );
    return token;
  }
  async login(username: string, password: string, res: Response) {
    const user = await this.db.read().get<User>("users", username);
    if (
      !user ||
      !timingSafeEqual(
        scryptSync(password, user.salt, 64),
        Buffer.from(user.passwordHash, "hex"),
      )
    )
      fail(401, "UNAUTHORIZED", "用户名或密码错误");
    const session: Session = {
      id: id(),
      userId: username,
      role: user!.role,
      revoked: false,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    const token = randomBytes(32).toString("base64url");
    await this.db.tx(async (s) => {
      await s.put("sessions", session);
      await s.put("refresh_tokens", {
        id: hash(token),
        kind: "refresh",
        sessionId: session.id,
        used: false,
        expiresAt: session.expiresAt,
      });
    });
    this.cookie(res, token);
    return { accessToken: await this.access(session) };
  }
  async validate(token: string): Promise<Principal> {
    if (typeof token !== "string" || token.length > 500)
      fail(401, "UNAUTHORIZED");
    const access = await this.db.read().get<{
      kind: string;
      sessionId: string;
      expiresAt: string;
    }>("refresh_tokens", hash(token));
    if (
      !access ||
      access.kind !== "access" ||
      Date.parse(access.expiresAt) <= Date.now()
    )
      fail(401, "UNAUTHORIZED");
    const session = await this.db
      .read()
      .get<Session>("sessions", access!.sessionId);
    if (
      !session ||
      session.revoked ||
      Date.parse(session.expiresAt) <= Date.now()
    )
      fail(401, "UNAUTHORIZED");
    return {
      sessionId: session!.id,
      userId: session!.userId,
      role: session!.role,
    };
  }
  async refresh(token: string, res: Response) {
    if (!token) fail(401, "UNAUTHORIZED");
    const newToken = randomBytes(32).toString("base64url");
    const session = await this.db.tx(async (s) => {
      const old = await s.get<Refresh & { kind: string }>(
        "refresh_tokens",
        hash(token),
      );
      if (!old || old.kind !== "refresh") return null;
      const session = await s.get<Session>("sessions", old.sessionId);
      if (!session || session.revoked) return null;
      if (old.used) {
        session.revoked = true;
        await s.put("sessions", session);
        return null;
      }
      if (Date.parse(old.expiresAt) <= Date.now()) return null;
      old.used = true;
      await s.put("refresh_tokens", old);
      await s.put("refresh_tokens", {
        id: hash(newToken),
        kind: "refresh",
        sessionId: session.id,
        used: false,
        expiresAt: session.expiresAt,
      });
      return session;
    });
    if (!session)
      fail(401, "UNAUTHORIZED", "会话已过期或 refresh token 被重复使用");
    this.cookie(res, newToken);
    return { accessToken: await this.access(session!) };
  }
  async logout(principal: Principal | undefined, res: Response) {
    if (principal)
      await this.db.tx(async (s) => {
        const session = await s.get<Session>("sessions", principal.sessionId);
        if (session) await s.put("sessions", { ...session, revoked: true });
      });
    res.clearCookie("refreshToken", {
      path: "/api/auth",
      httpOnly: true,
      sameSite: "strict",
    });
    return { ok: true };
  }
}

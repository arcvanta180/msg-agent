import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { Request, Response } from "express";
import { AuthService, Principal } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
@Controller("api")
export class AuthController {
  constructor(@Inject(AuthService) private auth: AuthService) {}
  @Post("auth/login") @HttpCode(200) login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.login(body.username, body.password, res);
  }
  @Post("auth/refresh") @HttpCode(200) refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.refresh(req.cookies?.refreshToken, res);
  }
  @Post("auth/logout") @HttpCode(200) logout(
    @Req() req: Request & { principal: Principal },
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.logout(req.principal, res);
  }
  @Get("auth/me") me(@Req() req: Request & { principal: Principal }) {
    return req.principal;
  }
}
